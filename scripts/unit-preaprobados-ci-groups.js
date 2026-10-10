'use strict';

/**
 * Preaprobados one row per CI: grouping, KPIs by CI, ELM focus, list cell.
 * Run: node scripts/unit-preaprobados-ci-groups.js
 */

const assert = require('assert');

const { S1, S2, CODES } = require('../src/services/elm/constants');
const { computeElmCell } = require('../src/services/elm/listView');
const {
  buildElmCohortByCzId,
  buildPreaprobadosManualElmByCzId,
  assembleCombinedPreaprobadosList,
  parseCombinedResultadoQuery,
} = require('../src/lib/preaprobadosElmCohort');
const {
  ELM_FOCUS_RANK,
  parseCiParam,
  pickElmFocusCzId,
  groupRowsByCi,
  refreshElmFocus,
  ciKpis,
  assembleGroupedPreaprobadosList,
  solicitudesOf,
} = require('../src/lib/preaprobadosCiGroups');
const ElmUi = require('../public/elm-ui-helpers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack : err));
  }
}

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const sol = (czId, ci, estado) => ({
  cz_id: czId,
  ci: ci,
  nombre: 'Cliente',
  apellido: String(ci),
  email: czId + '@x.test',
  lrw_id: 'LRW-' + czId,
  fecha_reg: '2026-09-20T00:00:00.000Z',
  solicitudes_estados_id: estado,
  synced_at: '2026-10-01T00:00:00.000Z',
  updated_at_src: null,
});
const estado8 = (czId, day) => ({
  cz_historico_id: czId,
  cz_solicitud_id: czId,
  solicitudes_estados_id: 8,
  estado: 'Enviado CDV',
  fechahora_src: '2026-10-0' + day + 'T10:00:00.000Z',
});

/**
 * CDV cohort (estado 8): CI 5000 has two solicitudes (501 sin resultado, 502 granted), CI 6000 two
 * (601, 602), CI 7000 one, CI 9000 two. CI 8000 is ELM-only (automatic circuit).
 */
const CI_OF = { 501: 5000, 502: 5000, 601: 6000, 602: 6000, 701: 7000, 901: 9000, 902: 9000 };
const DAY_OF = { 501: 1, 502: 3, 601: 2, 602: 4, 701: 2, 901: 1, 902: 5 };
const COHORT = Object.keys(CI_OF).map(Number);
const ESTADO_OF = (id) => (id === 502 ? 11 : 8);
const CDV = {
  estado8Rows: COHORT.map((id) => estado8(id, DAY_OF[id])),
  currentEstado8Solicitudes: COHORT.filter((id) => ESTADO_OF(id) === 8).map((id) => sol(id, CI_OF[id], 8)),
  solicitudRows: COHORT.map((id) => sol(id, CI_OF[id], ESTADO_OF(id))),
  grantedRows: [{ cz_id: 502, ci: 5000, monto_otorgado: 20000, updated_at_src: '2026-10-04T00:00:00.000Z', synced_at: '2026-10-04T00:00:00.000Z' }],
  historicoRows: COHORT.map((id) => estado8(id, DAY_OF[id])),
};
const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };

function proc(czId, over) {
  return Object.assign(
    {
      id: 'p-' + czId,
      cz_solicitud_id: czId,
      ci: CI_OF[czId] || 8000,
      trigger_origin: 'janus_manual',
      send_origin: 'preaprobados_manual',
      created_at: iso(NOW - 2 * DAY),
      s1_status: S1.ELIGIBLE,
      s1_started_at: iso(NOW - 2 * DAY),
      s1_completed_at: iso(NOW - 2 * DAY),
      s1_lease_expires_at: null,
      s1_result_message: 'Listo para recibir datos en servicio 2',
      s2_status: S2.REFERRED,
      s2_started_at: iso(NOW - 2 * DAY),
      s2_completed_at: iso(NOW - 2 * DAY),
      s2_lease_expires_at: null,
      s2_result_message: 'Lead Aprobado correctamente',
      referred_at: iso(NOW - 2 * DAY),
      provider_status: null,
      disbursed_at: null,
      ops_resolved_at: null,
    },
    over || {},
  );
}

