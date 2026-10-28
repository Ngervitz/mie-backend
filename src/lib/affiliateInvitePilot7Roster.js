'use strict';

/**
 * Hard-coded roster for the 7-recipient affiliate invite/join pilot.
 * Emails frozen from JANUS funnel validation (2026-10-28). Re-validate on --send.
 */

const { parseCi } = require('./affiliateDirectory');

/** CIs authorized for this pilot (preparation excludes the other 3 from the 10-CI list). */
const AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS = Object.freeze([
  54120325,
  29108021,
  52690534,
  34108109,
  32202553,
  37089910,
  51768867,
]);

const PILOT7_RECIPIENTS = Object.freeze([
  {
    key: 'p54120325',
    ci: 54120325,
    email: 'leonardozubi@gmail.com',
    cohort: 'preaprobado',
  },
  {
    key: 'p29108021',
    ci: 29108021,
    email: 'oanibalv@gmail.com',
    cohort: 'preaprobado',
  },
  {
    key: 'r52690534',
    ci: 52690534,
    email: 'lencivictor9@gmail.com',
    cohort: 'rechazado_encuesta',
  },
  {
    key: 'r34108109',
    ci: 34108109,
    email: 'chaio-33@hotmail.com',
    cohort: 'rechazado_encuesta',
  },
  {
    key: 'r32202553',
    ci: 32202553,
    email: 'bochastfb@hotmail.com',
    cohort: 'rechazado_encuesta',
  },
  {
    key: 'r37089910',
    ci: 37089910,
    email: 'paolagagliula@gmail.com',
    cohort: 'rechazado_encuesta',
  },
  {
    key: 'r51768867',
    ci: 51768867,
    email: 'desouzaromanluanayamila@gmail.com',
    cohort: 'rechazado_encuesta',
  },
]);

function pilot7AllowlistCsv() {
  return AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS.slice().join(',');
}

/**
 * Railway: set AFFILIATE_JOIN_PILOT_ALLOWLIST to this value (with AFFILIATE_JOIN_PILOT_CI unset).
 * @returns {{ ok: true, csv: string }|{ ok: false, reason: string }}
 */
function validateAffiliatePilot7JoinEnv() {
  const rawList = process.env.AFFILIATE_JOIN_PILOT_ALLOWLIST;
  if (rawList == null || String(rawList).trim() === '') {
    return { ok: false, reason: 'AFFILIATE_JOIN_PILOT_ALLOWLIST unset' };
  }
  if (String(process.env.AFFILIATE_JOIN_PILOT_CI || '').trim() !== '') {
    return {
      ok: false,
      reason:
        'AFFILIATE_JOIN_PILOT_CI must be unset for the 7-CI pilot (Nelson lock)',
    };
  }
  const parts = String(rawList)
    .split(/[,;\s]+/)
    .map(function (p) {
      return p.trim();
    })
    .filter(Boolean);
  const parsed = [];
  for (let i = 0; i < parts.length; i += 1) {
    const ci = parseCi(parts[i]);
    if (ci == null) {
      return { ok: false, reason: 'AFFILIATE_JOIN_PILOT_ALLOWLIST invalid CI' };
    }
    parsed.push(ci);
  }
  const expected = AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS.slice().sort(function (a, b) {
    return a - b;
  });
  const got = parsed.slice().sort(function (a, b) {
    return a - b;
  });
  if (got.length !== expected.length) {
    return { ok: false, reason: 'AFFILIATE_JOIN_PILOT_ALLOWLIST count mismatch' };
  }
  for (let j = 0; j < expected.length; j += 1) {
    if (got[j] !== expected[j]) {
      return { ok: false, reason: 'AFFILIATE_JOIN_PILOT_ALLOWLIST CI set mismatch' };
    }
  }
  if (String(process.env.AFFILIATE_JOIN_PILOT_SMS_PHONE || '').trim() !== '') {
    return {
      ok: false,
      reason:
        'AFFILIATE_JOIN_PILOT_SMS_PHONE must be unset (use funnel celular for each CI)',
    };
  }
  return { ok: true, csv: pilot7AllowlistCsv() };
}

module.exports = {
  AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS,
  PILOT7_RECIPIENTS,
  pilot7AllowlistCsv,
  validateAffiliatePilot7JoinEnv,
};
