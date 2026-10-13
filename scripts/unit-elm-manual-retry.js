'use strict';

/**
 * "Reintentar ELM" (manual retry of an S1 that failed before ELM received the lead) — mocks only.
 *
 * NO network: every non-loopback socket and the global fetch are blocked and counted. ELM is
 * exercised only through an injected fake fetch; credentials below are FAKE placeholders.
 * The DB rules of elm_manual_retry_s1 are covered by db-local-elm-manual-retry-{pglite,realpg}.js;
 * here the repository is a fake and only the JS wiring is checked.
 *
 * Run: node scripts/unit-elm-manual-retry.js
 */

const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

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

const { S1, S2, CODES, PRE_RECEPTION_ERROR_CODES } = require('../src/services/elm/constants');
const { readElmConfig } = require('../src/services/elm/config');
const { createElmClient } = require('../src/services/elm/client');
const { createElmOrchestrator } = require('../src/services/elm/orchestrator');
const { createElmListView, computeElmCell } = require('../src/services/elm/listView');
const { retryRejectedElm, sendRejectedToElm } = require('../src/lib/rejectedElmSend');
const { resolveRejectedSend } = require('../src/lib/rejectedElmRead');
const { evaluateCiResendHold, loadCiResendHold, HOLD } = require('../src/lib/rejectedElmResendGuard');
const { deriveFromProcess } = require('../src/services/providerFallback/outcome');
const { OUTCOME, REASONS } = require('../src/services/providerFallback/constants');
const ElmUi = require('../public/elm-ui-helpers');