const S1_REJECTED_ONLY = { s2_status: S2.NOT_STARTED, s2_started_at: null, s2_completed_at: null, s2_result_message: null, referred_at: null };
const PROCESSES = [
  proc(501),
  proc(601, { provider_status: 'Convertido', disbursed_at: iso(NOW - DAY) }),
  proc(701, { send_origin: 'rechazados_manual' }),
  proc(801, { trigger_origin: 'cz_automatic', send_origin: 'cz_automatic' }),
  proc(901, Object.assign({ s1_status: S1.REJECTED, s1_result_message: 'Repetido. Aprobado', s1_error_code: CODES.S1_DUPLICATE_OTHER_CHANNEL }, S1_REJECTED_ONLY)),
];

function input(extra) {
  return Object.assign({}, CDV, WINDOW, {
    elmCohort: buildElmCohortByCzId({ processes: PROCESSES, projectedByCz: new Map([[801, 13]]), nowMs: NOW }),
    elmManual: buildPreaprobadosManualElmByCzId({ processes: PROCESSES, nowMs: NOW }),
    elmSolicitudRows: [sol(801, 8000, 13)].concat(COHORT.map((id) => sol(id, CI_OF[id], ESTADO_OF(id)))),
    elmHistoricoRows: [],
    limit: 100,
    offset: 0,
    nowMs: NOW,
  }, extra || {});
}

const byCi = (rows) => new Map(rows.map((g) => [g.ci, g]));
const czIds = (g) => g.solicitudes.map((s) => s.cz_id);
const cellOf = (czId) => computeElmCell({ process: PROCESSES.find((p) => p.cz_solicitud_id === czId), nowMs: NOW, postReferralRejectionStatuses: [] });
const notSent = (czId) => ({ kind: 'not_sent', cz_solicitud_id: czId, label: 'Sin enviar', action: { show: false } });

test('membership unchanged: every combined solicitud is in exactly one CI group', () => {
  const combined = assembleCombinedPreaprobadosList(Object.assign(input(), { limit: 1000 }));
  const grouped = assembleGroupedPreaprobadosList(input());
  const flat = solicitudesOf(grouped.rows).map((s) => s.cz_id).sort();
  assert.deepStrictEqual(flat, combined.rows.map((r) => r.cz_id).sort());
  assert.strictEqual(new Set(flat).size, flat.length, 'no solicitud twice');
  assert.ok(!flat.includes(701) || combined.rows.some((r) => r.cz_id === 701), 'no new member');
  assert.strictEqual(grouped.total_solicitudes, combined.total);
  assert.deepStrictEqual(grouped.kpis, combined.kpis, 'per-solicitud KPIs kept untouched');
  assert.deepStrictEqual(grouped.kpis_elm, combined.kpis_elm);
  for (const s of solicitudesOf(grouped.rows)) {
    const r = combined.rows.find((x) => x.cz_id === s.cz_id);
    assert.strictEqual(s.proveedor, r.proveedor, 'classification kept for ' + s.cz_id);
    assert.strictEqual(s.resultado, r.resultado);
  }
});

test('one row per CI, solicitudes newest first; CDV / ELM summary per CI', () => {
  const out = assembleGroupedPreaprobadosList(input());
  assert.strictEqual(out.total, 5);
  const g = byCi(out.rows);
  assert.deepStrictEqual(czIds(g.get(5000)), [502, 501]);
  assert.strictEqual(g.get(5000).solicitudes_count, 2);
  assert.strictEqual(g.get(5000).cz_id, 502);
  assert.strictEqual(g.get(5000).cdv_status, 'granted');
  assert.deepStrictEqual(g.get(5000).cdv_granted_cz_ids, [502]);
  assert.strictEqual(g.get(5000).monto_otorgado, 20000);
  assert.strictEqual(g.get(5000).elm_member_state, 'referred', 'manual send from Preaprobados counts');
  assert.strictEqual(g.get(5000).proveedor, 'cdv_elm');
  assert.strictEqual(g.get(6000).cdv_status, 'sin_resultado');
  assert.strictEqual(g.get(6000).elm_member_state, 'granted');
  assert.strictEqual(g.get(7000).elm_member_state, null, 'a send from Rechazados is not an ELM member');
  assert.strictEqual(g.get(8000).cdv_status, null, 'ELM-only CI is outside the CDV cohort');
  assert.strictEqual(g.get(8000).proveedor, 'elm');
  assert.strictEqual(g.get(8000).elm_member_state, 'referred', 'automatic circuit counts');
  assert.deepStrictEqual(czIds(g.get(9000)), [902, 901]);
  assert.strictEqual(g.get(9000).elm_member_state, null, 'duplicate from another channel is not Aceptado');
  for (let i = 1; i < out.rows.length; i += 1) {
    assert.ok(Date.parse(out.rows[i - 1].cohort_entered_at) >= Date.parse(out.rows[i].cohort_entered_at), 'groups by newest solicitud');
  }
});

