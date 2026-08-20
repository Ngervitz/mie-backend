/**
 * Job: cz_funnel_data_sync
 * Isolated from legacy czSync.js / run-cz-sync.
 * Manual: POST /jobs/run-cz-data-sync (session or X-Cron-Key).
 *
 * updated (granted loans) is an approximation — not exact GRANTED transition.
 */

const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  INITIAL_SINCE,
  fetchAllCzPages,
  getCzApiBearerTokenDiagnostic,
} = require('../clients/czApiClient');
const {
  sanitizeTrackingDataSummary,
} = require('../lib/sanitizeCzTrackingData');

function isCzApiAuthFailure(message) {
  const m = String(message || '');
  return (
    /unauthorized/i.test(m) ||
    /\b401\b/.test(m) ||
    /CZ_API_BEARER_TOKEN is not configured/i.test(m)
  );
}

const JOB_NAME = 'cz_funnel_data_sync';
const JOB_LOCK_TTL_SECONDS = 15 * 60;

const SOURCE_GRANTED = 'cz_funnel_granted_loans';
const SOURCE_SOLICITUDES = 'cz_funnel_solicitudes';
const SOURCE_ENCUESTAS = 'cz_funnel_encuestas';

async function acquireJobLock(lockedBy) {
  const { data, error } = await supabase.rpc('acquire_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
    p_ttl_seconds: JOB_LOCK_TTL_SECONDS,
  });
  if (error) {
    throw new Error(`acquire_job_lock failed: ${error.message}`);
  }
  return data === true;
}

async function releaseJobLock(lockedBy) {
  const { error } = await supabase.rpc('release_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
  });
  if (error) {
    logger.error('release_job_lock failed', {
      jobName: JOB_NAME,
      lockedBy,
      error: error.message,
    });
  }
}

async function readCursor(sourceName) {
  const { data, error } = await supabase
    .from('cz_funnel_sync_cursors')
    .select('*')
    .eq('source_name', sourceName)
    .maybeSingle();
  if (error) {
    throw new Error(`cz_funnel_sync_cursors read failed: ${error.message}`);
  }
  return data;
}

async function writeCursor(sourceName, patch) {
  const row = {
    source_name: sourceName,
    updated_at: new Date().toISOString(),
    ...patch,
  };
  const { error } = await supabase
    .from('cz_funnel_sync_cursors')
    .upsert(row, { onConflict: 'source_name' });
  if (error) {
    throw new Error(`cz_funnel_sync_cursors write failed: ${error.message}`);
  }
}

/**
 * Mark old-base sms_contacts (credizona2_datos / prestafacil) whose
 * source_record_id matches a CI from this solicitudes upsert.
 * Safe integers only; empty list is a no-op.
 */
