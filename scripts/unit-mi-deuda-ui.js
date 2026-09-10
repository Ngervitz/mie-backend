'use strict';

/**
 * Offline checks for Mi Deuda Stage 1E UI helpers + dashboard wiring.
 * Run: node scripts/unit-mi-deuda-ui.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const MD = require('../public/mi-deuda-helpers');

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

assert.ok(html.indexOf('mi-deuda-helpers.js') !== -1);
assert.ok(html.indexOf('id="mi-deuda-landing"') !== -1);
assert.ok(html.indexOf('id="mi-deuda-results"') !== -1);
assert.ok(html.indexOf('id="mi-deuda-exclusions"') !== -1);
assert.ok(html.indexOf('data-rechazados-view="mi-deuda"') !== -1);
assert.ok(html.indexOf('id="rechazados-chrome"') !== -1);
assert.ok(js.indexOf('initMiDeudaBags') !== -1);
assert.ok(js.indexOf('/rechazados/mi-deuda/bags') !== -1 || js.indexOf('bagsEndpointUrl') !== -1);
assert.ok(js.indexOf('Monto problemático conocido') !== -1);
assert.ok(js.indexOf('knownProblematicAmount') === -1); // logic lives in helpers
assert.ok(css.indexOf('mi-deuda-bags-table') !== -1);
assert.ok(css.indexOf('mi-deuda-exclusions') !== -1);

assert.strictEqual(
  MD.knownProblematicAmount({
    moroso_mn: 100,
    moroso_me: 20,
    castigado_mn: 3,
    castigado_me: 4,
    reestructurado_mn: 999,
    reestructurado_me: 888,
  }),
  127,
);

assert.strictEqual(
  MD.knownProblematicAmount({
    moroso_mn: null,
    moroso_me: null,
    castigado_mn: null,
    castigado_me: null,
    reestructurado_mn: 500,
  }),
  null,
);

assert.strictEqual(
  MD.knownProblematicAmount({
    moroso_mn: null,
    moroso_me: 10,
    castigado_mn: null,
    castigado_me: null,
  }),
  10,
);

assert.strictEqual(
  MD.knownProblematicAmount({
    moroso_mn: 0,
    moroso_me: 0,
    castigado_mn: 0,
    castigado_me: 0,
  }),
  0,
);

const sorted = MD.sortBagsForUi([
  { institution_canonical: 'B', people_count: 2, moroso_mn: 999 },
  { institution_canonical: 'A', people_count: 2, moroso_mn: 1 },
  { institution_canonical: 'Z', people_count: 5, moroso_mn: 0 },
]);
assert.deepStrictEqual(
  sorted.map(function (b) {
    return b.institution_canonical;
  }),
  ['Z', 'A', 'B'],
);

assert.strictEqual(MD.exclusionsWarningMessage(0, 0), null);
assert.strictEqual(
  MD.exclusionsWarningMessage(3, 1),
  'Hay 3 registros sin institución canónica y 1 caso ambiguo excluidos de estas bolsas.',
);
assert.strictEqual(
  MD.exclusionsWarningMessage(1, 0),
  'Hay 1 registro sin institución canónica excluido de estas bolsas.',
);
assert.strictEqual(
  MD.exclusionsWarningMessage(0, 2),
  'Hay 2 casos ambiguos excluidos de estas bolsas.',
);

assert.strictEqual(
  MD.bagsEndpointUrl(''),
  '/rechazados/mi-deuda/bags',
);

const rows = MD.buildBagTableRows([
  {
    institution_canonical: 'SOCUR S.A.',
    people_count: 4,
    moroso_mn: 100,
    moroso_me: null,
    castigado_mn: 50,
    castigado_me: 0,
    reestructurado_mn: 9,
  },
  {
    institution_canonical: 'CASH S.A.',
    people_count: 4,
    moroso_mn: 10,
    moroso_me: 5,
    castigado_mn: null,
    castigado_me: null,
  },
]);
assert.strictEqual(rows.length, 2);
assert.strictEqual(rows[0].institution_canonical, 'CASH S.A.'); // alpha tie-break
assert.strictEqual(rows[0].monto_problematico_conocido, 15);
assert.strictEqual(rows[1].monto_problematico_conocido, 150);
assert.ok(!('members' in rows[0]));
assert.strictEqual(rows[0].moroso_mn, 10);
assert.strictEqual(rows[0].castigado_me, null);

assert.strictEqual(
  MD.countReestructuradoOutside([
    { also_bag_member: false },
    { also_bag_member: true },
    { also_bag_member: false },
  ]),
  2,
);

assert.ok(MD.formatMoneyUy(null) === '—');
assert.ok(MD.formatMoneyUy(100).indexOf('$') === 0);

console.log('unit-mi-deuda-ui: PASS');
