'use strict';

/**
 * Hard-coded roster for the two-recipient affiliate email/join pilot.
 * Env vars gate the window; these constants prevent typos from widening scope.
 */

const { parseCi } = require('./affiliateDirectory');

/** Nelson — only CI allowed through join when AFFILIATE_JOIN_PILOT_CI is set. */
const AFFILIATE_PILOT_AUTHORIZED_JOIN_CI = 19118189;

/** OTP SMS destination for Nelson during the pilot window. */
const AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS = '59893885859';

function normalizeDigits(raw) {
  return String(raw == null ? '' : raw).replace(/\D/g, '');
}

/**
 * @returns {{ ok: true }|{ ok: false, reason: string }}
 */
function validateAffiliatePilotJoinEnv() {
  const rawCi = process.env.AFFILIATE_JOIN_PILOT_CI;
  if (rawCi == null || String(rawCi).trim() === '') {
    return { ok: false, reason: 'AFFILIATE_JOIN_PILOT_CI unset' };
  }
  const pilotCi = parseCi(String(rawCi).trim());
  if (pilotCi == null) {
    return { ok: false, reason: 'AFFILIATE_JOIN_PILOT_CI invalid' };
  }
  if (pilotCi !== AFFILIATE_PILOT_AUTHORIZED_JOIN_CI) {
    return {
      ok: false,
      reason:
        'AFFILIATE_JOIN_PILOT_CI must be ' +
        String(AFFILIATE_PILOT_AUTHORIZED_JOIN_CI) +
        ' for this pilot',
    };
  }

  const rawPhone = process.env.AFFILIATE_JOIN_PILOT_SMS_PHONE;
  if (rawPhone == null || String(rawPhone).trim() === '') {
    return { ok: false, reason: 'AFFILIATE_JOIN_PILOT_SMS_PHONE unset' };
  }
  const phoneDigits = normalizeDigits(String(rawPhone).trim());
  if (phoneDigits !== AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS) {
    return {
      ok: false,
      reason:
        'AFFILIATE_JOIN_PILOT_SMS_PHONE must be ' +
        AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS,
    };
  }

  return { ok: true };
}

module.exports = {
  AFFILIATE_PILOT_AUTHORIZED_JOIN_CI,
  AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS,
  validateAffiliatePilotJoinEnv,
};
