'use strict';

/**
 * HMAC-signed opaque sessions for the public affiliate join API.
 * Never embed CI or raw invite token in the payload.
 */

const crypto = require('crypto');

const SESSION_VERSION = 1;
const PRE_OTP_TTL_MS = 30 * 60 * 1000;
const VERIFIED_TTL_MS = 24 * 60 * 60 * 1000;

function requireSecret(secret) {
  const key = secret == null ? '' : String(secret).trim();
  if (!key) {
    const err = new Error('affiliate_join_session_not_configured');
    err.code = 'AFFILIATE_JOIN_SESSION_NOT_CONFIGURED';
    throw err;
  }
  return key;
}

/**
 * @param {object} input
 * @param {string} input.invite_id
 * @param {string|Date} now
 * @param {string} secret
 */
function mintPreOtpSession(input, now, secret) {
  const key = requireSecret(secret);
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const payload = {
    v: SESSION_VERSION,
    i: String(input.invite_id),
    exp: t + PRE_OTP_TTL_MS,
    ta: null,
    tv: null,
    c: null,
    vf: false,
    ac: null,
  };
  return sign(payload, key);
}

/**
 * @param {object} base decoded session
 */
function withTermsAccepted(base, termsVersion, now, secret) {
  const key = requireSecret(secret);
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const payload = Object.assign({}, base, {
    ta: now instanceof Date ? now.toISOString() : String(now),
    tv: String(termsVersion).trim(),
    exp: Math.min(base.exp, t + PRE_OTP_TTL_MS),
  });
  return sign(payload, key);
}

function withChallenge(base, challengeId, now, secret) {
  const key = requireSecret(secret);
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const payload = Object.assign({}, base, {
    c: String(challengeId),
    exp: Math.min(base.exp, t + PRE_OTP_TTL_MS),
  });
  return sign(payload, key);
}

function withVerified(base, affiliateCode, now, secret) {
  const key = requireSecret(secret);
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const payload = Object.assign({}, base, {
    vf: true,
    ac: String(affiliateCode),
    c: null,
    exp: t + VERIFIED_TTL_MS,
  });
  return sign(payload, key);
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

/**
 * @returns {{ ok: true, session: object }|{ ok: false, error: string }}
 */
function verifySessionToken(token, secret, now) {
  const key = secret == null ? '' : String(secret).trim();
  if (!key) return { ok: false, error: 'not_configured' };
  const raw = token == null ? '' : String(token).trim();
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: 'invalid' };
  }
  const expected = crypto.createHmac('sha256', key).update(parts[0]).digest('base64url');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parts[1], 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'invalid' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (_err) {
    return { ok: false, error: 'invalid' };
  }
  if (!payload || payload.v !== SESSION_VERSION || !payload.i) {
    return { ok: false, error: 'invalid' };
  }
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(t) || t >= Number(payload.exp)) {
    return { ok: false, error: 'expired' };
  }
  return { ok: true, session: payload };
}

module.exports = {
  SESSION_VERSION,
  PRE_OTP_TTL_MS,
  VERIFIED_TTL_MS,
  mintPreOtpSession,
  withTermsAccepted,
  withChallenge,
  withVerified,
  verifySessionToken,
};
