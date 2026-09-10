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
  kind: 'badge',
  label: 'Pendiente',
  badgeClass: 'is-bcu-pending',
});
assert.deepStrictEqual(H.worstBcuCell(''), {
  kind: 'badge',
  label: 'Pendiente',
  badgeClass: 'is-bcu-pending',
});
assert.deepStrictEqual(H.worstBcuCell('1C'), {
  kind: 'badge',
  label: '1C',
  badgeClass: 'is-bcu-1c',
});
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
assert.ok(js.indexOf('consultar-bcu') === -1);
assert.ok(js.indexOf('openBcuForm') === -1);
assert.ok(js.indexOf('data-action="open-form"') !== -1);
assert.ok(js.indexOf('Cargar BCU') !== -1);
assert.ok(js.indexOf('formatRejectedAtDateCell') !== -1);
assert.ok(js.indexOf('rechazados-col-score') !== -1);
assert.ok(js.indexOf('rechazados-score') !== -1);
assert.ok(js.indexOf('rechazados-muted') !== -1);
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
assert.ok(css.indexOf('rechazados-score-slot') !== -1);
assert.ok(css.indexOf('justify-content: center') !== -1);
assert.ok(css.indexOf('tbody tr:nth-child(even)') !== -1);
assert.ok(css.indexOf('rechazados-muted') !== -1);
assert.ok(js.indexOf('rechazados-score-slot') !== -1);
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

// Stage 5 — money null≠0, extract helpers, UI wiring
assert.strictEqual(H.moneyCell(null), '—');
assert.strictEqual(H.moneyCell(undefined), '—');
assert.strictEqual(H.moneyCell(''), '—');
assert.strictEqual(H.moneyCell(0), '0');
assert.strictEqual(H.moneyCell(12.5), '12.5');

// Institutions table presentation: integer rounding (no trunc), null → —
assert.strictEqual(H.formatMoneyUyInteger(null), '—');
assert.strictEqual(H.formatMoneyUyInteger(undefined), '—');
assert.strictEqual(H.formatMoneyUyInteger(''), '—');
assert.strictEqual(H.formatMoneyUyInteger(0), '0');
assert.strictEqual(H.formatMoneyUyInteger(119623.68), '119624');
assert.strictEqual(H.formatMoneyUyInteger(494.55), '495');
assert.strictEqual(H.formatMoneyUyInteger(16377.91), '16378');
assert.strictEqual(H.formatMoneyUyInteger('119623.68'), '119624');
assert.strictEqual(H.formatMoneyUyInteger(12.5), '13');
assert.ok(js.indexOf('formatMoneyUyInteger') !== -1);
assert.ok(js.indexOf('rechazados-inst-money') !== -1);
assert.ok(css.indexOf('rechazados-inst-money.is-bcu-5') !== -1);

const emptyInst = H.emptyExtractInstitution();
assert.strictEqual(emptyInst.institution_name_raw, '');
assert.strictEqual(emptyInst.category, null);
assert.strictEqual(emptyInst.vigente.mn, null);
assert.strictEqual(emptyInst.castigado_por_atraso.me, null);
assert.strictEqual(emptyInst.creditos_reestructurados.mn, null);

assert.strictEqual(H.moneyModeFromValue(null), 'null');
assert.strictEqual(H.moneyModeFromValue(0), 'zero');
assert.strictEqual(H.moneyModeFromValue(10), 'value');
assert.strictEqual(H.moneyValueFromMode('null', '9'), null);
assert.strictEqual(H.moneyValueFromMode('zero', '9'), 0);
assert.strictEqual(H.moneyValueFromMode('value', '9'), 9);

const reviewedOk = H.extractionToReviewed({
  extraction_contract_version: 'bcu_v1',
  currency_view_selected: 'MN_PESOS_ME_PESOS',
  period: '2026-08',
  document_ci_raw: '45006120',
  institutions: [
    {
      institution_name_raw: 'OCA S.A.',
      category: '1C',
      vigente: { mn: 100, me: null },
      vigente_no_autoliquidable: { mn: null, me: null },
      moroso: { mn: 0, me: null },
      castigado_por_atraso: { mn: null, me: null },
      contingencias: { mn: null, me: null },
      creditos_reestructurados: { mn: null, me: null },
    },
  ],
  summary: H.emptyExtractSummary(),
});
assert.strictEqual(H.validateReviewedUx(reviewedOk).ok, true);
assert.strictEqual(reviewedOk.institutions[0].vigente.me, null);
assert.strictEqual(reviewedOk.institutions[0].moroso.mn, 0);

assert.strictEqual(
  H.validateReviewedUx({
    institutions: [],
    summary: H.emptyExtractSummary(),
  }).ok,
  false,
);
assert.strictEqual(
  H.validateReviewedUx({
    institutions: [H.emptyExtractInstitution()],
    summary: H.emptyExtractSummary(),
  }).ok,
  false,
);

