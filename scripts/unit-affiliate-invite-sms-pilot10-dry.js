'use strict';

/**
 * node scripts/unit-affiliate-invite-sms-pilot10-dry.js
 */

const assert = require('assert');
const {
  AFFILIATE_SMS_PILOT10_CIS,
  buildAffiliateSmsPilot10DryPlans,
  gsm7Septets,
  renderPilot10SmsText,
  sampleShortUrl,
} = require('../src/lib/affiliateInviteSmsPilot10');

assert.strictEqual(AFFILIATE_SMS_PILOT10_CIS.length, 10);
assert.deepStrictEqual(AFFILIATE_SMS_PILOT10_CIS.slice(0, 3), [
  55597953, 49825508, 18526448,
]);

const plan = buildAffiliateSmsPilot10DryPlans();
assert.strictEqual(plan.ok, true);
assert.strictEqual(plan.mode, 'dry-run');
assert.strictEqual(plan.tokens_minted, 0);
assert.strictEqual(plan.sms_sent, 0);
assert.strictEqual(plan.campaign.vertical, 'affiliates');
assert.strictEqual(plan.campaign.purpose, 'affiliate_program_invite');
assert.strictEqual(plan.recipients.length, 10);

const shortSample = sampleShortUrl('https://s.credizona.net');
assert.ok(shortSample.indexOf('s.credizona.net/s/') >= 0);

assert.strictEqual(plan.fits_single_gsm7_segment, true);
assert.strictEqual(plan.gsm7.encoding, 'GSM-7');
assert.ok(plan.gsm7.septets <= 160);

for (let i = 0; i < plan.recipients.length; i += 1) {
  const r = plan.recipients[i];
  assert.strictEqual(r.ci, AFFILIATE_SMS_PILOT10_CIS[i]);
  assert.ok(r.join_url.indexOf('t=DRY_RUN_INVITE_TOKEN_') >= 0);
  assert.ok(r.short_url.indexOf('s.credizona.net') >= 0);
  assert.strictEqual(r.source_system, 'affiliate_invite_sms');
  const gsm = gsm7Septets(r.sms_text);
  assert.strictEqual(gsm.encoding, 'GSM-7');
  assert.ok(gsm.septets <= 160);
}

const keys = plan.recipients.map(function (r) {
  return r.idempotency_key;
});
assert.strictEqual(new Set(keys).size, keys.length);

console.log('OK unit-affiliate-invite-sms-pilot10-dry');
