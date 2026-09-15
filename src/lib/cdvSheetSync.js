'use strict';

/**
 * Temporary Janus → Google Sheet sync for CDV (estado 8).
 * Write-only. Fail-open. Never logs CDV_GOOGLE_SERVICE_ACCOUNT_JSON.
 *
 * Sheet columns (A:K):
 * A BASE | B DOCUMENTO | C CELULAR | D FECHA ENVÍO | E ESTADO |
 * F MONTO OTORGADO | G FECHA RESPUESTA | H OBSERVACIÓN |
 * I CZ_SOLICITUD_ID | J PROCESADO_ESTADO | K FECHA_PROCESADO
 *
 * New rows are written with values.update on A{row}:K{row}.
 * Do not append an open range: Sheets can pick the contiguous block and shift the payload.
 */

const logger = require('./logger');

const CDV_ESTADO_ID = 8;
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TZ_MONTEVIDEO = 'America/Montevideo';
const IN_CHUNK = 200;
const HEADER_SOLICITUD_ID = 'CZ_SOLICITUD_ID';
const HEADER_BASE = 'BASE';
const SHEET_VALUE_RANGE = 'A:K';
const SHEET_ROW_WIDTH = 11;
/** 0-based sheet columns. Idempotency is column I only. */
const COL_BASE = 0;
const COL_CELULAR = 2;
const COL_FECHA_ENVIO = 3;
const COL_ESTADO = 4;
const COL_CZ_SOLICITUD_ID = 8;
/** 1-based template row for ESTADO dropdown (dataValidation only). */
const ESTADO_VALIDATION_TEMPLATE_ROW = 2;

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

