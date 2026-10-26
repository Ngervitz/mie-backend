'use strict';

/**
 * Optional single-CI gate for affiliate join pilot (env AFFILIATE_JOIN_PILOT_CI).
 * When unset, all CIs allowed (subject to AFFILIATE_JOIN_ENABLED and invite rules).
 */

const { parseCi } = require('./affiliateDirectory');

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

module.exports = {
  readAffiliateJoinPilotCi,
  isCiAllowedForAffiliateJoin,
};
