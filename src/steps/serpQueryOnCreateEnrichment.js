'use strict';

/**
 * After inserting a serp_monitored_queries row, fetch Keyword Planner CPC and
 * Serper SERP in parallel. Failures do not roll back the query insert.
 * No classifyAndPersistSyncRun / Claude (n=1 ranking is not comparable).
 */

const env = require('../config/env');
const logger = require('../lib/logger');
const { fetchSerperSearch } = require('../jobs/serpImportSync');
const { importGoogleSerpJson } = require('./collectGoogleSerpJsonImports');
const {
  measureKeywordPlannerTerm,
} = require('./measureKeywordPlannerTerm');

function errorMessage(err) {
  if (err && err.message) return String(err.message);
  return 'unknown';
}

function errorCode(err) {
  return err && err.code ? String(err.code) : null;
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
    measureKeywordPlannerTerm({
      term: query.queryText,
      writeKeywordCpc: { monitoredQueryId: query.id },
    }),
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
    const keywordCpc =
      plannerSettled.value && plannerSettled.value.keywordCpc
        ? plannerSettled.value.keywordCpc
        : null;
    logger.info('serp query on-create Keyword Planner ok', {
      queryId: query.id,
      estimateId: keywordCpc && keywordCpc.estimateId,
      alreadyMeasured: Boolean(keywordCpc && keywordCpc.alreadyMeasured),
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
