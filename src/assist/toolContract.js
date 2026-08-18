'use strict';

const { isAbortError } = require('./http');

const STATUSES = Object.freeze([
  'success',
  'empty',
  'error',
  'not_implemented',
]);

/**
 * @param {string} sourceTable
 * @param {string} [checkedAt]
 */
function meta(sourceTable, extras) {
  const out = {
    source_table: sourceTable,
    checked_at: (extras && extras.checked_at) || new Date().toISOString(),
  };
  if (extras && extras.truncated === true) {
    out.truncated = true;
    out.total_available =
      extras.total_available != null ? Number(extras.total_available) : 0;
  }
  return out;
}

function success(data, sourceTable, extras) {
  return {
    status: 'success',
    data,
    meta: meta(sourceTable, extras),
  };
}

function empty(sourceTable, extras) {
  return {
    status: 'empty',
    data: null,
    meta: meta(sourceTable, extras),
  };
}

function error(errorMessage, sourceTable, extras) {
  return {
    status: 'error',
    data: null,
    error_message: String(errorMessage || 'Unknown error'),
    meta: meta(sourceTable, extras),
  };
}

function notImplemented(errorMessage, sourceTable, extras) {
  return {
    status: 'not_implemented',
    data: null,
    error_message: String(
      errorMessage || 'This capability is not implemented',
    ),
    meta: meta(sourceTable, extras),
  };
}

/**
 * Timeouts / network / DB connectivity only.
 * Programming errors (TypeError, ReferenceError, SyntaxError) are never transient.
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientError(err) {
  if (!err || typeof err !== 'object') return false;
  if (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError
  ) {
    return false;
  }
  if (err.transient === true) return true;
  if (isAbortError(err)) return true;

  const code = String(err.code || '');
  if (
    [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      '57014',
      '08006',
      '08001',
      '08003',
      '08004',
      '57P01',
      'PGRST002',
      'PGRST003',
    ].includes(code)
  ) {
    return true;
  }

  const status = Number(err.httpStatus || err.status || 0);
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  const msg = String(err.message || '');
  return /timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error|connection (reset|refused|terminated)/i.test(
    msg,
  );
}

/**
 * Run fn; on transient failure retry once. Logic errors propagate immediately.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ onRetry?: () => void }} [opts]
 * @returns {Promise<{ value: T, retried: boolean }>}
 */
async function withTransientRetry(fn, opts) {
  try {
    const value = await fn();
    return { value, retried: false };
  } catch (err) {
    if (!isTransientError(err)) throw err;
    if (opts && typeof opts.onRetry === 'function') opts.onRetry();
    const value = await fn();
    return { value, retried: true };
  }
}

module.exports = {
  STATUSES,
  meta,
  success,
  empty,
  error,
  notImplemented,
  isTransientError,
  withTransientRetry,
};
