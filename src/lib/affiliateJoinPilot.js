'use strict';

/**
 * Optional affiliate join pilot gates:
 * - AFFILIATE_JOIN_PILOT_ALLOWLIST: comma-separated CIs (7-recipient pilot)
 * - AFFILIATE_JOIN_PILOT_CI: single Nelson CI (mutually exclusive with allowlist)
 * When both unset, all CIs allowed (subject to AFFILIATE_JOIN_ENABLED and invite rules).
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
 * @returns {Set<number>|null}
 */
function readAffiliateJoinPilotAllowlist() {
  const raw = process.env.AFFILIATE_JOIN_PILOT_ALLOWLIST;
  if (raw == null || String(raw).trim() === '') return null;
  const parts = String(raw)
    .split(/[,;\s]+/)
    .map(function (p) {
      return p.trim();
    })
    .filter(Boolean);
  const set = new Set();
  for (let i = 0; i < parts.length; i += 1) {
    const ci = parseCi(parts[i]);
    if (ci == null) return null;
    set.add(ci);
  }
  return set.size ? set : null;
}

/**
 * @param {number|string} ci
 * @returns {boolean}
 */
function isCiAllowedForAffiliateJoin(ci) {
  const allowlist = readAffiliateJoinPilotAllowlist();
  if (allowlist) {
    const parsed = parseCi(ci);
    if (parsed == null) return false;
    return allowlist.has(parsed);
  }

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
 * Optional SMS destination for the Nelson pilot CI only (env AFFILIATE_JOIN_PILOT_SMS_PHONE).
 * Allowlist pilot uses funnel celular per CI (no override).
 *
 * @param {number|string} ci
 * @returns {string|null} digits-only phone
 */
function resolvePilotSmsPhoneOverride(ci) {
  if (readAffiliateJoinPilotAllowlist()) return null;

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
  readAffiliateJoinPilotAllowlist,
  isCiAllowedForAffiliateJoin,
  resolvePilotSmsPhoneOverride,
};
