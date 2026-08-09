'use strict';

/**
 * Job: serp_import_sync
 * Cadence: external cron (cron-job.org) → POST /jobs/run-serp-import-sync
 *
 * For each active serp_monitored_queries row:
 *   Serper /search → importGoogleSerpJson (domain fn, not Express handler).
 * Per-query failures are logged and skipped; the job always returns a summary.
 */

const logger = require('../lib/logger');
const env = require('../config/env');
const {
  listActiveSerpMonitoredQueries,
} = require('../steps/serpMonitoredQueries');
const { importGoogleSerpJson } = require('../steps/collectGoogleSerpJsonImports');

const SERPER_SEARCH_URL = 'https://google.serper.dev/search';
const SERPER_TIMEOUT_MS = 15_000;

/**
 * Native fetch + AbortController (same pattern as ai-visibility fetchWithTimeout).
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(err) {
  return (
    err &&
    (err.name === 'AbortError' ||
      err.code === 'ABORT_ERR' ||
      /aborted|abort/i.test(String(err.message || '')))
  );
}

/**
 * Call Serper /search for one query. Uruguay defaults match sample payloads.
 * @param {string} queryText
 * @param {string} apiKey
 */
async function fetchSerperSearch(queryText, apiKey) {
  let response;
  try {
    response = await fetchWithTimeout(
      SERPER_SEARCH_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey,
        },
        body: JSON.stringify({
          q: queryText,
          gl: 'uy',
          hl: 'es',
        }),
      },
      SERPER_TIMEOUT_MS,
    );
  } catch (err) {
    if (isAbortError(err)) {
      const timeoutErr = new Error(
        `Serper timeout after ${SERPER_TIMEOUT_MS}ms`,
      );
      timeoutErr.code = 'SERPER_TIMEOUT';
      throw timeoutErr;
    }
    const netErr = new Error(
      err && err.message ? err.message : 'Serper request failed',
    );
    netErr.code = 'SERPER_NETWORK';
    throw netErr;
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const err = new Error(
      `Serper HTTP ${response.status}` +
        (body && body.message ? `: ${body.message}` : ''),
    );
    err.code = 'SERPER_HTTP';
    err.statusCode = response.status;
    throw err;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('Serper response is not a JSON object');
    err.code = 'SERPER_INVALID_SHAPE';
    throw err;
  }

  if (!Array.isArray(body.organic)) {
    const err = new Error('Serper response missing organic array');
    err.code = 'SERPER_INVALID_SHAPE';
    throw err;
  }

  return body;
}

/**
 * Classify importGoogleSerpJson result into job outcome bucket.
 * @param {object} result
 * @returns {'imported'|'duplicated'|'no_results'}
 */
function classifyImportResult(result) {
  if (result && result.duplicate) return 'duplicated';
  if (result && result.parserFoundNoResults) return 'no_results';
  return 'imported';
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   totalProcessed: number,
 *   imported: number,
 *   duplicated: number,
 *   noResults: number,
 *   errors: number,
 *   details: object[],
 * }>}
 */
async function runSerpImportSync() {
  const apiKey = env.serperApiKey;
  if (!apiKey) {
    const err = new Error(
      'SERPER_API_KEY is not configured (set it in the environment)',
    );
    err.code = 'SERPER_API_KEY_MISSING';
    throw err;
  }

  const { queries } = await listActiveSerpMonitoredQueries();
  const summary = {
    ok: true,
    totalProcessed: 0,
    imported: 0,
    duplicated: 0,
    noResults: 0,
    errors: 0,
    details: [],
  };

  logger.info('serp_import_sync started', {
    activeQueries: queries.length,
  });

  for (const query of queries) {
    summary.totalProcessed += 1;
    const detail = {
      queryId: query.id,
      queryText: query.queryText,
      outcome: null,
      captureId: null,
      error: null,
      code: null,
    };

    try {
      const payload = await fetchSerperSearch(query.queryText, apiKey);
      const result = await importGoogleSerpJson({ payload });
      const outcome = classifyImportResult(result);
      detail.outcome = outcome;
      detail.captureId = result.captureId || null;

      if (outcome === 'imported') summary.imported += 1;
      else if (outcome === 'duplicated') summary.duplicated += 1;
      else summary.noResults += 1;

      logger.info('serp_import_sync query done', {
        queryId: query.id,
        queryText: query.queryText,
        outcome,
        captureId: detail.captureId,
        organicFound: result.organicFound,
        adsFound: result.adsFound,
      });
    } catch (err) {
      summary.errors += 1;
      detail.outcome = 'error';
      detail.error = err && err.message ? err.message : 'unknown';
      detail.code = err && err.code ? err.code : null;

      logger.error('serp_import_sync query failed', {
        queryId: query.id,
        queryText: query.queryText,
        error: detail.error,
        code: detail.code,
      });
    }

    summary.details.push(detail);
  }

  logger.info('serp_import_sync finished', {
    totalProcessed: summary.totalProcessed,
    imported: summary.imported,
    duplicated: summary.duplicated,
    noResults: summary.noResults,
    errors: summary.errors,
  });

  return summary;
}

module.exports = {
  runSerpImportSync,
  fetchSerperSearch,
  SERPER_SEARCH_URL,
  SERPER_TIMEOUT_MS,
};
