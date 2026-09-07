'use strict';

/**
 * Deterministic canonical JSON serialization + SHA-256 for Stage 4 confirm payloads.
 * Hash covers { consulted_on, reviewed } only.
 */

const { createHash } = require('crypto');

/**
 * Canonical decimal string for finite numbers (no scientific notation).
 * @param {number} n
 * @returns {string}
 */
function canonicalNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error('canonicalNumber: non-finite');
  }
  if (Object.is(n, -0)) return '0';
  const raw = String(n);
  // Confirm payloads use ordinary decimals; reject scientific form rather than guess.
  if (/[eE]/.test(raw)) {
    throw new Error('canonicalNumber: scientific notation not supported');
  }
  return raw;
}

/**
 * RFC8785-inspired canonical JSON string (subset for bcu confirm payloads).
 * - object keys sorted
 * - arrays preserve order
 * - strings NFC + JSON string encoding
 * - null / boolean / number literals
 * @param {unknown} value
 * @returns {string}
 */
function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') {
    return JSON.stringify(value.normalize('NFC'));
  }
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ',';
      out += canonicalize(value[i]);
    }
    return out + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    let out = '{';
    for (let i = 0; i < keys.length; i += 1) {
      if (i > 0) out += ',';
      const k = keys[i];
      out += JSON.stringify(String(k).normalize('NFC'));
      out += ':';
      out += canonicalize(value[k]);
    }
    return out + '}';
  }
  throw new Error('canonicalize: unsupported type');
}

/**
 * @param {{ consulted_on: string, reviewed: object }} payload
 * @returns {string} lowercase hex sha256
 */
function hashConfirmPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('hashConfirmPayload: invalid payload');
  }
  const doc = {
    consulted_on: payload.consulted_on,
    reviewed: payload.reviewed,
  };
  const canonical = canonicalize(doc);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

module.exports = {
  canonicalize,
  canonicalNumber,
  hashConfirmPayload,
};
