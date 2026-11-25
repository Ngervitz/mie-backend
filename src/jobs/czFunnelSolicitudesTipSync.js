/**
 * Tip pass: recent /solicitudes → estado 8 enqueue (dual-pass with full cz_funnel_data_sync).
 * Manual: POST /jobs/run-cz-solicitudes-tip-sync
 */

const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { fetchAllCzPages, getCzApiBearerTokenDiagnostic } = require('../clients/czApiClient');
const {
  upsertSolicitudes,
  isCzApiAuthFailure,
  readCursor,
  writeCursor,
} = require('./czFunnelSync');

const JOB_NAME = 'cz_funnel_solicitudes_tip_sync';
const JOB_LOCK_TTL_SECONDS = 3 * 60;
const SOURCE_TIP = 'cz_funnel_solicitudes_tip';

const TIP_WINDOW_MS = 48 * 60 * 60 * 1000;
const TIP_OVERLAP_MS = 2 * 60 * 60 * 1000;
const TIP_MAX_PAGES_PER_RUN = 3;
const TIP_RESUME_MARKER = 'tip_sync_resume';

let fetchPagesFn = fetchAllCzPages;

function setFetchPagesForTests(fn) {
  fetchPagesFn = typeof fn === 'function' ? fn : fetchAllCzPages;
}

async function acquireJobLock(lockedBy) {
  const { data, error } = await supabase.rpc('acquire_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
    p_ttl_seconds: JOB_LOCK_TTL_SECONDS,
  });
  if (error) throw new Error(`acquire_job_lock failed: ${error.message}`);
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

/**
 * @param {object|null} cursor
 * @param {number} nowMs
 * @returns {{ sinceIso: string, resumed: boolean }}
 */
