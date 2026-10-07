'use strict';

/**
 * Strip credentials before anything ELM-related is persisted or logged.
 * Applied to provider responses and error texts. Request payloads are built from a fixed
 * key whitelist (payload.js) and never carry credentials.
 */

const REDACTED = '[REDACTED]';
const MAX_ERROR_DETAIL = 500;

const SECRET_KEY_RE =
  /authorization|oauth|token|secret|signature|password|passwd|api[-_]?key|consumer[-_]?key|cookie|credential|private[-_]?key|nonce/i;

const SECRET_TEXT_RES = [
  /\b(oauth_[a-z_]+)\s*=\s*"?[^",&\s]+"?/gi,
  /\b(Bearer|Basic|OAuth|Digest)\s+[^\s,;]+/gi,
  /\b(authorization|x-api-key|api[-_]?key|token|secret|password|signature)\s*[:=]\s*"?[^",&\s]+"?/gi,
];

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function redactSecrets(value, depth) {
  const d = depth || 0;
  if (d > 20) return REDACTED;
  if (Array.isArray(value)) {
    return value.map(function (v) {
      return redactSecrets(v, d + 1);
    });
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactSecrets(v, d + 1);
    }
    return out;
  }
  if (typeof value === 'string') return redactSecretText(value, Infinity);
  return value;
}

/**
 * @param {unknown} text
 * @param {number} [maxLen]
 * @param {string[]} [knownSecrets] exact values to scrub (e.g. configured credentials)
 * @returns {string|null}
 */
function redactSecretText(text, maxLen, knownSecrets) {
  if (text == null) return null;
  let s = String(text);
  for (const secret of knownSecrets || []) {
    if (typeof secret === 'string' && secret.length >= 4) {
      s = s.split(secret).join(REDACTED);
    }
  }
  s = s.replace(SECRET_TEXT_RES[0], '$1=' + REDACTED);
  s = s.replace(SECRET_TEXT_RES[1], '$1 ' + REDACTED);
  s = s.replace(SECRET_TEXT_RES[2], '$1=' + REDACTED);
  const limit = maxLen == null ? MAX_ERROR_DETAIL : maxLen;
  return s.length > limit ? s.slice(0, limit) : s;
}

module.exports = {
  REDACTED,
  MAX_ERROR_DETAIL,
  redactSecrets,
  redactSecretText,
};
