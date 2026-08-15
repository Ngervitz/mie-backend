'use strict';

/**
 * After inserting a serp_monitored_queries row, fetch Keyword Planner CPC and
 * Serper SERP in parallel. Failures do not roll back the query insert.
 * No classifyAndPersistSyncRun / Claude (n=1 ranking is not comparable).
 */

const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const env = require('../config/env');
const logger = require('../lib/logger');
const { fetchKeywordHistoricalMetrics } = require('../clients/googleAdsKeywordPlanner');
const { fetchSerperSearch } = require('../jobs/serpImportSync');
const { importGoogleSerpJson } = require('./collectGoogleSerpJsonImports');

function errorMessage(err) {
  if (err && err.message) return String(err.message);
  return 'unknown';
}

function errorCode(err) {
  return err && err.code ? String(err.code) : null;
}

/**
 * @param {{ id: string, queryText: string }} query
 */
async function fetchAndInsertKeywordCpc(query) {
  const fetched = await fetchKeywordHistoricalMetrics([query.queryText]);
  const metrics = fetched.resultsByKeyword.get(query.queryText) || null;
  const syncRunId = randomUUID();

  const { data, error } = await supabase
    .from('keyword_cpc_estimates')
    .insert({
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
      currency_code: fetched.currencyCode,
      competition_level:
        metrics && metrics.competitionLevel != null
          ? metrics.competitionLevel
          : null,
      sync_run_id: syncRunId,
    })
    .select('id')
    .single();

  if (error || !data) {
    const err = new Error(
      error && error.message
        ? error.message
        : 'Failed to insert keyword_cpc_estimates',
    );
    err.code = 'KEYWORD_CPC_INSERT_FAILED';
    throw err;
  }

  return { estimateId: data.id, syncRunId };
}

/**
 * @param {{ queryText: string }} query
 */
async function fetchAndImportSerper(query) {
  const apiKey = env.serperApiKey;
  if (!apiKey) {
    const err = new Error(
      'SERPER_API_KEY is not configured (set it in the environment)',
    );
    err.code = 'SERPER_API_KEY_MISSING';
    throw err;
  }
  const payload = await fetchSerperSearch(query.queryText, apiKey);
  return importGoogleSerpJson({ payload });
}

/**
 * @param {{ id: string, queryText: string }} query
 * @returns {Promise<{
 *   plannerStatus: 'ok'|'error',
 *   plannerError: string|null,
 *   plannerCode: string|null,
 *   serperStatus: 'ok'|'error',
 *   serperError: string|null,
 *   serperCode: string|null,
 * }>}
 */
async function enrichNewlyCreatedSerpQuery(query) {
  const [plannerSettled, serperSettled] = await Promise.allSettled([
    fetchAndInsertKeywordCpc(query),
    fetchAndImportSerper(query),
  ]);

  const plannerOk = plannerSettled.status === 'fulfilled';
  const serperOk = serperSettled.status === 'fulfilled';

  if (!plannerOk) {
    logger.error('serp query on-create Keyword Planner failed', {
      queryId: query.id,
      queryText: query.queryText,
      error: errorMessage(plannerSettled.reason),
      code: errorCode(plannerSettled.reason),
    });
  } else {
    logger.info('serp query on-create Keyword Planner ok', {
      queryId: query.id,
      estimateId: plannerSettled.value && plannerSettled.value.estimateId,
    });
  }

  if (!serperOk) {
    logger.error('serp query on-create Serper failed', {
      queryId: query.id,
      queryText: query.queryText,
      error: errorMessage(serperSettled.reason),
      code: errorCode(serperSettled.reason),
    });
  } else {
    logger.info('serp query on-create Serper ok', {
      queryId: query.id,
      captureId:
        serperSettled.value && serperSettled.value.captureId
          ? serperSettled.value.captureId
          : null,
    });
  }

  return {
    plannerStatus: plannerOk ? 'ok' : 'error',
    plannerError: plannerOk ? null : errorMessage(plannerSettled.reason),
    plannerCode: plannerOk ? null : errorCode(plannerSettled.reason),
    serperStatus: serperOk ? 'ok' : 'error',
    serperError: serperOk ? null : errorMessage(serperSettled.reason),
    serperCode: serperOk ? null : errorCode(serperSettled.reason),
  };
}

module.exports = {
  enrichNewlyCreatedSerpQuery,
};
