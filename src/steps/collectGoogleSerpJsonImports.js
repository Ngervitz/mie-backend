'use strict';

const { randomUUID } = require('crypto');
const stringify = require('json-stable-stringify');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { todayUruguay } = require('../activity/dates');
const {
  sha256Hex,
  normalizeDomain,
  normalizeSearchTerm,
  matchAdvertiserToEntities,
  queueUnmatchedDomainsForReview,
  MALFORMED_DOMAIN,
} = require('./collectGoogleSerpImports');

/**
 * Serper.dev /search JSON import — parallel to HTML importGoogleSerpHtml.
 * Does not modify Cheerio parsing or POST /import-google-serp.
 *
 * Dedup: SHA-256 of json-stable-stringify(payload) stored in google_serp_captures.file_hash.
 * Storage: private bucket serp-json-imports (created on first use, same pattern as HTML).
 */

const STORAGE_BUCKET_JSON = 'serp-json-imports';
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const TITLE_FALLBACK = '(sin título)';

/**
 * Deterministic JSON canonicalization (arrays, nested objects, null, numbers).
 * @param {unknown} value
 * @returns {string}
 */
function canonicalizeSerperJson(value) {
  return stringify(value);
}

/**
 * @param {unknown} value
 * @returns {string} hex SHA-256
 */
function hashSerperJson(value) {
  const canonical = canonicalizeSerperJson(value);
  return sha256Hex(Buffer.from(canonical, 'utf8'));
}

async function ensureSerpJsonBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    throw new Error(`Failed to list storage buckets: ${listError.message}`);
  }
  const exists = (buckets || []).some(
    (b) => b.name === STORAGE_BUCKET_JSON || b.id === STORAGE_BUCKET_JSON,
  );
  if (exists) return;

  const { error: createError } = await supabase.storage.createBucket(
    STORAGE_BUCKET_JSON,
    {
      public: false,
      fileSizeLimit: MAX_JSON_BYTES,
      allowedMimeTypes: ['application/json', 'text/json', 'text/plain'],
    },
  );
  if (createError) {
    if (!/already exists/i.test(createError.message || '')) {
      throw new Error(
        `Storage bucket "${STORAGE_BUCKET_JSON}" missing and could not be created: ${createError.message}`,
      );
    }
  }
  logger.info('Created storage bucket', {
    bucket: STORAGE_BUCKET_JSON,
    public: false,
  });
}

async function archiveJsonToStorage(buffer) {
  await ensureSerpJsonBucket();
  const fileName = `${Date.now()}-${randomUUID()}.json`;
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET_JSON)
    .upload(fileName, buffer, {
      contentType: 'application/json',
      upsert: false,
    });
  if (uploadError) {
    throw new Error(`Failed to archive SERP JSON: ${uploadError.message}`);
  }
  return `${STORAGE_BUCKET_JSON}/${fileName}`;
}

