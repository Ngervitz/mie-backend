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
const { summarizeCiElm, loadRejectedDetailElm, CI_ACTIVE_REASON } = require('../src/lib/rejectedElmRead');
const { sendRejectedToElm, OUTCOMES } = require('../src/lib/rejectedElmSend');
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
  const deps = {
    orchestrator: orch,
    listView: listView,
    loadRejectedCzIds: async () => o.rejectedCzIds || [1001],
  };
  const send = (czId) =>
    sendRejectedToElm(deps, { ci: ci, czSolicitudId: czId, actorUserId: 'user-admin-1' });
  return { orch, repo, fetchImpl, listView, send };
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
    readRows: async () => ({ processes: [referredA], states: [], openRequests: [] }),
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
    readRows: async () => ({ processes: [], states: [], openRequests: [] }),
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