test('KPIs by CI: five indicators, no double count, manual + automatic ELM', () => {
  const out = assembleGroupedPreaprobadosList(input());
  assert.deepStrictEqual(out.kpis_ci, {
    preaprobados: 5,
    aceptados_elm: 3,
    otorgados_cdv: 1,
    otorgados_elm: 1,
    pendientes: 3,
    solicitudes: 8,
  });
  assert.ok(out.kpis.preaprobados > 4, 'the per-solicitud count was inflated by multi-solicitud CIs');
  const twice = ciKpis(groupRowsByCi([
    { cz_id: 1, ci: 1, proveedor: 'cdv', resultado: 'granted', cohort_entered_at: '2026-10-02T00:00:00Z' },
    { cz_id: 2, ci: 1, proveedor: 'cdv', resultado: 'granted', cohort_entered_at: '2026-10-01T00:00:00Z' },
    { cz_id: 3, ci: 1, proveedor: 'cdv_elm', resultado: 'sin_resultado', elm_member: { state: 'referred' }, cohort_entered_at: '2026-10-03T00:00:00Z' },
  ]));
  assert.deepStrictEqual(twice, { preaprobados: 1, aceptados_elm: 1, otorgados_cdv: 1, otorgados_elm: 0, pendientes: 0, solicitudes: 3 });
});

test('filters pick the CIs; a listed CI keeps its full state (same as its detail)', () => {
  const res = parseCombinedResultadoQuery('granted');
  assert.ok(res.ok);
  const out = assembleGroupedPreaprobadosList(input({ resultadoCdv: res.cdv, resultadoElm: res.elm }));
  assert.strictEqual(out.total, 1);
  assert.deepStrictEqual(czIds(out.rows[0]), [502, 501]);
  assert.deepStrictEqual(out.rows[0].matched_cz_ids, [502]);
  assert.strictEqual(out.rows[0].cz_id, 502);
  assert.strictEqual(out.rows[0].elm_member_state, 'referred', 'ELM state of the CI kept under a CDV filter');
  assert.deepStrictEqual(out.kpis_ci, { preaprobados: 1, aceptados_elm: 1, otorgados_cdv: 1, otorgados_elm: 0, pendientes: 0, solicitudes: 2 });
  const elmOk = parseCombinedResultadoQuery('elm_aceptado');
  const accepted = assembleGroupedPreaprobadosList(input({ resultadoCdv: elmOk.cdv, resultadoElm: elmOk.elm }));
  assert.deepStrictEqual(accepted.rows.map((g) => g.ci).sort(), [5000, 8000]);
  const ci5000 = byCi(accepted.rows).get(5000);
  assert.strictEqual(ci5000.cdv_status, 'granted', 'CDV grant of the CI still shown under an ELM filter');
  assert.strictEqual(ci5000.proveedor, 'cdv_elm');
  assert.deepStrictEqual(ci5000.matched_cz_ids, [501]);
  const matchedRow = assembleCombinedPreaprobadosList(input({ resultadoCdv: elmOk.cdv, resultadoElm: elmOk.elm })).rows.find((r) => r.cz_id === 501);
  assert.strictEqual(ci5000.cohort_entered_at, matchedRow.cohort_entered_at, 'date of the matching solicitud, as the filter saw it');
  const search = assembleGroupedPreaprobadosList(input({ q: '602' }));
  assert.deepStrictEqual(search.rows.map((g) => g.ci), [6000]);
  assert.deepStrictEqual(czIds(search.rows[0]), [602, 601]);
  assert.strictEqual(search.rows[0].elm_member_state, 'granted');
  const outside = assembleGroupedPreaprobadosList(input({ from: '2026-10-04T00:00:00.000Z', to: '2026-10-05T23:59:59.999Z' }));
  assert.deepStrictEqual(outside.rows.map((g) => g.ci).sort(), [6000, 9000], 'period picks CIs by matching solicitudes');
  assert.ok(outside.rows.every((g) => g.solicitudes_count === 2), 'their other solicitudes (outside the period) still listed');
});

