const { createHash, randomUUID } = require('crypto');
const cheerio = require('cheerio');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { todayUruguay } = require('../activity/dates');

/**
 * Manual Google SERP HTML import (capture-only, no scraper).
 *
 * Nico saves a real Google search page via Ctrl+S ("Complete webpage") and
 * uploads the .html. We:
 *   1) SHA256 the bytes and short-circuit on duplicate file_hash
 *   2) archive the raw file in the private `serp-html-imports` Storage bucket
 *   3) insert one google_serp_captures row + google_serp_ads_manual rows
 *   4) cross-reference advertiser domains vs monitored_entities (flag only)
 *
 * Fragile by nature — Google's SERP markup changes without notice. When the
 * expected marker is absent we fail loudly (parserFoundNoAdMarkers /
 * parse_status='no_ads_found') rather than returning a silent empty success.
 */

const STORAGE_BUCKET = 'serp-html-imports';
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const SERP_IMPORT_SOURCE_SEED = 'google_serp_import';

const MALFORMED_DOMAIN = '(url malformada)';

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Protocol-safe hostname normalization for exact domain equality.
 * Bare hostnames (no scheme) are prefixed with https:// before URL parse.
 */
function normalizeDomain(urlStr) {
  if (!urlStr) return '';
  let cleanUrl = String(urlStr).trim().toLowerCase();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = 'https://' + cleanUrl;
  }
  try {
    const parsed = new URL(cleanUrl);
    let hostname = parsed.hostname;
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    if (hostname.endsWith('.')) {
      hostname = hostname.slice(0, -1);
    }
    return hostname;
  } catch (e) {
    return cleanUrl;
  }
}

/**
 * Search-term normalization for comparison/grouping only.
 * Does NOT mutate the original display search_term.
 * Separate from normalizeDomain() — never reuse or alter that helper.
 */
function normalizeSearchTerm(term) {
  if (term == null) return '';
  let s = String(term).trim().toLowerCase();
  // Unicode NFD then strip combining marks (accents/diacritics).
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Captures that count toward presence denominator / appearance. */
const PRESENCE_INCLUDED_PARSE_STATUSES = ['success'];
const PRESENCE_EXCLUDED_PARSE_STATUSES = ['failed', 'no_ads_found'];

function extractSearchTermFromHtml($) {
  const candidates = [
    () => {
      const el = $('input[name="q"]').first();
      return el.length ? el.attr('value') : null;
    },
    () => {
      const el = $('textarea[name="q"]').first();
      if (!el.length) return null;
      const val = el.val();
      if (val != null && String(val).trim()) return val;
      return el.text();
    },
    () => {
      const el = $('input[title="Buscar"]').first();
      return el.length ? el.attr('value') : null;
    },
  ];

  for (const get of candidates) {
    const raw = get();
    const term = raw == null ? '' : String(raw).trim();
    if (term) return term;
  }
  return null;
}

function extractAdurlFromString(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/[?&]adurl=([^&]*)/);
  if (!m || m[1] === undefined || m[1] === '') return null;
  return decodeURIComponent(m[1]);
}

function isGoogleHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'google.com' || h.endsWith('.google.com');
}

function hostnameOf(urlStr) {
  const u = new URL(urlStr);
  return u.hostname.replace(/^www\./i, '').toLowerCase();
}

/**
 * Placement from real SERP DOM (audited against the prestamos sample):
 *   - top: ancestor #tads (or #tvcap / data-hb="t")
 *   - bottom: ancestor #tadsb / #bottomads, or data-hb="b"
 *   - else: 'unknown' (do not guess)
 *
 * Note: this sample has no #tadsb / #bottomads; bottom ads sit under
 * div.GUyUUb[data-hb="b"] inside #rso after organic results.
 */
function resolvePlacement($, el) {
  const $el = $(el);
  if ($el.closest('#tads').length) return 'top';
  if ($el.closest('#tadsb, #bottomads').length) return 'bottom';

  const hbEl = $el.closest('[data-hb]');
  if (hbEl.length) {
    const hb = String(hbEl.attr('data-hb') || '').toLowerCase();
    if (hb === 't') return 'top';
    if (hb === 'b') return 'bottom';
  }

  // #tvcap wraps top ads in this sample; only treat as top if no bottom signal.
  if ($el.closest('#tvcap').length) return 'top';

  return 'unknown';
}

