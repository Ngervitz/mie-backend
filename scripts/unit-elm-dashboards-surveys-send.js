'use strict';

/**
 * ELM dashboards, surveys and manual send — the 14 mandatory scenarios (mocks only).
 *
 * NO network: every non-loopback socket and the global fetch are blocked and counted. ELM is
 * exercised only through an injected fake fetch; credentials below are FAKE placeholders.
 *
 * Run: node scripts/unit-elm-dashboards-surveys-send.js
 */

const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';
process.env.RECHAZADOS_SURVEY_INVITE_STEP1_CAMPAIGN_ID = '101';
process.env.RECHAZADOS_SURVEY_INVITE_STEP2_CAMPAIGN_ID = '102';
process.env.RECHAZADOS_SURVEY_INVITE_STEP3_CAMPAIGN_ID = '103';

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
    apifyToken: 'test',
    apifyActorId: 'test',
    sessionSecret: 'test-session',
    cronSecret: null,
    emailUnsubscribeHmacSecret: 'test-email-unsubscribe-secret',
    emailPublicBaseUrl: 'https://janus.test',
    rechazadosSurveyInviteCampaignId: '101',
    rechazadosSurveyInviteStep1CampaignId: '101',
    rechazadosSurveyInviteStep2CampaignId: '102',
    rechazadosSurveyInviteStep3CampaignId: '103',
  },
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

const externalNet = [];
function guard(mod, name) {
  mod[name] = function blocked() {
    externalNet.push(name);
    throw new Error('external network blocked in test: ' + name);
  };
}
guard(http, 'request');
guard(http, 'get');
guard(https, 'request');
guard(https, 'get');
guard(net, 'connect');
guard(net, 'createConnection');
guard(tls, 'connect');
globalThis.fetch = async function blockedFetch() {
  externalNet.push('fetch');
  throw new Error('fetch blocked in test');
};

const { S1, S2 } = require('../src/services/elm/constants');
const { readElmConfig } = require('../src/services/elm/config');
const { createElmClient } = require('../src/services/elm/client');
const { createElmOrchestrator } = require('../src/services/elm/orchestrator');
const { classifyElmProcess, blocksSurveyInvite } = require('../src/services/elm/classification');
const { computeElmKpis } = require('../src/services/elm/kpis');
const { createElmListView } = require('../src/services/elm/listView');
const {
  buildElmCohortByCzId,
  assembleCombinedPreaprobadosList,
  rejectedSetFrom,
} = require('../src/lib/preaprobadosElmCohort');
const { assemblePreaprobadosList } = require('../src/lib/preaprobadosRead');
const { assembleRejectedList } = require('../src/lib/rejectedOpsRead');
const { REASONS } = require('../src/lib/rejectedSurveyInvite');
const { decideSurveyInviteSequenceAction } = require('../src/lib/rejectedSurveyInviteEvaluate');
const { getRejectedSurveyInviteEligibility } = require('../src/lib/rejectedSurveyInviteEligibility');
const { computeElmSurveyBlocks } = require('../src/lib/rejectedSurveyInviteElmGate');
const {
  summarizeCiElm,
  loadRejectedDetailElm,
  attachElmToRejectedRows,
  resolveRejectedSend,
  CI_ACTIVE_REASON,
} = require('../src/lib/rejectedElmRead');
const { sendRejectedToElm, OUTCOMES } = require('../src/lib/rejectedElmSend');
const {
  evaluateCiResendHold,
  readElmSendRowsByCis,
  loadCiResendHold,
  montevideoMonthKey,
} = require('../src/lib/rejectedElmResendGuard');
const ElmUi = require('../public/elm-ui-helpers');

