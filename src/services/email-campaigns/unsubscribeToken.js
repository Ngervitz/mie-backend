'use strict';

/**
 * Signed unsubscribe tokens (no expiry — MVP trade-off).
 * Secret: EMAIL_UNSUBSCRIBE_HMAC_SECRET only. No SESSION_SECRET fallback.
 */

const crypto = require('crypto');
const env = require('../../config/env');

const TOKEN_TYP = 'email_unsub';

/**
 * @returns {string|null}
 */
function getUnsubscribeSecret() {
  const fromEnvModule =
    env && env.emailUnsubscribeHmacSecret != null
      ? String(env.emailUnsubscribeHmacSecret).trim()
      : '';
  if (fromEnvModule) return fromEnvModule;
  const raw = process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed || null;
}

/**
 * @param {unknown} email
 * @returns {string}
 */
function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

/**
 * @param {string} secret
 * @param {string} payload
 * @returns {string}
 */
function signPayload(secret, payload) {
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
}

/**
 * @param {unknown} email
 * @returns {string}
 */
function signUnsubscribeToken(email) {
  const secret = getUnsubscribeSecret();
  if (!secret) {
    throw new Error('EMAIL_UNSUBSCRIBE_HMAC_SECRET is not configured');
  }
  const emailNorm = normalizeEmail(email);
  if (!emailNorm || emailNorm.indexOf('@') < 1) {
    throw new Error('invalid email for unsubscribe token');
  }
  const payloadObj = { typ: TOKEN_TYP, e: emailNorm };
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString(
    'base64url',
  );
  const sig = signPayload(secret, payload);
  return payload + '.' + sig;
}

/**
 * @param {unknown} token
 * @returns {{ ok: true, email: string }|{ ok: false, reason: string }}
 */
function verifyUnsubscribeToken(token) {
  const secret = getUnsubscribeSecret();
  if (!secret) {
    return { ok: false, reason: 'secret_missing' };
  }
  if (typeof token !== 'string' || !token) {
    return { ok: false, reason: 'token_missing' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'token_invalid' };
  }
  const payload = parts[0];
  const sig = parts[1];
  if (!payload || !sig) {
    return { ok: false, reason: 'token_invalid' };
  }

  let expected;
  try {
    expected = signPayload(secret, payload);
  } catch {
    return { ok: false, reason: 'token_invalid' };
  }

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) {
    return { ok: false, reason: 'token_invalid' };
  }
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'token_invalid' };
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'token_invalid' };
  }

  if (!parsed || parsed.typ !== TOKEN_TYP) {
    return { ok: false, reason: 'token_invalid' };
  }
  const email = normalizeEmail(parsed.e);
  if (!email || email.indexOf('@') < 1) {
    return { ok: false, reason: 'token_invalid' };
  }
  return { ok: true, email: email };
}

/**
 * @param {string} publicBaseUrl e.g. https://s.credizona.net
 * @param {unknown} email
 * @returns {string}
 */
function buildUnsubscribeUrl(publicBaseUrl, email) {
  const base = String(publicBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) {
    throw new Error('publicBaseUrl is required for unsubscribe URL');
  }
  const token = signUnsubscribeToken(email);
  return base + '/email/unsubscribe?t=' + encodeURIComponent(token);
}

module.exports = {
  TOKEN_TYP,
  getUnsubscribeSecret,
  normalizeEmail,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
};
