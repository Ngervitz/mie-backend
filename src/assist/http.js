'use strict';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Fetch with AbortController timeout. Does not log secrets.
 * Isolated copy for Assist — do not import AI Visibility helpers here.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs]
 */
async function fetchWithTimeout(url, init, timeoutMs = DEFAULT_TIMEOUT_MS) {
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

module.exports = {
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  isAbortError,
};
