'use strict';

/**
 * "Enviar a ELM" from Preaprobados — regression and security (mocks only).
 *
 * The real orchestrator, ELM client (fake fetch injected), CI resend guard, list view and UI
 * helpers are exercised against an in-memory repository. NO network: every non-loopback socket and
 * the global fetch are blocked and counted; no database; credentials are FAKE placeholders.
 *
 * Run: node scripts/unit-elm-preaprobados-send.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

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

const { S1, S2, CODES, ENABLED_TRIGGER_ORIGINS } = require('../src/services/elm/constants');
const { readElmConfig } = require('../src/services/elm/config');
const { createElmClient } = require('../src/services/elm/client');
const { createElmOrchestrator } = require('../src/services/elm/orchestrator');
const { createElmListView, computeElmCell } = require('../src/services/elm/listView');
const { DUPLICATE_OTHER_CHANNEL_DETAIL } = require('../src/services/elm/classification');
const { loadCiResendHold, HOLD } = require('../src/lib/rejectedElmResendGuard');
const { sendRejectedToElm, NOT_IN_REJECTIONS } = require('../src/lib/rejectedElmSend');
const {
  NOT_IN_PREAPROBADOS,
  SEND_NOT_READY,
  loadPreaprobadoMember,
  sendPreaprobadoToElm,
  attachPreaprobadosElmSendHolds,
} = require('../src/lib/preaprobadosElmSend');
const {
  ORIGIN,
  buildElmCohortByCzId,
  buildPreaprobadosManualElmByCzId,
  assembleCombinedPreaprobadosList,
  fetchElmCohortBundle,
  fetchElmCohortDetail,
} = require('../src/lib/preaprobadosElmCohort');
const ElmUi = require('../public/elm-ui-helpers');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const CI = 12345678;
const CZ = 1001;
const silentLogger = { info() {}, warn() {}, error() {} };

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

/** A CDV-cohort solicitud (current estado 8) with every required field. */
function solicitudFixture(czId, ci, over) {
  return Object.assign(
    {
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
      solicitudes_estados_id: 8,
    },
    over || {},
  );
}

/** Process of ANOTHER solicitud of the same CI (history read by the CI resend guard). */
function otherProcess(over) {
  return Object.assign(
    {
      id: 'other-1',
      cz_solicitud_id: 900,
      ci: CI,
      trigger_origin: 'janus_manual',
      created_at: iso(NOW - 40 * DAY),
      s1_status: S1.REJECTED,
      s1_started_at: iso(NOW - 40 * DAY),
      s1_completed_at: iso(NOW - 40 * DAY),
      s1_lease_expires_at: null,
      s1_result_message: 'SCORE BAJO',
      s2_status: S2.NOT_STARTED,
      s2_started_at: null,
      s2_lease_expires_at: null,
      referred_at: null,
      provider_status: null,
      disbursed_at: null,
      ops_resolved_at: null,
    },
    over || {},
  );
}

function fakeFetch(steps) {
  const calls = [];
  async function f(url, init) {
    calls.push({ url: url, init: init });
    const step = steps[calls.length - 1];
    if (!step) throw new Error('unexpected ELM call #' + calls.length);
    return { status: step.status, text: async () => JSON.stringify(step.body) };
  }
  f.calls = calls;
  return f;
}
const okResult = (result) => ({ status: 200, body: { result: result } });

