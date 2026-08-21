/**
 * Job: bcu_usd_rate_sync
 * Cadence: cron-job.org → POST /jobs/run-bcu-usd-rate-sync
 *
 * Fills bcu_usd_uyu_daily from BCU SOAP (2225 / TCV).
 * First run (empty table): backfill min(own_ad_metrics.metric_date) → ultimoCierre.
 * Daily: insert ultimoCierre if missing. Does not overwrite existing dates.
 *
 * Does not write own_ad_metrics. Funnel CZ conversion happens only in the view.
 */

const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  fetchUltimoCierre,
  fetchUsdQuotes,
} = require('../lib/bcuCotizaciones');

const JOB_NAME = 'bcu_usd_rate_sync';
const JOB_LOCK_TTL_SECONDS = 15 * 60;
const CHUNK_DAYS = 60;

function addUtcDays(ymd, days) {
  const parts = String(ymd).split('-');
  const dt = new Date(
    Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])),
  );
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function chunkRange(desde, hasta) {
  const chunks = [];
  let start = desde;
  while (start <= hasta) {
    let end = addUtcDays(start, CHUNK_DAYS - 1);
    if (end > hasta) end = hasta;
    chunks.push({ desde: start, hasta: end });
    start = addUtcDays(end, 1);
  }
  return chunks;
}

async function acquireJobLock(lockedBy) {
  const { data, error } = await supabase.rpc('acquire_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
    p_ttl_seconds: JOB_LOCK_TTL_SECONDS,
  });
  if (error) {
    throw new Error('acquire_job_lock failed: ' + error.message);
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
      lockedBy: lockedBy,
      error: error.message,
    });
  }
}

async function isTableEmpty() {
  const { count, error } = await supabase
    .from('bcu_usd_uyu_daily')
    .select('rate_date', { count: 'exact', head: true });
  if (error) {
    throw new Error('bcu_usd_uyu_daily count failed: ' + error.message);
  }
  return !count;
}

async function minOwnAdMetricDate() {
  const { data, error } = await supabase
    .from('own_ad_metrics')
    .select('metric_date')
    .order('metric_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error('own_ad_metrics min date failed: ' + error.message);
  }
  if (!data || !data.metric_date) return null;
  const d = String(data.metric_date);
  return d.length >= 10 ? d.slice(0, 10) : null;
}

async function hasRateDate(rateDate) {
  const { data, error } = await supabase
    .from('bcu_usd_uyu_daily')
    .select('rate_date')
    .eq('rate_date', rateDate)
    .maybeSingle();
  if (error) {
    throw new Error('bcu_usd_uyu_daily lookup failed: ' + error.message);
  }
  return Boolean(data);
}

async function insertQuotes(quotes) {
  const now = new Date().toISOString();
  const rows = [];
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i];
    if (!q || !(q.sell > 0) || !(q.buy > 0)) continue;
    rows.push({
      rate_date: q.date,
      buy: q.buy,
      sell: q.sell,
      fetched_at: now,
    });
  }
  if (!rows.length) return 0;
  const { error } = await supabase.from('bcu_usd_uyu_daily').upsert(rows, {
    onConflict: 'rate_date',
    ignoreDuplicates: true,
  });
  if (error) {
    throw new Error('bcu_usd_uyu_daily upsert failed: ' + error.message);
  }
  return rows.length;
}

async function backfillRange(desde, hasta) {
  const chunks = chunkRange(desde, hasta);
  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const quotes = await fetchUsdQuotes(chunks[i].desde, chunks[i].hasta);
    inserted += await insertQuotes(quotes);
  }
  return inserted;
}

async function runBcuUsdRateSync() {
  const lockedBy = 'bcu-usd-rate-sync-' + randomUUID();
  const acquired = await acquireJobLock(lockedBy);
  if (!acquired) {
    return { ok: false, reason: 'lock_not_acquired' };
  }

  try {
    const closeDate = await fetchUltimoCierre();
    let backfilled = 0;
    let backfillFrom = null;

    if (await isTableEmpty()) {
      backfillFrom = (await minOwnAdMetricDate()) || closeDate;
      backfilled = await backfillRange(backfillFrom, closeDate);
      if (backfilled === 0) {
        throw new Error(
          'BCU backfill returned 0 quotes for ' +
            backfillFrom +
            ' … ' +
            closeDate,
        );
      }
    }

    let daily = { rate_date: closeDate, skipped: true, inserted: 0 };
    if (!(await hasRateDate(closeDate))) {
      const quotes = await fetchUsdQuotes(closeDate, closeDate);
      const n = await insertQuotes(quotes);
      if (n === 0) {
        throw new Error('BCU had no sell quote for ultimoCierre ' + closeDate);
      }
      daily = { rate_date: closeDate, skipped: false, inserted: n };
    }

    logger.info('bcu_usd_rate_sync completed', {
      closeDate: closeDate,
      backfillFrom: backfillFrom,
      backfilled: backfilled,
      daily: daily,
    });

    return {
      ok: true,
      closeDate: closeDate,
      backfillFrom: backfillFrom,
      backfilled: backfilled,
      daily: daily,
    };
  } finally {
    await releaseJobLock(lockedBy);
  }
}

module.exports = {
  runBcuUsdRateSync,
  JOB_NAME,
};