async function excludeOldBaseContactsByCi(cis) {
  const unique = [];
  const seen = new Set();
  for (let i = 0; i < cis.length; i += 1) {
    const n = cis[i];
    if (!Number.isSafeInteger(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    unique.push(n);
  }
  if (!unique.length) return;
  const { error } = await supabase.rpc('sms_contacts_exclude_old_base_by_ci', {
    p_cis: unique,
  });
  if (error) {
    throw new Error(
      `sms_contacts_exclude_old_base_by_ci failed: ${error.message}`,
    );
  }
}

/**
 * Parse CZ datetime-ish strings to ISO or null.
 * @param {unknown} raw
 * @returns {string|null}
 */
function parseCzDateTime(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  // "2026-05-08 10:27:38" → treat as local-naive → append Z is wrong;
  // Date.parse often treats as local. Prefer replacing space with T and keep as-is UTC guess.
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function upsertGrantedLoans(items) {
  const now = new Date().toISOString();
  const rows = [];
  for (const item of items) {
    if (!item || item.id == null) continue;
    const czId = Number(item.id);
    if (!Number.isFinite(czId)) continue;
    const updatedRaw =
      item.updated != null ? String(item.updated) : null;
    rows.push({
      cz_id: czId,
      ci: item.ci != null && item.ci !== '' ? Number(item.ci) : null,
      monto_otorgado:
        item.monto_otorgado != null && item.monto_otorgado !== ''
          ? Number(item.monto_otorgado)
          : null,
      updated_at_src: parseCzDateTime(updatedRaw),
      updated_raw: updatedRaw,
      synced_at: now,
    });
  }
  if (!rows.length) return 0;
  const { error } = await supabase.from(SOURCE_GRANTED).upsert(rows, {
    onConflict: 'cz_id',
  });
  if (error) throw new Error(`${SOURCE_GRANTED} upsert failed: ${error.message}`);
  return rows.length;
}

async function upsertSolicitudes(items) {
  const now = new Date().toISOString();
  const rows = [];
  for (const item of items) {
    if (!item || item.id == null) continue;
    const czId = Number(item.id);
    if (!Number.isFinite(czId)) continue;
    const updatedRaw =
      item.updated != null ? String(item.updated) : null;
    const fechaRaw =
      item.fechaReg != null ? String(item.fechaReg) : null;
    rows.push({
      cz_id: czId,
      solicitudes_estados_id:
        item.solicitudes_estados_id != null
          ? Number(item.solicitudes_estados_id)
          : null,
      usuarios_id:
        item.usuarios_id != null ? Number(item.usuarios_id) : null,
      ci: item.ci != null && item.ci !== '' ? Number(item.ci) : null,
      fecha_reg: parseCzDateTime(fechaRaw),
      updated_at_src: parseCzDateTime(updatedRaw),
      updated_raw: updatedRaw,
      tracking_data_summary: sanitizeTrackingDataSummary(item.tracking_data),
      synced_at: now,
    });
  }
  if (!rows.length) return 0;
  const { error } = await supabase.from(SOURCE_SOLICITUDES).upsert(rows, {
    onConflict: 'cz_id',
  });
  if (error) {
    throw new Error(`${SOURCE_SOLICITUDES} upsert failed: ${error.message}`);
  }
  await excludeOldBaseContactsByCi(
    rows
      .map((r) => r.ci)
      .filter((ci) => ci != null),
  );
  return rows.length;
}

async function upsertEncuestas(items) {
  const now = new Date().toISOString();
  const rows = [];
  for (const item of items) {
    if (!item || item.id == null) continue;
    const czId = Number(item.id);
    if (!Number.isFinite(czId)) continue;
    rows.push({
      cz_id: czId,
      ci: item.ci != null && item.ci !== '' ? Number(item.ci) : null,
      email: item.email != null ? String(item.email) : null,
      score_v2:
        item.score_v2 != null && item.score_v2 !== ''
          ? Number(item.score_v2)
          : null,
      completed_at: parseCzDateTime(item.completed_at),
      synced_at: now,
    });
  }
  if (!rows.length) return 0;
  const { error } = await supabase.from(SOURCE_ENCUESTAS).upsert(rows, {
    onConflict: 'cz_id',
  });
  if (error) throw new Error(`${SOURCE_ENCUESTAS} upsert failed: ${error.message}`);
  return rows.length;
}

/**
 * Sync one funnel source. On failure: do not advance cursor; record error.
 */
async function syncSource({ sourceName, apiPath, upsertPage }) {
  const result = {
    status: 'success',
    pagesFetched: 0,
    itemsFetched: 0,
    itemsUpserted: 0,
    initialSince: null,
    nextSince: null,
    error: null,
    hitPageLimit: false,
  };

  try {
    const cursor = await readCursor(sourceName);
    const initialSince =
      cursor && cursor.last_since
        ? String(cursor.last_since)
        : INITIAL_SINCE;
    result.initialSince = initialSince;

    const pageBundle = await fetchAllCzPages(apiPath, initialSince);
    result.pagesFetched = pageBundle.pagesFetched;
    result.itemsFetched = pageBundle.itemsFetched;
    result.hitPageLimit = Boolean(pageBundle.hitPageLimit);

    const upserted = await upsertPage(pageBundle.items || []);
    result.itemsUpserted = upserted;

    if (pageBundle.incomplete) {
      // Partial run: do not advance cursor (will resume from same since).
      result.status = 'success';
      result.nextSince = initialSince;
      result.error =
        'hit_page_limit — cursor not advanced; re-run to continue';
      await writeCursor(sourceName, {
        last_synced_at: new Date().toISOString(),
        last_sync_status: 'success',
        last_sync_error: result.error,
      });
      return result;
    }

    const finalCursor = pageBundle.nextSince || initialSince;
    result.nextSince = finalCursor;

    await writeCursor(sourceName, {
      last_since: finalCursor,
      last_synced_at: new Date().toISOString(),
      last_sync_status: 'success',
      last_sync_error: null,
    });
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'unknown';
    result.status = 'error';
    result.error = message.slice(0, 2000);
    try {
      await writeCursor(sourceName, {
        last_synced_at: new Date().toISOString(),
        last_sync_status: 'error',
        last_sync_error: result.error,
      });
    } catch (cursorErr) {
      logger.error('cz_funnel cursor error write failed', {
        sourceName,
        error: cursorErr && cursorErr.message ? cursorErr.message : 'unknown',
      });
    }
  }

  return result;
}

async function runCzFunnelSync() {
  const lockedBy = randomUUID();
  const acquired = await acquireJobLock(lockedBy);

  if (!acquired) {
    return {
      ok: false,
      skipped: true,
      reason: 'lock_not_acquired',
      jobName: JOB_NAME,
    };
  }

  const summary = {
    ok: true,
    jobName: JOB_NAME,
    lockedBy,
    grantedLoans: null,
    solicitudes: null,
    encuestas: null,
  };

  try {
    summary.grantedLoans = await syncSource({
      sourceName: SOURCE_GRANTED,
      apiPath: '/cdv_granted_loans',
      upsertPage: upsertGrantedLoans,
    });
    summary.solicitudes = await syncSource({
      sourceName: SOURCE_SOLICITUDES,
      apiPath: '/solicitudes',
      upsertPage: upsertSolicitudes,
    });
    summary.encuestas = await syncSource({
      sourceName: SOURCE_ENCUESTAS,
      apiPath: '/encuestas',
      upsertPage: upsertEncuestas,
    });

    const sources = [summary.grantedLoans, summary.solicitudes, summary.encuestas];
    const anyHardError = sources.some((r) => r && r.status === 'error');
    summary.ok = !anyHardError;

    const authFailures = sources.filter(
      (r) => r && r.status === 'error' && isCzApiAuthFailure(r.error),
    );
    if (authFailures.length) {
      // TEMP: surface safe env shape until Railway token mismatch is resolved
      summary.tokenDiagnostic = getCzApiBearerTokenDiagnostic();
      logger.error('cz_funnel_data_sync auth failure token diagnostic', {
        tokenDiagnostic: summary.tokenDiagnostic,
        failedSources: authFailures.map((r) => ({
          error: r.error ? String(r.error).slice(0, 200) : null,
        })),
      });
    }

    logger.info('cz_funnel_data_sync completed', {
      grantedLoans: {
        status: summary.grantedLoans.status,
        pages: summary.grantedLoans.pagesFetched,
        itemsFetched: summary.grantedLoans.itemsFetched,
        itemsUpserted: summary.grantedLoans.itemsUpserted,
        error: summary.grantedLoans.error,
      },
      solicitudes: {
        status: summary.solicitudes.status,
        pages: summary.solicitudes.pagesFetched,
        itemsFetched: summary.solicitudes.itemsFetched,
        itemsUpserted: summary.solicitudes.itemsUpserted,
        error: summary.solicitudes.error,
      },
      encuestas: {
        status: summary.encuestas.status,
        pages: summary.encuestas.pagesFetched,
        itemsFetched: summary.encuestas.itemsFetched,
        itemsUpserted: summary.encuestas.itemsUpserted,
        error: summary.encuestas.error,
      },
      hasTokenDiagnostic: Boolean(summary.tokenDiagnostic),
    });

    return summary;
  } finally {
    await releaseJobLock(lockedBy);
  }
}

module.exports = {
  runCzFunnelSync,
  JOB_NAME,
  JOB_LOCK_TTL_SECONDS,
  SOURCE_GRANTED,
  SOURCE_SOLICITUDES,
  SOURCE_ENCUESTAS,
  sanitizeTrackingDataSummary,
  isCzApiAuthFailure,
};
