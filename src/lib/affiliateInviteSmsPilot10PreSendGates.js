'use strict';

/**
 * Env operational switches before affiliate SMS pilot 10 dispatch.
 * Published bases and E2E attribution are verified manually after deploy, before enabling dispatch.
 */

const { resolveConfiguredTermsVersion } = require('./affiliateJoinContract');

function evaluateAffiliateSmsPilot10PreSendGates(env) {
  const e = env || process.env;
  const blockers = [];

  const termsVersion = resolveConfiguredTermsVersion(e.AFFILIATE_TERMS_VERSION);
  if (termsVersion !== 'affiliate_v3') {
    blockers.push({
      code: 'A_TERMS_VERSION',
      detail: 'AFFILIATE_TERMS_VERSION must resolve to affiliate_v3 (got ' + termsVersion + ')',
    });
  }

  if (String(e.AFFILIATE_V3_TERMS_PUBLISHED || '').trim().toLowerCase() !== 'true') {
    blockers.push({
      code: 'A_TERMS_NOT_PUBLISHED',
      detail: 'Set AFFILIATE_V3_TERMS_PUBLISHED=true after affiliate_v3 bases are live',
    });
  }

  if (String(e.AFFILIATE_JOIN_ENABLED || '').trim().toLowerCase() !== 'true') {
    blockers.push({
      code: 'A_JOIN_DISABLED',
      detail: 'AFFILIATE_JOIN_ENABLED must be true',
    });
  }

  if (String(e.AFFILIATE_PILOT10_E2E_TEST_PASSED || '').trim().toLowerCase() !== 'true') {
    blockers.push({
      code: 'B_E2E_NOT_PASSED',
      detail:
        'Set AFFILIATE_PILOT10_E2E_TEST_PASSED=true after is_test=true E2E (link, click, solicitud, no real commission)',
    });
  }

  return {
    ok: blockers.length === 0,
    blockers: blockers,
  };
}

module.exports = {
  evaluateAffiliateSmsPilot10PreSendGates,
};
