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

const dateCell = H.formatRejectedAtDateCell('2026-08-20T15:00:00.000Z');
assert.strictEqual(dateCell.text, '20/08/2026');
assert.ok(dateCell.title.indexOf('20/08/2026') !== -1);
assert.ok(dateCell.title.indexOf(':') !== -1);
assert.deepStrictEqual(H.formatRejectedAtDateCell(null), {
  text: '—',
  title: '',
});
assert.strictEqual(H.outreachStatusTone('Activo'), 'positive');
assert.strictEqual(H.outreachStatusTone('Aceptó'), 'positive');
assert.strictEqual(H.outreachStatusTone('Invitado'), 'info');
assert.strictEqual(H.outreachStatusTone('Enviado'), 'info');
assert.strictEqual(H.outreachStatusTone('Rechazó'), 'negative');
assert.strictEqual(H.outreachStatusTone('Invitar'), null);

assert.deepStrictEqual(H.scoreCell(24), {
  kind: 'text',
  label: '24',
  tone: 'success',
});
assert.deepStrictEqual(H.scoreCell(16), {
  kind: 'text',
  label: '16',
  tone: 'warn',
});
assert.deepStrictEqual(H.scoreCell(5), {
  kind: 'text',
  label: '5',
  tone: 'danger',
});
assert.strictEqual(H.scoreTone(30), 'success');
assert.strictEqual(H.scoreTone(20), 'success');
assert.strictEqual(H.scoreTone(19), 'warn');
assert.strictEqual(H.scoreTone(10), 'warn');
assert.strictEqual(H.scoreTone(9), 'danger');
assert.strictEqual(H.scoreTone(0), 'danger');
assert.strictEqual(H.scoreTone(31), null);
assert.strictEqual(H.scoreTone(null), null);
assert.deepStrictEqual(H.scoreCell(null), {
  kind: 'cta',
  label: 'Encuestar',
  enabled: false,
  action: null,
});
assert.deepStrictEqual(H.miPlanCell('not_invited'), {
  kind: 'cta',
  label: 'Invitar',
  enabled: false,
  action: null,
});
assert.deepStrictEqual(H.miPlanCell('invited'), {
  kind: 'text',
  label: 'Invitado',
});
assert.deepStrictEqual(H.miPlanCell('active'), {
  kind: 'text',
  label: 'Activo',
});
assert.strictEqual(H.miPlanLabel('active'), 'Activo');
assert.deepStrictEqual(H.miDeudaCell('not_invited'), {
  kind: 'cta',
  label: 'Invitar',
  enabled: false,
  action: null,
});
assert.deepStrictEqual(H.miDeudaCell('invite_sent', false), {
  kind: 'text',
  label: 'Enviado',
});
assert.deepStrictEqual(H.miDeudaCell('invite_sent', true), {
  kind: 'cta',
  label: 'Reinvitar',
  enabled: false,
  action: null,
  btnTone: 'warn',
});
assert.deepStrictEqual(H.miDeudaCell('opt_in_accepted'), {
  kind: 'text',
  label: 'Aceptó',
});
assert.deepStrictEqual(H.miDeudaCell('opt_in_rejected'), {
  kind: 'text',
  label: 'Rechazó',
});
assert.strictEqual(H.miDeudaLabel('opt_in_accepted', false), 'Aceptó');
assert.deepStrictEqual(H.worstBcuCell(null), {
  kind: 'cta',
  label: 'Consultar',
  enabled: true,
  action: 'consultar-bcu',
});
assert.deepStrictEqual(H.worstBcuCell('1C'), { kind: 'text', label: '1C' });
assert.deepStrictEqual(H.retryReviewCell('retry_eligible', null), {
  kind: 'cta',
  label: 'Reintentar',
  enabled: false,
  action: null,
  btnTone: 'action',
});
assert.deepStrictEqual(H.retryReviewCell('bcu_pending', null), {
  kind: 'text',
  label: '—',
});
assert.deepStrictEqual(H.retryReviewCell('no_auto_reconsult', null), {
  kind: 'text',
  label: 'Sin revisión auto',
});
assert.deepStrictEqual(H.retryReviewCell('undefined_case', null), {
  kind: 'text',
  label: 'Caso indefinido',
});
const retryDate = H.retryReviewCell(
  'reconsultable',
  '2020-01-05',
  Date.parse('2026-09-03T15:00:00Z'),
);
assert.strictEqual(retryDate.kind, 'text');
assert.strictEqual(retryDate.overdue, true);
assert.ok(retryDate.label.indexOf('vencida') !== -1);

assert.ok(js.indexOf('Mi Plan') !== -1);
assert.ok(js.indexOf('Mi Deuda') !== -1);
assert.ok(js.indexOf('Retry / Próx. revisión') !== -1);
assert.ok(js.indexOf('Estado operativo') === -1);
assert.ok(js.indexOf('title="Próximamente"') !== -1);
assert.ok(js.indexOf('consultar-bcu') !== -1);
assert.ok(js.indexOf('openBcuForm') !== -1);
assert.ok(js.indexOf('formatRejectedAtDateCell') !== -1);
assert.ok(js.indexOf('rechazados-col-score') !== -1);
assert.ok(js.indexOf('rechazados-score') !== -1);
assert.ok(js.indexOf('btn-primary') !== -1);
assert.ok(js.indexOf('outreach.mi_plan') !== -1 || js.indexOf('outreach.mi_plan_status') !== -1);

const css = fs.readFileSync(
  path.join(__dirname, '../public/mie-dashboard.css'),
  'utf8',
);
assert.ok(css.indexOf('table-layout: fixed') !== -1);
assert.ok(css.indexOf('min-width: 960px') === -1);
assert.ok(css.indexOf('min-width: 720px') !== -1);
assert.ok(css.indexOf('rechazados-col-score') !== -1);
assert.ok(css.indexOf('rechazados-status.is-positive') !== -1);
assert.ok(css.indexOf('rechazados-score.is-success') !== -1);
assert.ok(css.indexOf('rechazados-score.is-warn') !== -1);
assert.ok(css.indexOf('rechazados-score.is-danger') !== -1);
assert.ok(css.indexOf('th.rechazados-col-date') !== -1);
assert.ok(css.indexOf('.ga4-table.rechazados-table .rechazados-col-score') !== -1);
assert.ok(js.indexOf('rechazados-score is-') !== -1 || js.indexOf('rechazados-score') !== -1);

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
    mi_plan_status: 'not_invited',
    mi_plan_updated_at: null,
    mi_deuda_status: 'not_invited',
    mi_deuda_updated_at: null,
    mi_deuda_invited_at: null,
    mi_deuda_responded_at: null,
    mi_deuda_invite_expired: false,
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
