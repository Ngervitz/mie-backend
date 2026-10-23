/**
 * Unit checks for CZ funnel tracking allowlist (no network).
 * node scripts/unit-cz-funnel-sanitize.js
 */

const assert = require('assert');
const {
  sanitizeTrackingDataSummary,
  TRACKING_SUMMARY_ALLOWLIST,
  TRACKING_SUMMARY_COPY_KEYS,
  JT_RE,
  normalizeJt,
} = require('../src/lib/sanitizeCzTrackingData');

assert.ok(TRACKING_SUMMARY_ALLOWLIST.includes('jt'));
assert.ok(!TRACKING_SUMMARY_COPY_KEYS.includes('jt'));
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

const tagged = sanitizeTrackingDataSummary(
  Object.assign({}, raw, {
    seo_landing: '  Prestamo-Cedula  ',
    seo_cta: ' HERO ',
    attribution_source: 'utm',
  }),
);
assert.strictEqual(tagged.seo_landing, 'prestamo-cedula');
assert.strictEqual(tagged.seo_cta, 'hero');
assert.strictEqual(tagged.utm_source, 'fb');
assert.strictEqual(tagged.utm_medium, 'cpc');
assert.strictEqual(tagged.utm_campaign, 'x');
assert.strictEqual(tagged.utm_content, 'y');
assert.strictEqual(tagged.utm_term, 'z');
assert.strictEqual(tagged.submitted_at, '2026-01-01T00:00:00Z');
assert.strictEqual(tagged.attribution_source, undefined);
assert.strictEqual(tagged.fbclid, undefined);

assert.strictEqual(
  sanitizeTrackingDataSummary({ seo_landing: 'otra-landing', seo_cta: 'footer' }).seo_cta,
  'footer',
);
assert.strictEqual(
  sanitizeTrackingDataSummary({ utm_source: 'sms', seo_cta: 'button' }).seo_cta,
  undefined,
);
assert.strictEqual(
  sanitizeTrackingDataSummary({ utm_source: 'sms', seo_cta: 'button' }).utm_source,
  'sms',
);
assert.strictEqual(
  sanitizeTrackingDataSummary({ seo_landing: 'a_b', seo_cta: 'hero' }).seo_landing,
  undefined,
);
assert.strictEqual(
  sanitizeTrackingDataSummary({ seo_landing: '-bad', seo_cta: 'hero' }).seo_landing,
  undefined,
);
assert.strictEqual(
  sanitizeTrackingDataSummary({ seo_landing: 'a--b', seo_cta: 'hero' }).seo_landing,
  undefined,
);
assert.strictEqual(
  sanitizeTrackingDataSummary({ seo_landing: 'a'.repeat(201), seo_cta: 'hero' }).seo_landing,
  undefined,
);
assert.strictEqual(
  sanitizeTrackingDataSummary({ seo_landing: 'a'.repeat(200), seo_cta: 'hero' }).seo_landing,
  'a'.repeat(200),
);
assert.strictEqual(sanitizeTrackingDataSummary({ seo_landing: 12, seo_cta: null }).seo_landing, undefined);
assert.strictEqual(sanitizeTrackingDataSummary({ seo_cta: null }).seo_cta, undefined);
assert.strictEqual(
  sanitizeTrackingDataSummary({ seo_landing: 'prestamo-cedula', seo_cta: 'side' }).seo_landing,
  'prestamo-cedula',
);
assert.strictEqual(
  sanitizeTrackingDataSummary({ seo_landing: 'prestamo-cedula', seo_cta: 'side' }).seo_cta,
  undefined,
);

const previous = sanitizeTrackingDataSummary({
  utm_source: 'fb',
  utm_medium: 'paid',
  submitted_at: '2026-01-01T00:00:00Z',
});
assert.strictEqual(previous.utm_source, 'fb');
assert.strictEqual(previous.utm_medium, 'paid');
assert.strictEqual(previous.seo_landing, undefined);
assert.strictEqual(previous.seo_cta, undefined);

console.log('OK unit-cz-funnel-sanitize');