function resolveTipReadSince(cursor, nowMs) {
  const floorMs = nowMs - TIP_WINDOW_MS;
  const floorIso = new Date(floorMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const err = cursor && cursor.last_sync_error ? String(cursor.last_sync_error) : '';
  const lastSince = cursor && cursor.last_since ? String(cursor.last_since) : null;

  if (err.startsWith(TIP_RESUME_MARKER) && lastSince) {
    return { sinceIso: lastSince, resumed: true };
  }

  let overlapMs = floorMs;
  let longGapFromCursor = false;
  if (lastSince) {
    const lastMs = Date.parse(lastSince);
    if (Number.isFinite(lastMs)) {
      if (nowMs - lastMs > TIP_WINDOW_MS) {
        overlapMs = lastMs - TIP_OVERLAP_MS;
        longGapFromCursor = true;
      } else {
        overlapMs = Math.max(floorMs, lastMs - TIP_OVERLAP_MS);
      }
    }
  }
  const sinceIso = new Date(overlapMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { sinceIso, resumed: longGapFromCursor, longGapFromCursor: longGapFromCursor };
}

/**
 * @param {object} [deps]
 */
async function runCzFunnelSolicitudesTipSync(deps) {
  const d = deps || {};
  const nowMs = d.nowMs != null ? Number(d.nowMs) : Date.now();
  const lockedBy = d.lockedBy || randomUUID();

  const acquired =
    d.skipLock === true ? true : await acquireJobLock(lockedBy);
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
    sourceName: SOURCE_TIP,
    status: 'success',
    pagesFetched: 0,
    itemsFetched: 0,
    itemsUpserted: 0,
    parentSkippedStale: 0,
    initialSince: null,
    nextSince: null,
    hitPageLimit: false,
    passComplete: false,
    resumed: false,
    cdvEstado8Elm: null,
    error: null,
  };

  const estado8CandidateMap = new Map();
  async function upsertSolicitudesTrackEstado8(items) {
    const detected = require('../lib/cdvEstado8ElmAutomation').detectEstado8CandidatesFromItems(
      items,
    );
    for (const [czId, fechahora] of detected.entries()) {
      const prev = estado8CandidateMap.get(czId);
      if (!prev || Date.parse(fechahora) < Date.parse(prev)) {
        estado8CandidateMap.set(czId, fechahora);
      }
    }
    return upsertSolicitudes(items, { returnStats: true });
  }

  try {
    const cursor = await readCursor(SOURCE_TIP);
    const resolved = resolveTipReadSince(cursor, nowMs);
    summary.initialSince = resolved.sinceIso;
    summary.resumed = resolved.resumed;

    const pageBundle = await fetchPagesFn('/solicitudes', resolved.sinceIso, {
      maxPages: TIP_MAX_PAGES_PER_RUN,
    });

    summary.pagesFetched = pageBundle.pagesFetched;
    summary.itemsFetched = pageBundle.itemsFetched;
    summary.hitPageLimit = Boolean(pageBundle.hitPageLimit);
    summary.nextSince = pageBundle.nextSince || null;

    const upsertStats = await upsertSolicitudesTrackEstado8(pageBundle.items || []);
    summary.itemsUpserted =
      upsertStats && typeof upsertStats === 'object'
        ? upsertStats.parentUpserted || 0
        : Number(upsertStats) || 0;
    summary.parentSkippedStale =
      upsertStats && typeof upsertStats === 'object'
        ? upsertStats.parentSkippedStale || 0
        : 0;

    if (pageBundle.incomplete) {
      summary.passComplete = false;
      summary.error = `${TIP_RESUME_MARKER} — hit_page_limit; resume from last_since`;
      await writeCursor(SOURCE_TIP, {
        last_since: pageBundle.resumeSince || pageBundle.nextSince || resolved.sinceIso,
        last_synced_at: new Date(nowMs).toISOString(),
        last_sync_status: 'success',
        last_sync_error: summary.error,
      });
    } else {
      summary.passComplete = true;
      await writeCursor(SOURCE_TIP, {
        last_since: pageBundle.nextSince || resolved.sinceIso,
        last_synced_at: new Date(nowMs).toISOString(),
        last_sync_status: 'success',
        last_sync_error: null,
      });
    }

    try {
      summary.cdvEstado8Elm = await require('../lib/cdvEstado8ElmAutomation').enqueueCdvEstado8FromSync(
        estado8CandidateMap,
      );
    } catch (elmAutoErr) {
      const msg =
        elmAutoErr && elmAutoErr.message ? String(elmAutoErr.message) : 'unknown';
      logger.error('cdv_estado8_elm after tip sync failed', { error: msg.slice(0, 300) });
      summary.cdvEstado8Elm = { ok: false, error: msg.slice(0, 300) };
    }

    logger.info('cz_funnel_solicitudes_tip_sync completed', {
      pages: summary.pagesFetched,
      itemsFetched: summary.itemsFetched,
      itemsUpserted: summary.itemsUpserted,
      parentSkippedStale: summary.parentSkippedStale,
      passComplete: summary.passComplete,
      resumed: summary.resumed,
      enqueue: summary.cdvEstado8Elm && summary.cdvEstado8Elm.enqueue,
    });

    return summary;
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'unknown';
    summary.ok = false;
    summary.status = 'error';
    summary.error = message.slice(0, 2000);
    if (isCzApiAuthFailure(message)) {
      summary.tokenDiagnostic = getCzApiBearerTokenDiagnostic();
    }
    try {
      await writeCursor(SOURCE_TIP, {
        last_synced_at: new Date(nowMs).toISOString(),
        last_sync_status: 'error',
        last_sync_error: summary.error,
      });
    } catch (cursorErr) {
      logger.error('cz_funnel tip cursor error write failed', {
        error: cursorErr && cursorErr.message ? cursorErr.message : 'unknown',
      });
    }
    return summary;
  } finally {
    if (d.skipLock !== true) {
      await releaseJobLock(lockedBy);
    }
  }
}

module.exports = {
  runCzFunnelSolicitudesTipSync,
  JOB_NAME,
  JOB_LOCK_TTL_SECONDS,
  SOURCE_TIP,
  TIP_WINDOW_MS,
  TIP_OVERLAP_MS,
  TIP_MAX_PAGES_PER_RUN,
  TIP_RESUME_MARKER,
  resolveTipReadSince,
  setFetchPagesForTests,
};