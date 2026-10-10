'use strict';

/**
 * ELM confirmed (Fabián, ELM) that the S2 answer `{ success: true, result: null }` means the lead
 * was received and assigned to Copanel: "Aceptado ELM" (green), never a granted loan. "Otorgado
 * ELM" (blue) needs a confirmed disbursement (postback Convertido / audited ops resolution, or CZ
 * 16 projected for an automatic process).
 *
 * The stored attempt is not rewritten: the transport keeps it unknown / elm_response_undocumented
 * and the commercial reading (classification.isS2Accepted) recognizes the exact shape. Every
 * other HTTP 200 body stays in review. Covers the seven historical cases as stored in production,
 * future answers, granted transition, CI hold, surveys, KPIs by send_origin, ELM Ops, the
 * duplicate "Repetido. Aprobado" and the UI labels / colors.
 * Pure functions and in-memory fakes only: no network, no database.
 *
 * Run: node scripts/unit-elm-accepted-granted.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: { port: 3000, nodeEnv: 'test', supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'test' },
};
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from(table) {
      throw new Error('unexpected supabase access in test: ' + table);
    },
    rpc(name) {
      throw new Error('unexpected supabase rpc in test: ' + name);
    },
  },
};

const { S1, S2, CODES } = require('../src/services/elm/constants');
const { isService2AcceptedBody, classifyService2Response } = require('../src/services/elm/client');
const {
  classifyElmProcess,
  isS2Accepted,
  blocksSurveyInvite,
  COMMERCIAL,
} = require('../src/services/elm/classification');
const { computeElmKpis } = require('../src/services/elm/kpis');
const { computeElmCell } = require('../src/services/elm/listView');
const { isPostbackCompatible } = require('../src/services/elm/postback');
const { PROCESS_LIST_SELECT } = require('../src/services/elm/repository');
const { deriveFromProcess } = require('../src/services/providerFallback/outcome');
const { OUTCOME: FB_OUTCOME, REASONS } = require('../src/services/providerFallback/constants');
const { computeElmSurveyBlocks } = require('../src/lib/rejectedSurveyInviteElmGate');
const { evaluateCiResendHold, HOLD } = require('../src/lib/rejectedElmResendGuard');
const { outcomeOf, OUTCOMES } = require('../src/lib/rejectedElmSend');
const {
  parseCombinedResultadoQuery,
  buildElmCohortByCzId,
  buildPreaprobadosManualElmByCzId,
  assembleCombinedPreaprobadosList,
} = require('../src/lib/preaprobadosElmCohort');
const {
  processKind,
  openProcessView,
  PROCESS_RESOLUTIONS,
  ACCEPTED_RESOLUTIONS,
  ACCEPTED_CORRECTIONS,
  CORRECTION_NOTE_PREFIX,
  ACTION_HTTP,
  createElmOpsService,
} = require('../src/services/elmOps/service');
const ElmUi = require('../public/elm-ui-helpers');
const ElmOpsUi = require('../public/elm-ops');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack : err));
  }
}

const NOW = Date.parse('2026-10-10T15:00:00Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const TECH_RETRY = { maxAttempts: 3, retrySafeErrorCodes: [CODES.PROVIDER_BCU_ERROR], baseDelaySeconds: 60 };
const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** CI / TrackingId (cz_solicitud_id) confirmed with ELM. */
const HISTORICAL = [
  [32392154, 1333],
  [27645104, 1346],
  [36225953, 1394],
  [37656723, 1380],
  [19118189, 1190],
  [10768808, 1195],
  [34990122, 1256],
];

