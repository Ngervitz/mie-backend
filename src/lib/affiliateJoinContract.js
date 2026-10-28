'use strict';

/**
 * Public affiliate join API contract (pure constants + URL helpers).
 */

const DEFAULT_TERMS_VERSION = 'affiliate_v2';
const DEFAULT_REFERRAL_ORIGIN = 'https://s.credizona.net';

const TERMS_RE = /^[A-Za-z0-9._-]{1,64}$/;

function readReferralOrigin(raw) {
  const trimmed = raw == null ? '' : String(raw).trim();
  if (!trimmed) return DEFAULT_REFERRAL_ORIGIN;
  return trimmed.replace(/\/+$/, '');
}

/**
 * @param {string} code
 * @param {string} [origin]
 */
function buildReferralUrl(code, origin) {
  const base = readReferralOrigin(origin);
  const segment = encodeURIComponent(String(code).trim());
  return base + '/a/' + segment;
}

function isValidTermsVersion(version) {
  return TERMS_RE.test(String(version == null ? '' : version).trim());
}

/**
 * Matches public join API configuredTermsVersion() (env AFFILIATE_TERMS_VERSION).
 * @param {unknown} envValue
 */
function resolveConfiguredTermsVersion(envValue) {
  const raw =
    envValue == null || String(envValue).trim() === ''
      ? DEFAULT_TERMS_VERSION
      : String(envValue).trim();
  return isValidTermsVersion(raw) ? raw : DEFAULT_TERMS_VERSION;
}

/**
 * @param {unknown} phone
 */
function maskAffiliatePhone(phone) {
  const digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return '***' + digits.slice(-4);
}

module.exports = {
  DEFAULT_TERMS_VERSION,
  DEFAULT_REFERRAL_ORIGIN,
  TERMS_RE,
  readReferralOrigin,
  buildReferralUrl,
  isValidTermsVersion,
  resolveConfiguredTermsVersion,
  maskAffiliatePhone,
};
