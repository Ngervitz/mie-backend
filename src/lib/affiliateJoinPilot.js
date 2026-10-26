'use strict';

/**
 * Optional single-CI gate for affiliate join pilot (env AFFILIATE_JOIN_PILOT_CI).
 * When unset, all CIs allowed (subject to AFFILIATE_JOIN_ENABLED and invite rules).
 */

const { parseCi } = require('./affiliateDirectory');

function normalizeDigits(raw) {
  return String(raw == null ? '' : raw).replace(/\D/g, '');
}

function readAffiliateJoinPilotCi() {
  const raw = process.env.AFFILIATE_JOIN_PILOT_CI;
  if (raw == null || String(raw).trim() === '') return null;
  return parseCi(String(raw).trim());
}

/**
 * @param {number|string} ci
 * @returns {boolean}
 */
function isCiAllowedForAffiliateJoin(ci) {
  const pilot = readAffiliateJoinPilotCi();
  if (pilot == null) return true;
  const parsed = parseCi(ci);
  if (parsed == null) return false;
  return parsed === pilot;
}

/**
 * Optional SMS destination for the pilot CI only (env AFFILIATE_JOIN_PILOT_SMS_PHONE).
 * Used instead of cz_funnel_solicitudes when pilot CI matches. Unset → funnel only.
 *
 * @param {number|string} ci
 * @returns {string|null} digits-only phone
 */
function resolvePilotSmsPhoneOverride(ci) {
  const pilot = readAffiliateJoinPilotCi();
  if (pilot == null) return null;
  const parsed = parseCi(ci);
  if (parsed == null || parsed !== pilot) return null;

  const raw = process.env.AFFILIATE_JOIN_PILOT_SMS_PHONE;
  if (raw == null || String(raw).trim() === '') return null;
  const digits = normalizeDigits(String(raw).trim());
  if (digits.length < 8) return null;
  return digits;
}

module.exports = {
  readAffiliateJoinPilotCi,
  isCiAllowedForAffiliateJoin,
  resolvePilotSmsPhoneOverride,
};