test('CI detail: `ci` keeps every solicitud of that CI (no filters), others excluded', () => {
  const out = assembleGroupedPreaprobadosList(input({ ci: 5000, limit: 1, offset: 0 }));
  assert.strictEqual(out.total, 1);
  assert.deepStrictEqual(czIds(out.rows[0]), [502, 501]);
  assert.strictEqual(assembleGroupedPreaprobadosList(input({ ci: 4242 })).total, 0);
});

test('paging by CI: a CI is never split across pages', () => {
  const seen = [];
  for (let offset = 0; offset < 6; offset += 2) {
    const page = assembleGroupedPreaprobadosList(input({ limit: 2, offset: offset }));
    assert.strictEqual(page.total, 5);
    assert.ok(page.rows.length <= 2);
    for (const g of page.rows) seen.push(g.ci);
  }
  assert.deepStrictEqual(seen.slice().sort(), [5000, 6000, 7000, 8000, 9000]);
  const full = assembleGroupedPreaprobadosList(input());
  assert.deepStrictEqual(seen, full.rows.map((g) => g.ci), 'same order on every page');
});

test('rows without CI stay alone, never merged', () => {
  const groups = groupRowsByCi([
    { cz_id: 10, ci: null, proveedor: 'cdv', cohort_entered_at: '2026-10-02T00:00:00Z' },
    { cz_id: 11, ci: null, proveedor: 'cdv', cohort_entered_at: '2026-10-01T00:00:00Z' },
    { cz_id: 12, ci: 'x', proveedor: 'cdv', cohort_entered_at: '2026-10-01T00:00:00Z' },
  ]);
  assert.strictEqual(groups.length, 3);
  assert.ok(groups.every((g) => g.ci === null && g.solicitudes_count === 1));
});

test('ELM focus: most advanced state wins (Otorgado > Aceptado > … > Sin enviar); ties keep newest', () => {
  assert.ok(ELM_FOCUS_RANK.granted < ELM_FOCUS_RANK.referred && ELM_FOCUS_RANK.referred < ELM_FOCUS_RANK.in_evaluation);
  assert.ok(ELM_FOCUS_RANK.duplicate < ELM_FOCUS_RANK.rejected && ELM_FOCUS_RANK.rejected < ELM_FOCUS_RANK.not_sent);
  const out = assembleGroupedPreaprobadosList(input());
  const g = byCi(out.rows);
  assert.strictEqual(g.get(5000).elm_focus_cz_id, 501, 'before cells: the ELM member');
  for (const s of solicitudesOf(out.rows)) s.elm = PROCESSES.some((p) => p.cz_solicitud_id === s.cz_id) ? cellOf(s.cz_id) : notSent(s.cz_id);
  refreshElmFocus(out.rows);
  assert.strictEqual(g.get(5000).elm_focus_cz_id, 501, 'Aceptado over Sin enviar');
  assert.strictEqual(g.get(6000).elm_focus_cz_id, 601, 'Otorgado over Sin enviar');
  assert.strictEqual(g.get(9000).elm_focus_cz_id, 901, 'Duplicado over Sin enviar');
  assert.strictEqual(g.get(7000).elm_focus_cz_id, 701, 'a Rechazados send is still shown');
  assert.strictEqual(
    pickElmFocusCzId([
      { cz_id: 3, elm: { kind: 'rejected', state: 'rejected' } },
      { cz_id: 2, elm: { kind: 'referred', state: 'referred', granted_elm: true } },
      { cz_id: 1, elm: { kind: 'referred', state: 'referred' } },
    ]),
    2,
  );
  assert.strictEqual(pickElmFocusCzId([{ cz_id: 9, elm: notSent(9) }, { cz_id: 8, elm: notSent(8) }]), 9, 'newest on tie');
  assert.strictEqual(
    pickElmFocusCzId([{ cz_id: 9, elm: { kind: 'unavailable' } }, { cz_id: 8, elm: { kind: 'unavailable' }, elm_member: { state: 'granted' } }]),
    8,
    'cells unreadable: ELM membership decides',
  );
});

