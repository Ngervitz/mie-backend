'use strict';

/**
 * Afiliados dashboard KPI aggregates + UI wiring.
 * Run: node scripts/unit-affiliate-dashboard-summary.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  EXCLUSION_OUTCOMES,
  isAffiliateAdhesionValidated,
} = require('../src/lib/affiliateDirectory');
const read = require('../src/lib/affiliateDirectoryRead');

assert.ok(typeof read.aggregateAffiliateDashboardSummary === 'function');

assert.strictEqual(
  isAffiliateAdhesionValidated({
    is_test: false,
    status: 'active',
    accepted_at: '2026-10-28T12:00:00.000Z',
    terms_version: 'affiliate_v3',
    acceptance_evidence: 'invite:abc|otp:def|terms:affiliate_v3',
  }),
  true,
);
assert.strictEqual(
  isAffiliateAdhesionValidated({
    is_test: false,
    status: 'active',
    accepted_at: '2026-10-28T12:00:00.000Z',
    terms_version: 'affiliate_v3',
    acceptance_evidence: 'manual acta',
  }),
  false,
);

const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/affiliates-admin.js'),
  'utf8',
);
assert.ok(routeSrc.indexOf("router.get('/summary'") !== -1);
assert.ok(routeSrc.indexOf('aggregateAffiliateDashboardSummary') !== -1);

const html = fs.readFileSync(
  path.join(__dirname, '../public/mie-dashboard.html'),
  'utf8',
);
const js = fs.readFileSync(
  path.join(__dirname, '../public/mie-dashboard.js'),
  'utf8',
);
assert.ok(html.indexOf('id="affiliates-summary-root"') !== -1);
assert.ok(html.indexOf('20261028-affiliates-kpi-compact') !== -1);
assert.ok(js.indexOf("afFetch('/affiliates/summary')") !== -1);
assert.ok(js.indexOf('affiliates-kpi-grid') !== -1);
assert.ok(js.indexOf('Invitaciones enviadas') !== -1);
assert.ok(js.indexOf("'Validados'") !== -1);

assert.ok(EXCLUSION_OUTCOMES.indexOf('no_click') === -1);

console.log('unit-affiliate-dashboard-summary: ok');
