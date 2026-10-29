'use strict';

/**
 * node scripts/unit-sms-campaign-classification.js
 */

const assert = require('assert');
const {
  SMS_VERTICALS,
  SMS_DEFAULT_VERTICAL,
  SMS_DEFAULT_PURPOSE,
  SMS_PURPOSES,
  parseSmsVertical,
  parseSmsPurpose,
  resolveSmsCampaignClassification,
  labelSmsVertical,
  labelSmsPurpose,
} = require('../src/lib/smsCampaignClassification');

assert.deepStrictEqual(SMS_VERTICALS, [
  'loans',
  'affiliates',
  'insurance',
  'ecommerce',
]);

assert.strictEqual(parseSmsVertical(null).vertical, SMS_DEFAULT_VERTICAL);
assert.strictEqual(parseSmsVertical('affiliates').vertical, 'affiliates');
assert.strictEqual(parseSmsVertical('INVALID').ok, false);

assert.strictEqual(parseSmsPurpose(null).purpose, SMS_DEFAULT_PURPOSE);
assert.strictEqual(parseSmsPurpose('affiliate_otp').purpose, SMS_PURPOSES.TRANSACTIONAL);
assert.strictEqual(parseSmsPurpose('transactional').purpose, SMS_PURPOSES.TRANSACTIONAL);
assert.strictEqual(parseSmsPurpose('test').purpose, SMS_PURPOSES.TEST);
assert.strictEqual(parseSmsPurpose('nope').ok, false);

const classif = resolveSmsCampaignClassification({
  vertical: 'affiliates',
  purpose: 'affiliate_program_invite',
});
assert.strictEqual(classif.vertical, 'affiliates');
assert.strictEqual(classif.purpose, 'affiliate_program_invite');

const legacy = resolveSmsCampaignClassification({});
assert.strictEqual(legacy.vertical, 'loans');
assert.strictEqual(legacy.purpose, 'loan_reactivation');

assert.strictEqual(labelSmsVertical('affiliates'), 'Afiliados');
assert.strictEqual(
  labelSmsPurpose('affiliate_program_invite'),
  'Invitación programa afiliados',
);

console.log('OK unit-sms-campaign-classification');
