'use strict';

/**
 * Temporary Janus → Google Sheet sync for CDV (estado 8).
 * Write-only. Fail-open. Never logs CDV_GOOGLE_SERVICE_ACCOUNT_JSON.
 */

const logger = require('./logger');

const CDV_ESTADO_ID = 8;
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TZ_MONTEVIDEO = 'America/Montevideo';
const IN_CHUNK = 200;
const HEADER_SOLICITUD_ID = 'CZ_SOLICITUD_ID';

let loggedMissingConfig = false;

function readCdvSheetConfig(env) {
  const source = env || process.env;
  const rawJson = String(source.CDV_GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  const spreadsheetId = String(source.CDV_GOOGLE_SHEET_ID || '').trim();
  const tab = String(source.CDV_GOOGLE_SHEET_TAB || '').trim();
  const missing = [];
  if (!rawJson) missing.push('CDV_GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!spreadsheetId) missing.push('CDV_GOOGLE_SHEET_ID');
  if (!tab) missing.push('CDV_GOOGLE_SHEET_TAB');
  if (missing.length) {
    return { enabled: false, missing: missing };
  }
  return {
    enabled: true,
    rawJson: rawJson,
    spreadsheetId: spreadsheetId,
    tab: tab,
  };
}

function parseServiceAccountJson(rawJson) {
  let credentials;
  try {
    credentials = JSON.parse(rawJson);
  } catch (_err) {
    throw new Error('CDV_GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (
    !credentials ||
    typeof credentials !== 'object' ||
    Array.isArray(credentials) ||
    !credentials.client_email ||
    !credentials.private_key
  ) {
    throw new Error(
      'CDV_GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email/private_key',
    );
  }
  credentials.private_key = String(credentials.private_key).replace(/\\n/g, '\n');
  return credentials;
}

function quoteSheetTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

function normalizeCzSolicitudId(raw) {
  if (raw == null || raw === '') return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && String(raw).trim() !== '') {
    return String(asNum);
  }
  const s = String(raw).trim();
  return s || null;
}

function formatFechaEnvioMontevideo(isoOrDate) {
  if (isoOrDate == null || isoOrDate === '') return '';
  const d =
    isoOrDate instanceof Date ? isoOrDate : new Date(String(isoOrDate));
  if (!Number.isFinite(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('es-UY', {
    timeZone: TZ_MONTEVIDEO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const pick = function (type) {
    const found = parts.find(function (p) {
      return p.type === type;
    });
    return found ? found.value : '';
  };
  return (
    pick('day') +
    '/' +
    pick('month') +
    '/' +
    pick('year') +
    ' ' +
    pick('hour') +
    ':' +
    pick('minute') +
    ':' +
    pick('second')
  );
}

function earlierTs(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return String(a) <= String(b) ? a : b;
}

function upsertCandidate(byId, candidate) {
  const id = normalizeCzSolicitudId(candidate && candidate.cz_solicitud_id);
  if (!id) return;
  const next = {
    cz_solicitud_id: id,
    ci: candidate.ci != null && candidate.ci !== '' ? candidate.ci : null,
    fechahora_src: candidate.fechahora_src || null,
  };
  const prev = byId.get(id);
  if (!prev) {
    byId.set(id, next);
    return;
  }
  byId.set(id, {
    cz_solicitud_id: id,
    ci: next.ci != null ? next.ci : prev.ci,
    fechahora_src: earlierTs(prev.fechahora_src, next.fechahora_src),
  });
}

function collectEstado8FromHistorico(historicoRows, ciByCzId) {
  const byId = new Map();
  const rows = Array.isArray(historicoRows) ? historicoRows : [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (Number(row.solicitudes_estados_id) !== CDV_ESTADO_ID) continue;
    const czId = normalizeCzSolicitudId(row.cz_solicitud_id);
    if (!czId) continue;
    const ciFromMap =
      ciByCzId && typeof ciByCzId.get === 'function'
        ? ciByCzId.get(czId) || ciByCzId.get(Number(czId))
        : null;
    upsertCandidate(byId, {
      cz_solicitud_id: czId,
      ci: row.ci != null ? row.ci : ciFromMap,
      fechahora_src: row.fechahora_src || null,
    });
  }
  return byId;
}

function ciMapFromSolicitudes(solicitudes) {
  const map = new Map();
  const rows = Array.isArray(solicitudes) ? solicitudes : [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const id = normalizeCzSolicitudId(row.cz_id != null ? row.cz_id : row.id);
    if (!id) continue;
    map.set(id, row.ci != null && row.ci !== '' ? row.ci : null);
  }
  return map;
}

function existingIdsFromColumnG(values) {
  const ids = new Set();
  const table = Array.isArray(values) ? values : [];
  for (let i = 0; i < table.length; i += 1) {
    const cell = Array.isArray(table[i]) ? table[i][0] : table[i];
    if (cell == null || cell === '') continue;
    const text = String(cell).trim();
    if (!text) continue;
    if (i === 0 && text.toUpperCase() === HEADER_SOLICITUD_ID) continue;
    const id = normalizeCzSolicitudId(text);
    if (id) ids.add(id);
  }
  return ids;
}

function buildSheetRow(candidate) {
  return [
    candidate.ci != null && candidate.ci !== '' ? String(candidate.ci) : '',
    formatFechaEnvioMontevideo(candidate.fechahora_src),
    '',
    '',
    '',
    '',
    String(candidate.cz_solicitud_id),
    '',
    '',
  ];
}

function defaultCreateSheetsClient(credentials) {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: [SHEETS_SCOPE],
  });
  return google.sheets({ version: 'v4', auth: auth });
}

async function loadPersistedEstado8(supabase) {
  if (!supabase || typeof supabase.from !== 'function') return [];
  const { data: estadoRows, error: estadoErr } = await supabase
    .from('cz_funnel_solicitud_estados')
    .select('cz_solicitud_id, fechahora_src')
    .eq('solicitudes_estados_id', CDV_ESTADO_ID);
  if (estadoErr) {
    throw new Error(
      'cz_funnel_solicitud_estados estado-8 lookup failed: ' +
        String(estadoErr.message || estadoErr),
    );
  }
  const list = Array.isArray(estadoRows) ? estadoRows : [];
  const ids = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const id = normalizeCzSolicitudId(list[i] && list[i].cz_solicitud_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(Number(id));
  }
  const ciById = new Map();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data: sols, error: solErr } = await supabase
      .from('cz_funnel_solicitudes')
      .select('cz_id, ci')
      .in('cz_id', chunk);
    if (solErr) {
      throw new Error(
        'cz_funnel_solicitudes CI lookup failed: ' +
          String(solErr.message || solErr),
      );
    }
    (sols || []).forEach(function (row) {
      const id = normalizeCzSolicitudId(row && row.cz_id);
      if (!id) return;
      ciById.set(id, row.ci != null && row.ci !== '' ? row.ci : null);
    });
  }
  return list.map(function (row) {
    const id = normalizeCzSolicitudId(row && row.cz_solicitud_id);
    return {
      cz_solicitud_id: id,
      fechahora_src: row && row.fechahora_src ? row.fechahora_src : null,
      ci: id ? ciById.get(id) : null,
    };
  });
}

/**
 * Ensure one Sheet row per CZ_SOLICITUD_ID for estado 8.
 * May throw on Google / config parse errors (caller fail-opens).
 */
async function ensureCdvSheetRows(input, deps) {
  const env = (deps && deps.env) || process.env;
  const config = readCdvSheetConfig(env);
  if (!config.enabled) {
    if (!loggedMissingConfig) {
      loggedMissingConfig = true;
      logger.warn('CDV sheet sync disabled — missing configuration', {
        kind: 'cdv_sheet',
        missing: config.missing,
      });
    }
    return {
      status: 'disabled',
      missing: config.missing,
      inserted: 0,
      skipped: 0,
    };
  }

  const ciByCzId = ciMapFromSolicitudes(input && input.solicitudes);
  const byId = collectEstado8FromHistorico(
    input && input.historicoRows,
    ciByCzId,
  );

  if (input && input.supabase) {
    try {
      const persisted = await loadPersistedEstado8(input.supabase);
      for (let i = 0; i < persisted.length; i += 1) {
        upsertCandidate(byId, persisted[i]);
      }
    } catch (err) {
      logger.warn('CDV sheet reconcile from Janus failed', {
        kind: 'cdv_sheet',
        error: err && err.message ? String(err.message).slice(0, 300) : 'unknown',
      });
    }
  }

  const candidates = Array.from(byId.values());
  if (!candidates.length) {
    logger.info('CDV sheet sync: no estado 8 candidates', { kind: 'cdv_sheet' });
    return { status: 'ok', inserted: 0, skipped: 0, considered: 0 };
  }

  const credentials = parseServiceAccountJson(config.rawJson);
  const createClient =
    (deps && deps.createSheetsClient) || defaultCreateSheetsClient;
  const sheets = await createClient(credentials);
  const tabRange = quoteSheetTab(config.tab);

  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: tabRange + '!G:G',
  });
  const existing = existingIdsFromColumnG(
    got && got.data && got.data.values ? got.data.values : [],
  );

  const toInsert = [];
  let skipped = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (existing.has(candidate.cz_solicitud_id)) {
      skipped += 1;
      logger.info('CDV sheet sync skip — CZ_SOLICITUD_ID exists', {
        kind: 'cdv_sheet',
        cz_solicitud_id: candidate.cz_solicitud_id,
      });
      continue;
    }
    toInsert.push(buildSheetRow(candidate));
  }

  if (!toInsert.length) {
    return {
      status: 'ok',
      inserted: 0,
      skipped: skipped,
      considered: candidates.length,
    };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: tabRange + '!A:I',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: toInsert },
  });

  const insertedIds = toInsert.map(function (row) {
    return row[6];
  });
  logger.info('CDV sheet sync inserted', {
    kind: 'cdv_sheet',
    inserted: toInsert.length,
    skipped: skipped,
    cz_solicitud_ids: insertedIds,
  });

  return {
    status: 'ok',
    inserted: toInsert.length,
    skipped: skipped,
    considered: candidates.length,
    inserted_ids: insertedIds,
  };
}

/**
 * Fail-open entry used by the funnel sync. Never throws.
 */
async function syncCdvSheetAfterHistoricoPersist(input, deps) {
  try {
    return await ensureCdvSheetRows(input || {}, deps || {});
  } catch (err) {
    logger.error('CDV sheet sync failed', {
      kind: 'cdv_sheet',
      error: err && err.message ? String(err.message).slice(0, 300) : 'unknown',
    });
    return {
      status: 'error',
      inserted: 0,
      skipped: 0,
      error: err && err.message ? String(err.message).slice(0, 300) : 'unknown',
    };
  }
}

module.exports = {
  CDV_ESTADO_ID,
  SHEETS_SCOPE,
  readCdvSheetConfig,
  parseServiceAccountJson,
  quoteSheetTab,
  normalizeCzSolicitudId,
  formatFechaEnvioMontevideo,
  collectEstado8FromHistorico,
  ciMapFromSolicitudes,
  existingIdsFromColumnG,
  buildSheetRow,
  ensureCdvSheetRows,
  syncCdvSheetAfterHistoricoPersist,
};
