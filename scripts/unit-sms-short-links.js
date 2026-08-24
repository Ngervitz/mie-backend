'use strict';

/**
 * node scripts/unit-sms-short-links.js
 */

const assert = require('assert');
const {
  SHORT_CODE_LENGTH,
  generateShortCode,
  composePublicShortUrl,
  appendTrackingToken,
} = require('../src/lib/smsTinyUrl');

assert.strictEqual(SHORT_CODE_LENGTH, 6);

const a = generateShortCode();
const b = generateShortCode();
assert.strictEqual(a.length, 6);
assert.strictEqual(b.length, 6);
assert.match(a, /^[A-Za-z0-9]{6}$/);
assert.match(b, /^[A-Za-z0-9]{6}$/);
assert.ok(a !== b || generateShortCode() !== a, 'codes should vary');

const prev = process.env.SMS_SHORT_LINK_BASE_URL;
delete process.env.SMS_SHORT_LINK_BASE_URL;
assert.strictEqual(
  composePublicShortUrl('AbC234'),
  'https://mie-backend-production.up.railway.app/s/AbC234',
);

process.env.SMS_SHORT_LINK_BASE_URL = 'https://cz.uy/';
assert.strictEqual(composePublicShortUrl('AbC234'), 'https://cz.uy/s/AbC234');
process.env.SMS_SHORT_LINK_BASE_URL = 'https://cz.uy';
assert.strictEqual(composePublicShortUrl('AbC234'), 'https://cz.uy/s/AbC234');

if (prev == null) delete process.env.SMS_SHORT_LINK_BASE_URL;
else process.env.SMS_SHORT_LINK_BASE_URL = prev;

const token = 'abcdefghijABCDEFGHIJ12';
assert.strictEqual(token.length, 22);
const withUtms = appendTrackingToken(
  'https://cz.uy/x?utm_source=sms&utm_medium=sms&utm_campaign=camp-1#sec',
  token,
);
const withUtmsUrl = new URL(withUtms);
assert.strictEqual(withUtmsUrl.searchParams.get('utm_source'), 'sms');
assert.strictEqual(withUtmsUrl.searchParams.get('utm_medium'), 'sms');
assert.strictEqual(withUtmsUrl.searchParams.get('utm_campaign'), 'camp-1');
assert.strictEqual(withUtmsUrl.searchParams.get('jt'), token);
assert.strictEqual(withUtmsUrl.hash, '#sec');

const replaced = appendTrackingToken(
  'https://cz.uy/x?jt=oldtokenoldtokenoldtok&utm_source=sms',
  token,
);
const replacedUrl = new URL(replaced);
assert.strictEqual(replacedUrl.searchParams.get('jt'), token);
assert.strictEqual(replacedUrl.searchParams.get('utm_source'), 'sms');

assert.throws(function () {
  appendTrackingToken('not-a-url', token);
});

console.log('OK unit-sms-short-links');
