'use strict';

/**
 * Manual backfill: Meta ad-level insights into own_ad_ad_metrics (max ~30 days).
 *
 * Usage (local / staging only — NOT for production without authorization):
 *   node scripts/backfill-own-ad-ad-metrics.js [--days=30] [--chunk=2] [--pause-ms=3000]
 *
 * Requires META_MARKETING_API_TOKEN, META_AD_ACCOUNT_ID, Supabase service role (via env).
 * Does not write own_ad_metrics (campaign). Sleeps between API windows for rate limits.
 */

const { randomUUID } = require('crypto');
const env = require('../src/config/env');
const {
  calendarDateInZone,
  fetchAllAdRows,
  mapRowToAdMetric,
  upsertAdMetrics,
  resolveSelfEntityId,
  insertRun,
  finishRun,
  ACCOUNT_TIME_ZONE,
} = require('../src/steps/collectOwnMetrics');
const { shiftDateUtc } = require('../src/activity/dates');

function parseArgs(argv) {
  const out = { days: 30, chunk: 2, pauseMs: 3000 };
  argv.forEach(function (arg) {
    if (arg.startsWith('--days=')) out.days = parseInt(arg.slice(7), 10) || 30;
    if (arg.startsWith('--chunk=')) out.chunk = parseInt(arg.slice(8), 10) || 2;
    if (arg.startsWith('--pause-ms=')) out.pauseMs = parseInt(arg.slice(11), 10) || 3000;
  });
  return out;
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function inclusiveRanges(from, to, chunkDays) {
  const ranges = [];
  let cur = from;
  while (cur <= to) {
    const end = shiftDateUtc(cur, chunkDays - 1);
    const until = end > to ? to : end;
    ranges.push({ since: cur, until: until });
    cur = shiftDateUtc(until, 1);
  }
  return ranges;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const accessToken = env.metaMarketingApiToken;
  const adAccountId = env.metaAdAccountId;
  const apiVersion = env.metaMarketingApiVersion || 'v25.0';

  if (!accessToken || !adAccountId) {
    console.error('Missing META_MARKETING_API_TOKEN or META_AD_ACCOUNT_ID');
    process.exit(1);
  }

  const today = calendarDateInZone(ACCOUNT_TIME_ZONE);
  const from = shiftDateUtc(today, -(opts.days - 1));
  const ranges = inclusiveRanges(from, today, opts.chunk);

  const { entityId } = await resolveSelfEntityId();
  const runId = randomUUID();
  await insertRun({ runId, entityId });

  console.log('Backfill ad metrics', {
    runId,
    timeZone: ACCOUNT_TIME_ZONE,
    from,
    to: today,
    chunkDays: opts.chunk,
    windows: ranges.length,
  });

  let totalRows = 0;
  try {
    for (let i = 0; i < ranges.length; i++) {
      const reportingRange = ranges[i];
      console.log('Window', i + 1, '/', ranges.length, reportingRange);
      const adRows = await fetchAllAdRows({
        version: apiVersion,
        adAccountId,
        accessToken,
        reportingRange,
      });
      const metricRows = adRows
        .map(function (row) {
          return mapRowToAdMetric({ row, entityId, runId });
        })
        .filter(Boolean);
      const { upserted } = await upsertAdMetrics(metricRows);
      totalRows += upserted;
      console.log('  insight rows:', adRows.length, 'upserted:', upserted);
      if (i < ranges.length - 1 && opts.pauseMs > 0) {
        await sleep(opts.pauseMs);
      }
    }

    await finishRun({
      runId,
      status: 'success',
      rawJson: {
        backfill: true,
        adRowsUpserted: totalRows,
        from,
        to: today,
        windows: ranges.length,
      },
    });
    console.log('Backfill complete. Total upserted rows:', totalRows);
  } catch (err) {
    await finishRun({
      runId,
      status: 'failed',
      rawJson: {
        backfill: true,
        message: err && err.message ? err.message : 'unknown',
      },
    });
    throw err;
  }
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
