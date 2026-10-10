'use strict';

/**
 * Manual-only S1 allowances (janus_manual): relacion_laboral OTR without mapping goes verbatim as
 * activityType, an absent / invalid fecha_nacimiento leaves dateOfBirth out. The automatic circuit
 * (cz_automatic) keeps the strict rules. ELM's own answer is stored and shown, never retried.
 *
 * NO network: sockets and global fetch are blocked; the real NetSuite client runs on a fake fetch
 * with FAKE credentials.
 *
 * Run: node scripts/unit-elm-manual-flex.js
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

const { S1, S2, CODES, NOTICES, ELM_SOURCE } = require('../src/services/elm/constants');
const { readElmConfig } = require('../src/services/elm/config');
const { buildService1Payload, SERVICE1_KEYS } = require('../src/services/elm/payload');
const { evaluateElmEligibility } = require('../src/services/elm/eligibility');
const { createElmClient } = require('../src/services/elm/client');
const { createElmOrchestrator, toStepResult, S1_BY_OUTCOME } = require('../src/services/elm/orchestrator');
const { createElmListView } = require('../src/services/elm/listView');
const { resolveRejectedSend } = require('../src/lib/rejectedElmRead');
const { sendRejectedToElm } = require('../src/lib/rejectedElmSend');
const ElmUi = require('../public/elm-ui-helpers');

const URL_S1 = 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=10&deploy=1';
const URL_S2 = 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=11&deploy=1';
const ENV = Object.freeze({
  ELM_CLIENT_ENABLED: 'true',
  ELM_SERVICE_1_URL: URL_S1,
  ELM_SERVICE_2_URL: URL_S2,
  ELM_CONSUMER_KEY: 'fake-consumer-key-0001',
  ELM_CONSUMER_SECRET: 'fake-consumer-secret-0002',
  ELM_TOKEN_ID: 'fake-token-id-0003',
  ELM_TOKEN_SECRET: 'fake-token-secret-0004',
  ELM_HTTP_TIMEOUT_MS: '200',
  ELM_ACTIVITY_TYPE_MAP_JSON: '{"EPU":"TEST_PUBLICO","EPR":"TEST_PRIVADO","JUB":"TEST_JUBILADO"}',
  ELM_DATE_OF_BIRTH_FORMAT: 'D/M/YYYY',
  ELM_MOBILE_PHONE_FORMAT: 'uy_local_0',
});
const CONFIG = readElmConfig(ENV);
const NOW_MS = Date.parse('2026-10-10T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const CZ = 1255;
const CI = 12345678;
const MANUAL = { triggerOrigin: 'janus_manual', triggeredByUserId: 'user-admin-1', sendOrigin: 'rechazados_manual' };
const AUTOMATIC_ORIGINS = ['janus_manual', 'cz_automatic'];

function solicitud(over) {
  return Object.assign(
    {
      cz_id: CZ,
      ci: CI,
      nombre: 'Ana',
      apellido: 'Prueba',
      email: 'ana@example.test',
      celular: '59899123456',
      salario: 30000,
      fecha_nacimiento: '1991-07-10',
      relacion_laboral: 'EPR',
      lrw_id: 'LRW-1',
      solicitudes_estados_id: 3,
    },
    over || {},
  );
}

function fakeFetch(steps) {
  const calls = [];
  async function f(url, init) {
    calls.push({ url: url, init: init });
    const step = steps[calls.length - 1];
    if (!step) throw new Error('unexpected extra ELM call');
    return {
      status: step.status,
      text: async function () {
        return typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
      },
    };
  }
  f.calls = calls;
  return f;
}
const ok = (result) => ({ status: 200, body: { result: result } });

function createFakeRepo(sol, opts) {
  const o = opts || {};
  const rows = new Map();
  const iso = () => new Date(NOW_MS).toISOString();
  let seq = 0;
  const byId = (id) => [...rows.values()].find((r) => r.id === id) || null;
  const claims = [];
  return {
    rows,
    claims,
    async loadSolicitudContext() {
      return { solicitud: sol, grantedRow: null };
    },
    async loadSolicitudContexts(ids) {
      return new Map(ids.map((id) => [id, { solicitud: id === CZ ? sol : null, grantedRow: null }]));
    },
    async getProcessesByCzIds(ids) {
      return new Map(ids.filter((id) => rows.has(id)).map((id) => [id, Object.assign({}, rows.get(id))]));
    },
    async resolveBaseLabel() {
      return null;
    },
    async getProcessByCzId(czId) {
      const r = rows.get(czId);
      return r ? Object.assign({}, r) : null;
    },
    async claimProcess(a) {
      claims.push(a);
      if (o.claimBlocked) return { claimed: false, blocked: { status: 'monthly_quota_used' } };
      if (rows.has(a.czSolicitudId)) return { claimed: false, process: Object.assign({}, rows.get(a.czSolicitudId)) };
      seq += 1;
      const row = {
        id: 'proc-' + seq,
        cz_solicitud_id: a.czSolicitudId,
        ci: a.ci,
        trigger_origin: a.triggerOrigin,
        send_origin: a.sendOrigin,
        s1_status: S1.IN_FLIGHT,
        s1_request: a.s1Request,
        s1_attempts: 1,
        s1_started_at: iso(),
        s1_lease_expires_at: new Date(NOW_MS + a.leaseSeconds * 1000).toISOString(),
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
        s1_response: r.response,
        s1_http_status: r.httpStatus,
        s1_result_message: r.resultMessage,
        s1_error_code: r.errorCode,
        s1_error_detail: r.errorDetail,
        s1_lease_expires_at: null,
      });
      return Object.assign({}, row);
    },
    async beginS2(czId, req, leaseSeconds) {
      const row = rows.get(czId);
      if (!row || row.s1_status !== S1.ELIGIBLE || row.s2_status !== S2.NOT_STARTED) return null;
      Object.assign(row, {
        s2_status: S2.IN_FLIGHT,
        s2_request: req,
        s2_started_at: iso(),
        s2_lease_expires_at: new Date(NOW_MS + leaseSeconds * 1000).toISOString(),
      });
      return Object.assign({}, row);
    },
    async finishS2(id, r) {
      const row = byId(id);
      if (!row || row.s2_status !== S2.IN_FLIGHT) return null;
      Object.assign(row, {
        s2_status: r.status,
        s2_response: r.response,
        s2_result_message: r.resultMessage,
        s2_error_code: r.errorCode,
        s2_lease_expires_at: null,
        referred_at: r.status === S2.REFERRED ? iso() : null,
      });
      return Object.assign({}, row);
    },
    async expireStaleInFlight(czId) {
      return rows.get(czId) ? Object.assign({}, rows.get(czId)) : null;
    },
    async manualRetryS1(a) {
      const row = rows.get(a.czSolicitudId);
      if (!row) return { status: 'not_found' };
      Object.assign(row, {
        s1_status: S1.IN_FLIGHT,
        s1_attempts: row.s1_attempts + 1,
        s1_lease_expires_at: new Date(NOW_MS + a.leaseSeconds * 1000).toISOString(),
      });
      return { status: 'retried', process: Object.assign({}, row) };
    },
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

function setup(sol, steps, opts) {
  const repo = createFakeRepo(sol, opts);
  const f = fakeFetch(steps || []);
  const client = createElmClient({ env: ENV, fetchImpl: f });
  const orch = createElmOrchestrator({
    repository: repo,
    client: client,
    config: CONFIG,
    logger: silentLogger,
    now: () => NOW_MS,
    enabledTriggerOrigins: AUTOMATIC_ORIGINS,
    postReferralRejectionStatuses: [],
  });
  const listView = createElmListView({
    repository: repo,
    config: CONFIG,
    now: () => NOW_MS,
    postReferralRejectionStatuses: [],
    sendReadiness: () => orch.getSendReadiness(),
  });
  return { repo, f, orch, listView };
}

function s1Body(call) {
  return call.init.body;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------

test('payload: manual OTR verbatim, invalid DOB omitted, exact S1 JSON; automatic strict', () => {
  const sol = solicitud({ relacion_laboral: 'OTR', fecha_nacimiento: '0088-04-08' });
  const manual = buildService1Payload({ czId: CZ, solicitud: sol, config: CONFIG, now: NOW, manual: true });
  assert.strictEqual(manual.ok, true);
  assert.deepStrictEqual(manual.notices, [NOTICES.ACTIVITY_TYPE_RAW, NOTICES.DATE_OF_BIRTH_OMITTED]);
  assert.strictEqual(
    JSON.stringify(manual.payload),
    '{"activityType":"OTR","docNumber":"12345678","firstName":"Ana","lastName":"Prueba","salary":"30000","source":"' +
      ELM_SOURCE +
      '"}',
  );
  assert.deepStrictEqual(
    Object.keys(manual.payload),
    SERVICE1_KEYS.filter((k) => k !== 'dateOfBirth'),
    'documented key order kept',
  );

  const strict = buildService1Payload({ czId: CZ, solicitud: sol, config: CONFIG, now: NOW });
  assert.deepStrictEqual(strict, { ok: false, code: CODES.ACTIVITY_TYPE_MAPPING_MISSING });
  const strictDob = buildService1Payload({
    czId: CZ,
    solicitud: solicitud({ fecha_nacimiento: '0088-04-08' }),
    config: CONFIG,
    now: NOW,
  });
  assert.deepStrictEqual(strictDob, { ok: false, code: CODES.DATE_OF_BIRTH_INVALID });
});

test('payload: OTR with valid DOB keeps the date; absent DOB omitted; configured mapping wins', () => {
  const otr = buildService1Payload({
    czId: CZ,
    solicitud: solicitud({ relacion_laboral: 'OTR' }),
    config: CONFIG,
    now: NOW,
    manual: true,
  });
  assert.deepStrictEqual(otr.notices, [NOTICES.ACTIVITY_TYPE_RAW]);
  assert.strictEqual(
    JSON.stringify(otr.payload),
    '{"activityType":"OTR","dateOfBirth":"10/7/1991","docNumber":"12345678","firstName":"Ana","lastName":"Prueba","salary":"30000","source":"' +
      ELM_SOURCE +
      '"}',
  );
  const omittable = [
    { fecha_nacimiento: null, fecha_nacimiento_status: 'absent' },
    { fecha_nacimiento: null, fecha_nacimiento_status: 'impossible' },
    { fecha_nacimiento: null, fecha_nacimiento_status: 'over_max_age' },
    { fecha_nacimiento: '', fecha_nacimiento_status: 'absent' },
    { fecha_nacimiento: '0001-09-28' },
    { fecha_nacimiento: '1991-02-30' },
    { fecha_nacimiento: '1880-01-01' },
    { fecha_nacimiento: 'no-es-fecha' },
  ];
  for (const over of omittable) {
    const label = JSON.stringify(over);
    const b = buildService1Payload({ czId: CZ, solicitud: solicitud(over), config: CONFIG, now: NOW, manual: true });
    assert.strictEqual(b.ok, true, label);
    assert.ok(!('dateOfBirth' in b.payload), 'no dateOfBirth for ' + label);
    assert.deepStrictEqual(b.notices, [NOTICES.DATE_OF_BIRTH_OMITTED]);
    assert.strictEqual(b.payload.activityType, 'TEST_PRIVADO', 'mapped activity untouched');
  }
  const mapped = buildService1Payload({
    czId: CZ,
    solicitud: solicitud({ relacion_laboral: 'OTR' }),
    config: Object.assign({}, CONFIG, { activityTypeMap: Object.assign({}, CONFIG.activityTypeMap, { OTR: 'TEST_OTROS' }) }),
    now: NOW,
    manual: true,
  });
  assert.strictEqual(mapped.payload.activityType, 'TEST_OTROS');
  assert.deepStrictEqual(mapped.notices, []);
});

test('payload: manual keeps every other rule (unknown code, missing fields, salary, DOB format)', () => {
  const build = (over, cfg) =>
    buildService1Payload({ czId: CZ, solicitud: solicitud(over), config: cfg || CONFIG, now: NOW, manual: true });
  assert.strictEqual(build({ relacion_laboral: 'ICL' }).code, CODES.ACTIVITY_TYPE_MAPPING_MISSING, 'only OTR is raw');
  assert.strictEqual(build({ relacion_laboral: 'otr' }).code, CODES.ACTIVITY_TYPE_MAPPING_MISSING, 'exact code only');
  assert.deepStrictEqual(build({ email: '' }), { ok: false, code: CODES.MISSING_REQUIRED_FIELDS, fields: ['email'] });
  assert.strictEqual(build({ salario: 0 }).code, CODES.SALARY_INVALID);
  assert.strictEqual(
    build({ fecha_nacimiento: '0088-04-08' }, Object.assign({}, CONFIG, { dateOfBirthFormat: null })).code,
    CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED,
    'an unconfirmed format is never bypassed',
  );
  for (const dob of ['2015-01-01', '2008-10-11', '2027-03-01']) {
    assert.strictEqual(build({ fecha_nacimiento: dob }).code, CODES.DATE_OF_BIRTH_INVALID, 'possible minor blocks: ' + dob);
    const e = evaluateElmEligibility({ czId: CZ, solicitud: solicitud({ fecha_nacimiento: dob }), grantedRow: null, config: CONFIG, now: NOW, manual: true });
    assert.deepStrictEqual(e.blockers, [{ code: CODES.DATE_OF_BIRTH_INVALID }], 'eligibility blocks: ' + dob);
  }
  assert.strictEqual(build({ fecha_nacimiento: '2008-10-10' }).payload.dateOfBirth, '10/10/2008', '18 today is valid');
});

test('mirror null date: underage / future / unclassified never become "omit dateOfBirth"', async () => {
  const cases = [
    [{ fecha_nacimiento: null, fecha_nacimiento_status: 'underage' }, CODES.DATE_OF_BIRTH_INVALID],
    [{ fecha_nacimiento: null, fecha_nacimiento_status: 'future' }, CODES.DATE_OF_BIRTH_INVALID],
    [{ fecha_nacimiento: null, fecha_nacimiento_status: 'valid' }, CODES.DATE_OF_BIRTH_INVALID],
    [{ fecha_nacimiento: null, fecha_nacimiento_status: 'otro' }, CODES.DATE_OF_BIRTH_INVALID],
    [{ fecha_nacimiento: null }, CODES.DATE_OF_BIRTH_UNVERIFIED],
    [{ fecha_nacimiento: null, fecha_nacimiento_status: null }, CODES.DATE_OF_BIRTH_UNVERIFIED],
    [{ fecha_nacimiento: '', fecha_nacimiento_status: undefined }, CODES.DATE_OF_BIRTH_UNVERIFIED],
  ];
  for (const [over, code] of cases) {
    const label = JSON.stringify(over);
    const sol = solicitud(Object.assign({ relacion_laboral: 'OTR' }, over));
    const b = buildService1Payload({ czId: CZ, solicitud: sol, config: CONFIG, now: NOW, manual: true });
    assert.deepStrictEqual(b, { ok: false, code: code }, 'payload ' + label);
    const e = evaluateElmEligibility({ czId: CZ, solicitud: sol, grantedRow: null, config: CONFIG, now: NOW, manual: true });
    assert.deepStrictEqual(e.blockers, [{ code: code }], 'eligibility ' + label);

    const h = setup(sol, []);
    const out = await h.orch.sendElm(CZ, MANUAL);
    assert.strictEqual(out.code, code, 'orchestrator ' + label);
    assert.strictEqual(h.f.calls.length, 0, 'ELM never called for ' + label);
    assert.strictEqual(h.repo.claims.length, 0, 'no claim for ' + label);
    const cell = (await h.listView.cellsForCzIds([CZ], { allowSend: true })).get(CZ);
    assert.strictEqual(cell.kind, 'not_sendable', 'list "No enviable" for ' + label);
    assert.ok(!ElmUi.elmCellHtml(cell, { ci: CI }).includes('<button'));
  }
  assert.ok(ElmUi.sendBlockedHint({ reason: CODES.DATE_OF_BIRTH_UNVERIFIED }).includes('sin verificar'));
});

test('eligibility: manual turns DOB / OTR into notices; default stays strict; other blockers kept', () => {
  const sol = solicitud({ relacion_laboral: 'OTR', fecha_nacimiento: '0001-01-12' });
  const manual = evaluateElmEligibility({ czId: CZ, solicitud: sol, grantedRow: null, config: CONFIG, now: NOW, manual: true });
  assert.deepStrictEqual(manual, {
    eligible: true,
    blockers: [],
    notices: [NOTICES.DATE_OF_BIRTH_OMITTED, NOTICES.ACTIVITY_TYPE_RAW],
  });
  const strict = evaluateElmEligibility({ czId: CZ, solicitud: sol, grantedRow: null, config: CONFIG, now: NOW });
  assert.deepStrictEqual(
    strict.blockers.map((b) => b.code),
    [CODES.DATE_OF_BIRTH_INVALID, CODES.ACTIVITY_TYPE_MAPPING_MISSING],
  );
  const granted = evaluateElmEligibility({
    czId: CZ,
    solicitud: Object.assign({}, sol, { solicitudes_estados_id: 11 }),
    grantedRow: null,
    config: CONFIG,
    now: NOW,
    manual: true,
  });
  assert.strictEqual(granted.eligible, false, 'CDV granted still blocks');
  const existing = evaluateElmEligibility({ czId: CZ, solicitud: sol, grantedRow: null, existingProcess: { id: 'p' }, config: CONFIG, now: NOW, manual: true });
  assert.deepStrictEqual(existing.blockers, [{ code: CODES.PROCESS_EXISTS }]);
});

test('orchestrator: manual 1255-like case sends exactly the expected S1 JSON once; automatic never calls ELM', async () => {
  const sol = solicitud({ relacion_laboral: 'OTR', fecha_nacimiento: null, fecha_nacimiento_status: 'over_max_age' });
  const auto = setup(sol);
  const a = await auto.orch.evaluateElm(CZ, { triggerOrigin: 'cz_automatic', solicitud: sol });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.code, CODES.DATE_OF_BIRTH_INVALID);
  assert.deepStrictEqual(a.blockers.map((b) => b.code), [CODES.DATE_OF_BIRTH_INVALID, CODES.ACTIVITY_TYPE_MAPPING_MISSING]);
  assert.strictEqual(auto.f.calls.length, 0);
  assert.strictEqual(auto.repo.claims.length, 0);

  const m = setup(sol, [ok('SCORE BAJO')]);
  const out = await m.orch.sendElm(CZ, MANUAL);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(m.f.calls.length, 1, 'S1 only (rejected)');
  const expected =
    '{"activityType":"OTR","docNumber":"12345678","firstName":"Ana","lastName":"Prueba","salary":"30000","source":"' +
    ELM_SOURCE +
    '"}';
  assert.strictEqual(s1Body(m.f.calls[0]), expected);
  assert.strictEqual(JSON.stringify(m.repo.claims[0].s1Request), expected, 'frozen request = sent body');
  assert.strictEqual(m.repo.claims[0].triggerOrigin, 'janus_manual');
  const row = m.repo.rows.get(CZ);
  assert.strictEqual(row.s1_status, S1.REJECTED);
  assert.strictEqual(row.s1_result_message, 'SCORE BAJO');
});

test('orchestrator: CI lock / quota refusal still blocks the flexible manual send before ELM', async () => {
  const sol = solicitud({ relacion_laboral: 'OTR', fecha_nacimiento: null, fecha_nacimiento_status: 'impossible' });
  const h = setup(sol, [], { claimBlocked: true });
  const out = await h.orch.sendElm(CZ, MANUAL);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, CODES.CI_LOCK_BLOCKED);
  assert.strictEqual(h.f.calls.length, 0);
});

test('ELM format rejection (HTTP 400 JSON): exact answer stored and shown, unknown, never retried', async () => {
  const sol = solicitud({ relacion_laboral: 'OTR', fecha_nacimiento: '0001-10-10' });
  const errBody = { error: { code: 'INVALID_FLD_VALUE', message: 'You have entered an Invalid Field Value OTR for the following field: activityType' } };
  const h = setup(sol, [{ status: 400, body: errBody }]);
  const out = await h.orch.sendElm(CZ, MANUAL);
  assert.strictEqual(out.ok, true);
  const row = h.repo.rows.get(CZ);
  assert.strictEqual(row.s1_status, S1.UNKNOWN);
  assert.strictEqual(row.s1_http_status, 400);
  assert.strictEqual(row.s1_error_code, CODES.HTTP_ERROR);
  assert.deepStrictEqual(row.s1_response, errBody, 'full ELM body kept');
  assert.strictEqual(
    row.s1_result_message,
    'INVALID_FLD_VALUE: You have entered an Invalid Field Value OTR for the following field: activityType',
  );
  assert.strictEqual(row.s2_status, S2.NOT_STARTED);

  const again = await h.orch.sendElm(CZ, MANUAL);
  assert.strictEqual(again.code, CODES.PROCESS_EXISTS, 'second press does not resend');
  assert.strictEqual(h.f.calls.length, 1, 'exactly one request to ELM');

  const cell = (await h.listView.cellsForCzIds([CZ], { allowSend: true })).get(CZ);
  assert.strictEqual(cell.state, 'review');
  assert.strictEqual(cell.retry, null, 'no "Reintentar ELM" for an answered request');
  assert.deepStrictEqual(cell.elm_answer, { step: 's1', message: row.s1_result_message });
  const msg = ElmUi.sendResultMessage({ ok: true, outcome: 'review', cell: cell });
  assert.ok(msg.text.includes('Respuesta ELM (S1): INVALID_FLD_VALUE: You have entered an Invalid Field Value OTR'), msg.text);
  assert.ok(ElmUi.elmCellHtml(cell, { answer: 'full' }).includes('INVALID_FLD_VALUE'));
});

test('ELM non-JSON error body and undocumented 200 text are kept verbatim', async () => {
  const sol = solicitud({ fecha_nacimiento: '0001-03-31' });
  const raw = setup(sol, [{ status: 500, body: 'Error: dateOfBirth is required' }]);
  await raw.orch.sendElm(CZ, MANUAL);
  const r = raw.repo.rows.get(CZ);
  assert.strictEqual(r.s1_status, S1.UNKNOWN);
  assert.deepStrictEqual(r.s1_response, { raw_text: 'Error: dateOfBirth is required' });
  assert.strictEqual(r.s1_result_message, 'Error: dateOfBirth is required');

  const undocumented = setup(sol, [ok('Fecha de nacimiento requerida')]);
  await undocumented.orch.sendElm(CZ, MANUAL);
  const u = undocumented.repo.rows.get(CZ);
  assert.strictEqual(u.s1_status, S1.UNKNOWN);
  assert.strictEqual(u.s1_error_code, CODES.RESPONSE_UNDOCUMENTED);
  assert.strictEqual(u.s1_result_message, 'Fecha de nacimiento requerida');
  assert.strictEqual(undocumented.f.calls.length, 1);
});

test('automatic circuit: step result without raw-answer capture is unchanged', () => {
  const callResult = {
    outcome: 'unknown',
    httpStatus: 400,
    resultMessage: null,
    responseBody: { error: { code: 'X', message: 'Y' } },
    errorCode: CODES.HTTP_ERROR,
  };
  const auto = toStepResult(callResult, S1_BY_OUTCOME, S1.UNKNOWN);
  assert.strictEqual(auto.resultMessage, null);
  assert.deepStrictEqual(auto.response, { error: { code: 'X', message: 'Y' } });
  const text = toStepResult({ outcome: 'unknown', httpStatus: 500, responseText: 'boom' }, S1_BY_OUTCOME, S1.UNKNOWN);
  assert.strictEqual(text.response, null);
  assert.strictEqual(text.resultMessage, null);
  const manual = toStepResult(callResult, S1_BY_OUTCOME, S1.UNKNOWN, true);
  assert.strictEqual(manual.resultMessage, 'X: Y');
  assert.strictEqual(manual.status, S1.UNKNOWN, 'status never derived from the text');
});

test('S1 favorable without dateOfBirth continues to S2 with the original contact data', async () => {
  const sol = solicitud({ relacion_laboral: 'OTR', fecha_nacimiento: '0080-01-30' });
  const h = setup(sol, [ok('Listo para recibir datos en servicio 2'), ok('Lead Aprobado correctamente')]);
  const out = await h.orch.sendElm(CZ, MANUAL);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.stage, 's2');
  assert.strictEqual(
    h.f.calls[1].init.body,
    JSON.stringify({ docNumber: '12345678', mobilephone: '099123456', email: 'ana@example.test', source: ELM_SOURCE, TrackingId: String(CZ) }),
  );
  assert.strictEqual(h.repo.rows.get(CZ).s2_status, S2.REFERRED);
});

test('Reintentar ELM: manual request frozen without dateOfBirth is resent as frozen; automatic still blocked', async () => {
  const frozen = { activityType: 'OTR', docNumber: '12345678', firstName: 'Ana', lastName: 'Prueba', salary: '30000', source: ELM_SOURCE };
  const sol = solicitud({ relacion_laboral: 'OTR', fecha_nacimiento: null });
  const base = {
    id: 'proc-x',
    cz_solicitud_id: CZ,
    ci: CI,
    s1_status: S1.TECHNICAL_ERROR,
    s1_error_code: CODES.HTTP_AUTH_REJECTED,
    s1_http_status: 401,
    s1_attempts: 1,
    s1_request: frozen,
    s1_started_at: new Date(NOW_MS - 60000).toISOString(),
    s2_status: S2.NOT_STARTED,
  };
  const h = setup(sol, [ok('SCORE BAJO')]);
  h.repo.rows.set(CZ, Object.assign({ trigger_origin: 'janus_manual' }, base));
  const out = await h.orch.retrySendElm(CZ, MANUAL, { expectedAttempts: 1 });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(h.f.calls.length, 1);
  assert.strictEqual(h.f.calls[0].init.body, JSON.stringify(frozen), 'same frozen request');

  const a = setup(sol, []);
  a.repo.rows.set(CZ, Object.assign({ trigger_origin: 'cz_automatic' }, base));
  const blockedAuto = await a.orch.retrySendElm(CZ, MANUAL, { expectedAttempts: 1 });
  assert.strictEqual(blockedAuto.code, CODES.DATE_OF_BIRTH_INVALID);
  const badFrozen = setup(sol, []);
  badFrozen.repo.rows.set(
    CZ,
    Object.assign({ trigger_origin: 'janus_manual' }, base, { s1_request: Object.assign({ dateOfBirth: '16/12/0174' }, frozen) }),
  );
  const blockedBad = await badFrozen.orch.retrySendElm(CZ, MANUAL, { expectedAttempts: 1 });
  assert.strictEqual(blockedBad.code, CODES.DATE_OF_BIRTH_INVALID, 'a frozen impossible date is never resent');
  assert.strictEqual(a.f.calls.length + badFrozen.f.calls.length, 0);
});

test('list + Rechazados: OTR / invalid DOB are enabled sends with notices; UI announces them', async () => {
  const sol = solicitud({ relacion_laboral: 'OTR', fecha_nacimiento: '0088-04-08' });
  const h = setup(sol);
  const cells = await h.listView.cellsForCzIds([CZ], { allowSend: true });
  const cell = cells.get(CZ);
  assert.strictEqual(cell.kind, 'not_sent');
  assert.strictEqual(cell.action.enabled, true);
  assert.deepStrictEqual(cell.action.notices, [NOTICES.DATE_OF_BIRTH_OMITTED, NOTICES.ACTIVITY_TYPE_RAW]);

  const resolved = resolveRejectedSend({ rejected: [{ cz_solicitud_id: CZ, rejected_at: '2026-10-01T10:00:00Z' }], cells: cells, hold: null });
  assert.strictEqual(resolved.send.target_cz_id, CZ);
  assert.deepStrictEqual(resolved.send.candidates[0].notices, cell.action.notices);
  const html = ElmUi.rejectedSendHtml(CI, resolved.send);
  assert.ok(html.includes('data-action="elm-send"'));
  assert.ok(html.includes('Sin fecha nac. · Actividad OTR'));
  assert.ok(html.includes('data-elm-notice="Se envía sin fecha de nacimiento'));

  const held = resolveRejectedSend({
    rejected: [{ cz_solicitud_id: CZ, rejected_at: '2026-10-01T10:00:00Z' }],
    cells: cells,
    hold: { reason: 'elm_ci_recent_send', related_cz_solicitud_id: 1, until: '2026-11-08T00:00:00Z' },
  });
  assert.strictEqual(held.send.candidates[0].enabled, false, 'CI 30-day hold still applies');
  assert.ok(!ElmUi.rejectedSendHtml(CI, held.send).includes('data-action="elm-send"'));

  const strict = createElmListView({ repository: h.repo, config: CONFIG, now: () => NOW_MS, postReferralRejectionStatuses: [] });
  const plain = (await strict.cellsForCzIds([CZ])).get(CZ);
  assert.strictEqual(plain.kind, 'not_sent', 'shown as sendable by hand, no button without allowSend');
  assert.strictEqual(plain.action.show, false);
});

test('Rechazados send route: CI hold blocks before the orchestrator; a clear CI sends', async () => {
  const sol = solicitud({ relacion_laboral: 'OTR', fecha_nacimiento: '0001-01-24' });
  const h = setup(sol, [ok('No hay oferta')]);
  const deps = {
    orchestrator: h.orch,
    listView: h.listView,
    loadRejectedCzIds: async () => [CZ],
    loadCiResendHold: async () => ({ reason: 'elm_ci_monthly_quota_used', related_cz_solicitud_id: 1, until: null }),
  };
  const heldOut = await sendRejectedToElm(deps, { ci: CI, czSolicitudId: CZ, actorUserId: 'u1' });
  assert.strictEqual(heldOut.status, 409);
  assert.strictEqual(h.f.calls.length, 0);

  deps.loadCiResendHold = async () => null;
  const sent = await sendRejectedToElm(deps, { ci: CI, czSolicitudId: CZ, actorUserId: 'u1' });
  assert.strictEqual(sent.status, 200);
  assert.strictEqual(sent.body.outcome, 's1_rejected');
  assert.strictEqual(h.f.calls.length, 1);
  assert.ok(!('dateOfBirth' in JSON.parse(h.f.calls[0].init.body)));
  assert.ok(ElmUi.sendResultMessage(sent.body).text.includes('No hay oferta'));
});

// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log('ok   ' + t.name);
    } catch (err) {
      console.log('FAIL ' + t.name);
      console.log(err && err.stack ? err.stack : String(err));
    }
  }
  if (passed !== tests.length || externalNet.length) process.exitCode = 1;
  console.log(
    '\nunit-elm-manual-flex: ' + passed + '/' + tests.length + ' passed; external network attempts: ' + externalNet.length,
  );
})();
