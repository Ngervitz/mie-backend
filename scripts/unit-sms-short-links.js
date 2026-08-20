'use strict';

/**
 * node scripts/unit-sms-short-links.js
 */

const assert = require('assert');
const {
  SHORT_CODE_LENGTH,
  generateShortCode,
  composePublicShortUrl,
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

console.log('OK unit-sms-short-links');