/**
 * Per-ad destination URL resolution with try/catch resilience.
 * Priority: non-empty adurl= (href or data-rw) → first external headline href.
 * On decode/hostname failure: keep the raw string, domain = '(url malformada)'.
 */
function resolveDestination($, $el) {
  const attrCandidates = [];
  $el.find('a[href], [data-rw]').each((_, n) => {
    const href = $(n).attr('href');
    const rw = $(n).attr('data-rw');
    if (href) attrCandidates.push(href);
    if (rw) attrCandidates.push(rw);
  });

  for (const raw of attrCandidates) {
    try {
      const decoded = extractAdurlFromString(raw);
      if (decoded) {
        return {
          destinationUrl: decoded,
          advertiserDomain: hostnameOf(decoded),
          malformed: false,
        };
      }
    } catch (err) {
      try {
        const m = String(raw).match(/[?&]adurl=([^&]*)/);
        const fallback = m && m[1] ? m[1] : raw;
        return {
          destinationUrl: fallback,
          advertiserDomain: MALFORMED_DOMAIN,
          malformed: true,
        };
      } catch {
        return {
          destinationUrl: String(raw).slice(0, 2000),
          advertiserDomain: MALFORMED_DOMAIN,
          malformed: true,
        };
      }
    }
  }

  let externalHref = null;
  $el.find('a[href]').each((_, a) => {
    if (externalHref) return;
    const href = String($(a).attr('href') || '').trim();
    if (!/^https?:\/\//i.test(href)) return;
    try {
      const u = new URL(href);
      if (!isGoogleHost(u.hostname)) externalHref = href;
    } catch {
      /* skip */
    }
  });

  if (externalHref) {
    try {
      return {
        destinationUrl: externalHref,
        advertiserDomain: hostnameOf(externalHref),
        malformed: false,
      };
    } catch {
      return {
        destinationUrl: externalHref,
        advertiserDomain: MALFORMED_DOMAIN,
        malformed: true,
      };
    }
  }

  return { destinationUrl: null, advertiserDomain: null, malformed: false };
}

function extractAdvertiserName($, $el, adTitle) {
  let advertiserName = null;
  const titleLower = String(adTitle || '')
    .toLowerCase()
    .trim();

  $el.find('span').each((_, s) => {
    if (advertiserName) return;
    if ($(s).children().length > 0) return;
    const t = $(s).text().replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2 || t.length > 60) return;
    if (t.toLowerCase() === titleLower) return;
    if (/^My Ad Centre$/i.test(t)) return;
    if (/https?:\/\//i.test(t) || t.includes('›')) return;
    if (/^\d[\d\s-]+$/.test(t)) return;
    advertiserName = t;
  });

  return advertiserName;
}

function extractAdTitle($, $el) {
  let adTitle = null;
  $el.find('[role="heading"]').each((_, h) => {
    if (adTitle) return;
    const t = $(h).text().replace(/\s+/g, ' ').trim();
    if (t && !/^My Ad Centre$/i.test(t)) adTitle = t;
  });
  return adTitle || '(sin título)';
}

function extractAdDescription($, $el, adTitle) {
  const descCandidates = [];
  $el.find('div').each((_, n) => {
    const own = $(n)
      .contents()
      .filter((_, c) => c.type === 'text')
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    if (own.length >= 40 && own.length < 400 && !/My Ad Centre/i.test(own)) {
      if (adTitle && own === adTitle) return;
      descCandidates.push(own);
    }
  });
  if (!descCandidates.length) return null;
  descCandidates.sort((a, b) => b.length - a.length);
  return descCandidates[0];
}

/**
 * Organic web results from #rso (audited against samples/ SERP HTML).
 *
 * Container: #rso > div.MjjYud containing .tF2Cxc / .N54PNb
 * Title:     h3 text (inside external <a>)
 * Snippet:   div.VwiC3b text
 * URL:       closest a[href] on the h3 (http(s), non-Google host)
 * Domain:    normalizeDomain(hostname)
 * Site name: leaf span near the result (not the title); else domain
 * Rank:      document order among accepted blocks, starting at 1
 *
 * Skips ads ([data-text-ad]), Google hosts, and blocks without a real
 * external web-result link.
 */
function parseOrganicResults($) {
  const organic = [];
  const seenUrls = new Set();

  $('#rso > div.MjjYud').each((_, el) => {
    const $el = $(el);
    if ($el.find('[data-text-ad="1"]').length) return;
    if (!$el.find('.tF2Cxc, .N54PNb').length) return;

    const $h3 = $el.find('h3').first();
    if (!$h3.length) return;
    const title = $h3.text().replace(/\s+/g, ' ').trim();
    if (!title) return;

    const $a = $h3.closest('a[href]');
    const href = String(($a.length ? $a.attr('href') : '') || '').trim();
    if (!/^https?:\/\//i.test(href)) return;

    let hostname;
    try {
      hostname = new URL(href).hostname;
    } catch {
      return;
    }
    if (isGoogleHost(hostname)) return;

    const destKey = href.split('#')[0];
    if (seenUrls.has(destKey)) return;
    seenUrls.add(destKey);

    const advertiserDomain = normalizeDomain(hostname);
    if (!advertiserDomain) return;

    let siteName = null;
    const titleLower = title.toLowerCase();
    $el.find('span').each((_, sp) => {
      if (siteName) return;
      if ($(sp).children().length > 0) return;
      const t = $(sp).text().replace(/\s+/g, ' ').trim();
      if (!t || t.length < 2 || t.length > 60) return;
      if (t.toLowerCase() === titleLower) return;
      if (/https?:\/\//i.test(t) || t.includes('›')) return;
      if (/^translate this page$/i.test(t)) return;
      siteName = t;
    });

    let snippet = null;
    const $snip = $el.find('div.VwiC3b').first();
    if ($snip.length) {
      snippet = $snip.text().replace(/\s+/g, ' ').trim() || null;
      if (snippet && snippet.length > 400) snippet = snippet.slice(0, 400);
    }

    organic.push({
      position: organic.length + 1,
      placement: 'organic',
      result_type: 'organic',
      advertiser_name: siteName || advertiserDomain,
      advertiser_domain: advertiserDomain,
      ad_title: title,
      ad_description: snippet,
      destination_url: href,
    });
  });

  return organic;
}

/**
 * Parse a saved Google SERP HTML string (paid ads + organic web results).
 */
function parseGoogleSerpHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const searchTermFromHtml = extractSearchTermFromHtml($);

  const blocks = $('[data-text-ad="1"]');
  const ads = [];
  blocks.each((i, el) => {
    const $el = $(el);
    const adTitle = extractAdTitle($, $el);
    const advertiserName = extractAdvertiserName($, $el, adTitle);
    const adDescription = extractAdDescription($, $el, adTitle);
    const placement = resolvePlacement($, el);

    let destination;
    try {
      destination = resolveDestination($, $el);
    } catch (err) {
      destination = {
        destinationUrl: null,
        advertiserDomain: MALFORMED_DOMAIN,
        malformed: true,
      };
      logger.warn('SERP ad destination parse failed', {
        position: i + 1,
        error: err.message,
      });
    }

    ads.push({
      position: i + 1,
      placement,
      result_type: 'ad',
      advertiser_name: advertiserName,
      advertiser_domain: destination.advertiserDomain,
      ad_title: adTitle,
      ad_description: adDescription,
      destination_url: destination.destinationUrl,
      url_malformed: destination.malformed,
    });
  });

  const organic = parseOrganicResults($);
  const totalResults = ads.length + organic.length;

  return {
    searchTermFromHtml,
    ads,
    organic,
    adBlockCount: ads.length,
    organicCount: organic.length,
    // Loud failure only when neither ads nor organic web results were found.
    parserFoundNoAdMarkers: totalResults === 0,
    parserFoundNoResults: totalResults === 0,
  };
}

/**
 * Exact domain equality only — no name/slug/token/includes fuzzy matching.
 * advertiser_domain must equal entity.website_domain after normalizeDomain().
 */
function matchAdvertiserToEntities(ad, entities) {
  const advertiserDomain = normalizeDomain(ad.advertiser_domain);
  if (!advertiserDomain || advertiserDomain === MALFORMED_DOMAIN) return null;

  for (const entity of entities || []) {
    const entityDomain = normalizeDomain(entity.website_domain);
    if (!entityDomain) continue;
    if (advertiserDomain === entityDomain) {
      return { id: entity.id, name: entity.name };
    }
  }

  return null;
}

async function ensureSerpHtmlBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    throw new Error(`Failed to list storage buckets: ${listError.message}`);
  }
  const exists = (buckets || []).some((b) => b.name === STORAGE_BUCKET || b.id === STORAGE_BUCKET);
  if (exists) return;

  const { error: createError } = await supabase.storage.createBucket(STORAGE_BUCKET, {
    public: false,
    fileSizeLimit: MAX_FILE_BYTES,
    allowedMimeTypes: ['text/html', 'application/xhtml+xml'],
  });
  if (createError) {
    if (!/already exists/i.test(createError.message || '')) {
      throw new Error(
        `Storage bucket "${STORAGE_BUCKET}" missing and could not be created: ${createError.message}`,
      );
    }
  }
  logger.info('Created storage bucket', { bucket: STORAGE_BUCKET, public: false });
}

