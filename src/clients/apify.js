const { ApifyClient } = require('apify-client');
const env = require('../config/env');
const logger = require('../lib/logger');

const client = new ApifyClient({ token: env.apifyToken });

const APIFY_FAILURE_PATTERNS = [
  'timeout',
  'sources failed',
  'failed to get source',
  'connection error',
  'browser closed',
  'context closed',
  'page closed',
  'net::err',
  'blocked',
  'rate limit',
];

function buildApifyInput(adLibraryUrl) {
  return {
    startUrls: [adLibraryUrl],
    // maxResults: 50 — V1 limit. Actor default is 100. Set 0 for unlimited.
    maxResults: 50,
  };
}

async function fetchAllDatasetItems(datasetId) {
  const items = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { items: page } = await client.dataset(datasetId).listItems({ offset, limit });
    items.push(...page);

    if (page.length < limit) {
      break;
    }

    offset += limit;
  }

  return items;
}

function detectApifyFailurePattern(logText) {
  if (!logText || typeof logText !== 'string') {
    return { detected: false, pattern: null };
  }

  const lower = logText.toLowerCase();

  for (const pattern of APIFY_FAILURE_PATTERNS) {
    if (lower.includes(pattern)) {
      return { detected: true, pattern };
    }
  }

  return { detected: false, pattern: null };
}

async function getRunLog(runId) {
  if (!runId) {
    return { ok: false, log: null, error: 'missing_run_id' };
  }

  try {
    const log = await client.run(runId).log().get();

    if (log === undefined || log === null) {
      return { ok: false, log: null, error: 'log_not_available' };
    }

    return { ok: true, log: String(log), error: null };
  } catch (err) {
    return { ok: false, log: null, error: err.message };
  }
}

async function runActorOnce(input) {
  const run = await client.actor(env.apifyActorId).call(input);
  const items = await fetchAllDatasetItems(run.defaultDatasetId);

  return {
    items,
    apifyRunId: run.id || null,
    runStatus: run.status || null,
  };
}

async function runActorWithRetry(input) {
  const metrics = {
    retriesExecuted: 0,
    retriesSucceeded: 0,
    retriesFailed: 0,
  };

  const first = await runActorOnce(input);
  const attempt1 = {
    attempt: 1,
    items: first.items,
    apifyRunId: first.apifyRunId,
    adsFound: first.items.length,
    runStatus: first.runStatus,
  };

  if (first.items.length > 0) {
    return {
      items: first.items,
      apifyRunId: first.apifyRunId,
      status: 'success',
      attempts: [attempt1],
      metrics,
      retried: false,
    };
  }

  const firstLog = await getRunLog(first.apifyRunId);
  attempt1.logReadable = firstLog.ok;
  attempt1.logError = firstLog.error;

  if (!firstLog.ok) {
    attempt1.failurePattern = 'log_unreadable';
    logger.warn('Apify run log unreadable; empty_unconfirmed without retry', {
      apifyRunId: first.apifyRunId,
      error: firstLog.error,
    });

    return {
      items: [],
      apifyRunId: first.apifyRunId,
      status: 'empty_unconfirmed',
      attempts: [attempt1],
      metrics,
      retried: false,
    };
  }

  const firstFailure = detectApifyFailurePattern(firstLog.log);
  attempt1.failurePattern = firstFailure.pattern;

  if (!firstFailure.detected) {
    logger.info('Apify empty result without failure pattern', {
      apifyRunId: first.apifyRunId,
    });

    return {
      items: [],
      apifyRunId: first.apifyRunId,
      status: 'empty_confirmed',
      attempts: [attempt1],
      metrics,
      retried: false,
    };
  }

  metrics.retriesExecuted = 1;
  logger.info('Apify failure pattern detected, starting retry', {
    pattern: firstFailure.pattern,
    apifyRunId: first.apifyRunId,
  });

  const second = await runActorOnce(input);
  const attempt2 = {
    attempt: 2,
    items: second.items,
    apifyRunId: second.apifyRunId,
    adsFound: second.items.length,
    runStatus: second.runStatus,
  };

  if (second.items.length > 0) {
    metrics.retriesSucceeded = 1;
    logger.info('Retry successful.', {
      apifyRunId: second.apifyRunId,
      pattern: firstFailure.pattern,
    });

    return {
      items: second.items,
      apifyRunId: second.apifyRunId,
      status: 'success',
      attempts: [attempt1, attempt2],
      metrics,
      retried: true,
    };
  }

  const secondLog = await getRunLog(second.apifyRunId);
  attempt2.logReadable = secondLog.ok;
  attempt2.logError = secondLog.error;
  attempt2.failurePattern = secondLog.ok
    ? (detectApifyFailurePattern(secondLog.log).pattern || 'unknown_failure')
    : 'log_unreadable';

  metrics.retriesFailed = 1;
  logger.warn('Retry failed after empty capture with failure pattern', {
    firstPattern: firstFailure.pattern,
    retryApifyRunId: second.apifyRunId,
    retryFailurePattern: attempt2.failurePattern,
  });

  return {
    items: [],
    apifyRunId: second.apifyRunId,
    status: 'empty_unconfirmed',
    attempts: [attempt1, attempt2],
    metrics,
    retried: true,
  };
}

module.exports = {
  buildApifyInput,
  runActor: runActorOnce,
  runActorOnce,
  runActorWithRetry,
  detectApifyFailurePattern,
  getRunLog,
  APIFY_FAILURE_PATTERNS,
};
