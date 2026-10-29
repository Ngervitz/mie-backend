'use strict';

/**
 * node scripts/unit-sms-historical-classification.js
 */

const assert = require('assert');
const {
  resolveHistoricalSmsCampaignClassification,
  buildHistoricalClassificationAudit,
  isAffiliateOtpCampaignId,
  isHistoricalTestCampaignId,
  SMS_AFFILIATE_OTP_CAMPAIGN_IDS,
  SMS_HISTORICAL_TEST_CAMPAIGN_IDS,
} = require('../src/lib/smsCampaignHistoricalRegistry');
const { SMS_PURPOSES } = require('../src/lib/smsCampaignClassification');

const prev = process.env.AFFILIATE_TX_SMS_CAMPAIGN_ID;
process.env.AFFILIATE_TX_SMS_CAMPAIGN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const otpFromRegistry = SMS_AFFILIATE_OTP_CAMPAIGN_IDS[0];
assert.strictEqual(
  resolveHistoricalSmsCampaignClassification(otpFromRegistry).purpose,
  SMS_PURPOSES.TRANSACTIONAL,
);
assert.strictEqual(
  resolveHistoricalSmsCampaignClassification(otpFromRegistry).vertical,
  'affiliates',
);

const testId = SMS_HISTORICAL_TEST_CAMPAIGN_IDS[0];
assert.strictEqual(resolveHistoricalSmsCampaignClassification(testId).purpose, SMS_PURPOSES.TEST);
assert.ok(isHistoricalTestCampaignId(testId));

assert.strictEqual(
  resolveHistoricalSmsCampaignClassification('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').purpose,
  SMS_PURPOSES.TRANSACTIONAL,
);
assert.ok(isAffiliateOtpCampaignId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));

assert.strictEqual(
  resolveHistoricalSmsCampaignClassification('11111111-1111-4111-8111-111111111111').purpose,
  'loan_reactivation',
);

const audit = buildHistoricalClassificationAudit([
  { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'OTP bucket', created_at: '2026-10-01' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Loan wave 1', created_at: '2026-09-01' },
]);
assert.strictEqual(audit.campaigns.length, 2);
assert.strictEqual(audit.campaigns[0].proposed_purpose, 'loan_reactivation');
assert.strictEqual(audit.campaigns[1].proposed_purpose, SMS_PURPOSES.TRANSACTIONAL);

if (prev == null) delete process.env.AFFILIATE_TX_SMS_CAMPAIGN_ID;
else process.env.AFFILIATE_TX_SMS_CAMPAIGN_ID = prev;

console.log('OK unit-sms-historical-classification');
