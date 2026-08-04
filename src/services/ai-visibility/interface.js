/**
 * Shared contract for AI Visibility provider adapters.
 *
 * @typedef {object} AiVisibilityResult
 * @property {'success'|'error'|'not_configured'} status
 * @property {string|null} rawText
 * @property {string|null} error
 * @property {string|null} errorCode
 * @property {number|null} httpStatus
 * @property {string} modelName
 * @property {number} latencyMs
 * @property {number|null} inputTokens
 * @property {number|null} outputTokens
 */

const PROVIDER_TIMEOUT_MS = 30_000;

/**
 * @param {Partial<AiVisibilityResult> & { status: AiVisibilityResult['status'], modelName: string }} partial
 * @returns {AiVisibilityResult}
 */
function buildResult(partial) {
  return {
    status: partial.status,
    rawText: partial.rawText != null ? partial.rawText : null,
    error: partial.error != null ? partial.error : null,
    errorCode: partial.errorCode != null ? partial.errorCode : null,
    httpStatus: partial.httpStatus != null ? partial.httpStatus : null,
    modelName: String(partial.modelName || ''),
    latencyMs: Number.isFinite(partial.latencyMs) ? partial.latencyMs : 0,
    inputTokens: partial.inputTokens != null ? partial.inputTokens : null,
    outputTokens: partial.outputTokens != null ? partial.outputTokens : null,
  };
}

/**
 * @param {string} promptText
 */
function assertPromptText(promptText) {
  if (typeof promptText !== 'string' || !promptText.trim()) {
    throw new Error('promptText must be a non-empty string');
  }
  return promptText.trim();
}

/**
 * Fetch with AbortController timeout. Does not log secrets.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs]
 */
async function fetchWithTimeout(url, init, timeoutMs = PROVIDER_TIMEOUT_MS) {
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
  PROVIDER_TIMEOUT_MS,
  buildResult,
  assertPromptText,
  fetchWithTimeout,
  isAbortError,
};
