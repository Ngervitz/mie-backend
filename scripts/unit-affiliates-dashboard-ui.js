'use strict';

/**
 * Offline wiring for Afiliados V1 dashboard UI.
 * Run: node scripts/unit-affiliates-dashboard-ui.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '../public/mie-dashboard.html'),
  'utf8',
);
const js = fs.readFileSync(
  path.join(__dirname, '../public/mie-dashboard.js'),
  'utf8',
);
const css = fs.readFileSync(
  path.join(__dirname, '../public/mie-dashboard.css'),
  'utf8',
);

assert.ok(
  html.indexOf('?v=20261029-affiliates-directory') !== -1,
  'cache bust affiliates directory refresh',
);
assert.ok(html.indexOf('id="affiliates-summary-root"') !== -1);
assert.ok(js.indexOf("afFetch('/affiliates/summary')") !== -1);
assert.ok(js.indexOf('affiliates-kpi-grid--primary') !== -1);
assert.ok(js.indexOf('Invitaciones enviadas por email') !== -1);
assert.ok(js.indexOf('Afiliados activos') !== -1);
assert.ok(js.indexOf('Solicitudes excluidas') !== -1);
assert.ok(js.indexOf('excluded_count') !== -1);
assert.ok(js.indexOf('afDisplayName') !== -1);
assert.ok(html.indexOf('data-dashboard-tab="affiliates"') !== -1);
assert.ok(html.indexOf('id="affiliates-panel"') !== -1);
assert.ok(js.indexOf('affiliates-compact-table') !== -1);
assert.ok(js.indexOf('Adhesión validada') !== -1);
assert.ok(js.indexOf('affiliates-adhesion-valid') !== -1);
assert.ok(js.indexOf('loadOverviewTotals') === -1);
assert.ok(css.indexOf('.affiliates-col-stat') !== -1);
assert.ok(css.indexOf('.affiliates-person-name') !== -1);
assert.ok(css.indexOf('.affiliates-kpi-grid--primary') !== -1);
assert.ok(
  html.indexOf("affiliates: document.getElementById('affiliates-panel')") !== -1,
);
assert.ok(/SECTION_ORDER = \[[\s\S]*?'cz-funnel',\s*'affiliates'/m.test(html));
assert.ok(html.indexOf("sectionKey === 'affiliates'") !== -1);
assert.ok(html.indexOf("allowedSet['cz-funnel']") !== -1);
assert.ok(html.indexOf("name === 'affiliates'") !== -1);

assert.ok(js.indexOf('initAffiliatesPanel') !== -1);
assert.ok(js.indexOf('window.__openAffiliates') !== -1);
assert.ok(js.indexOf("afFetch('/affiliates'") !== -1);
assert.ok(js.indexOf('/affiliates/pending-attributions') !== -1);
assert.ok(js.indexOf('/affiliates/') !== -1);
assert.ok(js.indexOf('affiliateListHtml') !== -1);

assert.ok(css.indexOf('.affiliates-pending') !== -1);
assert.ok(css.indexOf('.affiliates-kpi-grid') !== -1);
assert.ok(css.indexOf('.af-col') !== -1);

console.log('unit-affiliates-dashboard-ui: ok');