const NOW = Date.parse('2026-10-09T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 24 * 3600 * 1000;

const CI = 51001152;
const CZ = 1430;
const FROZEN_MARKER = 'frozen-s1-request-1430';

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

/** Process 1430 as stored in prod after the 403 (list + orchestrator columns). */
function failed1430(over) {
  return Object.assign(
    {
      id: 'a9731690-0000-0000-0000-000000001430',
      cz_solicitud_id: CZ,
      ci: CI,
      trigger_origin: 'janus_manual',
      created_at: iso(NOW - 2 * DAY),
      updated_at: iso(NOW - 2 * DAY),
      s1_status: S1.TECHNICAL_ERROR,
      s1_attempts: 1,
      s1_http_status: 403,
      s1_error_code: CODES.HTTP_AUTH_REJECTED,
      s1_result_message: null,
      s1_request: { marker: FROZEN_MARKER, cedula: String(CI) },
      s1_started_at: iso(NOW - 2 * DAY),
      s1_completed_at: iso(NOW - 2 * DAY),
      s1_lease_expires_at: null,
      s2_status: S2.NOT_STARTED,
      s2_started_at: null,
      s2_completed_at: null,
      s2_lease_expires_at: null,
      referred_at: null,
      provider_status: null,
      disbursed_at: null,
      ops_resolution_code: null,
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
    if (step.throws) throw step.throws;
    return { status: step.status, text: async () => JSON.stringify(step.body) };
  }
  f.calls = calls;
  return f;
}
const okResult = (result) => ({ status: 200, body: { result: result } });
const AUTH_403 = { status: 403, body: { error: { code: 'INVALID_LOGIN_ATTEMPT' } } };

/**
 * In-memory repository. manualRetryS1 mimics only the happy path of elm_manual_retry_s1
 * (attempts check + same row back to in_flight) or returns `forced`.
 */
function createFakeRepo(solicitudes, initial) {
  const rows = new Map();
  for (const p of initial || []) rows.set(Number(p.cz_solicitud_id), Object.assign({}, p));
  const byId = (id) => [...rows.values()].find((r) => r.id === id) || null;
  const calls = { manualRetryS1: [], claimProcess: 0, retryStep: 0 };
  const repo = {
    rows,
    calls,
    forced: null,
    async loadSolicitudContext(czId) {
      return { solicitud: solicitudes.get(czId) || null, grantedRow: repo.grantedRow || null };
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
      calls.claimProcess += 1;
      if (rows.has(a.czSolicitudId)) {
        return { claimed: false, process: Object.assign({}, rows.get(a.czSolicitudId)) };
      }
      throw new Error('unexpected new process in test');
    },
    async retryStep() {
      calls.retryStep += 1;
      throw new Error('retryStep (automatic path) must not be used by a manual retry');
    },
    async manualRetryS1(a) {
      calls.manualRetryS1.push(a);
      if (repo.forced) return repo.forced;
      const row = rows.get(a.czSolicitudId);
      if (!row) return { status: 'not_found' };
      if (Number(row.s1_attempts) !== a.expectedAttempts) return { status: 'stale' };
      if (row.s1_status !== S1.TECHNICAL_ERROR) return { status: 'not_pre_reception', reason: 's1_status' };
      if (row.s1_attempts >= a.maxAttempts) return { status: 'attempts_exhausted' };
      Object.assign(row, {
        s1_status: S1.IN_FLIGHT,
        s1_attempts: row.s1_attempts + 1,
        s1_http_status: null,
        s1_error_code: null,
        s1_started_at: iso(NOW),
        s1_completed_at: null,
        s1_lease_expires_at: iso(NOW + a.leaseSeconds * 1000),
      });
      return { status: 'retried', process: Object.assign({}, row), lock: { status: 'acquired' } };
    },
    async finishS1(id, r) {
      const row = byId(id);
      if (!row || row.s1_status !== S1.IN_FLIGHT) return null;
      Object.assign(row, {
        s1_status: r.status,
        s1_result_message: r.resultMessage,
        s1_error_code: r.errorCode,
        s1_http_status: r.httpStatus,
        s1_completed_at: iso(NOW),
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
  return repo;
}

const silentLogger = { info() {}, warn() {}, error() {} };

function harness(steps, opts) {
  const o = opts || {};
  const solicitudes = new Map([[CZ, solicitudFixture(CZ, CI)]]);
  for (const id of o.extraCzIds || []) solicitudes.set(id, solicitudFixture(id, CI));
  const repo = createFakeRepo(solicitudes, o.processes || [failed1430()]);
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
    openRequests: o.openRequests || [],
    locks: o.locks === undefined ? [] : o.locks,
  });
  const holdCalls = [];
  const deps = {
    orchestrator: orch,
    listView: listView,
    loadRejectedCzIds: async () => o.rejectedCzIds || [CZ],
    loadCiResendHold: (holdCi, czId, holdOpts) => {
      holdCalls.push({ ci: holdCi, czId: czId, opts: holdOpts || null });
      return loadCiResendHold(
        null,
        holdCi,
        czId,
        Object.assign({ now: () => NOW, postReferralRejectionStatuses: [], readRows: readRows }, holdOpts || {}),
      );
    },
  };
  const retry = (input) =>
    retryRejectedElm(
      deps,
      Object.assign({ ci: CI, czSolicitudId: CZ, expectedAttempts: 1, actorUserId: 'user-admin-1' }, input || {}),
    );
  return { orch, repo, fetchImpl, listView, deps, retry, holdCalls, config };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// --- Orchestrator + route wiring ---------------------------------------------------------

test('1430: retry reuses the same process, sends the frozen S1 request once, S2 follows', async () => {
  const h = harness([okResult('Listo para recibir datos en servicio 2'), okResult('Lead Aprobado correctamente')]);
  const out = await h.retry();
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(out.body.outcome, 'referred');
  assert.strictEqual(out.body.stage, 's2');
  assert.strictEqual(h.repo.calls.manualRetryS1.length, 1);
  const call = h.repo.calls.manualRetryS1[0];
  assert.deepStrictEqual(
    { czSolicitudId: call.czSolicitudId, expectedAttempts: call.expectedAttempts, actorUserId: call.actorUserId },
    { czSolicitudId: CZ, expectedAttempts: 1, actorUserId: 'user-admin-1' },
  );
  assert.strictEqual(call.maxAttempts, h.config.technicalRetryMaxAttempts);
  assert.strictEqual(call.leaseSeconds, h.config.inFlightLeaseSeconds);
  assert.strictEqual(h.fetchImpl.calls.length, 2, 'one S1 + one S2 call');
  assert.ok(String(h.fetchImpl.calls[0].init.body).includes(FROZEN_MARKER), 'S1 resends the frozen request');
  assert.strictEqual(h.repo.calls.claimProcess, 0, 'no new process');
  assert.strictEqual(h.repo.calls.retryStep, 0, 'automatic retry path untouched');
  assert.strictEqual(h.repo.rows.size, 1);
  const row = h.repo.rows.get(CZ);
  assert.strictEqual(row.id, failed1430().id);
  assert.strictEqual(row.s1_attempts, 2);
  assert.strictEqual(row.s1_status, S1.ELIGIBLE);
  assert.strictEqual(row.s2_status, S2.REFERRED);
  assert.strictEqual(h.holdCalls.length, 1);
  assert.deepStrictEqual(h.holdCalls[0].opts, { retryOwnProcess: true });
});

test('1430: a second 403 is stored as technical_error again (no automatic retry, no S2)', async () => {
  const h = harness([AUTH_403]);
  const out = await h.retry();
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(out.body.outcome, 'technical_error');
  assert.strictEqual(h.fetchImpl.calls.length, 1);
  const row = h.repo.rows.get(CZ);
  assert.strictEqual(row.s1_status, S1.TECHNICAL_ERROR);
  assert.strictEqual(row.s1_error_code, CODES.HTTP_AUTH_REJECTED);
  assert.strictEqual(row.s1_http_status, 403);
  assert.strictEqual(row.s1_attempts, 2);
  assert.strictEqual(row.s2_status, S2.NOT_STARTED);
  const cell = out.body.cell;
  assert.ok(cell.retry && cell.retry.show === true, 'still offered after a second auth rejection');
  assert.strictEqual(cell.retry.expected_attempts, 2);
});

test('1430: S1 rejected by ELM ends the process (no S2, no retry offered)', async () => {
  const h = harness([okResult('SCORE BAJO')]);
  const out = await h.retry();
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(out.body.outcome, 's1_rejected');
  assert.strictEqual(h.fetchImpl.calls.length, 1);
  assert.strictEqual(out.body.cell.retry, null);
});

test('ELM disabled / config incomplete: 503 before any RPC or ELM call', async () => {
  for (const env of [{ ELM_CLIENT_ENABLED: 'false' }, { ELM_ACTIVITY_TYPE_MAP_JSON: undefined }]) {
    const h = harness([], { env: env });
    const out = await h.retry();
    assert.strictEqual(out.status, 503);
    assert.strictEqual(out.body.code, 'elm_send_not_ready');
    assert.strictEqual(h.repo.calls.manualRetryS1.length, 0);
    assert.strictEqual(h.fetchImpl.calls.length, 0);
  }
  const direct = harness([], { env: { ELM_CLIENT_ENABLED: 'false' } });
  const res = await direct.orch.retrySendElm(CZ, { triggerOrigin: 'janus_manual', triggeredByUserId: 'u' }, { expectedAttempts: 1 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, CODES.SEND_DISABLED);
  assert.strictEqual(direct.repo.calls.manualRetryS1.length, 0);
});

test('invalid input: 400 and nothing called', async () => {
  for (const input of [{ expectedAttempts: 0 }, { expectedAttempts: 'x' }, { expectedAttempts: 1.5 }, { expectedAttempts: null }]) {
    const h = harness([]);
    const out = await h.retry(input);
    assert.strictEqual(out.status, 400, JSON.stringify(input));
    assert.strictEqual(out.body.code, CODES.INVALID_CONTEXT);
    assert.strictEqual(h.repo.calls.manualRetryS1.length, 0);
  }
  const h = harness([]);
  const bad = await h.retry({ czSolicitudId: 'abc' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.code, CODES.INVALID_CZ_ID);
});

test('solicitud not among the CI rejections: 404, nothing called', async () => {
  const h = harness([], { rejectedCzIds: [999] });
  const out = await h.retry();
  assert.strictEqual(out.status, 404);
  assert.strictEqual(out.body.code, 'elm_solicitud_not_in_rejections');
  assert.strictEqual(h.repo.calls.manualRetryS1.length, 0);
});

test('only janus_manual may retry; automatic / batch origins are refused before the RPC', async () => {
  const h = harness([], { env: { ELM_ENABLED_TRIGGER_ORIGINS: 'janus_manual,janus_batch,cz_automatic' } });
  for (const origin of ['cz_automatic', 'janus_batch']) {
    const res = await h.orch.retrySendElm(
      CZ,
      { triggerOrigin: origin, triggeredByUserId: origin === 'cz_automatic' ? null : 'u' },
      { expectedAttempts: 1 },
    );
    assert.strictEqual(res.ok, false, origin);
  }
  assert.strictEqual(h.repo.calls.manualRetryS1.length, 0);
  assert.strictEqual(h.fetchImpl.calls.length, 0);
});

test('CDV granted: blocked by eligibility before the RPC', async () => {
  const h = harness([]);
  h.repo.grantedRow = { cz_id: CZ, ci: CI, monto_otorgado: 15000 };
  const out = await h.retry();
  assert.strictEqual(out.body.ok, false);
  assert.strictEqual(out.body.code, CODES.CDV_GRANTED);
  assert.strictEqual(h.repo.calls.manualRetryS1.length, 0);
  assert.strictEqual(h.fetchImpl.calls.length, 0);
});

test('no process: 404 elm_process_not_found', async () => {
  const h = harness([], { processes: [] });
  const out = await h.retry();
  assert.strictEqual(out.status, 404);
  assert.strictEqual(out.body.code, CODES.PROCESS_NOT_FOUND);
  assert.strictEqual(h.repo.calls.manualRetryS1.length, 0);
});

test('DB refusals map to 409 codes and never call ELM', async () => {
  const cases = [
    [{ status: 'stale' }, CODES.RETRY_STALE],
    [{ status: 'not_pre_reception', reason: 'reception_unproven' }, CODES.RETRY_NOT_PRE_RECEPTION],
    [{ status: 'attempts_exhausted' }, CODES.RETRY_ATTEMPTS_EXHAUSTED],
    [{ status: 'not_allowed', reason: 'automatic_origin' }, CODES.RETRY_NOT_ALLOWED],
    [{ status: 'blocked', lock: { status: 'blocked', block: 'monthly_quota_used' } }, CODES.CI_LOCK_BLOCKED],
    [{ status: 'something_new' }, CODES.RETRY_NOT_ALLOWED],
  ];
  for (const [forced, code] of cases) {
    const h = harness([]);
    h.repo.forced = forced;
    const out = await h.retry();
    assert.strictEqual(out.status, 409, forced.status);
    assert.strictEqual(out.body.ok, false);
    assert.strictEqual(out.body.code, code, forced.status);
    assert.strictEqual(out.body.outcome, 'technical_error', 'state shown is the stored one');
    assert.strictEqual(h.fetchImpl.calls.length, 0);
    assert.strictEqual(h.repo.rows.get(CZ).s1_attempts, 1);
  }
  const h = harness([]);
  h.repo.forced = { status: 'not_found' };
  const out = await h.retry();
  assert.strictEqual(out.status, 404);
  assert.strictEqual(out.body.code, CODES.PROCESS_NOT_FOUND);
});

test('stale double click: the second press with the old count is refused, ELM called once', async () => {
  const h = harness([AUTH_403]);
  const first = await h.retry();
  assert.strictEqual(first.body.ok, true);
  const second = await h.retry();
  assert.strictEqual(second.status, 409);
  assert.strictEqual(second.body.code, CODES.RETRY_STALE);
  assert.strictEqual(h.fetchImpl.calls.length, 1);
});

test('CI hold: another solicitud of the CI blocks the retry; the own process does not', async () => {
  const other = {
    id: 'p-other',
    cz_solicitud_id: 2000,
    ci: CI,
    trigger_origin: 'janus_manual',
    created_at: iso(NOW - DAY),
    s1_status: S1.IN_FLIGHT,
    s1_started_at: iso(NOW - 60 * 1000),
    s1_lease_expires_at: iso(NOW + 60 * 1000),
    s2_status: S2.NOT_STARTED,
  };
  const held = harness([], { processes: [failed1430(), other], extraCzIds: [2000] });
  const out = await held.retry();
  assert.strictEqual(out.status, 409);
  assert.strictEqual(out.body.code, HOLD.ACTIVE);
  assert.strictEqual(held.repo.calls.manualRetryS1.length, 0);

  const recent = Object.assign({}, other, {
    s1_status: S1.REJECTED,
    s1_result_message: 'SCORE BAJO',
    s1_lease_expires_at: null,
    s1_started_at: iso(NOW - 3 * DAY),
    created_at: iso(NOW - 3 * DAY),
  });
  const timed = harness([], { processes: [failed1430(), recent], extraCzIds: [2000] });
  const out2 = await timed.retry();
  assert.strictEqual(out2.status, 409);
  assert.ok([HOLD.RECENT_SEND, HOLD.MONTHLY_QUOTA].includes(out2.body.code), out2.body.code);

  const unverifiable = harness([], { locks: null });
  const out3 = await unverifiable.retry();
  assert.strictEqual(out3.status, 503);
  assert.strictEqual(out3.body.code, HOLD.UNVERIFIABLE);
  assert.strictEqual(unverifiable.repo.calls.manualRetryS1.length, 0);
});

test('regular "Enviar a ELM" is unchanged: an existing process is never resent by send', async () => {
  const h = harness([]);
  const deps = h.deps;
  const out = await sendRejectedToElm(deps, { ci: CI, czSolicitudId: CZ, actorUserId: 'user-admin-1' });
  assert.strictEqual(out.body.ok, false);
  assert.strictEqual(out.body.code, CODES.PROCESS_EXISTS);
  assert.strictEqual(h.fetchImpl.calls.length, 0);
  assert.strictEqual(h.repo.rows.get(CZ).s1_attempts, 1);
  assert.strictEqual(h.repo.calls.manualRetryS1.length, 0);
});

// --- Guard ---------------------------------------------------------------------------------

test('guard: retryOwnProcess keeps the target excluded but evaluates the CI', () => {
  const own = failed1430();
  const base = { ci: CI, czSolicitudId: CZ, processes: [own], locks: [], nowMs: NOW };
  assert.strictEqual(evaluateCiResendHold(base), null);
  assert.strictEqual(evaluateCiResendHold(Object.assign({}, base, { retryOwnProcess: true })), null);
  const releasedOwn = {
    ci: CI,
    cz_solicitud_id: CZ,
    state: 'released',
    reserved_at: iso(NOW - 2 * DAY),
    month_key: '2026-10-01',
  };
  assert.strictEqual(
    evaluateCiResendHold(Object.assign({}, base, { retryOwnProcess: true, locks: [releasedOwn] })),
    null,
  );
  const otherInFlight = {
    id: 'x',
    cz_solicitud_id: 2000,
    ci: CI,
    trigger_origin: 'janus_manual',
    created_at: iso(NOW - DAY),
    s1_status: S1.IN_FLIGHT,
    s1_started_at: iso(NOW - 1000),
    s1_lease_expires_at: iso(NOW + 60000),
    s2_status: S2.NOT_STARTED,
  };
  const both = Object.assign({}, base, { processes: [own, otherInFlight] });
  assert.strictEqual(evaluateCiResendHold(both), null, 'send path: own process → no hold (send refuses later)');
  const hold = evaluateCiResendHold(Object.assign({}, both, { retryOwnProcess: true }));
  assert.ok(hold && hold.reason === HOLD.ACTIVE && hold.related_cz_solicitud_id === 2000);
  const otherLock = { ci: CI, cz_solicitud_id: 2000, state: 'reserved', reserved_at: iso(NOW - 1000), month_key: '2026-10-01' };
  const lockHold = evaluateCiResendHold(Object.assign({}, base, { retryOwnProcess: true, locks: [otherLock] }));
  assert.ok(lockHold && lockHold.reason === HOLD.IN_PROGRESS);
});

// --- List cell ------------------------------------------------------------------------------

const READY = { ready: true, reasons: [] };

function cellOf(p, over) {
  return computeElmCell(
    Object.assign(
      {
        process: p,
        nowMs: NOW,
        postReferralRejectionStatuses: [],
        allowSend: true,
        sendReadiness: READY,
        maxRetryAttempts: 3,
      },
      over || {},
    ),
  );
}

test('cell: "Reintentar ELM" only for the pre-reception S1 failure', () => {
  const c = cellOf(failed1430());
  assert.deepStrictEqual(
    { show: c.retry.show, enabled: c.retry.enabled, expected: c.retry.expected_attempts },
    { show: true, enabled: true, expected: 1 },
  );
  assert.strictEqual(c.action.show, false, '"Enviar a ELM" stays hidden for a solicitud with a process');
  assert.strictEqual(cellOf(failed1430({ s1_http_status: 401 })).retry.enabled, true);

  const notOffered = [
    ['no allowSend', failed1430(), { allowSend: false }],
    ['other auth status', failed1430({ s1_http_status: 200 }), null],
    ['500', failed1430({ s1_http_status: 500, s1_error_code: CODES.HTTP_ERROR || 'elm_http_error' }), null],
    ['timeout', failed1430({ s1_http_status: null, s1_error_code: 'elm_timeout' }), null],
    ['unknown', failed1430({ s1_status: S1.UNKNOWN }), null],
    ['in_flight', failed1430({ s1_status: S1.IN_FLIGHT, s1_lease_expires_at: iso(NOW + 60000) }), null],
    ['rejected', failed1430({ s1_status: S1.REJECTED, s1_result_message: 'SCORE BAJO' }), null],
    ['eligible', failed1430({ s1_status: S1.ELIGIBLE }), null],
    ['S2 started', failed1430({ s2_status: S2.TECHNICAL_ERROR }), null],
    ['ops resolved', failed1430({ ops_resolved_at: iso(NOW - DAY), ops_resolution_code: 'x' }), null],
    ['cz_automatic', failed1430({ trigger_origin: 'cz_automatic' }), null],
    ['bcu error', failed1430({ s1_http_status: 200, s1_error_code: 'elm_s1_bcu_error' }), null],
  ];
  for (const [name, p, over] of notOffered) {
    assert.strictEqual(cellOf(p, over).retry, null, name);
  }
});

test('cell: shown disabled when ELM is not ready or attempts are used up', () => {
  const notReady = cellOf(failed1430(), { sendReadiness: { ready: false, reasons: ['elm_client_disabled'] } });
  assert.strictEqual(notReady.retry.show, true);
  assert.strictEqual(notReady.retry.enabled, false);
  assert.strictEqual(notReady.retry.reason, 'elm_client_disabled');
  const exhausted = cellOf(failed1430({ s1_attempts: 3 }));
  assert.strictEqual(exhausted.retry.enabled, false);
  assert.strictEqual(exhausted.retry.reason, CODES.RETRY_ATTEMPTS_EXHAUSTED);
});

test('cellsForCzIds: retry offered only with allowSend (Rechazados), with readiness', async () => {
  const h = harness([]);
  const withSend = await h.listView.cellsForCzIds([CZ], { allowSend: true });
  assert.strictEqual(withSend.get(CZ).retry.enabled, true);
  assert.strictEqual(withSend.get(CZ).retry.expected_attempts, 1);
  const readOnly = await h.listView.cellsForCzIds([CZ], {});
  assert.strictEqual(readOnly.get(CZ).retry, null);
  const off = harness([], { env: { ELM_CLIENT_ENABLED: 'false' } });
  const disabled = await off.listView.cellsForCzIds([CZ], { allowSend: true });
  assert.strictEqual(disabled.get(CZ).retry.enabled, false);
});

test('resolveRejectedSend: retry candidates carry the per-target CI hold', () => {
  const cell = cellOf(failed1430());
  const cells = new Map([[CZ, cell]]);
  const free = resolveRejectedSend({
    rejected: [{ cz_solicitud_id: CZ, rejected_at: '2026-10-07T10:00:00' }],
    cells: cells,
    hold: { reason: HOLD.ACTIVE, related_cz_solicitud_id: null, until: null },
    retryHold: () => null,
  });
  assert.strictEqual(free.send.candidates.length, 0, 'no "Enviar a ELM" for a solicitud with a process');
  assert.strictEqual(free.send.retry_candidates.length, 1);
  assert.deepStrictEqual(
    { id: free.send.retry_candidates[0].cz_solicitud_id, enabled: free.send.retry_candidates[0].enabled },
    { id: CZ, enabled: true },
  );
  const held = resolveRejectedSend({
    rejected: [{ cz_solicitud_id: CZ }],
    cells: cells,
    hold: null,
    retryHold: () => ({ reason: HOLD.MONTHLY_QUOTA, related_cz_solicitud_id: 2000, until: '2026-11-01' }),
  });
  const c = held.send.retry_candidates[0];
  assert.strictEqual(c.enabled, false);
  assert.strictEqual(c.reason, HOLD.MONTHLY_QUOTA);
  assert.strictEqual(c.hold.related_cz_solicitud_id, 2000);
  const none = resolveRejectedSend({ rejected: [{ cz_solicitud_id: CZ }], cells: new Map(), hold: null });
  assert.deepStrictEqual(none.send.retry_candidates, []);
});

test('CI hold caused by the retryable process: says "reintento pendiente", new sends stay blocked', () => {
  const sendable = {
    kind: 'not_sent',
    cz_solicitud_id: 1500,
    action: { show: true, enabled: true, reason: null, reasons: [], blockers: [], hint: null },
  };
  const hold = { reason: HOLD.ACTIVE, related_cz_solicitud_id: CZ, until: null };
  const rejected = [{ cz_solicitud_id: 1500 }, { cz_solicitud_id: CZ }];

  const withRetry = resolveRejectedSend({
    rejected: rejected,
    cells: new Map([[CZ, cellOf(failed1430())], [1500, sendable]]),
    hold: hold,
    retryHold: () => null,
  }).send;
  assert.strictEqual(withRetry.hold.reason, HOLD.ACTIVE, 'same restriction');
  assert.strictEqual(withRetry.hold.retry_pending, true);
  assert.strictEqual(withRetry.candidates[0].enabled, false, 'a new send of the CI stays blocked');
  assert.strictEqual(withRetry.candidates[0].reason, HOLD.ACTIVE);
  assert.strictEqual(withRetry.retry_candidates[0].enabled, true);
  const text = ElmUi.ciHoldText(withRetry.hold.reason, withRetry.hold);
  assert.ok(!/vigente/.test(text), text);
  assert.ok(text.includes('Reintentar ELM') && text.includes(String(CZ)), text);
  const html = ElmUi.rejectedRowElmHtml(
    { available: true, cell: cellOf(failed1430()), other_processes: [], send: withRetry },
    CI,
  );
  assert.ok(html.includes('data-action="elm-retry"'));
  assert.ok(!html.includes('data-action="elm-send"'), 'send button stays disabled');
  assert.ok(!/proceso ELM vigente/.test(html), html);

  const noRetry = resolveRejectedSend({
    rejected: rejected,
    cells: new Map([[CZ, cellOf(failed1430({ s1_http_status: 500 }))], [1500, sendable]]),
    hold: hold,
    retryHold: () => null,
  }).send;
  assert.strictEqual(noRetry.hold.retry_pending, undefined);
  assert.ok(/vigente/.test(ElmUi.ciHoldText(noRetry.hold.reason, noRetry.hold)));
  const otherHold = resolveRejectedSend({
    rejected: rejected,
    cells: new Map([[CZ, cellOf(failed1430())], [1500, sendable]]),
    hold: { reason: HOLD.ACTIVE, related_cz_solicitud_id: 2000, until: null },
  }).send;
  assert.strictEqual(otherHold.hold.retry_pending, undefined, 'another solicitud holds the CI: unchanged');
});

// --- UI helpers -----------------------------------------------------------------------------

test('UI: Rechazados row renders "Reintentar ELM" with the expected attempt count', () => {
  const cell = cellOf(failed1430());
  const send = resolveRejectedSend({
    rejected: [{ cz_solicitud_id: CZ }],
    cells: new Map([[CZ, cell]]),
    hold: null,
    retryHold: () => null,
  }).send;
  const html = ElmUi.rejectedRowElmHtml({ available: true, cell: cell, other_processes: [], send: send }, CI);
  assert.ok(html.includes('data-action="elm-retry"'), html);
  assert.ok(html.includes('data-cz-id="' + CZ + '"'));
  assert.ok(html.includes('data-ci="' + CI + '"'));
  assert.ok(html.includes('data-expected-attempts="1"'));
  assert.ok(html.includes('Reintentar ELM'));
  assert.ok(!html.includes('data-action="elm-send"'));

  const disabled = ElmUi.retryButtonHtml(
    { cz_solicitud_id: CZ, enabled: false, expected_attempts: 1, reasons: [HOLD.MONTHLY_QUOTA], hold: { until: '2026-11-01' } },
    CI,
  );
  assert.ok(disabled.includes('disabled'));
  assert.ok(!disabled.includes('data-action="elm-retry"'));
  assert.ok(disabled.includes('La CI ya tuvo un envío ELM este mes'));

  const detail = ElmUi.elmCellHtml(cell, { retryCi: CI });
  assert.ok(detail.includes('data-action="elm-retry"'));
  assert.ok(!ElmUi.elmCellHtml(cell, {}).includes('elm-retry'), 'no CI → no retry button');

  const plain = ElmUi.rejectedRowElmHtml(
    { available: true, cell: cellOf(failed1430({ s1_http_status: 500 })), other_processes: [], send: { available: true, candidates: [], retry_candidates: [] } },
    CI,
  );
  assert.ok(!plain.includes('elm-retry'));
});

test('UI: result messages for retry refusals', () => {
  const cell = cellOf(failed1430());
  for (const code of [
    CODES.RETRY_STALE,
    CODES.RETRY_NOT_PRE_RECEPTION,
    CODES.RETRY_ATTEMPTS_EXHAUSTED,
    CODES.RETRY_NOT_ALLOWED,
  ]) {
    const m = ElmUi.sendResultMessage({ ok: false, code: code, outcome: 'technical_error', cell: cell });
    assert.strictEqual(m.tone, 'warn');
    assert.ok(!m.text.includes('Código:'), code + ' has a message');
  }
});

// --- Automatic path unchanged ------------------------------------------------------------------

test('automatic path: an auth rejection still ends in manual_review (no automatic retry)', () => {
  const config = readElmConfig(ENV);
  assert.deepStrictEqual(Array.from(config.retrySafeErrorCodes), [], 'ELM_RETRY_SAFE_ERROR_CODES unset');
  assert.ok(!config.retrySafeErrorCodes.includes(CODES.HTTP_AUTH_REJECTED));
  const policy = {
    safeErrorCodes: config.retrySafeErrorCodes,
    maxAttempts: config.technicalRetryMaxAttempts,
    backoffSeconds: config.technicalRetryBackoffSeconds,
    backoffMaxSeconds: config.technicalRetryBackoffMaxSeconds,
  };
  const d = deriveFromProcess(failed1430({ trigger_origin: 'cz_automatic' }), NOW, policy);
  assert.strictEqual(d.kind, 'final');
  assert.strictEqual(d.outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(d.reasonCode, REASONS.ELM_S1_TECHNICAL_ERROR_RETRY_UNSAFE);
  assert.deepStrictEqual(PRE_RECEPTION_ERROR_CODES, [CODES.HTTP_AUTH_REJECTED]);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('ok   ' + t.name);
    } catch (err) {
      failed += 1;
      console.log('FAIL ' + t.name);
      console.log(err && err.stack ? err.stack : err);
    }
  }
  assert.deepStrictEqual(externalNet, [], 'no external network');
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