function normalizeJtToken(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function normalizeSourceSystem(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  return s;
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
    jt: candidate.jt != null ? candidate.jt : null,
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
    jt: prev.jt || next.jt || null,
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
    const fromMap =
      ciByCzId && typeof ciByCzId.get === 'function'
        ? ciByCzId.get(czId) || ciByCzId.get(Number(czId))
        : null;
    const ciFromMap =
      fromMap && typeof fromMap === 'object' ? fromMap.ci : fromMap;
    const jtFromMap =
      fromMap && typeof fromMap === 'object' ? fromMap.jt : null;
    upsertCandidate(byId, {
      cz_solicitud_id: czId,
      ci: row.ci != null ? row.ci : ciFromMap,
      fechahora_src: row.fechahora_src || null,
      jt: row.jt != null ? row.jt : jtFromMap,
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
    const summary =
      row.tracking_data_summary &&
      typeof row.tracking_data_summary === 'object' &&
      !Array.isArray(row.tracking_data_summary)
        ? row.tracking_data_summary
        : null;
    map.set(id, {
      ci: row.ci != null && row.ci !== '' ? row.ci : null,
      jt: summary ? normalizeJtToken(summary.jt) : null,
    });
  }
  return map;
}

function sheetSolicitudHeaderMatches(values) {
  const table = Array.isArray(values) ? values : [];
  const header = Array.isArray(table[0]) ? table[0] : [];
  const cell = header[COL_CZ_SOLICITUD_ID];
  return String(cell == null ? '' : cell).trim() === HEADER_SOLICITUD_ID;
}

/**
 * Next 1-based row after the last row returned for A:K.
 * Does not scan for a hole and does not let Sheets choose a start column.
 */
function nextFreeSheetRowNumber(values) {
  const table = Array.isArray(values) ? values : [];
  return table.length + 1;
}

/**
 * Parse sheet values A:K. Idempotency key is column I only.
 * Returns Map cz_solicitud_id → { rowNumber (1-based), base }.
 */
function indexExistingSheetRows(values) {
  const byId = new Map();
  const table = Array.isArray(values) ? values : [];
  for (let i = 0; i < table.length; i += 1) {
    const row = Array.isArray(table[i]) ? table[i] : [];
    const idCell = row[COL_CZ_SOLICITUD_ID];
    if (idCell == null || idCell === '') continue;
    const text = String(idCell).trim();
    if (!text) continue;
    if (i === 0 && text.toUpperCase() === HEADER_SOLICITUD_ID) continue;
    const id = normalizeCzSolicitudId(text);
    if (!id) continue;
    const baseRaw = row[COL_BASE];
    const baseText =
      baseRaw == null || baseRaw === ''
        ? ''
        : String(baseRaw).trim();
    // Skip header-looking BASE label only when id column was header (already skipped).
    if (i === 0 && baseText.toUpperCase() === HEADER_BASE && !id) continue;
    byId.set(id, {
      rowNumber: i + 1,
      base: baseText,
    });
  }
  return byId;
}

/**
 * Single-column lists are treated as column I (CZ_SOLICITUD_ID), not H.
 * Wider rows are indexed as-is. Name kept for existing unit imports.
 */
function existingIdsFromColumnH(values) {
  const indexed = indexExistingSheetRows(
    (Array.isArray(values) ? values : []).map(function (cell) {
      if (Array.isArray(cell)) {
        if (cell.length === 1) {
          const padded = new Array(SHEET_ROW_WIDTH).fill('');
          padded[COL_CZ_SOLICITUD_ID] = cell[0];
          return padded;
        }
        return cell;
      }
      const padded = new Array(SHEET_ROW_WIDTH).fill('');
      padded[COL_CZ_SOLICITUD_ID] = cell;
      return padded;
    }),
  );
  return new Set(indexed.keys());
}

function existingIdsFromColumnG(values) {
  return existingIdsFromColumnH(values);
}

function buildSheetRow(candidate) {
  const base = normalizeSourceSystem(candidate && candidate.base);
  const row = new Array(SHEET_ROW_WIDTH).fill('');
  row[COL_BASE] = base;
  row[1] =
    candidate.ci != null && candidate.ci !== '' ? String(candidate.ci) : '';
  row[COL_CELULAR] = '';
  row[COL_FECHA_ENVIO] = formatFechaEnvioMontevideo(candidate.fechahora_src);
  row[COL_CZ_SOLICITUD_ID] = String(candidate.cz_solicitud_id);
  return row;
}

/**
 * Resolve BASE for the touch that generated each solicitud.
 * Prefer sms_messages.source_system for the jt's marketing_impact;
 * else sms_contacts.source_system via impact.contact_id.
 * No jt → empty. Never infer by CI alone.
 */
async function resolveBasesForCandidates(supabase, candidates, deps) {
  const out = new Map();
  const list = Array.isArray(candidates) ? candidates : [];
  list.forEach(function (c) {
    if (c && c.cz_solicitud_id) out.set(String(c.cz_solicitud_id), '');
  });
  if (!supabase || typeof supabase.from !== 'function' || !list.length) {
    return out;
  }

  const ids = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const id = normalizeCzSolicitudId(list[i] && list[i].cz_solicitud_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(Number(id));
  }

  const jtByCzId = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    const id = normalizeCzSolicitudId(c && c.cz_solicitud_id);
    if (!id) continue;
    const jt = normalizeJtToken(c && c.jt);
    if (jt) jtByCzId.set(id, jt);
  }

  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data: sols, error } = await supabase
      .from('cz_funnel_solicitudes')
      .select('cz_id, tracking_data_summary')
      .in('cz_id', chunk);
    if (error) {
      throw new Error(
        'cz_funnel_solicitudes jt lookup failed: ' +
          String(error.message || error),
      );
    }
    (sols || []).forEach(function (row) {
      const id = normalizeCzSolicitudId(row && row.cz_id);
      if (!id || jtByCzId.has(id)) return;
      const summary =
        row.tracking_data_summary &&
        typeof row.tracking_data_summary === 'object' &&
        !Array.isArray(row.tracking_data_summary)
          ? row.tracking_data_summary
          : null;
      const jt = summary ? normalizeJtToken(summary.jt) : null;
      if (jt) jtByCzId.set(id, jt);
    });
  }

  const jts = [];
  const jtSeen = new Set();
  jtByCzId.forEach(function (jt) {
    if (!jt || jtSeen.has(jt)) return;
    jtSeen.add(jt);
    jts.push(jt);
  });
  if (!jts.length) return out;

  const impactByJt = new Map();
  for (let i = 0; i < jts.length; i += IN_CHUNK) {
    const chunk = jts.slice(i, i + IN_CHUNK);
    const { data: impacts, error } = await supabase
      .from('marketing_impacts')
      .select('id, tracking_token, contact_id')
      .in('tracking_token', chunk);
    if (error) {
      throw new Error(
        'marketing_impacts lookup failed: ' + String(error.message || error),
      );
    }
    (impacts || []).forEach(function (imp) {
      const token = normalizeJtToken(imp && imp.tracking_token);
      if (!token || !imp.id) return;
      impactByJt.set(token, imp);
    });
  }

  const impactIds = [];
  const impactIdSeen = new Set();
  impactByJt.forEach(function (imp) {
    const id = String(imp.id);
    if (impactIdSeen.has(id)) return;
    impactIdSeen.add(id);
    impactIds.push(id);
  });

  const msgSourceByImpactId = new Map();
  for (let i = 0; i < impactIds.length; i += IN_CHUNK) {
    const chunk = impactIds.slice(i, i + IN_CHUNK);
    const { data: msgs, error } = await supabase
      .from('sms_messages')
      .select('marketing_impact_id, source_system')
      .in('marketing_impact_id', chunk);
    if (error) {
      throw new Error(
        'sms_messages lookup failed: ' + String(error.message || error),
      );
    }
    (msgs || []).forEach(function (m) {
      if (!m || m.marketing_impact_id == null) return;
      const src = normalizeSourceSystem(m.source_system);
      if (!src) return;
      const key = String(m.marketing_impact_id);
      if (!msgSourceByImpactId.has(key)) msgSourceByImpactId.set(key, src);
    });
  }

  const contactIds = [];
  const contactSeen = new Set();
  impactByJt.forEach(function (imp) {
    if (!imp.contact_id) return;
    const key = String(imp.contact_id);
    if (contactSeen.has(key)) return;
    // Only need contact if message snapshot missing for this impact.
    if (msgSourceByImpactId.has(String(imp.id))) return;
    contactSeen.add(key);
    contactIds.push(imp.contact_id);
  });

  const contactSourceById = new Map();
  for (let i = 0; i < contactIds.length; i += IN_CHUNK) {
    const chunk = contactIds.slice(i, i + IN_CHUNK);
    const { data: contacts, error } = await supabase
      .from('sms_contacts')
      .select('id, source_system')
      .in('id', chunk);
    if (error) {
      throw new Error(
        'sms_contacts lookup failed: ' + String(error.message || error),
      );
    }
    (contacts || []).forEach(function (c) {
      if (!c || c.id == null) return;
      const src = normalizeSourceSystem(c.source_system);
      if (!src) return;
      contactSourceById.set(String(c.id), src);
    });
  }

  jtByCzId.forEach(function (jt, czId) {
    const imp = impactByJt.get(jt);
    if (!imp) return;
    const fromMsg = msgSourceByImpactId.get(String(imp.id));
    if (fromMsg) {
      out.set(czId, fromMsg);
      return;
    }
    if (imp.contact_id) {
      const fromContact = contactSourceById.get(String(imp.contact_id));
      if (fromContact) out.set(czId, fromContact);
    }
  });

  if (deps && typeof deps.afterResolveBases === 'function') {
    deps.afterResolveBases(out);
  }
  return out;
}