const dup = H.extractionToReviewed(reviewedOk);
dup.institutions.push(
  Object.assign(H.emptyExtractInstitution(), {
    institution_name_raw: 'oca s.a.',
    category: '2A',
  }),
);
assert.strictEqual(H.validateReviewedUx(dup).ok, false);

const payload = H.buildConfirmPayload('2026-09-06', reviewedOk);
assert.deepStrictEqual(Object.keys(payload).sort(), [
  'consulted_on',
  'reviewed',
]);
assert.strictEqual(payload.consulted_on, '2026-09-06');

assert.strictEqual(H.shouldContinueExtractPoll(0, 'extracting'), true);
assert.strictEqual(
  H.shouldContinueExtractPoll(H.BCU_EXTRACT_POLL_MAX_MS, 'extracting'),
  false,
);
assert.strictEqual(H.shouldContinueExtractPoll(1000, 'pending_review'), false);
assert.strictEqual(H.extractPollIntervalMs(), 3000);
assert.strictEqual(H.extractPollMaxMs(), 90000);

assert.strictEqual(H.institutionHistoryAmountKeys().length, 12);

assert.ok(js.indexOf('renderExtractAssist') !== -1);
assert.ok(js.indexOf('bcu-extraction-drafts') !== -1);
assert.ok(js.indexOf('extract-confirm') !== -1);
assert.ok(js.indexOf('Confirmar BCU') !== -1);
assert.ok(js.indexOf('stopExtractPoll') !== -1);
assert.ok(js.indexOf('refreshExtractLatest') !== -1);
assert.ok(js.indexOf('creditos_reestructurados_mn') !== -1);
assert.ok(js.indexOf('VigNA MN') !== -1);
assert.ok(!/initRechazados[\s\S]*storage_path/.test(js));
assert.ok(js.indexOf('file_url') !== -1);

// BCU category badge mapping (presentation only)
assert.strictEqual(H.bcuCategoryBadgeClass('1C'), 'is-bcu-1c');
assert.strictEqual(H.bcuCategoryBadgeClass('2A'), 'is-bcu-2a');
assert.strictEqual(H.bcuCategoryBadgeClass('2B'), 'is-bcu-2b');
assert.strictEqual(H.bcuCategoryBadgeClass('3'), 'is-bcu-3');
assert.strictEqual(H.bcuCategoryBadgeClass('4'), 'is-bcu-4');
assert.strictEqual(H.bcuCategoryBadgeClass('5'), 'is-bcu-5');
assert.strictEqual(H.bcuCategoryBadgeClass(null), 'is-bcu-pending');
assert.strictEqual(H.bcuCategoryBadgeClass(''), 'is-bcu-pending');
assert.strictEqual(H.bcuCategoryBadgeClass('9Z'), 'is-bcu-pending');
assert.strictEqual(H.bcuCategoryBadgeClass(' pending '), 'is-bcu-pending');
assert.deepStrictEqual(H.worstBcuCell(null), {
  kind: 'badge',
  label: 'Pendiente',
  badgeClass: 'is-bcu-pending',
});
assert.deepStrictEqual(H.worstBcuCell('2B'), {
  kind: 'badge',
  label: '2B',
  badgeClass: 'is-bcu-2b',
});
assert.strictEqual(H.formatWorstBcu('1C'), '1C');
assert.ok(js.indexOf('rechazados-bcu-badge') !== -1);
assert.ok(css.indexOf('rechazados-bcu-badge') !== -1);
assert.ok(css.indexOf('is-bcu-1c') !== -1);
assert.ok(css.indexOf('is-bcu-5') !== -1);

// --- Stage 5.1 UI review helpers ---
// 1–4: null / 0 / value / compact — toggle
assert.strictEqual(H.moneyValueFromCompact(true, '99'), null);
assert.strictEqual(H.moneyValueFromCompact(false, '0'), 0);
assert.strictEqual(H.moneyValueFromCompact(false, '12.5'), 12.5);
assert.ok(Number.isNaN(H.moneyValueFromCompact(false, '')));
assert.strictEqual(H.moneyModeFromValue(null), 'null');
assert.strictEqual(H.moneyModeFromValue(0), 'zero');
assert.strictEqual(H.moneyModeFromValue(7), 'value');

