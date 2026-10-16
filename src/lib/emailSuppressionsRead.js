'use strict';

/**
 * Chunked email_suppressions reads with brief retries for transient network errors only.
 * Callers must not treat a failed load as "no exclusions".
 */

const { normalizeEmail } = require('../services/email-campaigns/unsubscribeToken');

const EMAIL_IN_CHUNK = 100;
const TRANSIENT_RETRY_ATTEMPTS = 3;
const TRANSIENT_RETRY_DELAY_MS = 200;

function errorMessage(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err.message != null) return String(err.message);
  return String(err);
}

function errorCode(err) {
  if (!err || typeof err !== 'object') return '';
  if (err.code != null) return String(err.code);
  if (err.statusCode != null) return String(err.statusCode);
  if (err.status != null) return String(err.status);
  if (err.name != null) return String(err.name);
  return '';
}

/**
 * Authorization / SQL failures are never retried.
 * @param {unknown} err
 * @returns {boolean}
 */
function isNonTransientSuppressionError(err) {
  const code = errorCode(err);
  const msg = errorMessage(err);
  if (/^(PGRST|28|23|22|42)/i.test(code)) return true;
  if (/^(401|403|42501)$/i.test(code)) return true;
  if (/JWT|not authenticated|invalid api key|permission denied|\bRLS\b/i.test(msg)) {
    return true;
  }
  if (/column .* does not exist|relation .* does not exist|syntax error/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Transient network / edge failures observed in production (fetch failed, Cloudflare 1001).
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientSuppressionError(err) {
  if (!err) return false;
  if (isNonTransientSuppressionError(err)) return false;
  const code = errorCode(err);
  const msg = errorMessage(err);
  const name = err && err.name != null ? String(err.name) : '';
  if (name === 'TypeError' && /fetch failed/i.test(msg)) return true;
  if (/TypeError:\s*fetch failed/i.test(msg)) return true;
  if (/fetch failed/i.test(msg)) return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(code + ' ' + msg)) {
    return true;
  }
  if (/UND_ERR|socket hang up|network/i.test(msg)) return true;
  if (/DNS resolution error|Error 1001|cloudflare/i.test(msg)) return true;
  if (/^(502|503|504)$/i.test(code)) return true;
  const status = err && (err.statusCode || err.status);
  if (status === 502 || status === 503 || status === 504) return true;
  return false;
}

function uniqueNormalizedEmails(emails) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < (emails || []).length; i += 1) {
    const n = normalizeEmail(emails[i]);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function defaultSleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function querySuppressionChunk(supabase, chunk) {
  try {
    const { data, error } = await supabase
      .from('email_suppressions')
      .select('email')
      .in('email', chunk);
    if (error) return { rows: null, error: error };
    return { rows: data || [], error: null };
  } catch (err) {
    return { rows: null, error: err };
  }
}

/**
 * @param {object} supabase
 * @param {unknown[]} emails
 * @param {{
 *   chunkSize?: number,
 *   retryAttempts?: number,
 *   retryDelayMs?: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 * }} [opts]
 * @returns {Promise<{ ok: true, emails: Set<string> } | { ok: false, emails: Set<string>, error: Error }>}
 */
async function loadEmailSuppressionsByEmails(supabase, emails, opts) {
  const options = opts || {};
  const unique = uniqueNormalizedEmails(emails);
  const found = new Set();
  if (!unique.length) {
    return { ok: true, emails: found };
  }

  const chunkSize = Math.max(1, Number(options.chunkSize) || EMAIL_IN_CHUNK);
  const attempts = Math.max(1, Number(options.retryAttempts) || TRANSIENT_RETRY_ATTEMPTS);
  const delayMs = Math.max(0, Number(options.retryDelayMs));
  const retryDelay =
    options.retryDelayMs == null ? TRANSIENT_RETRY_DELAY_MS : delayMs;
  const sleep = options.sleep || defaultSleep;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    let lastErr = null;
    let rows = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await querySuppressionChunk(supabase, chunk);
      if (!result.error) {
        rows = result.rows;
        lastErr = null;
        break;
      }
      lastErr = result.error;
      if (!isTransientSuppressionError(lastErr) || attempt >= attempts) {
        break;
      }
      if (retryDelay > 0) await sleep(retryDelay);
    }
    if (lastErr) {
      const wrapped =
        lastErr instanceof Error
          ? lastErr
          : new Error(errorMessage(lastErr) || 'email_suppressions read failed');
      return { ok: false, emails: new Set(), error: wrapped };
    }
    for (let r = 0; r < (rows || []).length; r += 1) {
      const n = normalizeEmail(rows[r] && rows[r].email);
      if (n) found.add(n);
    }
  }

  return { ok: true, emails: found };
}

const SUPPRESSIONS_UNAVAILABLE = 'suppressions_unavailable';

function unavailableSurveyInvite() {
  return {
    available: false,
    eligible: false,
    reason: SUPPRESSIONS_UNAVAILABLE,
    email_masked: null,
    due_step: null,
  };
}

module.exports = {
  EMAIL_IN_CHUNK,
  TRANSIENT_RETRY_ATTEMPTS,
  TRANSIENT_RETRY_DELAY_MS,
  SUPPRESSIONS_UNAVAILABLE,
  isTransientSuppressionError,
  isNonTransientSuppressionError,
  loadEmailSuppressionsByEmails,
  unavailableSurveyInvite,
};