function defaultCreateSheetsClient(credentials) {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: [SHEETS_SCOPE],
  });
  return google.sheets({ version: 'v4', auth: auth });
}

/**
 * Resolve numeric sheetId for a tab title (needed by copyPaste).
 */
async function resolveSheetIdByTitle(sheets, spreadsheetId, tab) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  const list =
    meta && meta.data && Array.isArray(meta.data.sheets) ? meta.data.sheets : [];
  const want = String(tab || '');
  for (let i = 0; i < list.length; i += 1) {
    const props = list[i] && list[i].properties ? list[i].properties : null;
    if (!props) continue;
    if (String(props.title || '') === want) {
      const id = props.sheetId;
      if (id == null || !Number.isFinite(Number(id))) {
        throw new Error('CDV sheet tab has no sheetId: ' + want);
      }
      return Number(id);
    }
  }
  throw new Error('CDV sheet tab not found: ' + want);
}

/**
 * Copy only dataValidation from E{template} → E{targetRow}.
 * Does not copy values or general formatting (PASTE_DATA_VALIDATION).
 */
async function copyEstadoDataValidation(
  sheets,
  spreadsheetId,
  sheetId,
  targetRow,
) {
  const templateRow = ESTADO_VALIDATION_TEMPLATE_ROW;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [
        {
          copyPaste: {
            source: {
              sheetId: sheetId,
              startRowIndex: templateRow - 1,
              endRowIndex: templateRow,
              startColumnIndex: COL_ESTADO,
              endColumnIndex: COL_ESTADO + 1,
            },
            destination: {
              sheetId: sheetId,
              startRowIndex: targetRow - 1,
              endRowIndex: targetRow,
              startColumnIndex: COL_ESTADO,
              endColumnIndex: COL_ESTADO + 1,
            },
            pasteType: 'PASTE_DATA_VALIDATION',
          },
        },
      ],
    },
  });
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
  const metaById = new Map();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data: sols, error: solErr } = await supabase
      .from('cz_funnel_solicitudes')
      .select('cz_id, ci, tracking_data_summary')
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
      const summary =
        row.tracking_data_summary &&
        typeof row.tracking_data_summary === 'object' &&
        !Array.isArray(row.tracking_data_summary)
          ? row.tracking_data_summary
          : null;
      metaById.set(id, {
        ci: row.ci != null && row.ci !== '' ? row.ci : null,
        jt: summary ? normalizeJtToken(summary.jt) : null,
      });
    });
  }
  return list.map(function (row) {
    const id = normalizeCzSolicitudId(row && row.cz_solicitud_id);
    const meta = id ? metaById.get(id) : null;
    return {
      cz_solicitud_id: id,
      fechahora_src: row && row.fechahora_src ? row.fechahora_src : null,
      ci: meta ? meta.ci : null,
      jt: meta ? meta.jt : null,
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
      base_updated: 0,
    };
  }

  const metaByCzId = ciMapFromSolicitudes(input && input.solicitudes);
  const byId = collectEstado8FromHistorico(
    input && input.historicoRows,
    metaByCzId,
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
    return {
      status: 'ok',
      inserted: 0,
      skipped: 0,
      base_updated: 0,
      considered: 0,
    };
  }

  let baseByCzId = new Map();
  try {
    const resolveFn =
      (deps && deps.resolveBasesForCandidates) || resolveBasesForCandidates;
    baseByCzId = await resolveFn(
      input && input.supabase ? input.supabase : null,
      candidates,
      deps || {},
    );
  } catch (err) {
    logger.warn('CDV sheet BASE resolve failed', {
      kind: 'cdv_sheet',
      error: err && err.message ? String(err.message).slice(0, 300) : 'unknown',
    });
  }
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    c.base = baseByCzId.get(String(c.cz_solicitud_id)) || '';
  }

  const credentials = parseServiceAccountJson(config.rawJson);
  const createClient =
    (deps && deps.createSheetsClient) || defaultCreateSheetsClient;
  const sheets = await createClient(credentials);
  const tabRange = quoteSheetTab(config.tab);

  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: tabRange + '!' + SHEET_VALUE_RANGE,
  });
  const sheetValues =
    got && got.data && got.data.values ? got.data.values : [];
  if (!sheetSolicitudHeaderMatches(sheetValues)) {
    const headerRow = Array.isArray(sheetValues[0]) ? sheetValues[0] : [];
    const actual = headerRow[COL_CZ_SOLICITUD_ID];
    logger.error(
      'CDV sheet sync aborted — I1 is not CZ_SOLICITUD_ID; no rows written',
      {
        kind: 'cdv_sheet',
        expected: HEADER_SOLICITUD_ID,
        actual: actual == null ? '' : String(actual).slice(0, 80),
      },
    );
    return {
      status: 'header_mismatch',
      inserted: 0,
      skipped: 0,
      base_updated: 0,
      considered: candidates.length,
    };
  }
  const existingById = indexExistingSheetRows(sheetValues);

  const toInsert = [];
  const baseUpdates = [];
  let skipped = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const existing = existingById.get(candidate.cz_solicitud_id);
    if (!existing) {
      toInsert.push(buildSheetRow(candidate));
      continue;
    }
    const resolvedBase = normalizeSourceSystem(candidate.base);
    if (!existing.base && resolvedBase) {
      baseUpdates.push({
        rowNumber: existing.rowNumber,
        base: resolvedBase,
        cz_solicitud_id: candidate.cz_solicitud_id,
      });
      continue;
    }
    skipped += 1;
    logger.info('CDV sheet sync skip — CZ_SOLICITUD_ID exists', {
      kind: 'cdv_sheet',
      cz_solicitud_id: candidate.cz_solicitud_id,
      base_present: Boolean(existing.base),
    });
  }

  if (baseUpdates.length) {
    const data = baseUpdates.map(function (u) {
      return {
        range: tabRange + '!A' + u.rowNumber,
        values: [[u.base]],
      };
    });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: data,
      },
    });
    logger.info('CDV sheet sync BASE backfill', {
      kind: 'cdv_sheet',
      updated: baseUpdates.length,
      cz_solicitud_ids: baseUpdates.map(function (u) {
        return u.cz_solicitud_id;
      }),
    });
  }

  if (toInsert.length) {
    let nextRow = nextFreeSheetRowNumber(sheetValues);
    const insertedIds = [];
    let sheetIdForValidation = null;
    let sheetIdLookupFailed = false;
    for (let i = 0; i < toInsert.length; i += 1) {
      const rowNumber = nextRow;
      nextRow += 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: tabRange + '!A' + rowNumber + ':K' + rowNumber,
        valueInputOption: 'RAW',
        requestBody: { values: [toInsert[i]] },
      });
      insertedIds.push(toInsert[i][COL_CZ_SOLICITUD_ID]);

      // Fail-open: row already has CZ_SOLICITUD_ID in I — do not rethrow.
      try {
        if (sheetIdLookupFailed) {
          // already logged; skip remaining validation copies this run
        } else {
          if (sheetIdForValidation == null) {
            sheetIdForValidation = await resolveSheetIdByTitle(
              sheets,
              config.spreadsheetId,
              config.tab,
            );
          }
          await copyEstadoDataValidation(
            sheets,
            config.spreadsheetId,
            sheetIdForValidation,
            rowNumber,
          );
        }
      } catch (err) {
        if (sheetIdForValidation == null) sheetIdLookupFailed = true;
        logger.warn('CDV sheet sync ESTADO dataValidation copy failed', {
          kind: 'cdv_sheet',
          row: rowNumber,
          cz_solicitud_id: toInsert[i][COL_CZ_SOLICITUD_ID],
          error:
            err && err.message ? String(err.message).slice(0, 300) : 'unknown',
        });
      }
    }
    logger.info('CDV sheet sync inserted', {
      kind: 'cdv_sheet',
      inserted: toInsert.length,
      skipped: skipped,
      cz_solicitud_ids: insertedIds,
    });
  }

  return {
    status: 'ok',
    inserted: toInsert.length,
    skipped: skipped,
    base_updated: baseUpdates.length,
    considered: candidates.length,
    inserted_ids: toInsert.map(function (row) {
      return row[COL_CZ_SOLICITUD_ID];
    }),
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
      base_updated: 0,
      error: err && err.message ? String(err.message).slice(0, 300) : 'unknown',
    };
  }
}

module.exports = {
  CDV_ESTADO_ID,
  SHEETS_SCOPE,
  COL_BASE,
  COL_CELULAR,
  COL_FECHA_ENVIO,
  COL_ESTADO,
  COL_CZ_SOLICITUD_ID,
  ESTADO_VALIDATION_TEMPLATE_ROW,
  SHEET_VALUE_RANGE,
  SHEET_ROW_WIDTH,
  sheetSolicitudHeaderMatches,
  nextFreeSheetRowNumber,
  readCdvSheetConfig,
  parseServiceAccountJson,
  quoteSheetTab,
  normalizeCzSolicitudId,
  formatFechaEnvioMontevideo,
  collectEstado8FromHistorico,
  ciMapFromSolicitudes,
  indexExistingSheetRows,
  existingIdsFromColumnH,
  existingIdsFromColumnG,
  buildSheetRow,
  resolveBasesForCandidates,
  resolveSheetIdByTitle,
  copyEstadoDataValidation,
  ensureCdvSheetRows,
  syncCdvSheetAfterHistoricoPersist,
};
