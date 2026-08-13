/**
 * Unit checks for CZ funnel tracking allowlist (no network).
 * node scripts/unit-cz-funnel-sanitize.js
 */

const assert = require('assert');
const {
  sanitizeTrackingDataSummary,
  TRACKING_SUMMARY_ALLOWLIST,
} = require('../src/lib/sanitizeCzTrackingData');

const raw = {
  utm_source: 'fb',
  utm_medium: 'cpc',
  utm_campaign: 'x',
  utm_content: 'y',
  utm_term: 'z',
  submitted_at: '2026-01-01T00:00:00Z',
  ip: '1.2.3.4',
  fbp: 'fb.1',
  fbc: 'fb.2',
  fbclid: 'abc',
  fbclid_init: '123',
  ga4_client_id: '9.9',
  gtag: 'G-X',
  gtm: 'GTM-X',
  ctwa_id: 'ct',
  user_agent: 'Mozilla',
  ua: 'Postman',
};

const out = sanitizeTrackingDataSummary(raw);
assert.deepStrictEqual(Object.keys(out).sort(), [...TRACKING_SUMMARY_ALLOWLIST].sort());
assert.strictEqual(out.utm_source, 'fb');
assert.strictEqual(out.ip, undefined);
assert.strictEqual(out.fbp, undefined);

const fromJson = sanitizeTrackingDataSummary(JSON.stringify(raw));
assert.strictEqual(fromJson.utm_campaign, 'x');
assert.strictEqual(fromJson.ga4_client_id, undefined);

assert.deepStrictEqual(sanitizeTrackingDataSummary(''), {});
assert.deepStrictEqual(sanitizeTrackingDataSummary(null), {});

console.log('OK unit-cz-funnel-sanitize');