async function archiveHtmlToStorage(buffer, contentType) {
  await ensureSerpHtmlBucket();

  const fileName = `${Date.now()}-${randomUUID()}.html`;
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(fileName, buffer, {
      contentType: contentType || 'text/html',
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Failed to archive SERP HTML: ${uploadError.message}`);
  }

  return `${STORAGE_BUCKET}/${fileName}`;
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

function buildAdvertiserSummary(results, entities) {
  const advertisersMap = new Map();
  const unmatched = [];
  const matched = [];

  for (const row of results) {
    const domain = normalizeDomain(row.advertiser_domain);
    if (!domain || domain === MALFORMED_DOMAIN) continue;
    const key = domain;
    if (advertisersMap.has(key)) continue;
    const entity = matchAdvertiserToEntities(row, entities);
    const entry = {
      advertiserName: row.advertiser_name,
      advertiserDomain: row.advertiser_domain,
      matchedEntity: entity,
    };
    advertisersMap.set(key, entry);
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

/**
 * Route unmatched domains into confirmed_search_terms for Pendientes triage.
 * Batched: one SELECT + one INSERT; dedupes within the import via Set upstream.
 */
async function queueUnmatchedDomainsForReview(unmatchedDomains) {
  const unique = [
    ...new Set(
      (unmatchedDomains || []).map((d) => normalizeDomain(d)).filter(Boolean),
    ),
  ];
  if (!unique.length) {
    return { queued: 0, skipped: 0, domains: [] };
  }

  const { data: existing, error: selErr } = await supabase
    .from('confirmed_search_terms')
    .select('term')
    .eq('source_seed', SERP_IMPORT_SOURCE_SEED)
    .in('term', unique);
  if (selErr) {
    throw new Error(`Failed to check confirmed_search_terms: ${selErr.message}`);
  }

  const existingSet = new Set(
    (existing || []).map((r) => normalizeDomain(r.term)),
  );
  const toInsert = unique.filter((d) => !existingSet.has(d));
  if (!toInsert.length) {
    return { queued: 0, skipped: unique.length, domains: [] };
  }

  const rows = toInsert.map((term) => ({
    term,
    term_type: 'competitor_candidate',
    decision: 'pending',
    source_seed: SERP_IMPORT_SOURCE_SEED,
    discovered_score: null,
    entity_id: null,
  }));

  const { error: insErr } = await supabase.from('confirmed_search_terms').insert(rows);
  if (insErr) {
    // term UNIQUE spans all sources — skip rows that collide with Trends terms.
    if (/duplicate|unique/i.test(insErr.message || '')) {
      let queued = 0;
      for (const row of rows) {
        const { error: oneErr } = await supabase
          .from('confirmed_search_terms')
          .insert(row);
        if (!oneErr) queued += 1;
      }
      return {
        queued,
        skipped: unique.length - queued,
        domains: toInsert.slice(0, queued),
      };
    }
    throw new Error(`Failed to queue SERP unmatched domains: ${insErr.message}`);
  }

  return { queued: toInsert.length, skipped: unique.length - toInsert.length, domains: toInsert };
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
 * Full import pipeline: hash → dedup → archive → parse → capture + ads.
 *
 * @param {{ buffer: Buffer, contentType?: string, searchTermFallback?: string|null }} opts
 * Date is always the Uruguay calendar day of import — client-supplied dates are ignored.
 */
async function importGoogleSerpHtml(opts) {
  const buffer = opts.buffer;
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    const err = new Error('HTML file is required');
    err.statusCode = 400;
    err.code = 'MISSING_FILE';
    throw err;
  }
  if (buffer.length > MAX_FILE_BYTES) {
    const err = new Error(`File exceeds ${MAX_FILE_BYTES} byte limit`);
    err.statusCode = 400;
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }

  const fileHash = sha256Hex(buffer);

  // Dedup BEFORE parse / archive / insert.
  const existing = await findCaptureByHash(fileHash);
  if (existing) {
    const counts = await fetchCaptureResultCounts(existing.id);
    logger.info('SERP import duplicate hash — skipping', {
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

  const html = buffer.toString('utf8');
  const parsed = parseGoogleSerpHtml(html);

  const searchTerm =
    (parsed.searchTermFromHtml && String(parsed.searchTermFromHtml).trim()) ||
    (opts.searchTermFallback && String(opts.searchTermFallback).trim()) ||
    null;

  if (!searchTerm) {
    const err = new Error(
      'No se pudo extraer el término de búsqueda del HTML. Enviá searchTerm en el formulario.',
    );
    err.statusCode = 400;
    err.code = 'SEARCH_TERM_REQUIRED';
    err.parserFoundNoAdMarkers = parsed.parserFoundNoAdMarkers;
    throw err;
  }

  const date = todayUruguay();

  const storagePath = await archiveHtmlToStorage(buffer, opts.contentType);
  const searchTermSource = parsed.searchTermFromHtml ? 'html' : 'form';
  const searchTermNormalized = normalizeSearchTerm(searchTerm);

  // Fail loudly: no paid ads AND no organic web results.
  if (parsed.parserFoundNoResults) {
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
      throw new Error(`Failed to insert google_serp_captures: ${captureError.message}`);
    }

    logger.warn('SERP import: parser found no results', {
      searchTerm,
      storagePath,
      captureId: capture.id,
      fileHash,
      bytes: buffer.length,
    });

    return {
      ok: false,
      duplicate: false,
      parserFoundNoAdMarkers: true,
      parserFoundNoResults: true,
      message:
        'parser found no results — el HTML no contiene anuncios de pago ni resultados orgánicos reconocibles. ¿Es un SERP de Google guardado con "Página web completa"?',
      searchTerm,
      searchTermSource,
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
      ads_found: parsed.ads.length,
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
    throw new Error(`Failed to insert google_serp_captures: ${captureError.message}`);
  }

  const entities = await loadMonitoredEntities();
  const allParsed = [...parsed.ads, ...parsed.organic];
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
    placement: item.placement || (item.result_type === 'organic' ? 'organic' : 'unknown'),
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
    throw new Error(`Failed to insert google_serp_ads_manual rows: ${insertError.message}`);
  }

  const summary = buildAdvertiserSummary(allParsed, entities);
  const unmatchedDomains = collectUnmatchedDomains(allParsed, entities);
  const queuedUnmatchedDomains = await queueUnmatchedDomainsForReview(unmatchedDomains);
  const { ads: insertedAds, organicResults: insertedOrganic } = splitInsertedRows(inserted);

  logger.info('SERP import completed', {
    searchTerm,
    storagePath,
    captureId: capture.id,
    fileHash,
    adsFound: parsed.ads.length,
    organicFound: parsed.organic.length,
    unmatchedCount: summary.unmatchedAdvertisers.length,
    queuedDomains: queuedUnmatchedDomains.queued,
  });

  return {
    ok: true,
    duplicate: false,
    parserFoundNoAdMarkers: false,
    parserFoundNoResults: false,
    message: buildSuccessImportMessage(parsed.ads.length, parsed.organic.length),
    searchTerm,
    searchTermSource,
    date,
    captureId: capture.id,
    rawHtmlStoragePath: storagePath,
    fileHash,
    parseStatus: 'success',
    adsFound: parsed.ads.length,
    organicFound: parsed.organic.length,
    resultsFound: parsed.ads.length + parsed.organic.length,
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

/**
 * List prior captures (one uploaded HTML = one capture).
 */
async function listGoogleSerpImports({ limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const { data, error } = await supabase
    .from('google_serp_captures')
    .select(
      'id, search_term, date, storage_path, file_hash, parse_status, ads_found, imported_at',
    )
    .order('imported_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    throw new Error(`Failed to list google_serp_captures: ${error.message}`);
  }

  const imports = (data || []).map((c) => ({
    captureId: c.id,
    rawHtmlStoragePath: c.storage_path,
    searchTerm: c.search_term,
    date: c.date,
    importedAt: c.imported_at,
    adsCount: 0,
    organicCount: 0,
    parseStatus: c.parse_status,
    fileHash: c.file_hash,
    advertisers: [],
  }));

  const captureIds = imports.map((i) => i.captureId).filter(Boolean);
  if (captureIds.length) {
    const { data: resultRows, error: resErr } = await supabase
      .from('google_serp_ads_manual')
      .select('capture_id, result_type, advertiser_name, advertiser_domain')
      .in('capture_id', captureIds);
    if (!resErr && resultRows) {
      const byCapture = new Map();
      for (const row of resultRows) {
        if (!byCapture.has(row.capture_id)) {
          byCapture.set(row.capture_id, {
            adsCount: 0,
            organicCount: 0,
            advertisers: new Set(),
          });
        }
        const bucket = byCapture.get(row.capture_id);
        if (row.result_type === 'organic') bucket.organicCount += 1;
        else bucket.adsCount += 1;
        bucket.advertisers.add(row.advertiser_name || row.advertiser_domain || '—');
      }
      for (const item of imports) {
        const bucket = byCapture.get(item.captureId);
        if (!bucket) continue;
        item.adsCount = bucket.adsCount;
        item.organicCount = bucket.organicCount;
        item.advertisers = [...bucket.advertisers];
      }
    }
  }

  return { imports, total: imports.length };
}

async function getGoogleSerpImportAds({ path, captureId } = {}) {
  const id = captureId != null ? String(captureId).trim() : '';
  const storagePath = path != null ? String(path).trim() : '';

  if (!id && !storagePath) {
    const err = new Error('captureId or rawHtmlStoragePath (path) is required');
    err.statusCode = 400;
    throw err;
  }

  let query = supabase
    .from('google_serp_ads_manual')
    .select(
      'id, capture_id, search_term, date, result_type, advertiser_name, advertiser_domain, ad_title, ad_description, destination_url, position, placement, raw_html_storage_path, imported_at',
    )
    .order('result_type', { ascending: true })
    .order('position', { ascending: true });

  if (id) query = query.eq('capture_id', id);
  else query = query.eq('raw_html_storage_path', storagePath);

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to fetch SERP ads: ${error.message}`);
  }

  const entities = await loadMonitoredEntities();
  const ads = [];
  const organicResults = [];
  for (const row of data || []) {
    const matchedEntity = matchAdvertiserToEntities(
      {
        advertiser_domain: row.advertiser_domain,
        advertiser_name: row.advertiser_name,
      },
      entities,
    );
    const enriched = {
      ...row,
      matchedEntity,
      unmatched: !matchedEntity && Boolean(row.advertiser_domain || row.advertiser_name),
    };
    if (row.result_type === 'organic') organicResults.push(enriched);
    else ads.push(enriched);
  }

  return {
    captureId: ads[0]?.capture_id || organicResults[0]?.capture_id || id || null,
    rawHtmlStoragePath:
      ads[0]?.raw_html_storage_path ||
      organicResults[0]?.raw_html_storage_path ||
      storagePath ||
      null,
    searchTerm: ads[0]?.search_term || organicResults[0]?.search_term || null,
    date: ads[0]?.date || organicResults[0]?.date || null,
    importedAt: ads[0]?.imported_at || organicResults[0]?.imported_at || null,
    ads,
    organicResults,
    total: ads.length + organicResults.length,
  };
}

