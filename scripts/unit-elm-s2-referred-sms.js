'use strict';

/**
 * ELM S2 referred SMS helpers (no Notifyme).
 * node scripts/unit-elm-s2-referred-sms.js
 */

const assert = require('assert');
const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
    apifyToken: 'test',
    apifyActorId: 'test',
    sessionSecret: 'test-session',
    cronSecret: null,
  },
};

const { S2, CODES } = require('../src/services/elm/constants');
const { gsm7Septets, smsSegmentsGsm7 } = require('../src/lib/affiliateInviteSmsPilot10');
const {
  MESSAGE_TEXT,
  phoneFromS2Request,
  isEligibleForSms,
  readElmS2ReferredSmsConfig,
  SOURCE_SYSTEM,
} = require('../src/lib/elmS2ReferredSms');

assert.equal(SOURCE_SYSTEM, 'elm_s2_referred');
assert.ok(MESSAGE_TEXT.includes('Préstamos en la Mano'));
const gsm = gsm7Septets(MESSAGE_TEXT);
assert.equal(gsm.encoding, 'GSM-7', 'expected GSM-7: ' + (gsm.invalid_char || ''));
assert.equal(smsSegmentsGsm7(gsm.septets), 1, 'septets=' + gsm.septets);

const referred = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  s2_status: S2.REFERRED,
  referred_at: '2026-11-20T12:00:00.000Z',
  s2_request: { mobilephone: '091234567', email: 'a@b.com' },
  ci: 12345678,
};
assert.equal(phoneFromS2Request(referred), '091234567');
assert.equal(isEligibleForSms(referred), true);

const dupChannel = Object.assign({}, referred, {
  s1_error_code: CODES.S1_DUPLICATE_OTHER_CHANNEL,
});
assert.equal(isEligibleForSms(dupChannel), false);

const noPhone = Object.assign({}, referred, { s2_request: { email: 'x@y.com' } });
assert.equal(phoneFromS2Request(noPhone), null);

const cfg = readElmS2ReferredSmsConfig({});
assert.equal(cfg.enabled, false);
assert.equal(cfg.sendEnabled, false);

console.log('unit-elm-s2-referred-sms: OK');