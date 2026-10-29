'use strict';

/**
 * node scripts/unit-affiliate-sms-pilot10-pre-send-gates.js
 */

const assert = require('assert');
const { evaluateAffiliateSmsPilot10PreSendGates } = require('../src/lib/affiliateInviteSmsPilot10PreSendGates');

const base = {
  AFFILIATE_TERMS_VERSION: 'affiliate_v3',
  AFFILIATE_V3_TERMS_PUBLISHED: 'true',
  AFFILIATE_JOIN_ENABLED: 'true',
  AFFILIATE_PILOT10_E2E_TEST_PASSED: 'true',
};

assert.strictEqual(evaluateAffiliateSmsPilot10PreSendGates(base).ok, true);

const blocked = evaluateAffiliateSmsPilot10PreSendGates(
  Object.assign({}, base, { AFFILIATE_PILOT10_E2E_TEST_PASSED: 'false' }),
);
assert.strictEqual(blocked.ok, false);
assert.ok(
  blocked.blockers.some(function (b) {
    return b.code === 'B_E2E_NOT_PASSED';
  }),
);

console.log('OK unit-affiliate-sms-pilot10-pre-send-gates');