/** Row as PROCESS_LIST_SELECT returns it for the historical cases in production. */
function historicalRow(ci, czId, over) {
  return Object.assign(
    {
      id: 'p-' + czId,
      cz_solicitud_id: czId,
      ci: ci,
      trigger_origin: 'janus_manual',
      send_origin: 'rechazados_manual',
      created_at: iso(NOW - 10 * DAY),
      updated_at: iso(NOW - 10 * DAY + 5000),
      s1_status: S1.ELIGIBLE,
      s1_attempts: 1,
      s1_http_status: 200,
      s1_error_code: null,
      s1_started_at: iso(NOW - 10 * DAY),
      s1_completed_at: iso(NOW - 10 * DAY + 1000),
      s1_lease_expires_at: null,
      s1_result_message: 'Listo para recibir datos en servicio 2',
      s2_status: S2.UNKNOWN,
      s2_http_status: 200,
      s2_error_code: CODES.RESPONSE_UNDOCUMENTED,
      s2_response: { result: null, success: true, docNumber: String(ci) },
      s2_started_at: iso(NOW - 10 * DAY + 2000),
      s2_completed_at: iso(NOW - 10 * DAY + 3000),
      s2_lease_expires_at: null,
      s2_result_message: null,
      referred_at: null,
      provider_status: null,
      provider_status_at: null,
      disbursed_at: null,
      disbursed_amount: null,
      ops_resolution_code: null,
      ops_resolved_at: null,
    },
    over,
  );
}
const accepted = (over) => historicalRow(32392154, 1333, over);
const read = (p, extra) => classifyElmProcess(p, Object.assign({ nowMs: NOW }, extra || {}));

