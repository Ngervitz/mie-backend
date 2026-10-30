'use strict';

const assert = require('assert');
const {
  summarizeAcquisitionCost,
  loteSmsCostExVat,
} = require('../src/lib/affiliateSmsAcquisitionCost');

const invite = [{ czuid: '10' }, { czuid: '20' }];
const related = [
  { czuid: '10', source_system: 'affiliate_otp', status: 'DELIVERED' },
  { czuid: '10', source_system: 'affiliate_otp', status: 'pending' },
  { czuid: '20', source_system: 'affiliate_welcome', status: 'DELIVERED' },
  { czuid: '99', source_system: 'affiliate_otp', status: 'DELIVERED' },
  { czuid: '20', source_system: 'affiliate_invite_sms', status: 'DELIVERED' },
];

const summary = summarizeAcquisitionCost(invite, related, 1.28);
assert.strictEqual(summary.otp_delivered, 1);
assert.strictEqual(summary.otp_not_delivered, 1);
assert.strictEqual(summary.welcome_sms_delivered, 1);
assert.strictEqual(summary.welcome_sms_not_delivered, 0);
assert.strictEqual(summary.otp_cost_ex_vat, 1.28);
assert.strictEqual(summary.welcome_sms_cost_ex_vat, 1.28);
assert.strictEqual(summary.emails_included, false);
assert.strictEqual(loteSmsCostExVat(128, summary), 130.56);

const again = summarizeAcquisitionCost(invite, related, 1.28);
assert.strictEqual(again.otp_delivered, summary.otp_delivered);
assert.strictEqual(loteSmsCostExVat(null, summary), null);

console.log('OK unit-affiliate-sms-acquisition-cost');