test('parseCiParam: 1..999999999 digits only', () => {
  assert.deepStrictEqual(parseCiParam('12345678'), { ok: true, value: 12345678 });
  assert.deepStrictEqual(parseCiParam(' 42 '), { ok: true, value: 42 });
  for (const bad of [null, undefined, '', '0', '-1', '1e3', '12.5', 'abc', '1234567890']) {
    assert.strictEqual(parseCiParam(bad).ok, false, String(bad));
  }
});

test('list ELM cell: one line, never a button, Rechazados colors', () => {
  const html = (cell, opts) => ElmUi.preaprobadosElmStatusHtml(cell, opts);
  const all = [cellOf(501), cellOf(601), cellOf(901), notSent(1), { kind: 'not_sendable', cz_solicitud_id: 2, action: { show: true, enabled: false, reason: CODES.MISSING_REQUIRED_FIELDS } }];
  for (const c of all) {
    const h = html(c);
    assert.ok(!/<button|<br|<div/.test(h), h);
    assert.ok(h.includes('is-line') && !h.includes('is-wrap'), h);
  }
  assert.ok(/class="preaprobados-elm is-referred[^"]*is-line"[^>]*>Aceptado</.test(html(cellOf(501))), 'Aceptado green');
  const granted = html(cellOf(601));
  assert.ok(granted.includes(' is-granted') && granted.includes('>Otorgado<'), 'Otorgado blue: ' + granted);
  const dup = html(cellOf(901));
  assert.ok(dup.includes('is-closed is-duplicate') && dup.includes('Duplicado · Otro canal'), 'duplicate amber: ' + dup);
  const rejected = html({ kind: 'rejected', state: 'rejected', cz_solicitud_id: 1, label: 'Rechazado ELM', elm_answer: { message: 'SCORE BAJO. Rechazado' } });
  assert.ok(rejected.includes('is-rejected') && rejected.includes('>Rechazado · SCORE BAJO<'), 'rejected red: ' + rejected);
  assert.ok(html(notSent(1)).includes('>Sin enviar<'));
  const fallback = html({ kind: 'unavailable' }, { member: { state: 'granted', label: 'Otorgado ELM' } });
  assert.ok(fallback.includes('is-granted') && fallback.includes('>Otorgado<'), 'cells unreadable: membership shown');
  assert.ok(html({ kind: 'unavailable' }).includes('>—<'));
  assert.ok(html(null).includes('>—<'));
  const multi = html(cellOf(501), { czId: 501, others: [{ cz_id: 502, elm: notSent(502) }] });
  assert.ok(multi.includes('title="Sol. 501 · Aceptado ELM'), multi);
  assert.ok(multi.includes('Otras solicitudes de la CI:\nSol. 502: Sin enviar'), multi);
  const long = computeElmCell({ process: proc(1, Object.assign({ s1_status: S1.REJECTED, s1_result_message: 'Repetido. Aprobado. Otro motivo largo de ELM' }, S1_REJECTED_ONLY)), nowMs: NOW, postReferralRejectionStatuses: [] });
  assert.ok(!html(long).includes('is-wrap'), 'a multi-sentence answer stays on one line in the list');
  assert.ok(!html(cellOf(501), { member: null }).includes('<img'));
  assert.ok(!html({ kind: 'referred', state: 'referred', cz_solicitud_id: 1, provider_status: '<img src=x>' }).includes('<img'), 'escaped');
});

