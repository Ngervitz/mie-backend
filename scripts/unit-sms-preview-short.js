'use strict';

/**
 * node scripts/unit-sms-preview-short.js
 */

const assert = require('assert');
const {
  PREVIEW_UTM_CAMPAIGN_UUID,
  composeFinalUrl,
  getOrCreatePreviewShortUrl,
  clearPreviewShortCache,
} = require('../src/lib/smsTinyUrl');

assert.strictEqual(
  PREVIEW_UTM_CAMPAIGN_UUID,
  '00000000-0000-4000-8000-000000000001',
);

const destA = 'https://ejemplo.com/landing';
const destASpaced = '  https://ejemplo.com/landing  ';
const destB = 'https://ejemplo.com/otra';

clearPreviewShortCache();

(async () => {
  const calls = [];
  async function mockShorten(longUrl) {
    calls.push(longUrl);
    return { shortUrl: 'https://tinyurl.com/preview-a', reason: null };
  }

  const first = await getOrCreatePreviewShortUrl(destA, { shorten: mockShorten });
  assert.strictEqual(first.cached, false);
  assert.strictEqual(first.shortUrl, 'https://tinyurl.com/preview-a');
  assert.strictEqual(calls.length, 1);
  assert.ok(
    calls[0].includes('utm_campaign=' + PREVIEW_UTM_CAMPAIGN_UUID),
    'preview must shorten the URL with the fixed UUID',
  );
  assert.strictEqual(
    first.previewUrl,
    composeFinalUrl(destA, PREVIEW_UTM_CAMPAIGN_UUID),
  );

  const second = await getOrCreatePreviewShortUrl(destASpaced, {
    shorten: mockShorten,
  });
  assert.strictEqual(second.cached, true);
  assert.strictEqual(second.shortUrl, 'https://tinyurl.com/preview-a');
  assert.strictEqual(calls.length, 1, 'same destination must not call TinyURL again');

  async function mockShortenB(longUrl) {
    calls.push(longUrl);
    return { shortUrl: 'https://tinyurl.com/preview-b', reason: null };
  }
  const other = await getOrCreatePreviewShortUrl(destB, { shorten: mockShortenB });
  assert.strictEqual(other.cached, false);
  assert.strictEqual(other.shortUrl, 'https://tinyurl.com/preview-b');
  assert.strictEqual(calls.length, 2, 'a different destination generates a new preview');

  clearPreviewShortCache();
  let failCalls = 0;
  async function mockFail() {
    failCalls += 1;
    return { shortUrl: null, reason: 'TinyURL HTTP 429' };
  }
  const failed = await getOrCreatePreviewShortUrl(destA, { shorten: mockFail });
  assert.strictEqual(failed.shortUrl, null);
  assert.strictEqual(failed.cached, false);
  const retry = await getOrCreatePreviewShortUrl(destA, { shorten: mockFail });
  assert.strictEqual(failCalls, 2, 'failed previews must not be cached');
  assert.strictEqual(retry.shortUrl, null);

  clearPreviewShortCache();
  let inflightCalls = 0;
  async function mockSlow(longUrl) {
    inflightCalls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { shortUrl: 'https://tinyurl.com/preview-race', reason: null };
  }
  const [r1, r2] = await Promise.all([
    getOrCreatePreviewShortUrl(destA, { shorten: mockSlow }),
    getOrCreatePreviewShortUrl(destA, { shorten: mockSlow }),
  ]);
  assert.strictEqual(inflightCalls, 1, 'concurrent same-destination previews share one TinyURL call');
  assert.strictEqual(r1.shortUrl, 'https://tinyurl.com/preview-race');
  assert.strictEqual(r2.shortUrl, 'https://tinyurl.com/preview-race');

  console.log('OK unit-sms-preview-short');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