const NOW = Date.parse('2026-10-09T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 24 * 3600 * 1000;

const ENV = Object.freeze({
  ELM_CLIENT_ENABLED: 'true',
  ELM_SERVICE_1_URL: 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=10&deploy=1',
  ELM_SERVICE_2_URL: 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=11&deploy=1',
  ELM_CONSUMER_KEY: 'fake-consumer-key-0001',
  ELM_CONSUMER_SECRET: 'fake-consumer-secret-0002',
  ELM_TOKEN_ID: 'fake-token-id-0003',
  ELM_TOKEN_SECRET: 'fake-token-secret-0004',
  ELM_HTTP_TIMEOUT_MS: '40',
  ELM_ACTIVITY_TYPE_MAP_JSON: '{"EPR":"TEST_ACTIVITY_EPR"}',
  ELM_DATE_OF_BIRTH_FORMAT: 'D/M/YYYY',
  ELM_MOBILE_PHONE_FORMAT: 'uy_local_0',
});

/** Process row (list projection) with sensible defaults: S2 referred, manual. */
function proc(over) {
  return Object.assign(
    {
      id: 'p-' + (over && over.cz_solicitud_id),
      cz_solicitud_id: 1,
      ci: 11111111,
      trigger_origin: 'janus_manual',
      created_at: iso(NOW - 5 * DAY),
      updated_at: iso(NOW - 5 * DAY),
      s1_status: S1.ELIGIBLE,
      s1_started_at: iso(NOW - 5 * DAY),
      s1_completed_at: iso(NOW - 5 * DAY),
      s1_lease_expires_at: null,
      s1_result_message: 'Listo para recibir datos en servicio 2',
      s2_status: S2.REFERRED,
      s2_started_at: iso(NOW - 5 * DAY),
      s2_completed_at: iso(NOW - 5 * DAY),
      s2_lease_expires_at: null,
      s2_result_message: 'Lead Aprobado correctamente',
      referred_at: iso(NOW - 5 * DAY),
      provider_status: null,
      provider_status_at: null,
      disbursed_at: null,
      disbursed_amount: null,
      ops_resolution_code: null,
      ops_resolved_at: null,
    },
    over || {},
  );
}

const classify = (p, projectedEstado) =>
  classifyElmProcess(p, { nowMs: NOW, postReferralRejectionStatuses: [], projectedEstado: projectedEstado });

// --- Orchestrator with fake ELM transport + in-memory repository --------------------------

function solicitudFixture(czId, ci) {
  return {
    cz_id: czId,
    ci: ci,
    nombre: 'Ana',
    apellido: 'Prueba',
    email: 'ana@example.test',
    celular: '59899123456',
    salario: 30000,
    fecha_nacimiento: '1991-07-10',
    relacion_laboral: 'EPR',
    lrw_id: 'LRW-' + czId,
    solicitudes_estados_id: 3,
  };
}

function fakeFetch(steps) {
  const calls = [];
  async function f(url, init) {
    calls.push({ url: url, init: init });
    const step = steps[calls.length - 1];
    if (!step) throw new Error('unexpected ELM call #' + calls.length);
    if (step.throws) throw step.throws;
    return { status: step.status, text: async () => JSON.stringify(step.body) };
  }
  f.calls = calls;
  return f;
}
const okResult = (result) => ({ status: 200, body: { result: result } });

function createFakeRepo(solicitudes) {
  const rows = new Map();
  let seq = 0;
  const byId = (id) => [...rows.values()].find((r) => r.id === id) || null;
  return {
    rows,
    async loadSolicitudContext(czId) {
      return { solicitud: solicitudes.get(czId) || null, grantedRow: null };
    },
    async loadSolicitudContexts(ids) {
      return new Map(ids.map((id) => [id, { solicitud: solicitudes.get(id) || null, grantedRow: null }]));
    },
    async resolveBaseLabel() {
      return 'BASE_TEST';
    },
    async getProcessByCzId(czId) {
      return rows.has(czId) ? Object.assign({}, rows.get(czId)) : null;
    },
    async getProcessesByCzIds(ids) {
      const out = new Map();
      for (const id of ids) if (rows.has(id)) out.set(id, Object.assign({}, rows.get(id)));
      return out;
    },
    async claimProcess(a) {
      if (rows.has(a.czSolicitudId)) {
        return { claimed: false, process: Object.assign({}, rows.get(a.czSolicitudId)) };
      }
      seq += 1;
      const row = {
        id: 'proc-' + seq,
        cz_solicitud_id: a.czSolicitudId,
        ci: a.ci,
        trigger_origin: a.triggerOrigin,
        created_at: iso(NOW),
        s1_status: S1.IN_FLIGHT,
        s1_started_at: iso(NOW),
        s1_lease_expires_at: iso(NOW + a.leaseSeconds * 1000),
        s2_status: S2.NOT_STARTED,
        referred_at: null,
      };
      rows.set(a.czSolicitudId, row);
      return { claimed: true, process: Object.assign({}, row) };
    },
    async finishS1(id, r) {
      const row = byId(id);
      if (!row || row.s1_status !== S1.IN_FLIGHT) return null;
      Object.assign(row, {
        s1_status: r.status,
        s1_result_message: r.resultMessage,
        s1_error_code: r.errorCode,
        s1_lease_expires_at: null,
      });
      return Object.assign({}, row);
    },
    async beginS2(czId, req, leaseSeconds) {
      const row = rows.get(czId);
      if (!row || row.s1_status !== S1.ELIGIBLE || row.s2_status !== S2.NOT_STARTED) return null;
      Object.assign(row, {
        s2_status: S2.IN_FLIGHT,
        s2_started_at: iso(NOW),
        s2_lease_expires_at: iso(NOW + leaseSeconds * 1000),
      });
      return Object.assign({}, row);
    },
    async finishS2(id, r) {
      const row = byId(id);
      if (!row || row.s2_status !== S2.IN_FLIGHT) return null;
      Object.assign(row, {
        s2_status: r.status,
        s2_result_message: r.resultMessage,
        s2_lease_expires_at: null,
        referred_at: r.status === S2.REFERRED ? iso(NOW) : null,
      });
      return Object.assign({}, row);
    },
    async expireStaleInFlight(czId) {
      return rows.has(czId) ? Object.assign({}, rows.get(czId)) : null;
    },
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

function sendHarness(steps, opts) {
  const o = opts || {};
  const ci = o.ci || 12345678;
  const solicitudes = new Map((o.czIds || [1001]).map((id) => [id, solicitudFixture(id, ci)]));
  const repo = createFakeRepo(solicitudes);
  const fetchImpl = fakeFetch(steps);
  const env = Object.assign({}, ENV, o.env || {});
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const config = readElmConfig(env);
  const orch = createElmOrchestrator({
    repository: repo,
    client: createElmClient({ env: env, fetchImpl: fetchImpl }),
    config: config,
    logger: silentLogger,
    now: () => NOW,
    postReferralRejectionStatuses: [],
  });
  const listView = createElmListView({
    repository: repo,
    config: config,
    now: () => NOW,
    postReferralRejectionStatuses: [],
    sendReadiness: () => orch.getSendReadiness(),
  });
  const readRows = async () => ({
    processes: [...repo.rows.values()],
    states: [],
    openRequests: [],
    locks: o.locks === undefined ? [] : o.locks,
  });
  const deps = {
    orchestrator: orch,
    listView: listView,
    loadRejectedCzIds: async () => o.rejectedCzIds || [1001],
    loadCiResendHold: (holdCi, czId) =>
      loadCiResendHold(null, holdCi, czId, { now: () => NOW, postReferralRejectionStatuses: [], readRows: readRows }),
  };
  const send = (czId) =>
    sendRejectedToElm(deps, { ci: ci, czSolicitudId: czId, actorUserId: 'user-admin-1' });
  return { orch, repo, fetchImpl, listView, send, readRows, deps };
}

// --- CDV fixture (unchanged cohort rules) -----------------------------------------------

const cdvSol = (czId, ci, estado) => ({
  cz_id: czId,
  ci: ci,
  nombre: 'N' + czId,
  apellido: 'A',
  email: czId + '@x.com',
  lrw_id: 'LRW-' + czId,
  fecha_reg: '2026-08-01T00:00:00.000Z',
  solicitudes_estados_id: estado,
  synced_at: '2026-09-01T00:00:00.000Z',
  updated_at_src: null,
});
const CDV = {
  estado8Rows: [
    { cz_historico_id: 1, cz_solicitud_id: 100, solicitudes_estados_id: 8, estado: 'Enviado CDV', fechahora_src: '2026-10-01T10:00:00.000Z' },
    { cz_historico_id: 2, cz_solicitud_id: 600, solicitudes_estados_id: 8, estado: 'Enviado CDV', fechahora_src: '2026-10-02T10:00:00.000Z' },
  ],
  currentEstado8Solicitudes: [cdvSol(100, 111, 8)],
  solicitudRows: [cdvSol(100, 111, 8), cdvSol(600, 666, 11)],
  grantedRows: [{ cz_id: 600, ci: 666, monto_otorgado: 15000, updated_at_src: '2026-10-05T00:00:00.000Z', synced_at: '2026-10-05T00:00:00.000Z' }],
  historicoRows: [
    { cz_historico_id: 1, cz_solicitud_id: 100, solicitudes_estados_id: 8, estado: 'Enviado CDV', fechahora_src: '2026-10-01T10:00:00.000Z' },
    { cz_historico_id: 2, cz_solicitud_id: 600, solicitudes_estados_id: 8, estado: 'Enviado CDV', fechahora_src: '2026-10-02T10:00:00.000Z' },
    { cz_historico_id: 3, cz_solicitud_id: 600, solicitudes_estados_id: 11, estado: 'Otorgado', fechahora_src: '2026-10-05T00:00:00.000Z' },
  ],
};
const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };

function combined(elmCohort, extra) {
  return assembleCombinedPreaprobadosList(
    Object.assign({}, CDV, WINDOW, {
      elmCohort: elmCohort,
      elmSolicitudRows: [cdvSol(900, 999, 13), cdvSol(901, 998, 16)],
      elmHistoricoRows: [],
      limit: 100,
      offset: 0,
      nowMs: NOW,
    }, extra || {}),
  );
}

function rejectedList(estado3, solicitudRows) {
  return assembleRejectedList({
    estadoRows: estado3,
    solicitudRows: solicitudRows,
    encuestaRows: [],
    snapshotRows: [],
    institutionRows: [],
    outreachRows: [],
    nowMs: NOW,
  });
}

// --- Survey eligibility over a fake Supabase that also serves the ELM tables -----------

function surveySupabase(opts) {
  const o = opts || {};
  const data = {
    cz_funnel_solicitud_estados: o.estados || [],
    cz_funnel_solicitudes: o.solicitudes || [],
    elm_lead_processes: o.processes || [],
    provider_cz_state: o.states || [],
    provider_fallback_requests: o.openRequests || [],
  };
  return {
    from(table) {
      const q = {
        select(cols, selOpts) { q._head = selOpts && selOpts.head; return q; },
        eq() { return q; },
        in() { return q; },
        is() { return q; },
        order() { return q; },
        limit() { return q; },
        async maybeSingle() { return { data: null, error: null }; },
        then(resolve, reject) {
          let out;
          if (table === 'cz_funnel_encuestas') out = { data: o.hasEncuesta ? [{ ci: o.ci }] : [], count: o.hasEncuesta ? 1 : 0, error: null };
          else out = { data: data[table] || [], error: null };
          return Promise.resolve(out).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

function decide(over) {
  return decideSurveyInviteSequenceAction(
    Object.assign(
      {
        ci: 22222222,
        now: new Date(NOW),
        lastRejection: { ci: 22222222, cz_solicitud_id: 7001, cz_historico_id: 1, fechahora_src: iso(NOW - 3 * 3600 * 1000) },
        solicitud: { cz_id: 7001, ci: 22222222, email: 'lead@example.com', lrw_id: 'LRW-7001', nombre: 'Ana' },
        hasEncuesta: false,
        isSuppressed: false,
        stepCampaignIds: { 1: '101', 2: '102', 3: '103' },
        attemptsByStep: { 1: null, 2: null, 3: null },
        publicBaseUrlConfigured: true,
        normalCutoffAtMs: Date.parse('2020-01-01T00:00:00.000Z'),
      },
      over || {},
    ),
  );
}

// ---------------------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('1 historical manual → S1 favorable → S2 referred (Preaprobado ELM, stays in Rechazados)', async () => {
  const h = sendHarness([okResult('Listo para recibir datos en servicio 2'), okResult('Lead Aprobado correctamente')]);
  const out = await h.send(1001);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(out.body.stage, 's2');
  assert.strictEqual(out.body.outcome, OUTCOMES.REFERRED);
  assert.strictEqual(out.body.cell.label, 'Preaprobado ELM');
  assert.strictEqual(out.body.cell.granted_elm, false);
  assert.strictEqual(h.fetchImpl.calls.length, 2, 'S1 then S2 automatically');
  const msg = ElmUi.sendResultMessage(out.body);
  assert.ok(/No es un préstamo otorgado/.test(msg.text));
  assert.ok(!/Otorgado ELM/.test(msg.text));

  const row = h.repo.rows.get(1001);
  assert.strictEqual(row.trigger_origin, 'janus_manual');
  assert.strictEqual(buildElmCohortByCzId({ processes: [row], nowMs: NOW }).size, 0, 'manual never in Preaprobados');
  const blocks = computeElmSurveyBlocks({ processes: [row], nowMs: NOW });
  assert.ok(blocks.has(12345678), 'no survey while referred');
});

test('2 historical manual → S1 rejection (no S2 call, Rechazado ELM)', async () => {
  const h = sendHarness([okResult('SCORE BAJO')]);
  const out = await h.send(1001);
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(out.body.outcome, OUTCOMES.S1_REJECTED);
  assert.strictEqual(out.body.cell.label, 'Rechazado ELM (S1)');
  assert.strictEqual(h.fetchImpl.calls.length, 1, 'S2 never called');
  assert.ok(/evaluación inicial \(S1\)/.test(ElmUi.sendResultMessage(out.body).text));
  const blocks = computeElmSurveyBlocks({ processes: [h.repo.rows.get(1001)], nowMs: NOW });
  assert.strictEqual(blocks.size, 0, 'definitive rejection does not hold the survey circuit');

  const again = await h.send(1001);
  assert.strictEqual(again.body.ok, false, 'idempotent: one process per solicitud');
  assert.strictEqual(again.body.code, 'elm_process_exists');
  assert.ok(/No se envió a ELM/.test(ElmUi.sendResultMessage(again.body).text));
  assert.strictEqual(h.fetchImpl.calls.length, 1);
});

test('3 historical manual → later grant (Otorgado ELM, still Rechazados, not Preaprobados)', async () => {
  const p = proc({ cz_solicitud_id: 1002, provider_status: 'Convertido', disbursed_at: iso(NOW - DAY) });
  assert.strictEqual(classify(p).state, 'granted');
  const s = summarizeCiElm({ ci: p.ci, focusCzIds: [1002], processes: [p], nowMs: NOW });
  assert.strictEqual(s.cells.get(1002).label, 'Otorgado ELM');
  assert.ok(ElmUi.rejectedRowElmHtml({ available: true, cell: s.cells.get(1002) }).includes('Otorgado ELM'));
  assert.strictEqual(buildElmCohortByCzId({ processes: [p], nowMs: NOW }).size, 0);
  assert.ok(s.ci_active, 'granted CI does not get new sends');
});

test('4 automatic → CDV rejects → S2 referred → Preaprobados (not Rechazados)', async () => {
  const p = proc({ cz_solicitud_id: 900, ci: 999, trigger_origin: 'cz_automatic' });
  const cohort = buildElmCohortByCzId({ processes: [p], projectedByCz: new Map([[900, 13]]), nowMs: NOW });
  assert.ok(cohort.has(900));
  const out = combined(cohort);
  const row = out.rows.find((r) => r.cz_id === 900);
  assert.ok(row);
  assert.strictEqual(row.proveedor, 'elm');
  assert.strictEqual(row.elm_member.label, 'Preaprobado ELM');
  assert.strictEqual(row.elm_member.trigger_origin, 'cz_automatic');
  assert.strictEqual(out.kpis_elm.preaprobados_elm, 1);
  assert.strictEqual(out.kpis_elm.otorgados_elm, 0);
  const rej = rejectedList([], [cdvSol(900, 999, 13)]);
  assert.ok(!rej.some((r) => r.ci === 999), 'never in Rechazados while not in estado 3');
  const s1Pending = proc({ cz_solicitud_id: 905, trigger_origin: 'cz_automatic', s2_status: S2.NOT_STARTED, referred_at: null });
  assert.strictEqual(classify(s1Pending).detail, 's1_eligible_pending_s2');
  assert.strictEqual(buildElmCohortByCzId({ processes: [s1Pending], nowMs: NOW }).size, 0, 'S1 favorable only → seguimiento');
});

test('5 automatic → referred → later rejection → leaves Preaprobados, enters Rechazados', async () => {
  const p = proc({ cz_solicitud_id: 900, ci: 999, trigger_origin: 'cz_automatic', ops_resolution_code: 'provider_closed_no_loan', ops_resolved_at: iso(NOW) });
  assert.strictEqual(classify(p, 3).state, 'rejected');
  const estado3 = [{ cz_historico_id: 50, cz_solicitud_id: 900, solicitudes_estados_id: 3, fechahora_src: iso(NOW) }];
  const sols = [cdvSol(900, 999, 3)];
  const rejectedIds = rejectedSetFrom(estado3, sols);
  const cohort = buildElmCohortByCzId({ processes: [p], projectedByCz: new Map([[900, 3]]), rejectedCzIds: rejectedIds, nowMs: NOW });
  assert.strictEqual(cohort.size, 0);
  assert.ok(rejectedList(estado3, sols).some((r) => r.ci === 999));
  const stillReferredInRow = proc({ cz_solicitud_id: 901, trigger_origin: 'cz_automatic' });
  assert.strictEqual(classify(stillReferredInRow, 3).state, 'rejected', 'CZ estado 3 settles a lagging row');
  assert.strictEqual(computeElmSurveyBlocks({ processes: [p], states: [{ cz_solicitud_id: 900, ci: 999, projected_estado: 3 }], nowMs: NOW }).size, 0);
});

test('6 automatic → referred → granted stays in Preaprobados (stale projection never downgrades)', async () => {
  const p = proc({ cz_solicitud_id: 901, ci: 998, trigger_origin: 'cz_automatic', provider_status: 'Convertido', disbursed_at: iso(NOW - DAY) });
  assert.strictEqual(classify(p, 16).state, 'granted');
  assert.strictEqual(classify(p, 13).state, 'granted', 'projection 13 lagging the postback');
  const cohort = buildElmCohortByCzId({ processes: [p], projectedByCz: new Map([[901, 13]]), nowMs: NOW });
  const out = combined(cohort);
  const row = out.rows.find((r) => r.cz_id === 901);
  assert.strictEqual(row.elm_member.label, 'Otorgado ELM');
  assert.strictEqual(out.kpis_elm.otorgados_elm, 1);
  assert.strictEqual(out.kpis_elm.vigentes_elm, 0);
  const onlyGranted = combined(cohort, { resultadoElm: 'granted' });
  assert.deepStrictEqual(onlyGranted.rows.map((r) => r.cz_id), [901]);
});

test('7 ELM definitive rejection → STEP 1 → survey → Mi Plan (existing circuit)', async () => {
  const ci = 22222222;
  const estados = [{ cz_historico_id: 1, cz_solicitud_id: 7001, fechahora_src: iso(NOW - 3600 * 1000), solicitudes_estados_id: 3 }];
  const solicitudes = [{ cz_id: 7001, ci: ci, email: 'lead@example.com', lrw_id: 'LRW-7001', nombre: 'Ana' }];
  const rejectedByElm = proc({ cz_solicitud_id: 7001, ci: ci, s1_status: S1.REJECTED, s1_result_message: 'SCORE BAJO', s2_status: S2.NOT_STARTED, referred_at: null });
  const elig = await getRejectedSurveyInviteEligibility(
    surveySupabase({ ci: ci, estados: estados, solicitudes: solicitudes, processes: [rejectedByElm] }),
    ci,
    { campaignId: '101' },
  );
  assert.strictEqual(elig.eligible, true, 'definitive ELM rejection follows the existing circuit');
  assert.strictEqual(Number(elig.cz_solicitud_id), 7001);
  const d = decide({ elmBlocked: false });
  assert.strictEqual(d.action, 'materialize');
  assert.strictEqual(d.due_step, 1);

  const referred = proc({ cz_solicitud_id: 7001, ci: ci });
  const held = await getRejectedSurveyInviteEligibility(
    surveySupabase({ ci: ci, estados: estados, solicitudes: solicitudes, processes: [referred] }),
    ci,
    { campaignId: '101' },
  );
  assert.strictEqual(held.eligible, false);
  assert.strictEqual(held.reason, REASONS.ELM_IN_PROGRESS, 'no invite while referred');
  const pendingAuto = await getRejectedSurveyInviteEligibility(
    surveySupabase({ ci: ci, estados: estados, solicitudes: solicitudes, states: [{ cz_solicitud_id: 7009, ci: ci, projected_estado: 12 }] }),
    ci,
    { campaignId: '101' },
  );
  assert.strictEqual(pendingAuto.reason, REASONS.ELM_IN_PROGRESS, 'no invite while ELM evaluates (CZ 12)');
  const d2 = decide({ elmBlocked: true });
  assert.strictEqual(d2.action, 'skip');
  assert.strictEqual(d2.result, REASONS.ELM_IN_PROGRESS);

  const broken = {
    from(table) {
      if (table === 'elm_lead_processes') throw new Error('relation missing');
      return surveySupabase({ ci: ci, estados: estados, solicitudes: solicitudes }).from(table);
    },
  };
  await assert.rejects(getRejectedSurveyInviteEligibility(broken, ci, { campaignId: '101' }), /relation missing/, 'fails closed');
});

test('8 CI with a completed survey never gets a new one (with or without ELM)', async () => {
  const d = decide({ hasEncuesta: true, elmBlocked: false });
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.result, REASONS.SURVEY_ALREADY_COMPLETED);
  const d2 = decide({ hasEncuesta: true, elmBlocked: true });
  assert.strictEqual(d2.action, 'skip');
  assert.strictEqual(d2.result, REASONS.SURVEY_ALREADY_COMPLETED);
});

test('9 CI with several solicitudes: per-solicitud exclusivity, CI-level holds', async () => {
  const ci = 33333333;
  const referredA = proc({ cz_solicitud_id: 8001, ci: ci, created_at: iso(NOW - 10 * DAY) });
  const s = summarizeCiElm({ ci: ci, focusCzIds: [8002], processes: [referredA], nowMs: NOW });
  assert.strictEqual(s.cells.size, 0);
  assert.strictEqual(s.other_processes.length, 1);
  assert.strictEqual(s.other_processes[0].cz_solicitud_id, 8001);
  assert.strictEqual(s.other_processes[0].label, 'Preaprobado ELM');
  assert.ok(s.ci_active);
  assert.ok(ElmUi.rejectedRowElmHtml({ available: true, cell: null, other_processes: s.other_processes }).includes('(otra sol.)'));

  const solicitudes = new Map([[8002, solicitudFixture(8002, ci)]]);
  const repo = createFakeRepo(solicitudes);
  const detail = await loadRejectedDetailElm(null, { ci: ci, rejections: [{ cz_solicitud_id: 8002 }] }, {
    listView: createElmListView({ repository: repo, config: readElmConfig(ENV), now: () => NOW, postReferralRejectionStatuses: [], sendReadiness: () => ({ ready: true, reasons: [] }) }),
    sendReadiness: () => ({ ready: true, reasons: [] }),
    readRows: async () => ({ processes: [referredA], states: [], openRequests: [], locks: [] }),
    now: () => NOW,
    postReferralRejectionStatuses: [],
  });
  assert.strictEqual(detail.available, true);
  const cell = detail.solicitudes[0].cell;
  assert.strictEqual(cell.kind, 'not_sent');
  assert.strictEqual(cell.action.show, true);
  assert.strictEqual(cell.action.enabled, false, 'no second send while another solicitud is referred');
  assert.strictEqual(cell.action.reason, CI_ACTIVE_REASON);
  assert.ok(!ElmUi.elmCellHtml(cell).includes('data-action'));

  const free = await loadRejectedDetailElm(null, { ci: ci, rejections: [{ cz_solicitud_id: 8002 }] }, {
    listView: createElmListView({ repository: repo, config: readElmConfig(ENV), now: () => NOW, postReferralRejectionStatuses: [], sendReadiness: () => ({ ready: true, reasons: [] }) }),
    sendReadiness: () => ({ ready: true, reasons: [] }),
    readRows: async () => ({ processes: [], states: [], openRequests: [], locks: [] }),
    now: () => NOW,
  });
  assert.strictEqual(free.solicitudes[0].cell.action.enabled, true);
  assert.ok(ElmUi.elmCellHtml(free.solicitudes[0].cell).includes('data-cz-id="8002"'));

  const autoReferred = proc({ cz_solicitud_id: 8003, ci: ci, trigger_origin: 'cz_automatic' });
  const estado3 = [{ cz_historico_id: 1, cz_solicitud_id: 8002, solicitudes_estados_id: 3, fechahora_src: iso(NOW) }];
  const sols = [cdvSol(8002, ci, 3), cdvSol(8003, ci, 13)];
  const cohort = buildElmCohortByCzId({ processes: [autoReferred], rejectedCzIds: rejectedSetFrom(estado3, sols), nowMs: NOW });
  const rej = rejectedList(estado3, sols);
  assert.ok(cohort.has(8003), 'referred automatic solicitud of the CI in Preaprobados');
  const rejRow = rej.find((r) => r.ci === ci);
  assert.strictEqual(rejRow.cz_solicitud_id, 8002, 'the rejected solicitud of the same CI in Rechazados');
  assert.ok(!cohort.has(8002));
});

test('10 duplicate / out-of-order postbacks never regress or double count', async () => {
  const granted = proc({ cz_solicitud_id: 9001, provider_status: 'Latente', provider_status_at: iso(NOW), disbursed_at: iso(NOW - DAY) });
  assert.strictEqual(classify(granted).state, 'granted', 'older status arriving after Convertido');
  const unknownStatus = proc({ cz_solicitud_id: 9002, provider_status: 'Rechazado por análisis' });
  assert.strictEqual(classify(unknownStatus).state, 'referred', '"Rechazado" text alone is not definitive');
  const configured = classifyElmProcess(unknownStatus, { nowMs: NOW, postReferralRejectionStatuses: ['rechazado por analisis'] });
  assert.strictEqual(configured.state, 'rejected', 'only a configured post-referral status rejects');
  const replayed = Object.assign({}, granted, { provider_status: 'Convertido' });
  const k = computeElmKpis([replayed], { nowMs: NOW });
  assert.strictEqual(k.flow.total.granted, 1, 'replayed Convertido updates the same row');
  assert.strictEqual(k.flow.total.started, 1, 'one row per solicitud');
  assert.strictEqual(k.flow.total.referred_s2, 1);
});

test('11 technical error / ambiguous → review (never a rejection, never a survey)', async () => {
  const h = sendHarness([{ throws: new Error('socket hang up') }]);
  const out = await h.send(1001);
  assert.ok([OUTCOMES.TECHNICAL_ERROR, OUTCOMES.REVIEW].includes(out.body.outcome), 'outcome ' + out.body.outcome);
  assert.ok(/no es un rechazo/.test(ElmUi.sendResultMessage(out.body).text));
  assert.strictEqual(h.fetchImpl.calls.length, 1, 'S2 never runs after an S1 error');
  const row = h.repo.rows.get(1001);
  assert.strictEqual(classify(row).state, 'review');
  assert.ok(blocksSurveyInvite(classify(row)));

  for (const p of [
    proc({ s2_status: S2.UNKNOWN, referred_at: null }),
    proc({ s2_status: S2.REJECTED, s2_result_message: 'Aprobado sin canal', referred_at: null }),
    proc({ s1_status: S1.REJECTED, s1_result_message: 'Rechazado', s2_status: S2.NOT_STARTED, referred_at: null }),
    proc({ s2_status: S2.IN_FLIGHT, s2_lease_expires_at: iso(NOW - 1000), referred_at: null }),
  ]) {
    assert.strictEqual(classify(p).state, 'review', JSON.stringify([p.s1_status, p.s2_status, p.s2_result_message]));
  }
  const definitiveS2 = proc({ s2_status: S2.REJECTED, s2_result_message: 'Documento no válido', referred_at: null });
  assert.strictEqual(classify(definitiveS2).state, 'rejected');

  const notReady = sendHarness([], { env: { ELM_ACTIVITY_TYPE_MAP_JSON: undefined } });
  const blocked = await notReady.send(1001);
  assert.strictEqual(blocked.status, 503);
  assert.strictEqual(blocked.body.code, 'elm_send_not_ready');
  assert.strictEqual(notReady.fetchImpl.calls.length, 0);
  assert.strictEqual(notReady.repo.rows.size, 0, 'nothing persisted when config is missing');
  const disabled = sendHarness([], { env: { ELM_CLIENT_ENABLED: 'false' } });
  assert.strictEqual((await disabled.send(1001)).status, 503);
  const notRejected = sendHarness([]);
  const wrong = await notRejected.send(4242);
  assert.strictEqual(wrong.status, 404);
  assert.strictEqual(wrong.body.code, 'elm_solicitud_not_in_rejections');
});

test('12 KPIs: flow (historical) vs current state, by origin, no CDV fields', async () => {
  const laterRejected = proc({ cz_solicitud_id: 1, ci: 1, trigger_origin: 'cz_automatic', ops_resolution_code: 'provider_closed_no_loan', ops_resolved_at: iso(NOW) });
  const referred = proc({ cz_solicitud_id: 2, ci: 2, trigger_origin: 'janus_manual' });
  const s1No = proc({ cz_solicitud_id: 3, ci: 3, trigger_origin: 'janus_manual', s1_status: S1.REJECTED, s1_result_message: 'Blacklist', s2_status: S2.NOT_STARTED, referred_at: null });
  const review = proc({ cz_solicitud_id: 4, ci: 3, trigger_origin: 'janus_batch', s1_status: S1.TECHNICAL_ERROR, s2_status: S2.NOT_STARTED, referred_at: null });
  const k = computeElmKpis([laterRejected, referred, s1No, review], { nowMs: NOW });
  assert.strictEqual(k.flow.total.started, 4);
  assert.strictEqual(k.flow.total.referred_s2, 2, 'referral counted in flow even after the later rejection');
  assert.strictEqual(k.current.total.referred, 1);
  assert.strictEqual(k.current.total.rejected, 2);
  assert.strictEqual(k.flow.total.rejected_definitive, 2);
  assert.strictEqual(k.flow.total.pending_or_review, 1);
  assert.strictEqual(k.flow.cz_automatic.referred_s2, 1);
  assert.strictEqual(k.flow.janus_manual.started, 2);
  assert.strictEqual(k.flow.janus_batch.pending_or_review, 1);
  assert.strictEqual(k.flow.total.distinct_ci_started, 3);
  for (const key of ['started', 'referred_s2', 'granted']) {
    const sum = k.flow.janus_manual[key] + k.flow.janus_batch[key] + k.flow.cz_automatic[key];
    assert.strictEqual(sum, k.flow.total[key], 'segments add up: ' + key);
  }
  assert.ok(!/cdv|granted_cdv|estado8/i.test(JSON.stringify(Object.keys(k.flow.total))));
  const windowed = computeElmKpis([laterRejected], { nowMs: NOW, from: iso(NOW - DAY), to: iso(NOW) });
  assert.strictEqual(windowed.flow.total.started, 0, 'window by process created_at');
});

test('13 CDV cohort regression: rows and KPIs identical to the CDV assembler', async () => {
  const base = assemblePreaprobadosList(Object.assign({}, CDV, WINDOW, { limit: Number.MAX_SAFE_INTEGER, offset: 0, nowMs: NOW }));
  const none = combined(new Map());
  assert.deepStrictEqual(none.kpis, base.kpis);
  assert.deepStrictEqual(none.rows.map((r) => r.cz_id), base.rows.map((r) => r.cz_id));
  assert.ok(none.rows.every((r) => r.proveedor === 'cdv' && r.elm_member === null));
  const p = proc({ cz_solicitud_id: 900, ci: 999, trigger_origin: 'cz_automatic' });
  const withElm = combined(buildElmCohortByCzId({ processes: [p], nowMs: NOW }));
  assert.deepStrictEqual(withElm.kpis, base.kpis, 'CDV KPIs never include ELM');
  assert.strictEqual(withElm.total, base.rows.length + 1);
  const cdvOnly = combined(buildElmCohortByCzId({ processes: [p], nowMs: NOW }), { proveedor: 'cdv' });
  assert.deepStrictEqual(cdvOnly.rows.map((r) => r.cz_id), base.rows.map((r) => r.cz_id));
  const cdvGranted = combined(buildElmCohortByCzId({ processes: [p], nowMs: NOW }), { resultadoCdv: 'granted' });
  assert.ok(cdvGranted.rows.every((r) => r.proveedor !== 'elm'));
});

test('14 no solicitud is in Preaprobados and Rechazados at the same time', async () => {
  const procs = [
    proc({ cz_solicitud_id: 10, ci: 10, trigger_origin: 'cz_automatic' }),
    proc({ cz_solicitud_id: 11, ci: 11, trigger_origin: 'cz_automatic', disbursed_at: iso(NOW) }),
    proc({ cz_solicitud_id: 12, ci: 12, trigger_origin: 'cz_automatic' }),
    proc({ cz_solicitud_id: 13, ci: 13, trigger_origin: 'janus_manual' }),
    proc({ cz_solicitud_id: 14, ci: 14, trigger_origin: 'cz_automatic', s2_status: S2.IN_FLIGHT, referred_at: null }),
  ];
  const estado3 = [
    { cz_historico_id: 1, cz_solicitud_id: 12, solicitudes_estados_id: 3, fechahora_src: iso(NOW) },
    { cz_historico_id: 2, cz_solicitud_id: 13, solicitudes_estados_id: 3, fechahora_src: iso(NOW) },
  ];
  const sols = [cdvSol(10, 10, 13), cdvSol(11, 11, 16), cdvSol(12, 12, 3), cdvSol(13, 13, 3), cdvSol(14, 14, 12)];
  const cohort = buildElmCohortByCzId({
    processes: procs,
    projectedByCz: new Map([[10, 13], [11, 16], [12, 3]]),
    rejectedCzIds: rejectedSetFrom(estado3, sols),
    nowMs: NOW,
  });
  const rejected = new Set(rejectedList(estado3, sols).map((r) => r.cz_solicitud_id));
  for (const id of cohort.keys()) assert.ok(!rejected.has(id), 'double membership: ' + id);
  assert.deepStrictEqual(Array.from(cohort.keys()).sort(), [10, 11]);
  assert.deepStrictEqual(Array.from(rejected).sort(), [12, 13]);
  assert.ok(!cohort.has(14) && !rejected.has(14), 'in evaluation → seguimiento only');
});

// --- Rechazados list: "Enviar a ELM" in the ELM column (same send path as the detail) ------

/** List row as GET /rechazados builds it, then ELM attached with the harness deps. */
async function listRow(h, ci, rejected, extra) {
  const row = {
    ci: ci,
    cz_solicitud_id: rejected[0].cz_solicitud_id,
    rejected_solicitudes: rejected,
  };
  const e = extra || {};
  await attachElmToRejectedRows([row], {
    supabase: null,
    listView: e.listView || h.listView,
    readRows:
      e.readRows ||
      (async () => {
        const base = await h.readRows();
        return Object.assign(base, { processes: base.processes.concat(e.processes || []) });
      }),
    now: () => NOW,
    postReferralRejectionStatuses: [],
  });
  return row;
}

test('15 list row carries every rejected solicitud of the CI (newest first, one per solicitud)', async () => {
  const ci = 44444444;
  const estado3 = [
    { cz_historico_id: 1, cz_solicitud_id: 9001, solicitudes_estados_id: 3, fechahora_src: iso(NOW - 10 * DAY) },
    { cz_historico_id: 2, cz_solicitud_id: 9002, solicitudes_estados_id: 3, fechahora_src: iso(NOW - 2 * DAY) },
    { cz_historico_id: 3, cz_solicitud_id: 9001, solicitudes_estados_id: 3, fechahora_src: iso(NOW - 9 * DAY) },
  ];
  const row = rejectedList(estado3, [cdvSol(9001, ci, 3), cdvSol(9002, ci, 3)]).find((r) => r.ci === ci);
  assert.strictEqual(row.cz_solicitud_id, 9002);
  assert.deepStrictEqual(row.rejected_solicitudes, [
    { cz_solicitud_id: 9002, rejected_at: iso(NOW - 2 * DAY) },
    { cz_solicitud_id: 9001, rejected_at: iso(NOW - 9 * DAY) },
  ]);
});

test('16 list: one sendable solicitud → button bound to it; same S1→S2 send; then commercial state', async () => {
  const ci = 45454545;
  const h = sendHarness(
    [okResult('Listo para recibir datos en servicio 2'), okResult('Lead Aprobado correctamente')],
    { ci: ci, czIds: [9002], rejectedCzIds: [9002, 9001] },
  );
  const rejected = [
    { cz_solicitud_id: 9002, rejected_at: '2026-10-07T10:00:00.000Z' },
    { cz_solicitud_id: 9001, rejected_at: '2026-09-01T10:00:00.000Z' },
  ];
  const row = await listRow(h, ci, rejected);
  assert.strictEqual(row.elm.available, true);
  assert.strictEqual(row.elm.cell, null);
  assert.strictEqual(row.elm.send.target_cz_id, 9002, '9001 has no CZ solicitud → not sendable');
  assert.strictEqual(row.elm.send.needs_selection, false);
  assert.deepStrictEqual(row.elm.send.selectable_cz_ids, [9002]);
  const html = ElmUi.rejectedRowElmHtml(row.elm, row.ci);
  assert.ok(html.includes('data-action="elm-send"'));
  assert.ok(html.includes('data-cz-id="9002"'));
  assert.ok(html.includes('data-ci="' + ci + '"'));
  assert.ok(html.includes('data-rejected-at="07/10/2026"'));
  assert.ok(html.includes('Sol. 9002'), 'the solicitud is visible next to the button');
  assert.ok(!html.includes('<select'));
  assert.ok(!/ disabled /.test(html));

  const detail = await loadRejectedDetailElm(null, { ci: ci, rejections: rejected.map((r) => ({ cz_solicitud_id: r.cz_solicitud_id, fechahora_src: r.rejected_at })) }, {
    listView: h.listView,
    sendReadiness: () => h.orch.getSendReadiness(),
    readRows: h.readRows,
    now: () => NOW,
    postReferralRejectionStatuses: [],
  });
  assert.deepStrictEqual(detail.send, row.elm.send, 'list and detail resolve the target identically');
  assert.strictEqual(h.fetchImpl.calls.length, 0, 'rendering never calls ELM');

  const out = await h.send(9002);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.outcome, OUTCOMES.REFERRED);
  assert.strictEqual(h.fetchImpl.calls.length, 2, 'S1 then S2');
  const again = await h.send(9002);
  assert.strictEqual(again.body.code, 'elm_process_exists', 'idempotent');
  assert.strictEqual(h.fetchImpl.calls.length, 2);

  const after = await listRow(h, ci, rejected);
  assert.strictEqual(after.elm.cell.label, 'Preaprobado ELM');
  const afterHtml = ElmUi.rejectedRowElmHtml(after.elm, after.ci);
  assert.ok(afterHtml.includes('Preaprobado ELM'));
  assert.ok(!afterHtml.includes('<button'), 'state replaces the button');
});

test('17 list: several sendable solicitudes → explicit selection, never an implicit target', async () => {
  const ci = 46464646;
  const h = sendHarness([okResult('SCORE BAJO')], { ci: ci, czIds: [9101, 9102], rejectedCzIds: [9102, 9101] });
  const rejected = [
    { cz_solicitud_id: 9102, rejected_at: '2026-10-05T10:00:00.000Z' },
    { cz_solicitud_id: 9101, rejected_at: '2026-08-20T10:00:00.000Z' },
  ];
  const row = await listRow(h, ci, rejected);
  assert.strictEqual(row.elm.send.target_cz_id, null);
  assert.strictEqual(row.elm.send.needs_selection, true);
  assert.deepStrictEqual(row.elm.send.selectable_cz_ids, [9102, 9101]);
  const html = ElmUi.rejectedRowElmHtml(row.elm, row.ci);
  assert.ok(html.includes('<select') && html.includes('data-elm-pick="1"'));
  assert.ok(html.includes('<option value="">Elegir sol. (2)</option>'), 'nothing preselected');
  assert.ok(html.includes('<option value="9102" data-rejected-at="05/10/2026">Sol. 9102 · 05/10/2026</option>'));
  assert.ok(html.includes('<option value="9101" data-rejected-at="20/08/2026">Sol. 9101 · 20/08/2026</option>'));
  const button = html.slice(html.indexOf('<button'));
  assert.ok(/ disabled /.test(button), 'button disabled until a solicitud is chosen');
  assert.ok(!button.includes('data-cz-id'), 'no solicitud bound before the choice');

  const missing = await h.send(undefined);
  assert.strictEqual(missing.status, 400, 'the endpoint never guesses the solicitud');
  const foreign = await h.send(9999);
  assert.strictEqual(foreign.status, 404);
  assert.strictEqual(foreign.body.code, 'elm_solicitud_not_in_rejections');
  assert.strictEqual(h.fetchImpl.calls.length, 0);

  const chosen = await h.send(9101);
  assert.strictEqual(chosen.body.outcome, OUTCOMES.S1_REJECTED);
  assert.strictEqual(h.fetchImpl.calls.length, 1);
  assert.ok(h.repo.rows.has(9101) && !h.repo.rows.has(9102), 'only the chosen solicitud was sent');
});

test('18 list: ELM disabled or config missing → disabled button with a short reason', async () => {
  const cases = [
    { env: { ELM_CLIENT_ENABLED: 'false' }, title: 'Envío a ELM deshabilitado: la integración no está activada.' },
    { env: { ELM_CONSUMER_KEY: undefined }, title: 'Configuración ELM incompleta: faltan credenciales o URLs.' },
    {
      env: { ELM_DATE_OF_BIRTH_FORMAT: undefined, ELM_MOBILE_PHONE_FORMAT: undefined },
      title: 'Configuración ELM pendiente: formato de fecha de nacimiento, formato de celular.',
    },
    { env: { ELM_ACTIVITY_TYPE_MAP_JSON: undefined }, title: 'Configuración ELM pendiente: mapeo de actividad.' },
  ];
  for (const c of cases) {
    const ci = 47474747;
    const h = sendHarness([], { ci: ci, czIds: [9201, 9202], rejectedCzIds: [9202, 9201], env: c.env });
    const row = await listRow(h, ci, [{ cz_solicitud_id: 9202 }, { cz_solicitud_id: 9201 }]);
    assert.strictEqual(row.elm.send.candidates.length, 2);
    assert.strictEqual(row.elm.send.target_cz_id, null);
    assert.strictEqual(row.elm.send.needs_selection, false, 'nothing to choose while disabled');
    const html = ElmUi.rejectedRowElmHtml(row.elm, row.ci);
    assert.ok(/ disabled /.test(html), JSON.stringify(c.env));
    assert.ok(html.includes('title="' + c.title + '"'), html);
    assert.ok(!html.includes('data-action'), 'disabled: no click wiring');
    assert.ok(!html.includes('<select'));
    const out = await h.send(9202);
    assert.strictEqual(out.status, 503, 'endpoint keeps the readiness guard');
    assert.strictEqual(h.fetchImpl.calls.length, 0);
  }
});

test('19 vigente process of another solicitud (evaluation / referred / review) blocks new sends', async () => {
  const ci = 48484848;
  const h = sendHarness([], { ci: ci, czIds: [9301, 9302], rejectedCzIds: [9302, 9301] });
  const referredOther = proc({ cz_solicitud_id: 9301, ci: ci });
  const pending = proc({ cz_solicitud_id: 9301, ci: ci, s1_status: S1.IN_FLIGHT, s1_lease_expires_at: iso(NOW + 60000), s1_completed_at: null, s1_result_message: null, s2_status: S2.NOT_STARTED, s2_started_at: null, s2_completed_at: null, s2_result_message: null, referred_at: null });
  const review = proc({ cz_solicitud_id: 9301, ci: ci, s1_status: S1.UNKNOWN, s1_result_message: null, s2_status: S2.NOT_STARTED, s2_started_at: null, s2_completed_at: null, s2_result_message: null, referred_at: null });
  for (const active of [referredOther, pending, review]) {
    h.repo.rows.clear();
    h.repo.rows.set(9301, active);
    const row = await listRow(h, ci, [{ cz_solicitud_id: 9302 }, { cz_solicitud_id: 9301 }]);
    const html = ElmUi.rejectedRowElmHtml(row.elm, row.ci);
    assert.ok(html.includes('(otra sol.)'), 'history stays visible');
    assert.ok(html.includes('title="Hay un proceso ELM vigente para esta CI (sol. 9301)."'), html);
    assert.ok(!html.includes('data-action'), 'button shown disabled, never clickable');
    assert.strictEqual(row.elm.send.hold.reason, CI_ACTIVE_REASON);
    assert.deepStrictEqual(row.elm.send.candidates.map((c) => c.cz_solicitud_id), [9302], 'own-process solicitud is never a candidate');
    const out = await h.send(9302);
    assert.strictEqual(out.status, 409);
    assert.strictEqual(out.body.code, CI_ACTIVE_REASON);
    assert.ok(/proceso ELM vigente/.test(ElmUi.sendResultMessage(out.body).text));
  }
  assert.strictEqual(h.fetchImpl.calls.length, 0);
});

/** Process of another solicitud closed by a definitive S1 rejection `daysAgo` days ago. */
function closedS1(czId, ci, daysAgo) {
  const t = iso(NOW - daysAgo * DAY);
  return proc({
    cz_solicitud_id: czId, ci: ci, created_at: t, updated_at: t,
    s1_status: S1.REJECTED, s1_started_at: t, s1_completed_at: t, s1_result_message: 'SCORE BAJO',
    s2_status: S2.NOT_STARTED, s2_started_at: null, s2_completed_at: null, s2_result_message: null, referred_at: null,
  });
}

test('20 closed process of another solicitud (>30 days, other month): history + send of the new one', async () => {
  const ci = 48585858;
  const h = sendHarness(
    [okResult('Listo para recibir datos en servicio 2'), okResult('Lead Aprobado correctamente')],
    { ci: ci, czIds: [9301, 9302], rejectedCzIds: [9302, 9301] },
  );
  h.repo.rows.set(9301, closedS1(9301, ci, 40));
  const row = await listRow(h, ci, [{ cz_solicitud_id: 9302, rejected_at: '2026-10-06T10:00:00.000Z' }, { cz_solicitud_id: 9301 }]);
  assert.strictEqual(row.elm.send.hold, null);
  assert.strictEqual(row.elm.send.target_cz_id, 9302);
  assert.deepStrictEqual(row.elm.send.candidates.map((c) => c.cz_solicitud_id), [9302]);
  const html = ElmUi.rejectedRowElmHtml(row.elm, row.ci);
  assert.ok(html.includes('Rechazado · SCORE BAJO (otra sol.)'), 'historical ELM state shown');
  assert.ok(html.includes('data-action="elm-send"') && html.includes('data-cz-id="9302"'), 'button not hidden');
  assert.ok(html.indexOf('(otra sol.)') < html.indexOf('<button'), 'history above the button');

  const resend = await h.send(9301);
  assert.strictEqual(resend.body.code, 'elm_process_exists', 'a solicitud with its own process is never sent as new');
  assert.strictEqual(h.fetchImpl.calls.length, 0);
  const out = await h.send(9302);
  assert.strictEqual(out.body.outcome, OUTCOMES.REFERRED);
  assert.strictEqual(h.fetchImpl.calls.length, 2, 'unchanged S1 → S2');
});

test('21 ELM 30-day duplicate window: closed in JANUS does not mean ELM accepts a new referral', async () => {
  const ci = 48686868;
  const t10 = iso(NOW - 10 * DAY);
  const histories = [
    { name: 'S1 rejected 10 days ago (previous month)', p: closedS1(9301, ci, 10) },
    { name: 'granted 10 days ago', p: proc({ cz_solicitud_id: 9301, ci: ci, created_at: t10, s1_started_at: t10, s2_started_at: t10, referred_at: t10, disbursed_at: t10 }) },
    { name: 'ops: ELM confirmed not received', p: Object.assign(closedS1(9301, ci, 10), { ops_resolved_at: t10, ops_resolution_code: 'provider_confirmed_not_received' }) },
  ];
  for (const c of histories) {
    const h = sendHarness([], { ci: ci, czIds: [9302], rejectedCzIds: [9302, 9301] });
    h.repo.rows.set(9301, c.p);
    const row = await listRow(h, ci, [{ cz_solicitud_id: 9302 }, { cz_solicitud_id: 9301 }]);
    assert.strictEqual(row.elm.send.hold.reason, 'elm_ci_recent_send', c.name);
    assert.strictEqual(row.elm.send.hold.until, iso(NOW + 20 * DAY));
    const html = ElmUi.rejectedRowElmHtml(row.elm, row.ci);
    assert.ok(html.includes('dentro de los 30 días del anterior (sol. 9301); disponible desde el 29/10/2026.'), html);
    assert.ok(!html.includes('data-action'), c.name);
    const out = await h.send(9302);
    assert.strictEqual(out.status, 409, c.name);
    assert.strictEqual(out.body.code, 'elm_ci_recent_send');
    assert.strictEqual(out.body.until, iso(NOW + 20 * DAY));
    assert.strictEqual(h.fetchImpl.calls.length, 0, 'ELM never called');
  }
  const exactly30 = evaluateCiResendHold({ ci: ci, processes: [closedS1(9301, ci, 30)], locks: [], nowMs: NOW });
  assert.strictEqual(exactly30, null, '30 full days elapsed (and another month) → allowed');
  const almost = evaluateCiResendHold({ ci: ci, processes: [closedS1(9301, ci, 29.9)], locks: [], nowMs: NOW });
  assert.strictEqual(almost.reason, 'elm_ci_recent_send');
});

test('22 database CI lock mirrored: monthly quota, send in progress, blocking referral', async () => {
  const ci = 48787878;
  assert.strictEqual(montevideoMonthKey(NOW), '2026-10-01');
  assert.strictEqual(montevideoMonthKey(Date.parse('2026-10-01T02:30:00Z')), '2026-09-01', 'Uruguay calendar month');
  const lock = (over) => Object.assign({ ci: ci, cz_solicitud_id: 9301, state: 'consumed', month_key: '2026-10-01', blocks_future: false, block_reason: null, reserved_at: iso(NOW - 8 * DAY), consumed_at: iso(NOW - 8 * DAY) }, over);
  const cases = [
    { name: 'consumed this month', locks: [lock()], reason: 'elm_ci_monthly_quota_used', text: 'La CI ya tuvo un envío ELM este mes (sol. 9301); disponible desde el 01/11/2026.' },
    { name: 'reserved', locks: [lock({ state: 'reserved', consumed_at: null })], reason: 'elm_ci_send_in_progress', text: 'Hay un envío ELM en curso para esta CI (sol. 9301).' },
    { name: 'blocking referral', locks: [lock({ blocks_future: true, block_reason: 'active_referral', month_key: '2026-07-01', reserved_at: iso(NOW - 90 * DAY), consumed_at: iso(NOW - 90 * DAY) })], reason: 'elm_ci_active', text: 'Hay un proceso ELM vigente para esta CI (sol. 9301).' },
  ];
  for (const c of cases) {
    const h = sendHarness([], { ci: ci, czIds: [9302], rejectedCzIds: [9302], locks: c.locks });
    h.repo.rows.set(9301, closedS1(9301, ci, c.name === 'blocking referral' ? 90 : 8));
    const row = await listRow(h, ci, [{ cz_solicitud_id: 9302 }]);
    assert.strictEqual(row.elm.send.hold.reason, c.reason, c.name);
    assert.ok(ElmUi.rejectedRowElmHtml(row.elm, row.ci).includes('title="' + c.text + '"'), c.name);
    const out = await h.send(9302);
    assert.strictEqual(out.body.code, c.reason, c.name);
    assert.strictEqual(h.fetchImpl.calls.length, 0);
  }
  const released = evaluateCiResendHold({ ci: ci, processes: [], locks: [lock({ state: 'released', consumed_at: null, month_key: '2026-10-01' })], nowMs: NOW });
  assert.strictEqual(released, null, 'a released lock (no ELM contact) does not hold');
});

test('23 eligibility that cannot be determined safely → blocked with the reason', async () => {
  const ci = 48888888;
  const h = sendHarness([], { ci: ci, czIds: [9302], rejectedCzIds: [9302], locks: null });
  const row = await listRow(h, ci, [{ cz_solicitud_id: 9302 }]);
  assert.strictEqual(row.elm.send.hold.reason, 'elm_ci_history_unverifiable');
  const html = ElmUi.rejectedRowElmHtml(row.elm, row.ci);
  assert.ok(html.includes('title="No se pudo verificar el historial ELM de la CI: envío bloqueado."'));
  assert.ok(!html.includes('data-action'));
  const out = await h.send(9302);
  assert.strictEqual(out.status, 503);
  assert.strictEqual(out.body.code, 'elm_ci_history_unverifiable');

  const throwing = await sendRejectedToElm(
    Object.assign({}, h.deps, { loadCiResendHold: async () => { throw new Error('db down'); } }),
    { ci: ci, czSolicitudId: 9302, actorUserId: 'user-admin-1' },
  );
  assert.strictEqual(throwing.status, 503);
  assert.strictEqual(throwing.body.code, 'elm_ci_history_unverifiable');
  const noGuard = await sendRejectedToElm(
    Object.assign({}, h.deps, { loadCiResendHold: undefined }),
    { ci: ci, czSolicitudId: 9302, actorUserId: 'user-admin-1' },
  );
  assert.strictEqual(noGuard.body.code, 'elm_ci_history_unverifiable', 'missing guard fails closed');

  const undated = Object.assign(closedS1(9301, ci, 60), { created_at: null, s1_started_at: null, s1_completed_at: null });
  assert.strictEqual(evaluateCiResendHold({ ci: ci, processes: [undated], locks: [], nowMs: NOW }).reason, 'elm_ci_history_unverifiable');

  const fakeSb = {
    from(table) {
      const q = {
        select() { return q; },
        in() { return q; },
        is() { return q; },
        then(resolve, reject) {
          const out = table === 'elm_ci_send_locks'
            ? { data: null, error: { message: 'permission denied' } }
            : { data: table === 'elm_lead_processes' ? [closedS1(9301, ci, 60)] : [], error: null };
          return Promise.resolve(out).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const rows = await readElmSendRowsByCis(fakeSb, [ci]);
  assert.strictEqual(rows.locks, null, 'lock read failure is reported, not hidden');
  assert.strictEqual(rows.processes.length, 1, 'history still readable');
  assert.strictEqual(evaluateCiResendHold({ ci: ci, processes: rows.processes, locks: rows.locks, nowMs: NOW }).reason, 'elm_ci_history_unverifiable');
  assert.strictEqual(h.fetchImpl.calls.length, 0);
});

test('24 history + several eligible new solicitudes → explicit selection', async () => {
  const ci = 48989898;
  const h = sendHarness([okResult('SCORE BAJO')], { ci: ci, czIds: [9502, 9503], rejectedCzIds: [9503, 9502, 9501] });
  h.repo.rows.set(9501, closedS1(9501, ci, 45));
  const row = await listRow(h, ci, [{ cz_solicitud_id: 9503 }, { cz_solicitud_id: 9502 }, { cz_solicitud_id: 9501 }]);
  assert.strictEqual(row.elm.send.needs_selection, true);
  assert.strictEqual(row.elm.send.target_cz_id, null);
  assert.deepStrictEqual(row.elm.send.selectable_cz_ids, [9503, 9502]);
  const html = ElmUi.rejectedRowElmHtml(row.elm, row.ci);
  assert.ok(html.includes('Rechazado · SCORE BAJO (otra sol.)'));
  assert.ok(html.includes('data-elm-pick="1"') && !html.includes('value="9501"'), 'own-process solicitud not offered');
  const button = html.slice(html.indexOf('<button'));
  assert.ok(/ disabled /.test(button) && !button.includes('data-cz-id'));
  const out = await h.send(9502);
  assert.strictEqual(out.body.outcome, OUTCOMES.S1_REJECTED);
  const after = await listRow(h, ci, [{ cz_solicitud_id: 9503 }, { cz_solicitud_id: 9502 }, { cz_solicitud_id: 9501 }]);
  assert.strictEqual(after.elm.send.hold.reason, 'elm_ci_recent_send', 'the other new solicitud waits 30 days after this send');
  assert.strictEqual(after.elm.send.needs_selection, false);

  const pure = resolveRejectedSend({
    rejected: [{ cz_solicitud_id: 1 }, { cz_solicitud_id: 1 }],
    cells: new Map([[1, { kind: 'not_sent', cz_solicitud_id: 1, action: { show: true, enabled: true, reason: null } }]]),
    hold: null,
  });
  assert.strictEqual(pure.solicitudes.length, 1, 'duplicate rejections of one solicitud are one candidate');
  assert.strictEqual(pure.send.target_cz_id, 1);
});

test('25 list: fail-soft (state without send view; whole column unavailable only if ELM rows fail)', async () => {
  const ci = 49494949;
  const h = sendHarness([], { ci: ci, czIds: [9401] });
  const broken = { cellsForCzIds: async () => { throw new Error('boom'); } };
  const row = await listRow(h, ci, [{ cz_solicitud_id: 9401 }], { listView: broken, processes: [proc({ cz_solicitud_id: 9401, ci: ci })] });
  assert.strictEqual(row.elm.available, true);
  assert.deepStrictEqual(row.elm.send, { available: false });
  assert.ok(ElmUi.rejectedRowElmHtml(row.elm, row.ci).includes('Preaprobado ELM'));
  const noSend = await listRow(h, ci, [{ cz_solicitud_id: 9401 }], { listView: broken });
  assert.ok(!ElmUi.rejectedRowElmHtml(noSend.elm, noSend.ci).includes('<button'));
  const down = await listRow(h, ci, [{ cz_solicitud_id: 9401 }], { readRows: async () => { throw new Error('down'); } });
  assert.deepStrictEqual(down.elm, { available: false });
});

test('26 list and detail share one send path (dashboard + route wiring)', async () => {
  const fs = require('fs');
  const path = require('path');
  const dash = fs.readFileSync(path.join(__dirname, '../public/mie-dashboard.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/rechazados.js'), 'utf8');
  assert.strictEqual((dash.match(/action === 'elm-send'/g) || []).length, 1, 'single send action check');
  assert.strictEqual((dash.match(/\/elm\/send'/g) || []).length, 1, 'single POST to the send endpoint');
  assert.strictEqual((dash.match(/onElmSendClick\(/g) || []).length, 3, 'definition + list + detail');
  assert.ok(/isElmSendAction\(action\)\) \{\s*onElmSendClick\(btn, ci\)/.test(dash), 'list click');
  assert.ok(/onElmSendClick\(actionEl, state\.detailCi\)/.test(dash), 'detail click');
  assert.ok(dash.includes("closest('[data-elm-pick]')"), 'picker binds the chosen solicitud');
  assert.ok(dash.includes("window.confirm("), 'confirmation kept');
  assert.ok(dash.includes('rejectedRowElmHtml(row.elm, row.ci)'));
  assert.ok(/attachElmToRejectedRows\(optin\.rows, \{\s*supabase: supabase,\s*listView: getElmListView\(\)/.test(route));
  assert.strictEqual((route.match(/sendRejectedToElm\(/g) || []).length, 1, 'one send route');
  assert.ok(/loadCiResendHold: function \(holdCi, czId\) \{\s*return loadCiResendHold\(supabase, holdCi, czId\);/.test(route), 'endpoint uses the same guard');
  assert.ok(!dash.includes('elm.ci_active'), 'detail shows the send hold, not the survey-gate meaning');
});

test('zero external network attempts', async () => {
  assert.strictEqual(externalNet.length, 0, externalNet.join(','));
});

(async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      process.stdout.write('ok - ' + t.name + '\n');
    } catch (err) {
      failed += 1;
      process.stdout.write('FAIL - ' + t.name + '\n' + (err && err.stack ? err.stack : err) + '\n');
    }
  }
  process.stdout.write(
    'unit-elm-dashboards-surveys-send: ' + (tests.length - failed) + '/' + tests.length +
      ' passed; external network attempts: ' + externalNet.length + '\n',
  );
  if (failed) process.exit(1);
})();