// 5: findings grouping
const grouped = H.groupFindingsForUi([
  {
    severity: 'info',
    reason_code: 'SUMMARY_DETAIL_NOT_COMPARABLE',
    path: 'vigente.mn',
  },
  {
    severity: 'info',
    reason_code: 'SUMMARY_DETAIL_NOT_COMPARABLE',
    path: 'moroso.mn',
  },
  {
    severity: 'blocker',
    reason_code: 'RUBRO_ORPHAN_INCONSISTENT_SUPPORT',
    path: 'vigente.mn',
  },
  {
    severity: 'blocker',
    reason_code: 'RUBRO_ORPHAN_INCONSISTENT_SUPPORT',
    path: 'moroso.mn',
  },
]);
assert.strictEqual(grouped.length, 2);
assert.strictEqual(grouped[0].count, 2);
assert.strictEqual(grouped[0].reason_code, 'SUMMARY_DETAIL_NOT_COMPARABLE');
assert.strictEqual(
  grouped[0].label,
  'Resumen y detalle no son comparables',
);
assert.strictEqual(grouped[1].severity, 'blocker');
assert.deepStrictEqual(grouped[1].paths.sort(), ['moroso.mn', 'vigente.mn']);

// 6–7: path highlight; never invent institution
const hl = H.highlightPathMapFromFindings([
  { reason_code: 'RUBRO_ORPHAN_INCONSISTENT_SUPPORT', path: 'vigente.mn' },
  { reason_code: 'CI_MISMATCH', path: 'document_ci_raw' },
]);
assert.strictEqual(H.isMoneyPathHighlighted(hl, 'vigente', 'mn'), true);
assert.strictEqual(H.isMoneyPathHighlighted(hl, 'vigente', 'me'), false);
assert.strictEqual(H.parseMoneyFindingPath('document_ci_raw'), null);
const groupedBlob = JSON.stringify(grouped);
assert.ok(groupedBlob.indexOf('BROU') === -1);
assert.ok(groupedBlob.indexOf('institution') === -1);
assert.ok(groupedBlob.indexOf('institution_name') === -1);

// 8: period YYYYMM → MM/YYYY
assert.strictEqual(H.formatPeriodLabelUy('202607'), '07/2026');
assert.strictEqual(H.formatPeriodLabelUy('2026-07'), '07/2026');
assert.strictEqual(H.formatPeriodLabelUy(null), '—');
assert.strictEqual(H.classificationLabel('HUMAN_REVIEW'), 'Requiere revisión');

// 9: Cancelar = close-detail (no abandon/delete write)
assert.ok(
  /data-action="close-detail">Cancelar</.test(js) ||
    js.indexOf('data-action="close-detail">Cancelar') !== -1,
);
assert.ok(js.indexOf('/abandon') === -1);
assert.ok(js.indexOf('extract-cancel') === -1);

// 10: Confirmar still Stage 4 payload shape
const payload51 = H.buildConfirmPayload('2026-09-07', reviewedOk);
assert.deepStrictEqual(Object.keys(payload51).sort(), [
  'consulted_on',
  'reviewed',
]);
assert.strictEqual(payload51.reviewed, reviewedOk);
assert.strictEqual(payload51.reviewed.institutions[0].vigente.me, null);
assert.strictEqual(payload51.reviewed.institutions[0].moroso.mn, 0);

// 11–12: null hidden initially; value/0 visible
assert.strictEqual(H.shouldShowMoneyCell(null, false), false);
assert.strictEqual(H.shouldShowMoneyCell(0, false), true);
assert.strictEqual(H.shouldShowMoneyCell(10, false), true);
assert.strictEqual(H.shouldShowMoneyCell(null, true), true);

// 13: summary opens with relevant finding
assert.strictEqual(
  H.shouldExpandExtractSummary([
    {
      reason_code: 'SUMMARY_DETAIL_NOT_COMPARABLE',
      path: 'vigente.mn',
    },
  ]),
  true,
);
assert.strictEqual(
  H.shouldExpandExtractSummary([
    { reason_code: 'CI_MISMATCH', path: 'document_ci_raw' },
  ]),
  false,
);

// 14: 422 path keeps edited review (blockers set; no wipe before return)
assert.ok(js.indexOf('extractConfirmBlockers') !== -1);
assert.ok(js.indexOf("|| 'confirmación bloqueada'") !== -1);
const marker422 = "|| 'confirmación bloqueada'";
const idx422 = js.indexOf(marker422);
assert.ok(idx422 !== -1);
const slice422 = js.slice(idx422, idx422 + 450);
assert.ok(slice422.indexOf('extractConfirmBlockers') !== -1);
assert.ok(slice422.indexOf('extractReview = null') === -1);
assert.ok(slice422.indexOf('renderDetailModal();') !== -1);

// Stage 5.1 layout / compact money markers
assert.ok(js.indexOf('rechazados-extract-review-layout') !== -1);
assert.ok(js.indexOf('rechazados-money-compact') !== -1);
assert.ok(js.indexOf('data-money-null') !== -1);
assert.ok(js.indexOf('Mostrar campos vacíos') !== -1);
assert.ok(js.indexOf('Detalles técnicos') !== -1);
assert.ok(js.indexOf('rechazados-extract-doc-sticky') !== -1);
assert.ok(css.indexOf('rechazados-extract-doc-sticky') !== -1);
assert.ok(css.indexOf('position: sticky') !== -1);
assert.ok(js.indexOf('rechazados-money-mode') === -1);
assert.ok(js.indexOf('>Valor</option>') === -1);

