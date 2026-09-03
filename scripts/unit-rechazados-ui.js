'use strict';

/**
 * Offline checks for Rechazados V0 UI helpers + static dashboard wiring.
 * Run: node scripts/unit-rechazados-ui.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../public/rechazados-helpers');

const html = fs.readFileSync(
  path.join(__dirname, '../public/mie-dashboard.html'),
  'utf8',
);
const js = fs.readFileSync(
  path.join(__dirname, '../public/mie-dashboard.js'),
  'utf8',
);

assert.ok(html.indexOf('data-dashboard-tab="rechazados"') !== -1);
assert.ok(html.indexOf('id="rechazados-panel"') !== -1);
assert.ok(html.indexOf("rechazados: document.getElementById('rechazados-panel')") !== -1);
assert.ok(/SECTION_ORDER = \[[\s\S]*?'cz-funnel',\s*'rechazados'/m.test(html));
assert.ok(html.indexOf('window.__activateDashboardTab') !== -1);
assert.ok(html.indexOf("name === 'rechazados'") !== -1);
assert.ok(html.indexOf('rechazados-helpers.js') !== -1);
assert.ok(js.indexOf('data-action="open-rechazados"') !== -1);
assert.ok(js.indexOf('Ver rechazados') !== -1);
assert.ok(js.indexOf('window.__openRechazados') !== -1);
assert.ok(js.indexOf('p1') === -1 || js.indexOf('initRechazados') !== -1);
assert.ok(!/initRechazados[\s\S]*\bp1\b/.test(js));
assert.ok(!/initRechazados[\s\S]*segmento/.test(js));
assert.ok(!/initRechazados[\s\S]*b_plus/.test(js));

assert.strictEqual(H.opsStatusLabel('bcu_pending'), 'BCU pendiente');
assert.strictEqual(H.opsStatusLabel('retry_eligible'), 'Elegible retry');
assert.strictEqual(H.opsStatusLabel('reconsultable'), 'Reconsultable');
assert.strictEqual(
  H.opsStatusLabel('no_auto_reconsult'),
  'Sin reconsulta automática',
);
assert.strictEqual(H.opsStatusLabel('undefined_case'), 'Caso no definido');

assert.strictEqual(H.formatPersonName('Ana', 'Perez'), 'Ana Perez');
assert.strictEqual(H.formatPersonName(null, null), '—');
assert.strictEqual(H.formatScore(null), '—');
assert.strictEqual(H.formatWorstBcu(null), '—');

assert.strictEqual(H.buildListUrl('', null), '/rechazados');
assert.strictEqual(
  H.buildListUrl('', 'bcu_pending'),
  '/rechazados?status=bcu_pending',
);
assert.strictEqual(
  H.buildListUrl('/api', 'retry_eligible'),
  '/api/rechazados?status=retry_eligible',
);

const overdue = H.formatNextReviewOn('2020-01-05', Date.parse('2026-09-03T15:00:00Z'));
assert.strictEqual(overdue.overdue, true);
assert.ok(overdue.text.indexOf('vencida') !== -1);
assert.ok(overdue.text.indexOf('05/01/2020') !== -1);

const future = H.formatNextReviewOn('2099-10-05', Date.parse('2026-09-03T15:00:00Z'));
assert.strictEqual(future.overdue, false);
assert.strictEqual(future.text.indexOf('vencida'), -1);
assert.strictEqual(future.text, '05/10/2099');

const empty = H.formatNextReviewOn(null);
assert.deepStrictEqual(empty, { text: '—', overdue: false });

assert.strictEqual(H.canRemoveInstitution(1), false);
assert.strictEqual(H.canRemoveInstitution(2), true);

const badEmpty = H.serializeInstitutions([]);
assert.strictEqual(badEmpty.ok, false);

const badName = H.serializeInstitutions([H.emptyInstitution()]);
assert.strictEqual(badName.ok, false);

const ok = H.serializeInstitutions([
  {
    institution_name: ' Banco A ',
    category: '3',
    vigente_mn: '10',
    vigente_me: '',
    moroso_mn: 0,
    moroso_me: 0,
    castigado_mn: 0,
    castigado_me: 0,
    contingencias_mn: 0,
    contingencias_me: 0,
  },
  {
    institution_name: 'Banco B',
    category: '1C',
    vigente_mn: 1,
    vigente_me: 2,
    moroso_mn: 3,
    moroso_me: 4,
    castigado_mn: 5,
    castigado_me: 6,
    contingencias_mn: 7,
    contingencias_me: 8,
  },
]);
assert.strictEqual(ok.ok, true);
assert.strictEqual(ok.institutions.length, 2);
assert.strictEqual(ok.institutions[0].institution_name, 'Banco A');
assert.strictEqual(ok.institutions[0].vigente_mn, 10);
assert.strictEqual(ok.institutions[0].vigente_me, 0);
assert.strictEqual(ok.institutions[1].vigente_me, 2);
assert.notStrictEqual(
  ok.institutions[1].moroso_mn + ok.institutions[1].moroso_me,
  ok.institutions[1].moroso_mn,
);

const fdShape = {
  period_label: 'Ago 2026',
  consulted_on: '2026-08-10',
  institutions: JSON.stringify(ok.institutions),
  hasFile: false,
};
assert.strictEqual(typeof fdShape.institutions, 'string');
assert.ok(JSON.parse(fdShape.institutions).length === 2);

const fileOk = H.validateSelectedFile({
  type: 'image/jpeg',
  size: 100,
  name: 'x.jpg',
});
assert.strictEqual(fileOk.ok, true);
const fileBad = H.validateSelectedFile({
  type: 'image/gif',
  size: 100,
  name: 'x.gif',
});
assert.strictEqual(fileBad.ok, false);
const fileBig = H.validateSelectedFile({
  type: 'application/pdf',
  size: H.MAX_FILE_BYTES + 1,
  name: 'x.pdf',
});
assert.strictEqual(fileBig.ok, false);
assert.strictEqual(H.validateSelectedFile(null).ok, true);

assert.ok(js.indexOf('state.submitting') !== -1);
assert.ok(js.indexOf("fd.append('institutions'") !== -1);
assert.ok(js.indexOf("fd.append('file'") !== -1);
assert.ok(js.indexOf('Archivo:') !== -1);
assert.ok(js.indexOf('storage_path') === -1 || !/initRechazados[\s\S]*storage_path/.test(js));

// BUG1 regression: success path must clear loading BEFORE the success renderList.
const loadListMatch = js.match(
  /async function loadList\(\) \{[\s\S]*?async function openDetail/,
);
assert.ok(loadListMatch, 'loadList block missing');
const loadListSrc = loadListMatch[0];
assert.ok(
  /state\.rows = rows;\s*state\.loading = false;\s*setStatus\([\s\S]*?renderList\(\);/.test(
    loadListSrc,
  ),
  'success path must set loading=false before renderList',
);
assert.ok(
  /listError[\s\S]*state\.loading = false;\s*setStatus\(state\.listError/.test(
    loadListSrc,
  ),
  'error path must clear loading before renderList',
);

const css = fs.readFileSync(
  path.join(__dirname, '../public/mie-dashboard.css'),
  'utf8',
);
assert.ok(
  /#cz-funnel-panel,\s*#mie-dashboard-app #rechazados-panel,/.test(css) ||
    css.indexOf('#mie-dashboard-app #rechazados-panel') !== -1,
  'rechazados-panel must share panel padding rule',
);

// Fixture shaped like prod GET /rechazados (31 rows) — null-heavy, no throws.
const fixtureRows = [];
for (let i = 0; i < 31; i += 1) {
  fixtureRows.push({
    ci: 50000000 + i,
    nombre: i % 3 === 0 ? null : 'Nombre' + i,
    apellido: i % 5 === 0 ? null : 'Apellido' + i,
    rejected_at:
      i % 7 === 0 ? null : '2026-0' + ((i % 8) + 1) + '-10T12:00:00.000Z',
    score_v2: i % 4 === 0 ? null : i,
    worst_bcu: i % 6 === 0 ? null : '3',
    ops_status: 'bcu_pending',
    next_review_on: i % 2 === 0 ? null : '2026-10-05',
  });
}
assert.strictEqual(fixtureRows.length, 31);
function listViewKind(state) {
  if (state.loading) return 'loading';
  if (state.listError) return 'error';
  if (!state.rows.length) return 'empty';
  return 'table';
}
assert.strictEqual(
  listViewKind({ loading: true, rows: fixtureRows, listError: null }),
  'loading',
);
assert.strictEqual(
  listViewKind({ loading: false, rows: fixtureRows, listError: null }),
  'table',
);
for (let i = 0; i < fixtureRows.length; i += 1) {
  const row = fixtureRows[i];
  assert.ok(typeof H.formatPersonName(row.nombre, row.apellido) === 'string');
  assert.ok(typeof H.formatTsUy(row.rejected_at) === 'string');
  assert.ok(typeof H.formatScore(row.score_v2) === 'string');
  assert.ok(typeof H.formatWorstBcu(row.worst_bcu) === 'string');
  assert.ok(typeof H.opsStatusLabel(row.ops_status) === 'string');
  assert.ok(typeof H.formatNextReviewOn(row.next_review_on).text === 'string');
}

console.log('OK unit-rechazados-ui');