(async function main() {
  await test('1 body shape: only { success: true, result: null } (+ docNumber) is an accepted S2 body', () => {
    const yes = [
      { success: true, result: null },
      { result: null, success: true, docNumber: '32392154' },
      { success: true, result: null, docNumber: 32392154 },
    ];
    for (const b of yes) assert.strictEqual(isService2AcceptedBody(b), true, JSON.stringify(b));
    const no = [
      null,
      undefined,
      'ok',
      [],
      {},
      { success: true },
      { result: null },
      { success: false, result: null },
      { success: 'true', result: null },
      { success: 1, result: null },
      { success: true, result: '' },
      { success: true, result: 'Lead Aprobado correctamente' },
      { success: true, result: 'Algo nuevo' },
      { success: true, result: {} },
      { success: true, result: null, message: 'x' },
      { success: true, result: null, error: null },
      { success: true, result: null, docNumber: null },
      { success: true, result: null, docNumber: { v: 1 } },
    ];
    for (const b of no) assert.strictEqual(isService2AcceptedBody(b), false, JSON.stringify(b));
  });

  await test('2 transport unchanged: the accepted body is still unknown / undocumented (stored as answered)', () => {
    assert.deepStrictEqual(classifyService2Response(null), { outcome: 'unknown', errorCode: null });
    assert.strictEqual(classifyService2Response('Lead Aprobado correctamente').outcome, 'positive');
  });

  await test('3 the seven historical cases (CI / TrackingId) read as Aceptado ELM, never Otorgado', () => {
    const select = PROCESS_LIST_SELECT.split(',').map((c) => c.trim());
    for (const k of ['s2_http_status', 's2_error_code', 's2_response']) assert.ok(select.includes(k), 'list projection has ' + k);
    for (const [ci, czId] of HISTORICAL) {
      const p = historicalRow(ci, czId);
      assert.deepStrictEqual(Object.keys(p).sort(), select.slice().sort(), 'fixture = list projection');
      assert.strictEqual(isS2Accepted(p), true, czId);
      const c = read(p);
      assert.deepStrictEqual(
        [c.state, c.detail, c.label, c.detail_label, c.stage],
        [COMMERCIAL.REFERRED, 's2_accepted', 'Aceptado ELM', 'Aceptado ELM (asignado a Copanel)', 's2'],
        czId + ' / ' + ci,
      );
      const cell = computeElmCell({ process: p, nowMs: NOW });
      assert.deepStrictEqual([cell.kind, cell.label, cell.granted_elm, cell.s2_status], ['referred', 'Aceptado ELM', false, 'unknown']);
      assert.strictEqual(cell.elm_answer, null);
      assert.strictEqual(ElmUi.compactCellText(cell), 'Aceptado');
      const html = ElmUi.elmCellHtml(cell, { compact: true });
      assert.ok(html.includes('preaprobados-elm is-referred') && !html.includes('is-granted'), html);
      assert.ok(!JSON.stringify(cell).includes('docNumber'), 'the stored body never reaches the cell');
      assert.strictEqual(outcomeOf(cell), OUTCOMES.REFERRED);
    }
  });

  await test('4 strict: other S2 unknowns stay in review (not every HTTP 200 is an acceptance)', () => {
    const cases = {
      'HTTP 201': { s2_http_status: 201 },
      'HTTP 500': { s2_http_status: 500, s2_error_code: CODES.HTTP_ERROR },
      'HTTP missing': { s2_http_status: null },
      'timeout': { s2_http_status: null, s2_error_code: CODES.HTTP_TIMEOUT, s2_response: null },
      'unparseable': { s2_error_code: CODES.RESPONSE_UNPARSEABLE, s2_response: null },
      'other error code': { s2_error_code: 'elm_transport_error' },
      'result text stored': { s2_result_message: 'Algo nuevo', s2_response: { success: true, result: 'Algo nuevo' } },
      'success false': { s2_response: { success: false, result: null } },
      'result missing': { s2_response: { success: true } },
      'extra key': { s2_response: { success: true, result: null, docNumber: '32392154', extra: 1 } },
      'docNumber of another CI': { s2_response: { success: true, result: null, docNumber: '11111111' } },
      'docNumber without CI': { ci: null },
      'body as text': { s2_response: '{"success":true,"result":null}' },
      'body missing': { s2_response: null },
    };
    for (const [name, over] of Object.entries(cases)) {
      const c = read(accepted(over));
      assert.deepStrictEqual([c.state, c.detail], [COMMERCIAL.REVIEW, 's2_unknown'], name);
    }
    const expired = read(accepted({ s2_status: S2.IN_FLIGHT, s2_lease_expires_at: iso(NOW - 60000) }));
    assert.deepStrictEqual([expired.state, expired.detail], [COMMERCIAL.REVIEW, 's2_unknown'], 'expired lease is not an answer');
    const tech = read(accepted({ s2_status: S2.TECHNICAL_ERROR }));
    assert.strictEqual(tech.detail, 's2_technical_error');
    const noDoc = read(accepted({ s2_response: { success: true, result: null } }));
    assert.strictEqual(noDoc.detail, 's2_accepted', 'shape confirmed by ELM without docNumber');
  });

  await test('5 documented "Lead Aprobado correctamente" is Aceptado ELM too (derivado a ventas)', () => {
    const p = accepted({ s2_status: S2.REFERRED, s2_error_code: null, s2_result_message: 'Lead Aprobado correctamente', s2_response: { result: 'Lead Aprobado correctamente' }, referred_at: iso(NOW - DAY) });
    const c = read(p);
    assert.deepStrictEqual([c.state, c.detail, c.label, c.detail_label], [COMMERCIAL.REFERRED, 's2_referred', 'Aceptado ELM', 'Aceptado ELM (derivado a ventas)']);
  });

  await test('6 Aceptado → Otorgado only with evidence: postback Convertido (disbursed_at) or CZ 16 for automatic', () => {
    assert.strictEqual(isPostbackCompatible(accepted()), true, 'postbacks still apply to these processes');
    for (const status of ['Latente', 'Aprobado', 'Pendiente de Doc', 'Inicial']) {
      const c = read(accepted({ provider_status: status, provider_status_at: iso(NOW) }));
      assert.deepStrictEqual([c.state, c.detail], [COMMERCIAL.REFERRED, 's2_accepted'], status + ' is not a grant');
    }
    const g = read(accepted({ provider_status: 'Convertido', disbursed_at: iso(NOW) }));
    assert.deepStrictEqual([g.state, g.label], [COMMERCIAL.GRANTED, 'Otorgado ELM']);
    const cell = computeElmCell({ process: accepted({ provider_status: 'Convertido', disbursed_at: iso(NOW) }), nowMs: NOW });
    assert.deepStrictEqual([cell.kind, cell.granted_elm, ElmUi.cellLabel(cell), ElmUi.compactCellText(cell)], ['granted', true, 'Otorgado ELM', 'Otorgado']);
    assert.ok(ElmUi.elmCellHtml(cell).includes('is-granted'));
    assert.strictEqual(outcomeOf(cell), OUTCOMES.GRANTED);
    const auto = accepted({ trigger_origin: 'cz_automatic', send_origin: 'cz_automatic' });
    assert.strictEqual(read(auto, { projectedEstado: 16 }).state, COMMERCIAL.GRANTED);
    assert.strictEqual(read(auto, { projectedEstado: 13 }).detail, 's2_accepted', 'CZ 13 does not change an acceptance');
    assert.strictEqual(read(auto, { projectedEstado: 3 }).state, COMMERCIAL.REJECTED);
  });

  await test('7 later rejection evidence still applies: configured post-referral status, ops closure', () => {
    const r = read(accepted({ provider_status: 'Rechazado' }), { postReferralRejectionStatuses: ['rechazado'] });
    assert.deepStrictEqual([r.state, r.detail], [COMMERCIAL.REJECTED, 'post_referral_status']);
    const unconfigured = read(accepted({ provider_status: 'Rechazado' }));
    assert.strictEqual(unconfigured.state, COMMERCIAL.REFERRED, 'unconfigured statuses never reject (fail safe)');
    const closed = read(accepted({ ops_resolved_at: iso(NOW), ops_resolution_code: 'provider_closed_no_loan' }));
    assert.strictEqual(closed.state, COMMERCIAL.REJECTED);
    const withdrew = read(accepted({ ops_resolved_at: iso(NOW), ops_resolution_code: 'customer_withdrew' }));
    assert.strictEqual(withdrew.state, COMMERCIAL.CLOSED);
  });

  await test('8 "Repetido. Aprobado" unchanged: Duplicado · Otro canal (closed), never Aceptado', () => {
    const dup = accepted({
      s1_status: S1.REJECTED,
      s1_error_code: CODES.S1_DUPLICATE_OTHER_CHANNEL,
      s1_result_message: 'Repetido. Aprobado',
      s2_status: S2.NOT_STARTED,
      s2_http_status: null,
      s2_error_code: null,
      s2_response: null,
      s2_started_at: null,
      s2_completed_at: null,
    });
    const c = read(dup);
    assert.deepStrictEqual([c.state, c.detail, c.detail_label], [COMMERCIAL.CLOSED, 's1_duplicate_other_channel', 'Duplicado · Otro canal']);
    assert.strictEqual(blocksSurveyInvite(c), true);
    const cell = computeElmCell({ process: dup, nowMs: NOW });
    assert.strictEqual(ElmUi.compactCellText(cell), 'Duplicado · Otro canal');
  });

  await test('9 CI hold and surveys: an Aceptado CI keeps holding new sends and survey invites', () => {
    const hold = evaluateCiResendHold({ ci: 32392154, czSolicitudId: 1999, processes: [accepted()], locks: [], nowMs: NOW });
    assert.deepStrictEqual([hold.reason, hold.related_cz_solicitud_id], [HOLD.ACTIVE, 1333]);
    const own = evaluateCiResendHold({ ci: 32392154, czSolicitudId: 1333, processes: [accepted()], locks: [], nowMs: NOW });
    assert.strictEqual(own, null, 'idempotency of the same solicitud is the orchestrator\'s (elm_process_exists)');
    assert.strictEqual(blocksSurveyInvite(read(accepted())), true);
    const blocks = computeElmSurveyBlocks({ processes: [accepted()], states: [], openRequests: [], nowMs: NOW });
    assert.deepStrictEqual(blocks.get(32392154), { cz_solicitud_id: 1333, state: 'referred', source: 'elm_process' });
    const grantedHold = evaluateCiResendHold({ ci: 32392154, czSolicitudId: 1999, processes: [accepted({ disbursed_at: iso(NOW - 40 * DAY) })], locks: [], nowMs: NOW });
    assert.strictEqual(grantedHold.reason, 'elm_ci_recent_send', 'a grant is no longer active; only the usual resend window applies');
  });

  await test('10 ELM KPIs: acceptances and grants apart (flow + current), nothing pending', () => {
    const rows = HISTORICAL.map(([ci, cz]) => historicalRow(ci, cz));
    rows[0] = Object.assign(rows[0], { provider_status: 'Convertido', disbursed_at: iso(NOW - DAY) });
    const k = computeElmKpis(rows, { nowMs: NOW });
    const f = k.flow.janus_manual;
    assert.deepStrictEqual(
      [f.started, f.s1_favorable, f.referred_s2, f.granted, f.pending_or_review, f.rejected_definitive, f.distinct_ci_referred],
      [7, 7, 7, 1, 0, 0, 7],
    );
    assert.deepStrictEqual(k.current.janus_manual, { in_evaluation: 0, referred: 6, granted: 1, rejected: 0, review: 0, closed: 0 });
    const before = computeElmKpis([accepted({ s2_response: { success: true, result: 'x' } })], { nowMs: NOW });
    assert.strictEqual(before.current.janus_manual.review, 1, 'unknown shapes stay pending');
  });

  await test('11 Preaprobados KPIs respect send_origin: preaprobados_manual counted, rechazados_manual never', () => {
    const pre = historicalRow(40000001, 7001, { send_origin: 'preaprobados_manual' });
    const preGranted = historicalRow(40000002, 7002, { send_origin: 'preaprobados_manual', provider_status: 'Convertido', disbursed_at: iso(NOW - DAY) });
    const preUnknown = historicalRow(40000003, 7003, { send_origin: 'preaprobados_manual', s2_response: { success: true, result: 'otro' } });
    const rech = HISTORICAL.map(([ci, cz]) => historicalRow(ci, cz));
    const all = [pre, preGranted, preUnknown].concat(rech);
    const elmManual = buildPreaprobadosManualElmByCzId({ processes: all, nowMs: NOW });
    assert.deepStrictEqual([...elmManual.keys()].sort(), [7001, 7002, 7003]);
    const out = assembleCombinedPreaprobadosList({
      estado8Rows: [],
      currentEstado8Solicitudes: [],
      solicitudRows: [],
      grantedRows: [],
      historicoRows: [],
      elmCohort: buildElmCohortByCzId({ processes: all, nowMs: NOW }),
      elmManual: elmManual,
      elmSolicitudRows: [],
      elmHistoricoRows: [],
      limit: 100,
      offset: 0,
      nowMs: NOW,
    });
    const km = out.kpis_elm.by_origin.preaprobados_manual;
    assert.deepStrictEqual(
      [km.enviados_elm, km.preaprobados_elm, km.otorgados_elm, km.vigentes_elm, km.revision_elm, km.conversion_elm],
      [3, 2, 1, 1, 1, 0.5],
    );
    assert.strictEqual(out.kpis_elm.by_origin.cz_automatic.preaprobados_elm, 0, 'Rechazados sends never join the automatic cohort');
    const byCz = new Map(out.rows.filter((r) => r.elm_member).map((r) => [r.elm_member.cz_solicitud_id, r.elm_member]));
    assert.deepStrictEqual([...byCz.keys()].sort(), [7001, 7002]);
    assert.deepStrictEqual(
      [byCz.get(7001).state, byCz.get(7001).label, byCz.get(7001).detail, byCz.get(7001).accepted_at],
      ['referred', 'Aceptado ELM', 's2_accepted', pre.s2_completed_at],
    );
    assert.deepStrictEqual([byCz.get(7002).state, byCz.get(7002).label], ['granted', 'Otorgado ELM']);
    assert.deepStrictEqual(parseCombinedResultadoQuery('elm_aceptado'), { ok: true, cdv: null, elm: 'referred' });
    assert.deepStrictEqual(parseCombinedResultadoQuery('elm_preaprobado'), { ok: true, cdv: null, elm: 'referred' }, 'old filter value still accepted');
    assert.deepStrictEqual(parseCombinedResultadoQuery('elm_otorgado'), { ok: true, cdv: null, elm: 'granted' });
  });

  await test('12 ELM Ops: technical kind stays s2_unknown (DB-enforced resolutions), labelled Aceptado; no follow-up item', async () => {
    const p = accepted();
    assert.strictEqual(processKind(p, NOW), 's2_unknown');
    const v = openProcessView(p, { nowMs: NOW });
    assert.strictEqual(v.kind, 's2_unknown');
    assert.strictEqual(v.s2_accepted, true);
    assert.deepStrictEqual(v.allowed_resolutions, ['provider_closed_no_loan', 'provider_loan_disbursed', 'other']);
    assert.deepStrictEqual(v.correction_resolutions, ['provider_confirmed_not_received']);
    assert.ok(!JSON.stringify(v).includes('docNumber'), 'no response body in the view');
    assert.strictEqual(ElmOpsUi.processKindLabel(v), 'Aceptado ELM (S2, asignado a Copanel)');
    const plain = openProcessView(accepted({ s2_response: { success: true, result: 'x' } }), { nowMs: NOW });
    assert.strictEqual(plain.s2_accepted, false);
    assert.deepStrictEqual(plain.allowed_resolutions, PROCESS_RESOLUTIONS.s2_unknown.slice(), 'other uncertain S2 unchanged');
    assert.deepStrictEqual(plain.correction_resolutions, []);
    assert.strictEqual(ElmOpsUi.processKindLabel(plain), 'Derivación incierta (S2)');
    const ops = createElmOpsService({
      repository: { czIdsWithEstado3: async () => new Set(), listOpenFallbackRequests: async () => [] },
      elmRepository: {
        listAllProcesses: async () => [accepted(), accepted({ cz_solicitud_id: 1346, ci: 27645104, s2_response: { success: true, result: 'x' } })],
        getProjectedEstadosByCzIds: async () => new Map(),
      },
      fallbackRepository: {},
      now: () => NOW,
      logger: { info() {}, warn() {}, error() {} },
      c1StaleHours: 72,
      postReferralRejectionStatuses: [],
    });
    const ids = (await ops.followup(50)).map((i) => i.cz_solicitud_id);
    assert.ok(!ids.includes(1333), 'Aceptado is not pending review');
    assert.ok(ids.includes(1346), 'other unknowns still are');
  });

  await test('13 CDV / automatic fallback untouched: an automatic accepted shape still goes to manual review', () => {
    const d = deriveFromProcess(accepted({ trigger_origin: 'cz_automatic', send_origin: 'cz_automatic' }), NOW, TECH_RETRY);
    assert.deepStrictEqual([d.kind, d.outcome, d.reasonCode], ['final', FB_OUTCOME.MANUAL_REVIEW, REASONS.ELM_S2_UNKNOWN]);
  });

  await test('14 UI: Aceptado green, Otorgado blue; labels and send message never call an acceptance a loan', () => {
    const css = readSrc('public/mie-dashboard.css');
    const rule = (selector) => {
      const i = css.indexOf(selector);
      assert.ok(i >= 0, selector);
      return css.slice(i, css.indexOf('}', i));
    };
    const GREEN = 'rgba(34, 197, 94, 0.15)';
    const BLUE = 'rgba(59, 130, 246, 0.15)';
    assert.ok(rule('#mie-dashboard-app .preaprobados-elm.is-referred,').includes(GREEN));
    assert.ok(rule('#mie-dashboard-app .preaprobados-result.is-referred-elm {').includes(GREEN));
    assert.ok(rule('#mie-dashboard-app .preaprobados-elm.is-granted,').includes(BLUE));
    assert.ok(rule('#mie-dashboard-app .preaprobados-result.is-granted-elm {').includes(BLUE));
    assert.ok(rule('#mie-dashboard-app .preaprobados-result.is-granted {').includes(GREEN), 'GRANTED CDV badge unchanged');
    const msg = ElmUi.sendResultMessage({ ok: true, outcome: 'referred' });
    assert.ok(msg.text.startsWith('Aceptado ELM') && msg.text.includes('No es un préstamo otorgado'), msg.text);
    assert.ok(ElmUi.sendResultMessage({ ok: true, outcome: 'granted' }).text.startsWith('Otorgado ELM'));
    const dash = readSrc('public/mie-dashboard.js');
    assert.ok(dash.includes("{ id: 'elm_aceptado', label: 'Aceptado ELM' }"));
    assert.ok(dash.includes("escapeHtml(granted ? 'Otorgado ELM' : 'Aceptado ELM')"));
    assert.ok(dash.includes("kpiCard('Aceptados ELM', String(km.preaprobados_elm))"));
    assert.ok(!dash.includes('Preaprobado ELM') && !dash.includes('Preaprobados ELM'), 'old label gone from Preaprobados');
    const html = readSrc('public/mie-dashboard.html');
    assert.strictEqual((html.match(/\?v=20261010-preaprobados-simplify/g) || []).length, 3, 'cache version bumped');
    const flow = new Map(ElmOpsUi.FLOW_LABELS);
    const current = new Map(ElmOpsUi.CURRENT_LABELS);
    assert.deepStrictEqual([flow.get('referred_s2'), flow.get('granted'), current.get('referred'), current.get('granted')], ['Aceptados S2 (Aceptado ELM)', 'Otorgados ELM', 'Aceptado ELM', 'Otorgado ELM']);
  });

  await test('15 ELM Ops resolution of an Aceptado: compatible codes only; "not received" only as an audited correction', async () => {
    for (const c of ACCEPTED_RESOLUTIONS.concat(ACCEPTED_CORRECTIONS)) {
      assert.ok(PROCESS_RESOLUTIONS.s2_unknown.includes(c), c + ' accepted by elm_resolve_process for s2_unknown');
    }
    const PID = '11111111-2222-4333-8444-555555555555';
    const NOTE = 'ELM informó por correo el cierre del caso.';
    const LONG = 'ELM confirmó por correo del 12/10 que el lead nunca ingresó a su CRM.';
    function opsWith(row) {
      const calls = [];
      const svc = createElmOpsService({
        repository: {
          async getProcessById(id) {
            return id === PID ? Object.assign({ id: PID, updated_at: 'v1' }, row) : null;
          },
          async resolveProcess(args) {
            calls.push(args);
            return { status: 'resolved' };
          },
        },
        elmRepository: {},
        fallbackRepository: {},
        now: () => NOW,
        logger: { info() {}, warn() {}, error() {} },
        c1StaleHours: 72,
        postReferralRejectionStatuses: [],
      });
      const resolve = (body) => svc.resolveProcess(PID, Object.assign({ expected_updated_at: 'v1', note: NOTE }, body), 'actor-1');
      return { calls, resolve };
    }

    const a = opsWith(accepted());
    assert.strictEqual((await a.resolve({ resolution_code: 'provider_confirmed_not_received' })).status, 'incompatible_with_accepted');
    assert.strictEqual(ACTION_HTTP.incompatible_with_accepted, 409);
    assert.strictEqual((await a.resolve({ resolution_code: 'customer_withdrew' })).status, 'invalid_resolution', 'DB kind still rules');
    assert.strictEqual(
      (await a.resolve({ resolution_code: 'provider_confirmed_not_received', correction: true, note: 'ELM no lo recibió.' })).status,
      'correction_note_required',
      'ordinary note (10+) is not enough for a correction (30+)',
    );
    assert.strictEqual(
      (await a.resolve({ resolution_code: 'provider_confirmed_not_received', correction: true, note: 'x'.repeat(2000 - CORRECTION_NOTE_PREFIX.length + 1) })).status,
      'correction_note_required',
      'prefix + note must fit the 2000 audited characters',
    );
    assert.strictEqual((await a.resolve({ resolution_code: 'provider_closed_no_loan', correction: true, note: LONG })).status, 'invalid_correction');
    assert.strictEqual((await a.resolve({ resolution_code: 'provider_confirmed_not_received', correction: 'true', note: LONG })).status, 'incompatible_with_accepted', 'only a literal true');
    assert.strictEqual(a.calls.length, 0, 'refusals never reach the RPC');

    for (const code of ACCEPTED_RESOLUTIONS) {
      assert.strictEqual((await a.resolve({ resolution_code: code })).status, 'resolved', code);
    }
    assert.deepStrictEqual(a.calls.map((c) => [c.resolutionCode, c.note]), ACCEPTED_RESOLUTIONS.map((c) => [c, NOTE]));
    const fixed = await a.resolve({ resolution_code: 'provider_confirmed_not_received', correction: true, note: LONG });
    assert.strictEqual(fixed.status, 'resolved');
    const last = a.calls[a.calls.length - 1];
    assert.deepStrictEqual(
      [last.resolutionCode, last.note, last.actorUserId, last.expectedUpdatedAt],
      ['provider_confirmed_not_received', CORRECTION_NOTE_PREFIX + LONG, 'actor-1', 'v1'],
      'correction marked in the note the RPC audits (elm_ops_audit_events)',
    );

    const u = opsWith(accepted({ s2_response: { success: true, result: 'x' } }));
    assert.strictEqual((await u.resolve({ resolution_code: 'provider_confirmed_not_received' })).status, 'resolved', 'other uncertain S2 unchanged');
    assert.strictEqual((await u.resolve({ resolution_code: 'provider_confirmed_not_received', correction: true, note: LONG })).status, 'invalid_correction');
    const r = opsWith(accepted({ s2_status: S2.REFERRED, s2_response: { result: 'Lead Aprobado correctamente' }, s2_error_code: null, s2_result_message: 'Lead Aprobado correctamente' }));
    assert.strictEqual((await r.resolve({ resolution_code: 'customer_withdrew' })).status, 'resolved', 'referrals unchanged');
    assert.strictEqual((await r.resolve({ resolution_code: 'other', correction: true, note: LONG })).status, 'invalid_correction');

    const view = openProcessView(accepted(), { nowMs: NOW });
    const form = ElmOpsUi.resolveProcessFormHtml(view);
    const ordinary = form.slice(0, form.indexOf('<optgroup'));
    assert.ok(!ordinary.includes('value="provider_confirmed_not_received"'), 'not an ordinary option');
    assert.ok(form.includes('<optgroup label="Corrección auditada (contradice Aceptado ELM)"><option value="correction:provider_confirmed_not_received">'), form);
    assert.ok(form.includes('al menos 30 caracteres'));
    assert.deepStrictEqual(ElmOpsUi.parseResolutionChoice('correction:provider_confirmed_not_received'), { resolution_code: 'provider_confirmed_not_received', correction: true });
    assert.deepStrictEqual(ElmOpsUi.parseResolutionChoice('other'), { resolution_code: 'other', correction: false });
    const plainForm = ElmOpsUi.resolveProcessFormHtml(openProcessView(accepted({ s2_response: null }), { nowMs: NOW }));
    assert.ok(!plainForm.includes('optgroup') && plainForm.includes('value="provider_confirmed_not_received"'));
    assert.ok(ElmOpsUi.actionErrorText('incompatible_with_accepted').includes('corrección auditada'));
  });

  await test('16 "Duplicado · Otro canal" in amber; its classification and other closures unchanged', () => {
    const dup = accepted({
      s1_status: S1.REJECTED,
      s1_error_code: CODES.S1_DUPLICATE_OTHER_CHANNEL,
      s1_result_message: 'Repetido. Aprobado',
      s2_status: S2.NOT_STARTED,
      s2_http_status: null,
      s2_error_code: null,
      s2_response: null,
    });
    const cell = computeElmCell({ process: dup, nowMs: NOW });
    assert.deepStrictEqual([cell.kind, cell.state, cell.detail], ['closed', 'closed', 's1_duplicate_other_channel']);
    for (const html of [ElmUi.elmCellHtml(cell), ElmUi.elmCellHtml(cell, { compact: true }), ElmUi.processPillHtml(cell)]) {
      assert.ok(html.includes('preaprobados-elm is-closed is-duplicate'), html);
    }
    const withdrew = computeElmCell({ process: accepted({ ops_resolved_at: iso(NOW), ops_resolution_code: 'customer_withdrew' }), nowMs: NOW });
    const rejected = computeElmCell({ process: accepted({ s1_status: S1.REJECTED, s1_result_message: 'Repetido. Rechazado', s2_status: S2.NOT_STARTED, s2_response: null }), nowMs: NOW });
    for (const c of [withdrew, rejected, computeElmCell({ process: accepted(), nowMs: NOW })]) {
      assert.ok(!ElmUi.elmCellHtml(c).includes('is-duplicate'), c.detail);
      assert.ok(!ElmUi.processPillHtml(c).includes('is-duplicate'), c.detail);
    }
    const css = readSrc('public/mie-dashboard.css');
    const i = css.indexOf('#mie-dashboard-app .preaprobados-elm.is-closed.is-duplicate {');
    assert.ok(i >= 0);
    assert.ok(css.slice(i, css.indexOf('}', i)).includes('rgba(245, 158, 11, 0.15)'), 'amber');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
