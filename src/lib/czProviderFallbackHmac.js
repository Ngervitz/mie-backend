'use strict';

/**
 * Dedicated HMAC for Credizona → JANUS provider fallback (/internal/providers/v1/fallback/*).
 * Same wire shape as the miplan handoff, different secret (CZ_PROVIDER_FALLBACK_HMAC_SECRET).
 * A secret equal to another S2S secret is treated as not configured.
 *
 * Headers:
 *   X-Janus-Timestamp
 *   X-Janus-Signature = hex(HMAC-SHA256(secret, timestamp + '.' + rawBody))
 */

const crypto = require('crypto');
const env = require('../config/env');
const { signHandoffPayload } = require('./czMiplanHandoffHmac');

const WINDOW_SECONDS = 300;
const SIG_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^[0-9]+$/;

function trimmed(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

/** @returns {{ secret: string|null, reason: string|null }} */
function getProviderFallbackSecret() {
  const secret = trimmed(env && env.czProviderFallbackHmacSecret);
  if (!secret) return { secret: null, reason: 'hmac_secret_missing' };
  const others = [
    env.czTrackingHmacSecret,
    env.czMiplanHandoffHmacSecret,
    env.miplanHandoffRedeemSecret,
    env.cronSecret,
    env.sessionSecret,
  ].map(trimmed);
  if (others.includes(secret)) return { secret: null, reason: 'hmac_secret_reused' };
  return { secret: secret, reason: null };
}

function readHeader(headers, name) {
  if (!headers) return '';
  const value = headers[name];
  if (Array.isArray(value)) return value[0] != null ? String(value[0]) : '';
  if (value == null) return '';
  return String(value);
}

function verifyProviderFallbackHmac(headers, rawBody, nowSeconds) {
  const { secret, reason } = getProviderFallbackSecret();
  if (!secret) return { ok: false, reason: reason };

  const timestamp = readHeader(headers, 'x-janus-timestamp').trim();
  const signature = readHeader(headers, 'x-janus-signature').trim().toLowerCase();
  if (!timestamp || !signature) return { ok: false, reason: 'hmac_missing' };
  if (!TIMESTAMP_RE.test(timestamp) || !SIG_RE.test(signature)) {
    return { ok: false, reason: 'hmac_invalid' };
  }

  const ts = Number(timestamp);
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'hmac_invalid' };
  if (ts > now + WINDOW_SECONDS) return { ok: false, reason: 'hmac_timestamp_future' };
  if (ts < now - WINDOW_SECONDS) return { ok: false, reason: 'hmac_timestamp_expired' };

  const provided = Buffer.from(signature, 'hex');
  const expected = Buffer.from(signHandoffPayload(secret, timestamp, rawBody), 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'hmac_invalid' };
  }
  return { ok: true, reason: null };
}

module.exports = {
  WINDOW_SECONDS,
  getProviderFallbackSecret,
  signProviderFallbackPayload: signHandoffPayload,
  verifyProviderFallbackHmac,
};