/**
 * Count-based competitor presence across real (parse_status=success) captures.
 * No percentages, rates, growth, or trends.
 */
async function getGoogleSerpCompetitorPresence() {
  const { data: captures, error: capErr } = await supabase
    .from('google_serp_captures')
    .select('id, date, parse_status')
    .in('parse_status', PRESENCE_INCLUDED_PARSE_STATUSES);
  if (capErr) {
    throw new Error(`Failed to load captures for presence: ${capErr.message}`);
  }

  const realCaptures = captures || [];
  const totalCaptures = realCaptures.length;
  const captureIds = realCaptures.map((c) => c.id);
  const dateByCapture = new Map(realCaptures.map((c) => [c.id, c.date]));

  const { data: entities, error: entErr } = await supabase
    .from('monitored_entities')
    .select('id, name, website_domain')
    .not('website_domain', 'is', null);
  if (entErr) {
    throw new Error(`Failed to load entities for presence: ${entErr.message}`);
  }

  const withDomain = (entities || []).filter((e) => {
    const d = normalizeDomain(e.website_domain);
    return Boolean(d);
  });

  /** @type {Map<string, { captureIds: Set<string>, adCaptureIds: Set<string>, organicCaptureIds: Set<string>, dates: string[] }>} */
  const appearanceByEntityId = new Map();
  for (const e of withDomain) {
    appearanceByEntityId.set(e.id, {
      captureIds: new Set(),
      adCaptureIds: new Set(),
      organicCaptureIds: new Set(),
      dates: [],
    });
  }

  if (captureIds.length && withDomain.length) {
    const { data: rows, error: rowErr } = await supabase
      .from('google_serp_ads_manual')
      .select('capture_id, advertiser_domain, result_type')
      .in('capture_id', captureIds);
    if (rowErr) {
      throw new Error(`Failed to load SERP rows for presence: ${rowErr.message}`);
    }

    const domainToEntities = new Map();
    for (const e of withDomain) {
      const d = normalizeDomain(e.website_domain);
      if (!domainToEntities.has(d)) domainToEntities.set(d, []);
      domainToEntities.get(d).push(e);
    }

    for (const row of rows || []) {
      const d = normalizeDomain(row.advertiser_domain);
      if (!d) continue;
      const matched = domainToEntities.get(d);
      if (!matched) continue;
      const resultType = String(row.result_type || '').toLowerCase();
      for (const e of matched) {
        const bucket = appearanceByEntityId.get(e.id);
        if (!bucket) continue;
        if (!bucket.captureIds.has(row.capture_id)) {
          bucket.captureIds.add(row.capture_id);
          const dt = dateByCapture.get(row.capture_id);
          if (dt) bucket.dates.push(dt);
        }
        if (resultType === 'ad') {
          bucket.adCaptureIds.add(row.capture_id);
        } else if (resultType === 'organic') {
          bucket.organicCaptureIds.add(row.capture_id);
        }
      }
    }
  }

  const entityRows = withDomain.map((e) => {
    const bucket = appearanceByEntityId.get(e.id);
    const appearedCaptureCount = bucket ? bucket.captureIds.size : 0;
    const appearedAdsCaptureCount = bucket ? bucket.adCaptureIds.size : 0;
    const appearedOrganicCaptureCount = bucket ? bucket.organicCaptureIds.size : 0;
    let mostRecentAppearanceDate = null;
    if (bucket && bucket.dates.length) {
      mostRecentAppearanceDate = bucket.dates.slice().sort().reverse()[0];
    }
    return {
      entityId: e.id,
      entityName: e.name,
      websiteDomain: normalizeDomain(e.website_domain),
      appearedCaptureCount,
      appearedAdsCaptureCount,
      appearedOrganicCaptureCount,
      totalCaptureCount: totalCaptures,
      mostRecentAppearanceDate,
    };
  });

  entityRows.sort((a, b) => {
    if (b.appearedCaptureCount !== a.appearedCaptureCount) {
      return b.appearedCaptureCount - a.appearedCaptureCount;
    }
    const aDate = a.mostRecentAppearanceDate || '';
    const bDate = b.mostRecentAppearanceDate || '';
    if (aDate !== bDate) {
      // DESC NULLS LAST: empty dates sort last
      if (!aDate) return 1;
      if (!bDate) return -1;
      return bDate.localeCompare(aDate);
    }
    return String(a.entityName || '').localeCompare(String(b.entityName || ''), 'es');
  });

  return {
    totalCaptures,
    includedParseStatuses: [...PRESENCE_INCLUDED_PARSE_STATUSES],
    excludedParseStatuses: [...PRESENCE_EXCLUDED_PARSE_STATUSES],
    entities: entityRows,
  };
}

module.exports = {
  STORAGE_BUCKET,
  MAX_FILE_BYTES,
  MALFORMED_DOMAIN,
  SERP_IMPORT_SOURCE_SEED,
  PRESENCE_INCLUDED_PARSE_STATUSES,
  PRESENCE_EXCLUDED_PARSE_STATUSES,
  sha256Hex,
  normalizeDomain,
  normalizeSearchTerm,
  resolvePlacement,
  parseGoogleSerpHtml,
  parseOrganicResults,
  matchAdvertiserToEntities,
  queueUnmatchedDomainsForReview,
  importGoogleSerpHtml,
  listGoogleSerpImports,
  getGoogleSerpImportAds,
  getGoogleSerpCompetitorPresence,
  ensureSerpHtmlBucket,
};
