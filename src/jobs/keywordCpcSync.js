'use strict';

/**
 * Job: keyword_cpc_sync
 * Cadence: external (not wired to cron yet) → POST /jobs/run-keyword-cpc-sync
 *
 * Active serp_monitored_queries → Keyword Planner (UY) → append keyword_cpc_estimates.
 * No job_locks / no blocking unique (append-only historial; same class as serp/liquidity
 * data-level idempotency — double-fire inserts another snapshot set).
 */

const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  listActiveSerpMonitoredQueries,
} = require('../steps/serpMonitoredQueries');
const {
  fetchKeywordHistoricalMetrics,
  KEYWORD_BATCH_MAX,
} = require('../clients/googleAdsKeywordPlanner');

/**
 * @param {object|null} metrics
 * @returns {'imported'|'no_data'}
 */
function classifyMetrics(metrics) {
  if (metrics && metrics.hasUsefulMetrics) return 'imported';
  return 'no_data';
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   syncRunId: string,
 *   totalProcessed: number,
 *   imported: number,
 *   noData: number,
 *   errors: number,
 *   currencyCode: string|null,
 *   details: object[],
 * }>}
 */
async function runKeywordCpcSync() {
  const syncRunId = randomUUID();
  const { queries } = await listActiveSerpMonitoredQueries();

  const summary = {
    ok: true,
    syncRunId,
    totalProcessed: 0,
    imported: 0,
    noData: 0,
    errors: 0,
    currencyCode: null,
    details: [],
  };

  logger.info('keyword_cpc_sync started', {
    syncRunId,
    activeQueries: queries.length,
  });

  if (!queries.length) {
    logger.info('keyword_cpc_sync finished — no active queries', { syncRunId });
    return summary;
  }

  if (queries.length > KEYWORD_BATCH_MAX) {
    const err = new Error(
      `Active queries (${queries.length}) exceed Keyword Planner batch max (${KEYWORD_BATCH_MAX})`,
    );
    err.code = 'GOOGLE_ADS_BATCH_TOO_LARGE';
    throw err;
  }

  const keywordTexts = queries.map((q) => q.queryText);

  let currencyCode = null;
  /** @type {Map<string, object|null>} */
  let resultsByKeyword = new Map();

  try {
    const fetched = await fetchKeywordHistoricalMetrics(keywordTexts);
    currencyCode = fetched.currencyCode;
    resultsByKeyword = fetched.resultsByKeyword;
    summary.currencyCode = currencyCode;
  } catch (err) {
    const message = err && err.message ? err.message : 'unknown';
    const code = err && err.code ? err.code : 'GOOGLE_ADS_KEYWORD_PLANNER_ERROR';
    logger.error('keyword_cpc_sync Keyword Planner call failed', {
      syncRunId,
      error: message,
      code,
    });

    for (const query of queries) {
      summary.totalProcessed += 1;
      summary.errors += 1;
      summary.details.push({
        queryId: query.id,
        queryText: query.queryText,
        outcome: 'error',
        error: message,
        code,
        estimateId: null,
      });
    }

    summary.ok = false;
    return summary;
  }

  const rowsToInsert = [];

  for (const query of queries) {
    summary.totalProcessed += 1;
    const metrics = resultsByKeyword.get(query.queryText) || null;
    const outcome = classifyMetrics(metrics);

    const row = {
      monitored_query_id: query.id,
      query_text_snapshot: query.queryText,
      avg_monthly_searches:
        metrics && metrics.avgMonthlySearches != null
          ? metrics.avgMonthlySearches
          : null,
      low_top_of_page_bid_raw:
        metrics && metrics.lowTopOfPageBidRaw != null
          ? metrics.lowTopOfPageBidRaw
          : null,
      high_top_of_page_bid_raw:
        metrics && metrics.highTopOfPageBidRaw != null
          ? metrics.highTopOfPageBidRaw
          : null,
      currency_code: currencyCode,
      competition_level:
        metrics && metrics.competitionLevel != null
          ? metrics.competitionLevel
          : null,
      sync_run_id: syncRunId,
    };

    rowsToInsert.push({ query, outcome, row });
  }

  if (rowsToInsert.length) {
    const { data: inserted, error: insertErr } = await supabase
      .from('keyword_cpc_estimates')
      .insert(rowsToInsert.map((r) => r.row))
      .select('id, monitored_query_id');

    if (insertErr) {
      const message = insertErr.message || 'insert failed';
      logger.error('keyword_cpc_sync insert failed', {
        syncRunId,
        error: message,
      });
      for (const item of rowsToInsert) {
        summary.errors += 1;
        summary.details.push({
          queryId: item.query.id,
          queryText: item.query.queryText,
          outcome: 'error',
          error: message,
          code: 'KEYWORD_CPC_INSERT_FAILED',
          estimateId: null,
        });
      }
      summary.ok = false;
      return summary;
    }

    const idByQuery = new Map();
    (inserted || []).forEach((row) => {
      if (row && row.monitored_query_id) {
        idByQuery.set(String(row.monitored_query_id), row.id);
      }
    });

    for (const item of rowsToInsert) {
      const estimateId = idByQuery.get(String(item.query.id)) || null;
      if (item.outcome === 'imported') summary.imported += 1;
      else summary.noData += 1;

      summary.details.push({
        queryId: item.query.id,
        queryText: item.query.queryText,
        outcome: item.outcome,
        estimateId,
        avgMonthlySearches: item.row.avg_monthly_searches,
        lowTopOfPageBidRaw: item.row.low_top_of_page_bid_raw,
        highTopOfPageBidRaw: item.row.high_top_of_page_bid_raw,
        competitionLevel: item.row.competition_level,
        currencyCode: item.row.currency_code,
        error: null,
        code: null,
      });
    }
  }

  logger.info('keyword_cpc_sync finished', {
    syncRunId,
    totalProcessed: summary.totalProcessed,
    imported: summary.imported,
    noData: summary.noData,
    errors: summary.errors,
    currencyCode: summary.currencyCode,
  });

  return summary;
}

module.exports = {
  runKeywordCpcSync,
};
