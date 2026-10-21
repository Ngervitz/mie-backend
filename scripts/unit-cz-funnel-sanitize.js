/**
 * Unit checks for CZ funnel tracking allowlist (no network).
 * node scripts/unit-cz-funnel-sanitize.js
 */

const assert = require('assert');
const {
  sanitizeTrackingDataSummary,
  applyJtFirstValidWins,
  TRACKING_SUMMARY_ALLOWLIST,
  TRACKING_SUMMARY_COPY_KEYS,
  JT_RE,
  normalizeJt,
} = require('../src/lib/sanitizeCzTrackingData');

const CLICK_A = '22222222-2222-4222-8222-222222222222';
const CLICK_B = '33333333-3333-4333-8333-333333333333';
const PRESENTED = '2026-10-21T11:21:00-03:00';

assert.ok(TRACKING_SUMMARY_ALLOWLIST.includes('jt'));
assert.ok(TRACKING_SUMMARY_ALLOWLIST.includes('cz_click'));
assert.ok(TRACKING_SUMMARY_ALLOWLIST.includes('presentation_at'));
assert.ok(!TRACKING_SUMMARY_COPY_KEYS.includes('jt'));
assert.ok(!TRACKING_SUMMARY_COPY_KEYS.includes('cz_click'));
assert.ok(!TRACKING_SUMMARY_COPY_KEYS.includes('presentation_at'));
assert.ok(JT_RE.test('AAAAAAAAAAAAAAAAAAAAAA'));

const VALID_JT = 'AAAAAAAAAAAAAAAAAAAAAA';
assert.strictEqual(VALID_JT.length, 22);

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
assert.deepStrictEqual(Object.keys(out).sort(), [...TRACKING_SUMMARY_COPY_KEYS].sort());
assert.strictEqual(out.utm_source, 'fb');
assert.strictEqual(out.ip, undefined);
assert.strictEqual(out.fbp, undefined);
assert.strictEqual(out.jt, undefined);

const fromJson = sanitizeTrackingDataSummary(JSON.stringify(raw));
assert.strictEqual(fromJson.utm_campaign, 'x');
assert.strictEqual(fromJson.ga4_client_id, undefined);
assert.strictEqual(fromJson.jt, undefined);

assert.deepStrictEqual(sanitizeTrackingDataSummary(''), {});
assert.deepStrictEqual(sanitizeTrackingDataSummary(null), {});

const withValidJt = sanitizeTrackingDataSummary(
  Object.assign({}, raw, { jt: VALID_JT }),
);
assert.strictEqual(withValidJt.jt, VALID_JT);
assert.strictEqual(withValidJt.utm_source, 'fb');
assert.strictEqual(withValidJt.ip, undefined);

const padded = sanitizeTrackingDataSummary({ jt: '  ' + VALID_JT + '  ' });
assert.strictEqual(padded.jt, VALID_JT);

assert.strictEqual(sanitizeTrackingDataSummary({ utm_source: 'sms' }).jt, undefined);
assert.strictEqual(sanitizeTrackingDataSummary({ jt: null }).jt, undefined);
assert.strictEqual(sanitizeTrackingDataSummary({ jt: '' }).jt, undefined);
assert.strictEqual(sanitizeTrackingDataSummary({ jt: '   ' }).jt, undefined);
assert.strictEqual(sanitizeTrackingDataSummary({ jt: 'A'.repeat(21) }).jt, undefined);
assert.strictEqual(sanitizeTrackingDataSummary({ jt: 'A'.repeat(23) }).jt, undefined);
assert.strictEqual(sanitizeTrackingDataSummary({ jt: 'AAAAAAAAAAAAAAAAAAA+++' }).jt, undefined);
assert.strictEqual(normalizeJt(null), null);
assert.strictEqual(normalizeJt(1), null);

const utmsUnchanged = sanitizeTrackingDataSummary(
  Object.assign({}, raw, { jt: 'nope' }),
);
assert.deepStrictEqual(
  Object.keys(utmsUnchanged).sort(),
  [...TRACKING_SUMMARY_COPY_KEYS].sort(),
);
assert.strictEqual(utmsUnchanged.utm_medium, 'cpc');

const attributed = sanitizeTrackingDataSummary(
  Object.assign({}, raw, {
    cz_click: '  ' + CLICK_A.toUpperCase() + ' ',
    presentation_at: PRESENTED,
    ip: '203.0.113.8',
  }),
);
assert.strictEqual(attributed.cz_click, CLICK_A);
assert.strictEqual(attributed.presentation_at, PRESENTED);
assert.strictEqual(attributed.utm_source, 'fb');
assert.strictEqual(attributed.utm_medium, 'cpc');
assert.strictEqual(attributed.jt, undefined);
assert.strictEqual(attributed.ip, undefined);

assert.strictEqual(
  sanitizeTrackingDataSummary({ cz_click: 'not-a-uuid', utm_source: 'sms' }).cz_click,
  undefined,
);
assert.strictEqual(
  sanitizeTrackingDataSummary({
    utm_source: 'sms',
    presentation_at: '2026-10-21 11:21:00',
  }).presentation_at,
  undefined,
);
assert.strictEqual(
  sanitizeTrackingDataSummary({
    utm_source: 'email',
    presentation_at: '2026-10-21T14:21:00Z',
  }).presentation_at,
  '2026-10-21T14:21:00Z',
);
assert.strictEqual(
  sanitizeTrackingDataSummary({ utm_source: 'email' }).utm_source,
  'email',
);

const kept = applyJtFirstValidWins(
  7,
  { utm_source: 'meta', cz_click: CLICK_B, presentation_at: '2026-10-22T11:21:00-03:00' },
  null,
  { utm_source: 'sms', cz_click: CLICK_A, presentation_at: PRESENTED, jt: VALID_JT },
);
assert.strictEqual(kept.tracking_data_summary.utm_source, 'meta');
assert.strictEqual(kept.tracking_data_summary.cz_click, CLICK_A);
assert.strictEqual(kept.tracking_data_summary.presentation_at, PRESENTED);
assert.strictEqual(kept.tracking_data_summary.jt, undefined);

const filled = applyJtFirstValidWins(
  8,
  sanitizeTrackingDataSummary({
    utm_source: 'sms',
    cz_click: CLICK_B,
    presentation_at: PRESENTED,
    jt: VALID_JT,
  }),
  null,
  {},
);
assert.strictEqual(filled.tracking_data_summary.cz_click, CLICK_B);
assert.strictEqual(filled.tracking_data_summary.presentation_at, PRESENTED);
assert.strictEqual(filled.tracking_data_summary.utm_source, 'sms');
assert.strictEqual(filled.tracking_data_summary.jt, VALID_JT);

console.log('OK unit-cz-funnel-sanitize');
