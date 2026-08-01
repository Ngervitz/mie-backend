/**
 * Job: cz_sync
 * Cadence: once daily via cron-job.org → POST /jobs/run-cz-sync
 *
 * Depends on CZLeadSource interface only — never on PHP/MySQL details.
 */

const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { getCZLeadSource } = require('../services/cz-lead-source');
const {
  MAX_PAGES_PER_RUN,
  isNotConfiguredError,
} = require('../services/cz-lead-source/interface');

const JOB_NAME = 'cz_sync';
const JOB_LOCK_TTL_SECONDS = 15 * 60;

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
    .from('cz_sync_cursor')
    .select('*')
    .eq('source_name', sourceName)
    .maybeSingle();
  if (error) {
    throw new Error(`cz_sync_cursor read failed: ${error.message}`);
  }
  return data;
}

async function writeCursor(sourceName, patch) {
  const row = {
    source_name: sourceName,
    ...patch,
  };
  const { error } = await supabase
    .from('cz_sync_cursor')
    .upsert(row, { onConflict: 'source_name' });
  if (error) {
    throw new Error(`cz_sync_cursor write failed: ${error.message}`);
  }
}

/**
 * Upsert granted loans — skip items without cdv_operation_id.
 * Updates all mapped fields on conflict (not only synced_at).
 */
async function upsertGrantedLoans(items) {
  const now = new Date().toISOString();
  const rows = [];
  for (const item of items) {
    if (!item || item.cdv_operation_id == null) continue;
    const opId = String(item.cdv_operation_id).trim();
    if (!opId) continue;
    rows.push({
      cdv_operation_id: opId,
      loan_amount: item.loan_amount,
      granted_at: item.granted_at
        ? new Date(item.granted_at).toISOString()
        : now,
      cz_solicitud_id: Number(item.solicitudes_id),
      synced_at: now,
    });
  }
  if (!rows.length) return 0;

  const { error } = await supabase.from('cz_granted_loans').upsert(rows, {
    onConflict: 'cdv_operation_id',
  });
  if (error) {
    throw new Error(`cz_granted_loans upsert failed: ${error.message}`);
  }
  return rows.length;
}

async function upsertSolicitudes(items) {
  const now = new Date().toISOString();
  const rows = [];
  for (const item of items) {
    if (!item || item.id == null) continue;
    rows.push({
      cz_id: Number(item.id),
      solicitudes_estados_id:
        item.solicitudes_estados_id != null
          ? Number(item.solicitudes_estados_id)
          : null,
      usuarios_id: item.usuarios_id != null ? Number(item.usuarios_id) : null,
      fecha_reg: item.fechaReg ? new Date(item.fechaReg).toISOString() : null,
      lrw_id: item.lrw_id != null ? String(item.lrw_id) : null,
      tracking_data: item.tracking_data != null ? item.tracking_data : null,
      synced_at: now,
    });
  }
  if (!rows.length) return 0;

  const { error } = await supabase.from('cz_solicitudes_synced').upsert(rows, {
    onConflict: 'cz_id',
  });
  if (error) {
    throw new Error(`cz_solicitudes_synced upsert failed: ${error.message}`);
  }
  return rows.length;
}

/**
 * Sync one source with page loop + safety cap.
 * @returns {Promise<object>}
 */
async function syncSource({
  sourceName,
  fetchPage,
  upsertPage,
}) {
  const result = {
    sourceName,
    status: 'success',
    pages: 0,
    itemsUpserted: 0,
    hitPageLimit: false,
    lastSince: null,
    error: null,
    notConfigured: false,
  };

  try {
    const cursor = await readCursor(sourceName);
    let since = cursor && cursor.last_since ? String(cursor.last_since) : null;
    let hasMore = true;

    while (hasMore) {
      if (result.pages >= MAX_PAGES_PER_RUN) {
        result.hitPageLimit = true;
        logger.warn('cz_sync hit page safety limit — will continue next run', {
          sourceName,
          maxPages: MAX_PAGES_PER_RUN,
          lastSince: since,
        });
        break;
      }

      const page = await fetchPage({ since });
      result.pages += 1;

      const upserted = await upsertPage(page.items || []);
      result.itemsUpserted += upserted;

      if (page.nextSince) {
        since = String(page.nextSince);
        result.lastSince = since;
      }

      hasMore = Boolean(page.hasMore);
      if (!page.nextSince) {
        hasMore = false;
      }
    }

    await writeCursor(sourceName, {
      last_since: result.lastSince != null ? result.lastSince : since,
      last_synced_at: new Date().toISOString(),
      last_sync_status: 'success',
      last_sync_error: null,
    });
  } catch (err) {
    const message = err && err.message ? err.message : 'unknown';
    result.status = 'error';
    result.error = message;
    result.notConfigured = isNotConfiguredError(err);

    try {
      await writeCursor(sourceName, {
        last_synced_at: new Date().toISOString(),
        last_sync_status: 'error',
        last_sync_error: message.slice(0, 2000),
      });
    } catch (cursorErr) {
      logger.error('cz_sync failed to write error cursor', {
        sourceName,
        error: cursorErr && cursorErr.message ? cursorErr.message : 'unknown',
      });
    }
  }

  return result;
}

async function runCzSync() {
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
  };

  try {
    const source = getCZLeadSource();

    summary.grantedLoans = await syncSource({
      sourceName: 'granted_loans',
      fetchPage: (args) => source.fetchGrantedLoans(args),
      upsertPage: upsertGrantedLoans,
    });

    summary.solicitudes = await syncSource({
      sourceName: 'solicitudes',
      fetchPage: (args) => source.fetchSolicitudes(args),
      upsertPage: upsertSolicitudes,
    });

    // Job is ok unless both sources failed for non-config reasons —
    // notConfigured is expected until CZ_SOURCE_MODE + credentials are set.
    const gl = summary.grantedLoans;
    const sol = summary.solicitudes;
    logger.info('cz_sync completed', {
      grantedLoans: {
        status: gl.status,
        notConfigured: gl.notConfigured,
        pages: gl.pages,
        itemsUpserted: gl.itemsUpserted,
        hitPageLimit: gl.hitPageLimit,
        error: gl.error,
      },
      solicitudes: {
        status: sol.status,
        notConfigured: sol.notConfigured,
        pages: sol.pages,
        itemsUpserted: sol.itemsUpserted,
        hitPageLimit: sol.hitPageLimit,
        error: sol.error,
      },
    });

    return summary;
  } finally {
    await releaseJobLock(lockedBy);
  }
}

module.exports = {
  runCzSync,
  JOB_NAME,
  JOB_LOCK_TTL_SECONDS,
};