// --- Stage 5.2 quick authorize ---
assert.ok(js.indexOf('Estado general') !== -1);
assert.ok(js.indexOf('Observaciones de extracción') !== -1);
assert.ok(js.indexOf('Editar detalles') !== -1);
assert.ok(js.indexOf('rechazados-inst-quick-card') !== -1);
assert.ok(js.indexOf('extractEditDetailsOpen') !== -1);
assert.ok(js.indexOf('data-extract-edit-details') !== -1);
assert.ok(js.indexOf('extract-doc-zoom') !== -1);
assert.ok(js.indexOf('validación final ocurre al confirmar') !== -1);
assert.ok(css.indexOf('minmax(0, 0.45fr)') !== -1);
assert.ok(css.indexOf('min-width: 0') !== -1);
assert.ok(css.indexOf('max-width: 800px') !== -1);
assert.ok(css.indexOf('rechazados-inst-quick-card') !== -1);
assert.ok(css.indexOf('width: min(1200px') !== -1);

assert.deepStrictEqual(
  H.documentCiMatchesExpected('UY IDE 000000000050212550', 50212550),
  { ok: true, label: 'coincide' },
);
assert.strictEqual(H.documentCiMatchesExpected('123', 50212550).ok, false);
assert.strictEqual(H.isPeriodValidYyyymm('202607'), true);
assert.strictEqual(H.isPeriodValidYyyymm('202613'), false);
assert.deepStrictEqual(H.currencyViewQuickStatus('MN_PESOS_ME_PESOS'), {
  ok: true,
  label: 'Pesos',
});
assert.strictEqual(H.formatMoneyUyQuick(null), '—');
assert.strictEqual(H.formatQuickMoneyPair({ mn: null, me: null }), '—');
assert.strictEqual(H.formatQuickMoneyPair({ mn: null, me: 0 }), '—');
assert.ok(H.formatQuickMoneyPair({ mn: 1410.4, me: 0 }).indexOf('ME') === -1);
assert.ok(H.formatQuickMoneyPair({ mn: 0, me: null }).indexOf('$') !== -1);

const quickInst = {
  institution_name_raw: 'BROU',
  category: '5',
  vigente: { mn: 1410.4, me: 0 },
  vigente_no_autoliquidable: { mn: 1410.4, me: 0 },
  moroso: { mn: null, me: null },
  castigado_por_atraso: { mn: 0, me: null },
  contingencias: { mn: null, me: null },
  creditos_reestructurados: { mn: 75598.99, me: 0 },
};
const qRows = H.institutionQuickRows(quickInst);
const qKeys = qRows.map(function (r) {
  return r.key;
});
assert.ok(qKeys.indexOf('vigente') !== -1);
assert.ok(qKeys.indexOf('vigente_no_autoliquidable') === -1);
assert.ok(qKeys.indexOf('moroso') !== -1);
assert.ok(qKeys.indexOf('castigado_por_atraso') !== -1);
assert.ok(qKeys.indexOf('creditos_reestructurados') !== -1);
assert.strictEqual(
  qRows.find(function (r) {
    return r.key === 'moroso';
  }).display,
  '—',
);

const obs = H.extractionObservationsForUi([
  {
    severity: 'info',
    reason_code: 'SUMMARY_DETAIL_NOT_COMPARABLE',
    path: 'vigente.mn',
  },
  {
    severity: 'blocker',
    reason_code: 'RUBRO_ORPHAN_INCONSISTENT_SUPPORT',
    path: 'vigente.mn',
  },
  {
    severity: 'blocker',
    reason_code: 'CI_MISMATCH',
    path: 'document_ci_raw',
  },
]);
assert.strictEqual(obs.length, 3);
assert.strictEqual(obs[0].title, 'Totales no completamente comparables');
assert.strictEqual(obs[0].showAsCurrentBlocker, false);
assert.strictEqual(obs[1].showAsCurrentBlocker, false);
assert.strictEqual(obs[2].showAsCurrentBlocker, true);
assert.ok(JSON.stringify(obs).indexOf('BROU') === -1);

// confirm still available without requiring edit-details open string coupling
assert.ok(js.indexOf('data-action="extract-confirm"') !== -1);
assert.ok(js.indexOf('buildConfirmPayload') !== -1);
assert.ok(js.indexOf("state.extractEditDetailsOpen = true") !== -1);

console.log('OK unit-rechazados-ui');
