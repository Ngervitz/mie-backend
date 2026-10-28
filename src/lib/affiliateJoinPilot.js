'use strict';

/**
 * Optional single-CI gate for affiliate join pilot (env AFFILIATE_JOIN_PILOT_CI).
 * When unset, all CIs allowed (subject to AFFILIATE_JOIN_ENABLED and invite rules).
 */

const { parseCi } = require('./affiliateDirectory');
const {
  AFFILIATE_PILOT_AUTHORIZED_JOIN_CI,
  AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS,
} = require('./affiliateJoinPilotRoster');

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
  if (pilot !== AFFILIATE_PILOT_AUTHORIZED_JOIN_CI) {
    return false;
  }
  const parsed = parseCi(ci);
  if (parsed == null) return false;
  return parsed === AFFILIATE_PILOT_AUTHORIZED_JOIN_CI;
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
  if (pilot !== AFFILIATE_PILOT_AUTHORIZED_JOIN_CI) return null;
  const parsed = parseCi(ci);
  if (parsed == null || parsed !== AFFILIATE_PILOT_AUTHORIZED_JOIN_CI) {
    return null;
  }

  const raw = process.env.AFFILIATE_JOIN_PILOT_SMS_PHONE;
  if (raw == null || String(raw).trim() === '') return null;
  const digits = normalizeDigits(String(raw).trim());
  if (digits !== AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS) return null;
  return AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS;
}

module.exports = {
  AFFILIATE_PILOT_AUTHORIZED_JOIN_CI,
  readAffiliateJoinPilotCi,
  isCiAllowedForAffiliateJoin,
  resolvePilotSmsPhoneOverride,
};
