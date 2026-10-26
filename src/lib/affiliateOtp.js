'use strict';

/**
 * OTP rules for affiliate opt-in (pure). Raw OTP never stored.
 */

const crypto = require('crypto');

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_CI_PER_24H = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function hashOtp(code, secret) {
  const key = secret == null ? '' : String(secret).trim();
  if (!key) {
    throw new Error('affiliate OTP HMAC secret is required');
  }
  const normalized = String(code).trim();
  return crypto.createHmac('sha256', key).update(normalized, 'utf8').digest('hex');
}

function generateOtpCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(OTP_LENGTH, '0');
}

function otpExpiresAt(now) {
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  return new Date(t + OTP_TTL_MS).toISOString();
}

/**
 * @param {string|Date} now
 * @param {string|Date|null|undefined} lastSentAt
 */
function resendCooldownRemainingMs(now, lastSentAt) {
  if (!lastSentAt) return 0;
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const last = Date.parse(String(lastSentAt));
  if (!Number.isFinite(t) || !Number.isFinite(last)) return 0;
  const wait = RESEND_COOLDOWN_MS - (t - last);
  return wait > 0 ? wait : 0;
}

/**
 * @param {number} sendCountLast24h
 */
function canSendOtp(now, lastSentAt, sendCountLast24h) {
  const cooldown = resendCooldownRemainingMs(now, lastSentAt);
  if (cooldown > 0) {
    return { ok: false, reason: 'resend_cooldown', retry_after_ms: cooldown };
  }
  const count = Number(sendCountLast24h);
  if (Number.isFinite(count) && count >= MAX_SENDS_PER_CI_PER_24H) {
    return { ok: false, reason: 'daily_send_limit' };
  }
  return { ok: true };
}

/**
 * @param {object} challenge
 * @param {string|Date} now
 */
function isOtpChallengeVerifiable(challenge, now) {
  if (!challenge) return false;
  if (challenge.status !== 'pending') return false;
  const expires = Date.parse(String(challenge.expires_at));
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(expires) || !Number.isFinite(t) || t >= expires) return false;
  const attempts = Number(challenge.attempt_count);
  const max = Number(challenge.max_attempts);
  if (Number.isFinite(attempts) && Number.isFinite(max) && attempts >= max) return false;
  return true;
}

function verifyOtpCode(code, challenge, secret) {
  const expected = challenge && challenge.otp_hash;
  if (!expected) return false;
  let actual;
  try {
    actual = hashOtp(code, secret);
  } catch (_err) {
    return false;
  }
  const a = Buffer.from(String(actual), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function countSendsSince(challenges, sinceMs, now) {
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const since = Number(sinceMs);
  let count = 0;
  (challenges || []).forEach(function (row) {
    const sent = Date.parse(String(row.last_sent_at || row.created_at));
    if (!Number.isFinite(sent) || sent < since) return;
    if (sent > t) return;
    count += Number(row.send_count) > 0 ? Number(row.send_count) : 1;
  });
  return count;
}

function sendsInLast24h(challenges, now) {
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  return countSendsSince(challenges, t - DAY_MS, now);
}

module.exports = {
  OTP_LENGTH,
  OTP_TTL_MS,
  MAX_VERIFY_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  MAX_SENDS_PER_CI_PER_24H,
  hashOtp,
  generateOtpCode,
  otpExpiresAt,
  resendCooldownRemainingMs,
  canSendOtp,
  isOtpChallengeVerifiable,
  verifyOtpCode,
  sendsInLast24h,
};
