'use strict';

/**
 * node scripts/unit-affiliate-join-pilot-roster.js
 */

const assert = require('assert');
const {
  AFFILIATE_PILOT_AUTHORIZED_JOIN_CI,
  AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS,
  validateAffiliatePilotJoinEnv,
} = require('../src/lib/affiliateJoinPilotRoster');
const {
  isCiAllowedForAffiliateJoin,
  resolvePilotSmsPhoneOverride,
} = require('../src/lib/affiliateJoinPilot');

delete process.env.AFFILIATE_JOIN_PILOT_CI;
delete process.env.AFFILIATE_JOIN_PILOT_SMS_PHONE;

assert.strictEqual(AFFILIATE_PILOT_AUTHORIZED_JOIN_CI, 19118189);
assert.strictEqual(AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS, '59893885859');
assert.strictEqual(validateAffiliatePilotJoinEnv().ok, false);

process.env.AFFILIATE_JOIN_PILOT_CI = '19118189';
assert.strictEqual(validateAffiliatePilotJoinEnv().ok, false);

process.env.AFFILIATE_JOIN_PILOT_SMS_PHONE = '59893885859';
assert.strictEqual(validateAffiliatePilotJoinEnv().ok, true);

process.env.AFFILIATE_JOIN_PILOT_CI = '42424242';
assert.strictEqual(validateAffiliatePilotJoinEnv().ok, false);

process.env.AFFILIATE_JOIN_PILOT_CI = '19118189';
assert.strictEqual(isCiAllowedForAffiliateJoin(19118189), true);
assert.strictEqual(isCiAllowedForAffiliateJoin(25167491), false);
assert.strictEqual(
  resolvePilotSmsPhoneOverride(19118189),
  AFFILIATE_PILOT_AUTHORIZED_SMS_DIGITS,
);
assert.strictEqual(resolvePilotSmsPhoneOverride(25167491), null);

process.env.AFFILIATE_JOIN_PILOT_SMS_PHONE = '59899999999';
assert.strictEqual(resolvePilotSmsPhoneOverride(19118189), null);

delete process.env.AFFILIATE_JOIN_PILOT_CI;
delete process.env.AFFILIATE_JOIN_PILOT_SMS_PHONE;

console.log('unit-affiliate-join-pilot-roster: ok');
