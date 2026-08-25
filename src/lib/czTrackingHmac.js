'use strict';

const crypto = require('crypto');
const env = require('../config/env');

const WINDOW_SECONDS = 300;
const SIG_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^[0-9]+$/;

function getSecret() {
  const secret = env && env.czTrackingHmacSecret;
  if (secret == null) return null;
  const trimmed = String(secret).trim();
  return trimmed || null;
}

function toBodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody == null) return Buffer.alloc(0);
  return Buffer.from(String(rawBody), 'utf8');
}

function signTrackingPayload(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(String(timestamp), 'utf8')
    .update('.', 'utf8')
    .update(toBodyBuffer(rawBody))
    .digest('hex');
}

function readHeader(headers, name) {
  if (!headers) return '';
  const value = headers[name];
  if (Array.isArray(value)) return value[0] != null ? String(value[0]) : '';
  if (value == null) return '';
  return String(value);
}

function verifyTrackingHmac(headers, rawBody, nowSeconds) {
  const secret = getSecret();
  if (!secret) {
    return { ok: false, reason: 'hmac_secret_missing' };
  }

  const timestamp = readHeader(headers, 'x-janus-timestamp').trim();
  const signature = readHeader(headers, 'x-janus-signature').trim().toLowerCase();
  if (!timestamp || !signature) {
    return { ok: false, reason: 'hmac_missing' };
  }
  if (!TIMESTAMP_RE.test(timestamp) || !SIG_RE.test(signature)) {
    return { ok: false, reason: 'hmac_invalid' };
  }

  const ts = Number(timestamp);
  const now =
    Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'hmac_invalid' };
  }
  if (ts > now + WINDOW_SECONDS) {
    return { ok: false, reason: 'hmac_timestamp_future' };
  }
  if (ts < now - WINDOW_SECONDS) {
    return { ok: false, reason: 'hmac_timestamp_expired' };
  }

  const expectedHex = signTrackingPayload(secret, timestamp, rawBody);
  const provided = Buffer.from(signature, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'hmac_invalid' };
  }
  if (!crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'hmac_invalid' };
  }
  return { ok: true, reason: null };
}

module.exports = {
  WINDOW_SECONDS,
  getSecret,
  signTrackingPayload,
  verifyTrackingHmac,
};