async function findCaptureByHash(fileHash) {
  const { data, error } = await supabase
    .from('google_serp_captures')
    .select(
      'id, search_term, date, storage_path, file_hash, parse_status, ads_found, imported_at',
    )
    .eq('file_hash', fileHash)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to check file_hash: ${error.message}`);
  }
  return data || null;
}

async function fetchCaptureResultCounts(captureId) {
  const { data, error } = await supabase
    .from('google_serp_ads_manual')
    .select('result_type')
    .eq('capture_id', captureId);
  if (error) {
    return { adsCount: 0, organicCount: 0 };
  }
  let adsCount = 0;
  let organicCount = 0;
  for (const row of data || []) {
    if (row.result_type === 'organic') organicCount += 1;
    else adsCount += 1;
  }
  return { adsCount, organicCount };
}

async function loadMonitoredEntities() {
  const { data, error } = await supabase
    .from('monitored_entities')
    .select('id, name, is_self, active, website_domain');
  if (error) {
    throw new Error(`Failed to fetch monitored_entities: ${error.message}`);
  }
  return data || [];
}

function buildAdvertiserSummary(results, entities) {
  const advertisersMap = new Map();
  const unmatched = [];
  const matched = [];

  for (const row of results) {
    const domain = normalizeDomain(row.advertiser_domain);
    if (!domain || domain === MALFORMED_DOMAIN) continue;
    if (advertisersMap.has(domain)) continue;
    const entity = matchAdvertiserToEntities(row, entities);
    const entry = {
      advertiserName: row.advertiser_name,
      advertiserDomain: row.advertiser_domain,
      matchedEntity: entity,
    };
    advertisersMap.set(domain, entry);
    if (entity) matched.push(entry);
    else unmatched.push(entry);
  }

  return {
    advertisers: [...advertisersMap.values()],
    unmatchedAdvertisers: unmatched,
    matchedAdvertisers: matched,
  };
}

function collectUnmatchedDomains(results, entities) {
  const domains = new Set();
  for (const row of results) {
    const domain = normalizeDomain(row.advertiser_domain);
    if (!domain || domain === MALFORMED_DOMAIN) continue;
    if (!matchAdvertiserToEntities(row, entities)) {
      domains.add(domain);
    }
  }
  return [...domains];
}

function splitInsertedRows(inserted) {
  const ads = [];
  const organicResults = [];
  for (const row of inserted || []) {
    if (row.result_type === 'organic') organicResults.push(row);
    else ads.push(row);
  }
  return { ads, organicResults };
}

function buildSuccessImportMessage(adCount, organicCount) {
  const parts = [];
  if (adCount) parts.push(`${adCount} anuncio(s) de pago`);
  if (organicCount) parts.push(`${organicCount} resultado(s) orgánico(s)`);
  if (!parts.length) return 'Importación completada sin filas.';
  return `Se importaron ${parts.join(' y ')}.`;
}

/**
 * Map Serper organic[] — confirmed fields: title, link, snippet, position
 * (optional date ignored for DB). placement always 'organic'.
 */
function mapSerperOrganic(organic) {
  const list = Array.isArray(organic) ? organic : [];
  const out = [];
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const link = item.link != null ? String(item.link).trim() : '';
    const titleRaw = item.title != null ? String(item.title).trim() : '';
    const snippet =
      item.snippet != null ? String(item.snippet).trim() || null : null;
    const domain = link ? normalizeDomain(link) : null;
    const title = titleRaw || TITLE_FALLBACK;
    const position =
      Number.isFinite(Number(item.position)) && Number(item.position) > 0
        ? Number(item.position)
        : index + 1;

    out.push({
      position,
      placement: 'organic',
      result_type: 'organic',
      advertiser_name: titleRaw || domain || null,
      advertiser_domain: domain || null,
      ad_title: title,
      ad_description: snippet,
      destination_url: link || null,
    });
  });
  return out;
}

/**
 * Map Serper ads[] when present.
 * Shape of populated ads is UNCONFIRMED (no real sample yet).
 * Safe fallbacks only: title/link/snippet|description/position if present;
 * placement always 'unknown' — never invent top/bottom.
 */
function mapSerperAds(ads) {
  if (!Array.isArray(ads)) return [];
  const out = [];
  ads.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const link = item.link != null ? String(item.link).trim() : '';
    const titleRaw = item.title != null ? String(item.title).trim() : '';
    const desc =
      item.snippet != null
        ? String(item.snippet).trim() || null
        : item.description != null
          ? String(item.description).trim() || null
          : null;
    const domain = link ? normalizeDomain(link) : null;
    const title = titleRaw || TITLE_FALLBACK;
    const position =
      Number.isFinite(Number(item.position)) && Number(item.position) > 0
        ? Number(item.position)
        : index + 1;

    out.push({
      position,
      placement: 'unknown',
      result_type: 'ad',
      advertiser_name: titleRaw || domain || null,
      advertiser_domain: domain || null,
      ad_title: title,
      ad_description: desc,
      destination_url: link || null,
    });
  });
  return out;
}

/**
 * Validate Serper /search body before any persistence.
 * @returns {{ searchTerm: string, organic: unknown, ads: unknown }}
 */
function validateSerperPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('Body JSON inválido');
    err.statusCode = 400;
    err.code = 'INVALID_BODY';
    throw err;
  }

  const q =
    body.searchParameters && body.searchParameters.q != null
      ? String(body.searchParameters.q).trim()
      : '';
  if (!q) {
    const err = new Error(
      'searchParameters.q es requerido y debe ser un string no vacío',
    );
    err.statusCode = 400;
    err.code = 'SEARCH_TERM_REQUIRED';
    throw err;
  }

  const hasOrganicArray = Array.isArray(body.organic);
  const hasAdsArray = Array.isArray(body.ads);
  if (!hasOrganicArray && !hasAdsArray) {
    const err = new Error(
      'El JSON debe incluir al menos uno de organic o ads como array',
    );
    err.statusCode = 400;
    err.code = 'MISSING_RESULT_ARRAYS';
    throw err;
  }

  return {
    searchTerm: q,
    organic: hasOrganicArray ? body.organic : [],
    ads: hasAdsArray ? body.ads : [],
  };
}

/**
 * Full Serper JSON import pipeline.
 * @param {{ payload: object }} opts
 */
async function importGoogleSerpJson(opts) {
  const payload = opts && opts.payload;
  const validated = validateSerperPayload(payload);

  const fileHash = hashSerperJson(payload);
  const existing = await findCaptureByHash(fileHash);
  if (existing) {
    const counts = await fetchCaptureResultCounts(existing.id);
    logger.info('SERP JSON import duplicate hash — skipping', {
      fileHash,
      captureId: existing.id,
      storagePath: existing.storage_path,
    });
    return {
      ok: true,
      duplicate: true,
      message: 'Esta captura ya había sido importada.',
      adsInserted: 0,
      organicInserted: 0,
      resultsInserted: 0,
      adsFound: counts.adsCount,
      organicFound: counts.organicCount,
      resultsFound: counts.adsCount + counts.organicCount,
      captureId: existing.id,
      searchTerm: existing.search_term,
      date: existing.date,
      rawHtmlStoragePath: existing.storage_path,
      fileHash: existing.file_hash,
      parseStatus: existing.parse_status,
      importedAt: existing.imported_at,
    };
  }

  const organicMapped = mapSerperOrganic(validated.organic);
  const adsMapped = mapSerperAds(validated.ads);
  const allParsed = [...adsMapped, ...organicMapped];
  const adsFoundCount = adsMapped.length;
  const organicFoundCount = organicMapped.length;
  const parserFoundNoResults = allParsed.length === 0;

  const searchTerm = validated.searchTerm;
  const searchTermNormalized = normalizeSearchTerm(searchTerm);
  const date = todayUruguay();

  const rawJson = Buffer.from(canonicalizeSerperJson(payload), 'utf8');
  if (rawJson.length > MAX_JSON_BYTES) {
    const err = new Error(`JSON exceeds ${MAX_JSON_BYTES} byte limit`);
    err.statusCode = 400;
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
  const storagePath = await archiveJsonToStorage(rawJson);

  // Schema allows only success | no_ads_found | failed — reuse no_ads_found
  // for empty Serper results (same loud-empty semantics as HTML path).
  if (parserFoundNoResults) {
    const { data: capture, error: captureError } = await supabase
      .from('google_serp_captures')
      .insert({
        search_term: searchTerm,
        search_term_normalized: searchTermNormalized,
        date,
        storage_path: storagePath,
        file_hash: fileHash,
        parse_status: 'no_ads_found',
        ads_found: 0,
      })
      .select(
        'id, search_term, search_term_normalized, date, storage_path, file_hash, parse_status, ads_found, imported_at',
      )
      .single();

    if (captureError) {
      throw new Error(
        `Failed to insert google_serp_captures: ${captureError.message}`,
      );
    }

    return {
      ok: false,
      duplicate: false,
      parserFoundNoAdMarkers: true,
      parserFoundNoResults: true,
      message:
        'parser found no results — el JSON de Serper no contiene anuncios ni resultados orgánicos.',
      searchTerm,
      searchTermSource: 'serper_json',
      date,
      captureId: capture.id,
      rawHtmlStoragePath: storagePath,
      fileHash,
      parseStatus: 'no_ads_found',
      adsFound: 0,
      organicFound: 0,
      resultsFound: 0,
      adsInserted: 0,
      organicInserted: 0,
      resultsInserted: 0,
      advertisers: [],
      unmatchedAdvertisers: [],
      matchedAdvertisers: [],
      ads: [],
      organicResults: [],
      queuedUnmatchedDomains: { queued: 0, skipped: 0, domains: [] },
    };
  }

  const { data: capture, error: captureError } = await supabase
    .from('google_serp_captures')
    .insert({
      search_term: searchTerm,
      search_term_normalized: searchTermNormalized,
      date,
      storage_path: storagePath,
      file_hash: fileHash,
      parse_status: 'success',
      ads_found: adsFoundCount,
    })
    .select(
      'id, search_term, search_term_normalized, date, storage_path, file_hash, parse_status, ads_found, imported_at',
    )
    .single();

  if (captureError) {
    if (/duplicate|unique/i.test(captureError.message || '')) {
      const raced = await findCaptureByHash(fileHash);
      if (raced) {
        const counts = await fetchCaptureResultCounts(raced.id);
        return {
          ok: true,
          duplicate: true,
          message: 'Esta captura ya había sido importada.',
          adsInserted: 0,
          organicInserted: 0,
          resultsInserted: 0,
          adsFound: counts.adsCount,
          organicFound: counts.organicCount,
          resultsFound: counts.adsCount + counts.organicCount,
          captureId: raced.id,
          searchTerm: raced.search_term,
          date: raced.date,
          rawHtmlStoragePath: raced.storage_path,
          fileHash: raced.file_hash,
          parseStatus: raced.parse_status,
          importedAt: raced.imported_at,
        };
      }
    }
    throw new Error(
      `Failed to insert google_serp_captures: ${captureError.message}`,
    );
  }

  const entities = await loadMonitoredEntities();
  const rows = allParsed.map((item) => ({
    capture_id: capture.id,
    search_term: searchTerm,
    date,
    result_type: item.result_type || 'ad',
    advertiser_name: item.advertiser_name,
    advertiser_domain: item.advertiser_domain,
    ad_title: item.ad_title,
    ad_description: item.ad_description,
    destination_url: item.destination_url,
    position: item.position,
    placement:
      item.placement ||
      (item.result_type === 'organic' ? 'organic' : 'unknown'),
    raw_html_storage_path: storagePath,
  }));

  const { data: inserted, error: insertError } = await supabase
    .from('google_serp_ads_manual')
    .insert(rows)
    .select(
      'id, capture_id, search_term, date, result_type, advertiser_name, advertiser_domain, ad_title, ad_description, destination_url, position, placement, raw_html_storage_path, imported_at',
    );

  if (insertError) {
    await supabase
      .from('google_serp_captures')
      .update({ parse_status: 'failed', ads_found: 0 })
      .eq('id', capture.id);
    throw new Error(
      `Failed to insert google_serp_ads_manual rows: ${insertError.message}`,
    );
  }

  const summary = buildAdvertiserSummary(allParsed, entities);
  const unmatchedDomains = collectUnmatchedDomains(allParsed, entities);
  const queuedUnmatchedDomains =
    await queueUnmatchedDomainsForReview(unmatchedDomains);
  const { ads: insertedAds, organicResults: insertedOrganic } =
    splitInsertedRows(inserted);

  logger.info('SERP JSON import completed', {
    searchTerm,
    storagePath,
    captureId: capture.id,
    fileHash,
    adsFound: adsFoundCount,
    organicFound: organicFoundCount,
    unmatchedCount: summary.unmatchedAdvertisers.length,
    queuedDomains: queuedUnmatchedDomains.queued,
  });

  return {
    ok: true,
    duplicate: false,
    parserFoundNoAdMarkers: false,
    parserFoundNoResults: false,
    message: buildSuccessImportMessage(adsFoundCount, organicFoundCount),
    searchTerm,
    searchTermSource: 'serper_json',
    date,
    captureId: capture.id,
    rawHtmlStoragePath: storagePath,
    fileHash,
    parseStatus: 'success',
    adsFound: adsFoundCount,
    organicFound: organicFoundCount,
    resultsFound: adsFoundCount + organicFoundCount,
    adsInserted: insertedAds.length,
    organicInserted: insertedOrganic.length,
    resultsInserted: (inserted || []).length,
    advertisers: summary.advertisers,
    unmatchedAdvertisers: summary.unmatchedAdvertisers,
    matchedAdvertisers: summary.matchedAdvertisers,
    ads: insertedAds,
    organicResults: insertedOrganic,
    queuedUnmatchedDomains,
  };
}

module.exports = {
  STORAGE_BUCKET_JSON,
  MAX_JSON_BYTES,
  canonicalizeSerperJson,
  hashSerperJson,
  validateSerperPayload,
  mapSerperOrganic,
  mapSerperAds,
  importGoogleSerpJson,
  ensureSerpJsonBucket,
};
