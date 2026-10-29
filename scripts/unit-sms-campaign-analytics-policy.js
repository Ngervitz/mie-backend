'use strict';

/**
 * node scripts/unit-sms-campaign-analytics-policy.js
 */

const assert = require('assert');
const {
  isSmsTransactionalPurpose,
  isSmsTestPurpose,
  isSmsCommercialPerformancePurpose,
  isSmsCommercialPerformanceCampaign,
} = require('../src/lib/smsCampaignAnalyticsPolicy');

assert.strictEqual(isSmsTransactionalPurpose('transactional'), true);
assert.strictEqual(isSmsTransactionalPurpose('affiliate_otp'), true);
assert.strictEqual(isSmsTestPurpose('test'), true);
assert.strictEqual(isSmsCommercialPerformancePurpose('affiliate_program_invite'), true);
assert.strictEqual(isSmsCommercialPerformancePurpose('transactional'), false);
assert.strictEqual(isSmsCommercialPerformancePurpose('test'), false);

assert.strictEqual(
  isSmsCommercialPerformanceCampaign({ id: 'x', purpose: 'loan_reactivation' }),
  true,
);
assert.strictEqual(
  isSmsCommercialPerformanceCampaign({ id: 'x', purpose: 'transactional' }),
  false,
);

console.log('OK unit-sms-campaign-analytics-policy');