function createFakeRepo(solicitudes, opts) {
  const o = opts || {};
  const rows = new Map();
  let seq = 0;
  const byId = (id) => [...rows.values()].find((r) => r.id === id) || null;
  const claims = [];
  return {
    rows,
    claims,
    async loadSolicitudContext(czId) {
      return { solicitud: solicitudes.get(czId) || null, grantedRow: null };
    },
    async loadSolicitudContexts(ids) {
      return new Map(ids.map((id) => [id, { solicitud: solicitudes.get(id) || null, grantedRow: null }]));
    },
    async resolveBaseLabel() {
      return null;
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
      claims.push(a);
      if (o.claimBlocked) {
        return { claimed: false, process: null, blocked: o.claimBlocked };
      }
      if (rows.has(a.czSolicitudId)) {
        return { claimed: false, process: Object.assign({}, rows.get(a.czSolicitudId)) };
      }
      seq += 1;
      const row = {
        id: 'proc-' + seq,
        cz_solicitud_id: a.czSolicitudId,
        ci: a.ci,
        trigger_origin: a.triggerOrigin,
        triggered_by_user_id: a.triggeredByUserId,
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

/**
 * @param {object[]} steps fake ELM answers, in call order
 * @param {{ solicitud?: object, others?: object[], locks?: object[]|null, env?: object,
 *   member?: Function, claimBlocked?: object, holdThrows?: boolean }} [opts]
 */
function harness(steps, opts) {
  const o = opts || {};
  const solicitudes = new Map([[CZ, o.solicitud || solicitudFixture(CZ, CI)]]);
  const repo = createFakeRepo(solicitudes, { claimBlocked: o.claimBlocked });
  for (const p of o.others || []) repo.rows.set(p.cz_solicitud_id, p);
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
  const memberCalls = [];
  const loadHold = (holdCi, czId) => {
    if (o.holdThrows) return Promise.reject(new Error('db down'));
    return loadCiResendHold(null, holdCi, czId, { now: () => NOW, postReferralRejectionStatuses: [], readRows: readRows });
  };
  const deps = {
    orchestrator: orch,
    listView: listView,
    loadMember: async (czId) => {
      memberCalls.push(czId);
      return o.member ? o.member(czId) : czId === CZ ? { ci: CI } : { status: 404, body: { ok: false, code: NOT_IN_PREAPROBADOS, outcome: 'blocked', cz_solicitud_id: czId } };
    },
    loadCiResendHold: loadHold,
  };
  const send = (czId) => sendPreaprobadoToElm(deps, { czSolicitudId: czId, actorUserId: 'user-admin-1' });
  const sendRejected = (czId) =>
    sendRejectedToElm(
      { orchestrator: orch, listView: listView, loadRejectedCzIds: async () => [CZ], loadCiResendHold: loadHold },
      { ci: CI, czSolicitudId: czId, actorUserId: 'user-admin-1' },
    );
  return { orch, repo, fetchImpl, listView, deps, send, sendRejected, memberCalls, readRows };
}

/** Minimal supabase fake for preaprobadosRead.fetchPreaprobadosDetailBundle. */
function fakeSupabase(tables) {
  return {
    from(table) {
      const filters = [];
      const rowsOf = () =>
        (tables[table] || []).filter((r) => filters.every(([c, v]) => String(r[c]) === String(v)));
      const q = {
        select() {
          return q;
        },
        eq(c, v) {
          filters.push([c, v]);
          return q;
        },
        order() {
          return q;
        },
        async range(from, to) {
          return { data: rowsOf().slice(from, to + 1), error: null };
        },
        async maybeSingle() {
          return { data: rowsOf()[0] || null, error: null };
        },
      };
      return q;
    },
  };
}

// --- KPI fixtures: CDV cohort 100, 600 (CDV granted), 700..740; automatic ELM 900 ----------

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
const COHORT_IDS = [100, 600, 700, 710, 720, 730, 740];
const estado8 = (czId, i) => ({
  cz_historico_id: i + 1,
  cz_solicitud_id: czId,
  solicitudes_estados_id: 8,
  estado: 'Enviado CDV',
  fechahora_src: '2026-10-0' + (1 + (i % 5)) + 'T10:00:00.000Z',
});
const KPI_CDV = {
  estado8Rows: COHORT_IDS.map(estado8),
  currentEstado8Solicitudes: [100, 700, 710, 720, 730].map((id) => cdvSol(id, id * 10, 8)),
  solicitudRows: COHORT_IDS.map((id) => cdvSol(id, id * 10, id === 600 ? 11 : id === 740 ? 3 : 8)),
  grantedRows: [{ cz_id: 600, ci: 6000, monto_otorgado: 15000, updated_at_src: '2026-10-05T00:00:00.000Z', synced_at: '2026-10-05T00:00:00.000Z' }],
  historicoRows: COHORT_IDS.map(estado8),
};
const KPI_WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };

/** "Enviar a ELM" process of a cohort solicitud, sent 2 days ago; default S1 + S2 referred. */
function manualProc(czId, over) {
  return otherProcess(
    Object.assign(
      {
        id: 'm-' + czId,
        cz_solicitud_id: czId,
        ci: czId * 10,
        created_at: iso(NOW - 2 * DAY),
        s1_started_at: iso(NOW - 2 * DAY),
        s1_completed_at: iso(NOW - 2 * DAY),
        s1_status: S1.ELIGIBLE,
        s1_result_message: 'Listo para recibir datos en servicio 2',
        s2_status: S2.REFERRED,
        s2_started_at: iso(NOW - 2 * DAY),
        s2_completed_at: iso(NOW - 2 * DAY),
        s2_result_message: 'Lead Aprobado correctamente',
        referred_at: iso(NOW - 2 * DAY),
      },
      over || {},
    ),
  );
}

function kpiProcesses() {
  return {
    manual: [
      manualProc(100),
      manualProc(700, { provider_status: 'Convertido', disbursed_at: iso(NOW - DAY) }),
      manualProc(710, { s1_status: S1.REJECTED, s1_result_message: 'SCORE BAJO', s2_status: S2.NOT_STARTED, s2_started_at: null, s2_completed_at: null, s2_result_message: null, referred_at: null }),
      manualProc(720, { s1_status: S1.REJECTED, s1_result_message: 'Repetido. Aprobado', s1_error_code: CODES.S1_DUPLICATE_OTHER_CHANNEL, s2_status: S2.NOT_STARTED, s2_started_at: null, s2_completed_at: null, s2_result_message: null, referred_at: null }),
      manualProc(730, { s1_status: S1.IN_FLIGHT, s1_completed_at: null, s1_result_message: null, s1_lease_expires_at: iso(NOW + 3600 * 1000), s2_status: S2.NOT_STARTED, s2_started_at: null, s2_completed_at: null, s2_result_message: null, referred_at: null }),
      manualProc(740),
    ],
    rechazados: manualProc(800),
    automatic: manualProc(900, { trigger_origin: 'cz_automatic', ci: 9990 }),
  };
}

function kpiList(extra) {
  const p = kpiProcesses();
  const elmManual = buildPreaprobadosManualElmByCzId({
    processes: p.manual.concat([p.rechazados]),
    cdvCohortCzIds: new Set(COHORT_IDS),
    rejectedCzIds: new Set([740]),
    nowMs: NOW,
  });
  const elmCohort = buildElmCohortByCzId({
    processes: [p.automatic, p.rechazados].concat(p.manual),
    projectedByCz: new Map([[900, 13]]),
    nowMs: NOW,
  });
  return assembleCombinedPreaprobadosList(
    Object.assign({}, KPI_CDV, KPI_WINDOW, {
      elmCohort: elmCohort,
      elmManual: elmManual,
      elmSolicitudRows: [cdvSol(900, 9990, 13)].concat([100, 700, 710, 720, 730].map((id) => cdvSol(id, id * 10, 8))),
      elmHistoricoRows: [],
      limit: 100,
      offset: 0,
      nowMs: NOW,
    }, extra || {}),
  );
}

/** Supabase fake with .in() for the ELM cohort bundle reads. */
function inSupabase(tables) {
  return {
    from(table) {
      const filters = [];
      const q = {
        select() { return q; },
        in(c, vals) { filters.push((r) => vals.map(String).includes(String(r[c]))); return q; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return q; },
        async range(from, to) {
          return { data: (tables[table] || []).filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null };
        },
        async maybeSingle() {
          return { data: (tables[table] || []).filter((r) => filters.every((f) => f(r)))[0] || null, error: null };
        },
      };
      return q;
    },
  };
}

function cohortRepo(processes) {
  const calls = { byCzIds: [], listAll: [] };
  const byCz = new Map(processes.map((p) => [p.cz_solicitud_id, p]));
  return {
    calls,
    async listAllProcesses(opts) {
      calls.listAll.push(opts);
      return processes.filter((p) => opts.triggerOrigins.includes(p.trigger_origin));
    },
    async getProcessesByCzIds(ids) {
      calls.byCzIds.push(ids.slice());
      const out = new Map();
      for (const id of ids) if (byCz.has(id)) out.set(id, byCz.get(id));
      return out;
    },
    async getProcessByCzId(id) {
      return byCz.get(id) || null;
    },
    async getProjectedEstadosByCzIds() {
      return new Map([[900, 13]]);
    },
  };
}

async function main() {
  // --- membership ----------------------------------------------------------------------------
  await test('membership: only the CDV cohort (ever estado 8, historical or current) is a member', async () => {
    const sb = fakeSupabase({
      cz_funnel_solicitudes: [
        solicitudFixture(1, 111, { solicitudes_estados_id: 8 }),
        solicitudFixture(2, 222, { solicitudes_estados_id: 3 }),
        solicitudFixture(3, 333, { solicitudes_estados_id: 3 }),
      ],
      cz_funnel_solicitud_estados: [
        { cz_historico_id: 10, cz_solicitud_id: 2, solicitudes_estados_id: 8, fechahora_src: '2026-05-01T10:00:00Z' },
        { cz_historico_id: 11, cz_solicitud_id: 2, solicitudes_estados_id: 3, fechahora_src: '2026-05-03T10:00:00Z' },
      ],
      cz_funnel_granted_loans: [],
    });
    assert.deepStrictEqual(await loadPreaprobadoMember(sb, 1), { ci: 111 }, 'current estado 8');
    assert.deepStrictEqual(await loadPreaprobadoMember(sb, 2), { ci: 222 }, 'historical estado 8 (now rejected)');
    const outsider = await loadPreaprobadoMember(sb, 3);
    assert.strictEqual(outsider.status, 404);
    assert.strictEqual(outsider.body.code, NOT_IN_PREAPROBADOS);
    assert.strictEqual(outsider.body.outcome, 'blocked');
    const missing = await loadPreaprobadoMember(sb, 4);
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body.code, NOT_IN_PREAPROBADOS);
    const invalid = await loadPreaprobadoMember(sb, 'x');
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalid.body.code, CODES.INVALID_CZ_ID);
  });

  await test('not a member → 404, no claim, no ELM call; message names Preaprobados', async () => {
    const h = harness([]);
    const out = await h.send(4242);
    assert.strictEqual(out.status, 404);
    assert.strictEqual(out.body.code, NOT_IN_PREAPROBADOS);
    assert.strictEqual(h.repo.claims.length, 0);
    assert.strictEqual(h.fetchImpl.calls.length, 0);
    const msg = ElmUi.sendResultMessage(out.body);
    assert.strictEqual(msg.tone, 'error');
    assert.ok(msg.text.includes('cohorte CDV de Preaprobados'), msg.text);
  });

  await test('invalid solicitud id → 400 before any read', async () => {
    const h = harness([]);
    for (const raw of ['abc', '0', '-5', '1.5', '', null, '9007199254740993']) {
      const out = await h.send(raw);
      assert.strictEqual(out.status, 400, String(raw));
      assert.strictEqual(out.body.code, CODES.INVALID_CZ_ID);
    }
    assert.strictEqual(h.memberCalls.length, 0);
    assert.strictEqual(h.fetchImpl.calls.length, 0);
  });

  await test('send not ready (transport off / config pending) → 503 before membership, no ELM call', async () => {
    const off = harness([], { env: { ELM_CLIENT_ENABLED: undefined } });
    const a = await off.send(CZ);
    assert.strictEqual(a.status, 503);
    assert.strictEqual(a.body.code, SEND_NOT_READY);
    assert.strictEqual(off.memberCalls.length, 0);
    const pending = harness([], { env: { ELM_DATE_OF_BIRTH_FORMAT: undefined } });
    const b = await pending.send(CZ);
    assert.strictEqual(b.status, 503);
    assert.ok(b.body.reasons.includes(CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED));
    assert.strictEqual(off.fetchImpl.calls.length + pending.fetchImpl.calls.length, 0);
  });

  await test('member without a valid CI → 422, no claim', async () => {
    const h = harness([], { member: async () => ({ ci: null }) });
    const out = await h.send(CZ);
    assert.strictEqual(out.status, 422);
    assert.strictEqual(out.body.code, CODES.MISSING_REQUIRED_FIELDS);
    assert.deepStrictEqual(out.body.fields, ['ci']);
    assert.strictEqual(h.repo.claims.length, 0);
  });

  // --- eligibility and valid dates (orchestrator authority) ----------------------------------
  await test('eligibility: CDV GRANTED, missing fields and invalid / underage birth dates never reach ELM', async () => {
    const cases = [
      [{ solicitudes_estados_id: 11 }, CODES.CDV_GRANTED],
      [{ celular: '' }, CODES.MISSING_REQUIRED_FIELDS],
      [{ fecha_nacimiento: '1991-02-30' }, CODES.DATE_OF_BIRTH_INVALID],
      [{ fecha_nacimiento: '2015-01-01' }, CODES.DATE_OF_BIRTH_INVALID],
      [{ fecha_nacimiento: '1880-01-01' }, CODES.DATE_OF_BIRTH_INVALID],
      [{ relacion_laboral: 'XYZ' }, CODES.ACTIVITY_TYPE_MAPPING_MISSING],
    ];
    for (const [over, code] of cases) {
      const h = harness([], { solicitud: solicitudFixture(CZ, CI, over) });
      const out = await h.send(CZ);
      assert.strictEqual(out.body.ok, false, JSON.stringify(over));
      assert.strictEqual(out.body.code, code, JSON.stringify(over));
      assert.strictEqual(out.body.outcome, 'blocked');
      assert.strictEqual(h.repo.claims.length, 0, 'no claim: ' + JSON.stringify(over));
      assert.strictEqual(h.fetchImpl.calls.length, 0, 'no ELM call: ' + JSON.stringify(over));
    }
  });

  // --- CI resend guard -----------------------------------------------------------------------
  await test('CI: 30-day ELM window (other solicitud sent 20 days ago, previous month) → 409 recent send', async () => {
    const h = harness([], {
      others: [otherProcess({ created_at: iso(NOW - 20 * DAY), s1_started_at: iso(NOW - 20 * DAY) })],
      locks: [{ ci: CI, cz_solicitud_id: 900, state: 'consumed', month_key: '2026-09-01', blocks_future: false, reserved_at: iso(NOW - 20 * DAY), consumed_at: iso(NOW - 20 * DAY) }],
    });
    const out = await h.send(CZ);
    assert.strictEqual(out.status, 409);
    assert.strictEqual(out.body.code, HOLD.RECENT_SEND);
    assert.strictEqual(out.body.related_cz_solicitud_id, 900);
    assert.strictEqual(out.body.until, iso(NOW + 10 * DAY));
    assert.strictEqual(h.repo.claims.length, 0);
    assert.strictEqual(h.fetchImpl.calls.length, 0);
    assert.ok(ElmUi.sendResultMessage(out.body).text.includes('30 días'));
  });

  await test('CI: monthly quota (other solicitud received 1 Oct; quota ends after the 30 days) → 409 quota', async () => {
    const h = harness([], {
      others: [otherProcess({ created_at: iso(NOW - 8 * DAY), s1_started_at: iso(NOW - 8 * DAY) })],
      locks: [{ ci: CI, cz_solicitud_id: 900, state: 'consumed', month_key: '2026-10-01', blocks_future: false, reserved_at: iso(NOW - 8 * DAY), consumed_at: iso(NOW - 8 * DAY) }],
    });
    const out = await h.send(CZ);
    assert.strictEqual(out.status, 409);
    assert.strictEqual(out.body.code, HOLD.MONTHLY_QUOTA);
    assert.strictEqual(out.body.until, '2026-11-01');
    assert.strictEqual(h.fetchImpl.calls.length, 0);
  });

  await test('CI: active referral of another solicitud → 409 active; 40-day-old rejection → allowed', async () => {
    const active = harness([], {
      others: [otherProcess({ s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, referred_at: iso(NOW - 40 * DAY) })],
    });
    const a = await active.send(CZ);
    assert.strictEqual(a.status, 409);
    assert.strictEqual(a.body.code, HOLD.ACTIVE);
    assert.strictEqual(active.fetchImpl.calls.length, 0);

    const old = harness([okResult('SCORE BAJO')], { others: [otherProcess()] });
    const b = await old.send(CZ);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(old.fetchImpl.calls.length, 1);
  });

  await test('CI: unreadable history (read error or locks unreadable) → 503 unverifiable, fail closed', async () => {
    const h = harness([], { holdThrows: true });
    const out = await h.send(CZ);
    assert.strictEqual(out.status, 503);
    assert.strictEqual(out.body.code, HOLD.UNVERIFIABLE);
    const noLocks = harness([], { locks: null });
    const out2 = await noLocks.send(CZ);
    assert.strictEqual(out2.status, 503);
    assert.strictEqual(out2.body.code, HOLD.UNVERIFIABLE);
    assert.strictEqual(h.fetchImpl.calls.length + noLocks.fetchImpl.calls.length, 0);
  });

  await test('DB CI lock refuses the claim → 409 elm_ci_lock_blocked, no ELM call', async () => {
    const h = harness([], { claimBlocked: { status: 'blocked', block: 'monthly_quota_used', related_cz_solicitud_id: 777 } });
    const out = await h.send(CZ);
    assert.strictEqual(out.status, 409);
    assert.strictEqual(out.body.code, CODES.CI_LOCK_BLOCKED);
    assert.strictEqual(h.repo.claims.length, 1);
    assert.strictEqual(h.fetchImpl.calls.length, 0);
  });

  // --- outcomes ------------------------------------------------------------------------------
  await test('S1 + S2 favorable → "Preaprobado ELM" (referred), never a granted loan', async () => {
    const h = harness([okResult('Listo para recibir datos en servicio 2'), okResult('Lead Aprobado correctamente')]);
    const out = await h.send(CZ);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.ok, true);
    assert.strictEqual(out.body.stage, 's2');
    assert.strictEqual(out.body.outcome, 'referred');
    assert.strictEqual(out.body.cell.label, 'Preaprobado ELM');
    assert.strictEqual(out.body.cell.granted_elm, false);
    assert.strictEqual(h.fetchImpl.calls.length, 2);
    const row = h.repo.rows.get(CZ);
    assert.strictEqual(row.trigger_origin, 'janus_manual');
    assert.strictEqual(row.triggered_by_user_id, 'user-admin-1');
    assert.strictEqual(h.repo.claims[0].ci, CI);
    const msg = ElmUi.sendResultMessage(out.body);
    assert.strictEqual(msg.tone, 'ok');
    assert.ok(msg.text.includes('No es un préstamo otorgado'), msg.text);
  });

  await test('S1 rejected ("Mocasist", any letter case) → s1_rejected, no S2', async () => {
    const h = harness([okResult('MOCASIST')]);
    const out = await h.send(CZ);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.outcome, 's1_rejected');
    assert.strictEqual(h.fetchImpl.calls.length, 1);
    assert.ok(ElmUi.sendResultMessage(out.body).text.includes('S1'));
  });

  await test('S1 "Repetido. Aprobado" → "Duplicado · Otro canal" (closed, not a rejection, no S2)', async () => {
    const h = harness([okResult('Repetido. Aprobado')]);
    const out = await h.send(CZ);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.outcome, 'duplicate_other_channel');
    assert.strictEqual(out.body.cell.state, 'closed');
    assert.strictEqual(out.body.cell.detail, DUPLICATE_OTHER_CHANNEL_DETAIL);
    assert.strictEqual(out.body.cell.label, 'Duplicado · Otro canal');
    assert.strictEqual(h.repo.rows.get(CZ).s1_error_code, CODES.S1_DUPLICATE_OTHER_CHANNEL);
    assert.strictEqual(h.fetchImpl.calls.length, 1);
    const msg = ElmUi.sendResultMessage(out.body);
    assert.ok(msg.text.startsWith('Duplicado · Otro canal'), msg.text);
  });

  await test('undocumented S1 answer → review (uncertain), not a rejection', async () => {
    const h = harness([okResult('Algo nuevo')]);
    const out = await h.send(CZ);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.outcome, 'review');
    assert.ok(ElmUi.sendResultMessage(out.body).text.includes('no es un rechazo'));
  });

  // --- idempotency ---------------------------------------------------------------------------
  await test('idempotency: a second send of the same solicitud never calls ELM again', async () => {
    const h = harness([okResult('SCORE BAJO')]);
    const first = await h.send(CZ);
    assert.strictEqual(first.body.outcome, 's1_rejected');
    const second = await h.send(CZ);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.code, CODES.PROCESS_EXISTS);
    assert.strictEqual(second.body.outcome, 's1_rejected', 'answer read back from the stored process');
    assert.strictEqual(h.fetchImpl.calls.length, 1);
    assert.strictEqual(h.repo.rows.size, 1);
  });

  await test('concurrent double click: one claim wins, ELM called once', async () => {
    const h = harness([okResult('SCORE BAJO')]);
    const [a, b] = await Promise.all([h.send(CZ), h.send(CZ)]);
    const codes = [a.body.code, b.body.code].sort();
    assert.ok(codes.includes(CODES.PROCESS_EXISTS), JSON.stringify(codes));
    assert.strictEqual(h.fetchImpl.calls.length, 1);
  });

  // --- same path as Rechazados ---------------------------------------------------------------
  await test('parity: Preaprobados answers exactly what the Rechazados send answers', async () => {
    const scenarios = [
      [okResult('SCORE BAJO')],
      [okResult('Repetido. Aprobado')],
      [okResult('Listo para recibir datos en servicio 2'), okResult('Lead Aprobado correctamente')],
    ];
    for (const steps of scenarios) {
      const p = harness(steps.slice());
      const r = harness(steps.slice());
      const pa = await p.send(CZ);
      const ra = await r.sendRejected(CZ);
      assert.deepStrictEqual(pa, ra, steps.map((s) => s.body.result).join(' / '));
    }
    const pHold = harness([], { holdThrows: true });
    assert.deepStrictEqual(await pHold.send(CZ), await pHold.sendRejected(CZ));
  });

  await test('Rechazados unchanged: its own membership still refuses solicitudes outside the CI rejections', async () => {
    const h = harness([]);
    const out = await sendRejectedToElm(
      { orchestrator: h.orch, listView: h.listView, loadRejectedCzIds: async () => [555], loadCiResendHold: async () => null },
      { ci: CI, czSolicitudId: CZ, actorUserId: 'user-admin-1' },
    );
    assert.strictEqual(out.status, 404);
    assert.strictEqual(out.body.code, NOT_IN_REJECTIONS);
    assert.strictEqual(h.fetchImpl.calls.length, 0);
  });

  await test('module load order: no half-initialized exports in either order (statusFor / send)', async () => {
    const mods = ['../src/routes/preaprobadosElm', '../src/lib/rejectedElmSend', '../src/lib/preaprobadosElmSend'].map(
      (m) => require.resolve(m),
    );
    for (const order of [[0, 1, 2], [1, 0, 2], [2, 1, 0]]) {
      for (const m of mods) delete require.cache[m];
      const loaded = order.map((i) => require(mods[i]));
      const byIdx = {};
      order.forEach((i, k) => (byIdx[i] = loaded[k]));
      assert.strictEqual(typeof byIdx[0].statusFor, 'function', 'route statusFor, order ' + order);
      assert.strictEqual(typeof byIdx[0].createPreaprobadosElmRouter, 'function');
      assert.strictEqual(typeof byIdx[1].sendRejectedToElm, 'function');
      assert.strictEqual(typeof byIdx[2].sendPreaprobadoToElm, 'function');
      assert.strictEqual(byIdx[0].statusFor({ ok: false, code: CODES.PROCESS_EXISTS }), 409);
    }
  });

  // --- list: button + holds ------------------------------------------------------------------
  await test('list: eligible member → enabled "Enviar a ELM" bound to the solicitud; CI hold → disabled with reason', async () => {
    const h = harness([]);
    const rows = [{ cz_id: CZ, ci: CI }];
    rows[0].elm = (await h.listView.cellsForCzIds([CZ], { allowSend: true })).get(CZ);
    await attachPreaprobadosElmSendHolds(rows, { readRows: h.readRows, now: () => NOW, postReferralRejectionStatuses: [] });
    assert.strictEqual(rows[0].elm.action.enabled, true);
    const html = ElmUi.elmCellHtml(rows[0].elm, { ci: CI });
    assert.ok(html.includes('data-action="elm-send"') && html.includes('data-cz-id="1001"'), html);
    assert.ok(html.includes('data-ci="12345678"'));

    const held = harness([], {
      others: [otherProcess({ created_at: iso(NOW - 20 * DAY), s1_started_at: iso(NOW - 20 * DAY) })],
    });
    const hr = [{ cz_id: CZ, ci: CI }];
    hr[0].elm = (await held.listView.cellsForCzIds([CZ], { allowSend: true })).get(CZ);
    await attachPreaprobadosElmSendHolds(hr, { readRows: held.readRows, now: () => NOW, postReferralRejectionStatuses: [] });
    assert.strictEqual(hr[0].elm.action.enabled, false);
    assert.strictEqual(hr[0].elm.action.reason, HOLD.RECENT_SEND);
    const hhtml = ElmUi.elmCellHtml(hr[0].elm, { ci: CI });
    assert.ok(/ disabled /.test(hhtml) && !hhtml.includes('data-action'), hhtml);
    assert.ok(hhtml.includes('30 días'), hhtml);
  });

  await test('list: unreadable ELM history holds every offered button; cells with a process untouched', async () => {
    const h = harness([]);
    const sent = { kind: 'rejected', state: 'rejected', action: { show: false, enabled: false } };
    const rows = [
      { cz_id: CZ, ci: CI, elm: (await h.listView.cellsForCzIds([CZ], { allowSend: true })).get(CZ) },
      { cz_id: 2002, ci: 2, elm: sent },
    ];
    const warns = [];
    await attachPreaprobadosElmSendHolds(rows, {
      readRows: async () => {
        throw new Error('db down');
      },
      logger: { warn: (m) => warns.push(m) },
      now: () => NOW,
    });
    assert.strictEqual(rows[0].elm.action.enabled, false);
    assert.strictEqual(rows[0].elm.action.reason, HOLD.UNVERIFIABLE);
    assert.strictEqual(rows[1].elm, sent);
    assert.strictEqual(warns.length, 1);
  });

  await test('list: not sendable (invalid birth date) is never a button', async () => {
    const h = harness([], { solicitud: solicitudFixture(CZ, CI, { fecha_nacimiento: '1991-02-30' }) });
    const cell = (await h.listView.cellsForCzIds([CZ], { allowSend: true })).get(CZ);
    assert.strictEqual(cell.kind, 'not_sendable');
    assert.ok(!ElmUi.elmCellHtml(cell, { ci: CI }).includes('<button'));
  });

  // --- S1 / S2 / postback display ------------------------------------------------------------
  await test('display: referral ≠ grant; postback status kept; only disbursed is "Otorgado ELM"', async () => {
    const referred = computeElmCell({
      process: otherProcess({ cz_solicitud_id: CZ, s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, referred_at: iso(NOW - DAY), provider_status: 'Latente' }),
      nowMs: NOW,
      postReferralRejectionStatuses: [],
    });
    assert.strictEqual(ElmUi.cellLabel(referred), 'Preaprobado ELM');
    assert.strictEqual(referred.granted_elm, false);
    assert.ok(ElmUi.elmCellHtml(referred).includes('Estado ELM: Latente'));
    const granted = computeElmCell({
      process: otherProcess({ cz_solicitud_id: CZ, s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, referred_at: iso(NOW - 5 * DAY), provider_status: 'Convertido', disbursed_at: iso(NOW - DAY) }),
      nowMs: NOW,
      postReferralRejectionStatuses: [],
    });
    assert.strictEqual(ElmUi.cellLabel(granted), 'Otorgado ELM');
    const dash = readSrc('public/mie-dashboard.js');
    assert.ok(dash.includes("dlRow('Respuesta S1'") && dash.includes("dlRow('Respuesta S2'"));
    assert.ok(dash.includes("'Último postback'") && dash.includes("'GRANTED ELM'"));
    assert.ok(dash.includes('S2 · Derivado a ventas ELM (no implica otorgado ni desembolsado)'));
  });

  // --- KPIs by origin ------------------------------------------------------------------------
  await test('KPIs: Preaprobados sends counted apart from the automatic circuit; total = sum', async () => {
    const out = kpiList();
    const ke = out.kpis_elm;
    assert.deepStrictEqual(ke.by_origin[ORIGIN.AUTOMATIC], {
      preaprobados_elm: 1,
      otorgados_elm: 0,
      vigentes_elm: 1,
      conversion_elm: 0,
    });
    assert.deepStrictEqual(ke.by_origin[ORIGIN.PREAPROBADOS_MANUAL], {
      enviados_elm: 5,
      en_evaluacion_elm: 1,
      rechazados_elm: 1,
      duplicado_otro_canal_elm: 1,
      revision_elm: 0,
      cerrados_elm: 0,
      preaprobados_elm: 2,
      otorgados_elm: 1,
      vigentes_elm: 1,
      conversion_elm: 0.5,
    });
    const m = ke.by_origin[ORIGIN.PREAPROBADOS_MANUAL];
    assert.strictEqual(
      m.preaprobados_elm + m.rechazados_elm + m.duplicado_otro_canal_elm + m.en_evaluacion_elm + m.revision_elm + m.cerrados_elm,
      m.enviados_elm,
      'manual buckets add up to the sends',
    );
    assert.strictEqual(ke.preaprobados_elm, 3);
    assert.strictEqual(ke.otorgados_elm, 1);
    assert.strictEqual(ke.vigentes_elm, 2);
    assert.strictEqual(ke.conversion_elm, 1 / 3);
    assert.strictEqual(ke.scope, 'cz_automatic+preaprobados_manual');
    assert.deepStrictEqual(out.kpis, kpiList({ elmManual: new Map(), elmCohort: new Map() }).kpis, 'CDV KPIs untouched');
  });

  await test('KPIs: Rechazados sends and cohort solicitudes later rejected (estado 3) never count', async () => {
    const p = kpiProcesses();
    const manual = buildPreaprobadosManualElmByCzId({
      processes: p.manual.concat([p.rechazados, p.automatic]),
      cdvCohortCzIds: new Set(COHORT_IDS),
      rejectedCzIds: new Set([740]),
      nowMs: NOW,
    });
    assert.deepStrictEqual([...manual.keys()].sort(), [100, 700, 710, 720, 730]);
    assert.ok(!manual.has(800), 'a Rechazados send is not a Preaprobados send');
    assert.ok(!manual.has(740), 'estado 3 hands the solicitud over to Rechazados');
    assert.ok(!manual.has(900), 'the automatic circuit is its own origin');
    assert.strictEqual(
      buildElmCohortByCzId({ processes: p.manual.concat([p.rechazados]), nowMs: NOW }).size,
      0,
      'automatic cohort rule unchanged: manual sends never enter it',
    );
  });

  await test('KPIs: rows mark Preaprobados referrals as ELM members (cdv_elm) with their origin', async () => {
    const out = kpiList();
    const byId = new Map(out.rows.map((r) => [r.cz_id, r]));
    assert.strictEqual(byId.get(100).proveedor, 'cdv_elm');
    assert.strictEqual(byId.get(100).elm_member.origin, ORIGIN.PREAPROBADOS_MANUAL);
    assert.strictEqual(byId.get(100).elm_member.label, 'Preaprobado ELM');
    assert.strictEqual(byId.get(700).elm_member.label, 'Otorgado ELM');
    assert.strictEqual(byId.get(710).proveedor, 'cdv', 'an S1 rejection is not an ELM member');
    assert.strictEqual(byId.get(710).elm_member, null);
    assert.strictEqual(byId.get(720).elm_member, null, 'Duplicado · Otro canal is not a referral');
    assert.strictEqual(byId.get(900).proveedor, 'elm');
    assert.strictEqual(byId.get(900).elm_member.origin, ORIGIN.AUTOMATIC);
    assert.ok(!byId.has(800), 'Rechazados send never listed');
  });

  await test('KPIs: filters apply per origin (resultado ELM, proveedor CDV, date window)', async () => {
    const granted = kpiList({ resultadoElm: 'granted' });
    assert.deepStrictEqual(granted.rows.map((r) => r.cz_id), [700]);
    assert.strictEqual(granted.kpis_elm.by_origin[ORIGIN.PREAPROBADOS_MANUAL].enviados_elm, 1);
    assert.strictEqual(granted.kpis_elm.by_origin[ORIGIN.AUTOMATIC].preaprobados_elm, 0);
    const cdvOnly = kpiList({ proveedor: 'cdv' });
    assert.strictEqual(cdvOnly.kpis_elm.preaprobados_elm, 0);
    assert.strictEqual(cdvOnly.kpis_elm.by_origin[ORIGIN.PREAPROBADOS_MANUAL].enviados_elm, 0);
    const before = kpiList({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
    assert.strictEqual(before.kpis_elm.by_origin[ORIGIN.PREAPROBADOS_MANUAL].enviados_elm, 0, 'sends dated by S1 start');
    const one = kpiList({ q: 'N710' });
    assert.strictEqual(one.kpis_elm.by_origin[ORIGIN.PREAPROBADOS_MANUAL].enviados_elm, 1);
    assert.strictEqual(one.kpis_elm.by_origin[ORIGIN.PREAPROBADOS_MANUAL].rechazados_elm, 1);
  });

  await test('KPIs: bundle reads Preaprobados sends only for CDV cohort ids; estado 3 drops them', async () => {
    const p = kpiProcesses();
    const all = p.manual.concat([p.rechazados, p.automatic]);
    const tables = {
      cz_funnel_solicitudes: [cdvSol(900, 9990, 13), cdvSol(740, 7400, 3)].concat([100, 700, 710, 720, 730].map((id) => cdvSol(id, id * 10, 8))),
      cz_funnel_solicitud_estados: [{ cz_historico_id: 99, cz_solicitud_id: 740, solicitudes_estados_id: 3, estado: 'Rechazado', fechahora_src: iso(NOW - DAY) }],
    };
    const repo = cohortRepo(all);
    const out = await fetchElmCohortBundle(inSupabase(tables), { elmRepository: repo, cdvCohortCzIds: COHORT_IDS, nowMs: NOW, postReferralRejectionStatuses: [] });
    assert.deepStrictEqual(repo.calls.listAll, [{ triggerOrigins: ['cz_automatic'] }], 'automatic read unchanged');
    assert.deepStrictEqual(repo.calls.byCzIds, [COHORT_IDS], 'manual read limited to the cohort');
    assert.deepStrictEqual([...out.elmManual.keys()].sort(), [100, 700, 710, 720, 730]);
    assert.deepStrictEqual([...out.elmCohort.keys()], [900]);
    const none = cohortRepo(all);
    const noIds = await fetchElmCohortBundle(inSupabase(tables), { elmRepository: none, nowMs: NOW, postReferralRejectionStatuses: [] });
    assert.strictEqual(noIds.elmManual.size, 0);
    assert.strictEqual(none.calls.byCzIds.length, 0, 'no cohort → no manual read');
  });

  await test('KPIs: detail shows a Preaprobados referral only for a CDV cohort member', async () => {
    const p = kpiProcesses();
    const tables = { cz_funnel_solicitudes: [cdvSol(100, 1000, 8), cdvSol(710, 7100, 8)], cz_funnel_solicitud_estados: [] };
    const repo = cohortRepo(p.manual);
    const deps = { elmRepository: repo, nowMs: NOW, postReferralRejectionStatuses: [] };
    assert.strictEqual(await fetchElmCohortDetail(inSupabase(tables), 100, deps), null, 'outside the CDV detail: automatic only');
    const member = await fetchElmCohortDetail(inSupabase(tables), 100, Object.assign({ cdvMember: true }, deps));
    assert.strictEqual(member.elm_member.origin, ORIGIN.PREAPROBADOS_MANUAL);
    assert.strictEqual(member.elm_member.label, 'Preaprobado ELM');
    assert.strictEqual(await fetchElmCohortDetail(inSupabase(tables), 710, Object.assign({ cdvMember: true }, deps)), null, 'S1 rejection is not a member');
    const route = readSrc('src/routes/preaprobados.js');
    assert.ok(/fetchElmCohortDetail\(supabase, bundle\.czId, \{\s*elmRepository: getElmRepository\(\),\s*cdvMember: true,/.test(route), 'only the CDV detail passes cdvMember');
    assert.strictEqual((route.match(/cdvMember: true/g) || []).length, 1);
  });

  await test('KPIs UI: one group per origin, referral ≠ grant; Rechazados code does not read these KPIs', async () => {
    const dash = readSrc('public/mie-dashboard.js');
    assert.ok(dash.includes("'<div class=\"preaprobados-kpi-scope\">ELM · circuito automático (derivados S2)</div>'"));
    assert.ok(dash.includes("'<div class=\"preaprobados-kpi-scope\">ELM · envío manual desde Preaprobados</div>'"));
    assert.ok(dash.includes('const ka = byOrigin.cz_automatic || ke;'));
    assert.ok(dash.includes("kpiCard('Duplicado · Otro canal', String(km.duplicado_otro_canal_elm))"));
    assert.ok(dash.includes('no es un préstamo otorgado.</p>'));
    assert.ok(dash.includes("'Envío manual desde Preaprobados'"));
    for (const rel of ['src/routes/rechazados.js', 'src/lib/rejectedElmSend.js', 'src/lib/rejectedElmRead.js', 'src/lib/rejectedOpsRead.js', 'src/lib/rejectedElmResendGuard.js']) {
      assert.ok(!readSrc(rel).includes('preaprobadosElmCohort'), rel + ' does not depend on Preaprobados KPIs');
    }
  });

  // --- security / no automation --------------------------------------------------------------
  await test('security: one POST route, no S1/S2 routes, manual origin only, no batch', async () => {
    const route = readSrc('src/routes/preaprobadosElm.js');
    assert.strictEqual((route.match(/router\.post\(/g) || []).length, 1);
    assert.ok(/router\.post\('\/:czId\/elm\/send', requireElmAction,/.test(route), 'action gate on the send');
    assert.ok(!/evaluateElm|referElm|elm\/evaluate|elm\/refer/.test(route.replace(/\/\*[\s\S]*?\*\//g, '')));
    assert.ok(!/req\.body/.test(route), 'request body never used');
    const lib = readSrc('src/lib/preaprobadosElmSend.js');
    assert.strictEqual((lib.match(/sendRejectedToElm\(/g) || []).length, 1);
    assert.ok(!/janus_batch|cz_automatic|for \(const .* of .*\)\s*\{[^}]*sendRejectedToElm/.test(lib));
    assert.deepStrictEqual([...ENABLED_TRIGGER_ORIGINS], ['janus_manual']);
    const list = readSrc('src/routes/preaprobados.js');
    assert.ok(!/sendElm|sendPreaprobadoToElm|evaluateElm|referElm/.test(list), 'the list never sends');
  });

  await test('UI: explicit confirmation before the single-solicitud POST; no CI or data in the request', async () => {
    const dash = readSrc('public/mie-dashboard.js');
    const start = dash.indexOf('async function postPreaprobadoElmSend(');
    assert.ok(start > 0);
    const fn = dash.slice(start, dash.indexOf('\n  }\n', start));
    const confirmAt = fn.indexOf('window.confirm(');
    const guardAt = fn.indexOf('if (!ok) return;');
    const fetchAt = fn.indexOf('fetch(');
    assert.ok(confirmAt > 0 && guardAt > confirmAt && fetchAt > guardAt, 'confirm → abort on cancel → fetch');
    assert.ok(fn.includes('no es un préstamo otorgado'));
    assert.ok(fn.includes("'/preaprobados/' + encodeURIComponent(czId) + '/elm/send'"));
    assert.ok(!/body:/.test(fn), 'no request body');
    assert.ok(fn.includes('state.elmSendingCzId'), 'one send at a time');
    assert.ok(/action === 'elm-send' && !btn\.disabled/.test(dash), 'disabled buttons never send');
  });

  assert.strictEqual(externalNet.length, 0, 'external network attempts: ' + externalNet.join(','));
}

main()
  .then(() => {
    console.log('');
    console.log(passed + ' passed, ' + failed + ' failed; external network attempts: ' + externalNet.length);
    if (failed) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