test('CDV cohort KPIs stay per solicitud next to the per-CI KPIs', () => {
  const out = assembleGroupedPreaprobadosList(input());
  const cdv = solicitudesOf(out.rows).filter((s) => s.proveedor !== 'elm');
  const granted = cdv.filter((s) => s.resultado === 'granted');
  assert.strictEqual(out.kpis.preaprobados, cdv.length, 'per solicitud, CDV cohort only');
  assert.strictEqual(out.kpis.granted, granted.length);
  assert.strictEqual(out.kpis.sin_resultado, cdv.length - granted.length);
  assert.strictEqual(out.kpis.monto_otorgado, granted.reduce((n, s) => n + Number(s.monto_otorgado || 0), 0));
  assert.strictEqual(out.kpis.conversion, granted.length / cdv.length);
  assert.ok(out.kpis_ci.otorgados_cdv <= out.kpis.granted, 'per CI never above per solicitud');
});

test('dashboard: CZ column, CDV amount, CDV cohort KPI section (no ELM ops panels)', () => {
  const fs = require('fs');
  const path = require('path');
  const dash = fs.readFileSync(path.join(__dirname, '../public/mie-dashboard.js'), 'utf8');
  const start = dash.indexOf('(function initPreaprobados()');
  const pre = dash.slice(start, dash.indexOf('\n})();', start));
  assert.ok(pre.includes('<th class="preaprobados-col-cz" title="Estado actual en CZ de la solicitud más reciente">CZ</th>'));
  assert.ok(/'<th class="preaprobados-col-ci">CI<\/th>' \+\s*'<th class="preaprobados-col-cz"[^']*' \+\s*'<th class="preaprobados-col-cdv">/.test(pre), 'CZ between CI and Estado CDV');
  assert.ok(pre.includes('const s = findSolicitud(group, group.cz_id) || solicitudesOf(group)[0];'), 'row solicitud (newest listed)');
  assert.ok(pre.includes("const title = 'Estado CZ ' + estadoText(s) + ' · solicitud ' + s.cz_id;"), 'full name in tooltip');
  assert.ok(pre.includes('cdvBadge(row.cdv_status, row.monto_otorgado)'), 'list amount');
  assert.ok(pre.includes("cdvBadge(s.resultado === 'granted' ? 'granted' : 'sin_resultado', s.monto_otorgado)"), 'detail amount');
  assert.ok(pre.includes("'Otorgado CDV' + (monto != null ? ' · $ ' + fmtMoney(monto) : '')"));
  assert.ok(pre.includes('cdvKpisHtml(data.kpis)'), 'CDV KPIs from the server CDV cohort');
  assert.ok(pre.includes("'<div class=\"preaprobados-kpi-scope\">CDV · cohorte estado 8 '"), 'scope label');
  for (const label of ['Monto total otorgado', 'Conversión CDV', 'Otorgadas CDV (solicitudes)', 'Sin resultado CDV (solicitudes)']) {
    assert.ok(pre.includes("kpiCard('" + label + "'"), label);
  }
  for (const label of ['Preaprobados', 'Aceptados ELM', 'Otorgados CDV', 'Otorgados ELM', 'Pendientes']) {
    assert.ok(pre.includes("kpiCard('" + label + "'") || pre.includes("'" + label + "',"), 'per-CI KPI kept: ' + label);
  }
  assert.ok(!pre.includes('kpis_elm') && !pre.includes('by_origin'), 'no ELM ops KPI panels');
  const css = fs.readFileSync(path.join(__dirname, '../public/mie-dashboard.css'), 'utf8');
  const widths = ['date', 'name', 'ci', 'cz', 'cdv', 'elm', 'ver'].map((c) => {
    const m = css.match(new RegExp('\\.preaprobados-table \\.preaprobados-col-' + c + ' \\{\\s*width: (\\d+)%'));
    assert.ok(m, 'width for ' + c);
    return Number(m[1]);
  });
  assert.strictEqual(widths.reduce((a, b) => a + b, 0), 100, 'columns fill the table');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
