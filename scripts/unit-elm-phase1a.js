'use strict';

/**
 * Offline checks for ELM Fase 1A (JANUS). No Supabase, no network, no applied migration.
 * Run: node scripts/unit-elm-phase1a.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const express = require('express');

const TEST_SESSION_SECRET = 'unit-test-session-secret-0123456789';
const TEST_CRON_SECRET = 'unit-test-cron-secret-0123456789';

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
    sessionSecret: TEST_SESSION_SECRET,
    cronSecret: TEST_CRON_SECRET,
  },
};

/** Supabase stub: only dashboard_users / dashboard_user_permissions for auth middleware. */
const USERS = new Map();
const SECTION_PERMS = new Set();
const supabaseCalls = [];
function chain(table) {
  const filters = {};
  const q = {
    select() {
      return q;
    },
    eq(col, val) {
      filters[col] = val;
      return q;
    },
    async maybeSingle() {
      supabaseCalls.push(table);
      if (table === 'dashboard_users') {
        return { data: USERS.get(String(filters.id)) || null, error: null };
      }
      if (table === 'dashboard_user_permissions') {
        const key = String(filters.user_id) + ':' + String(filters.section_key);
        return {
          data: SECTION_PERMS.has(key) ? { section_key: filters.section_key } : null,
          error: null,
        };
      }
      throw new Error('unexpected supabase table in test: ' + table);
    },
  };
  return q;
}
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from(table) {
      return chain(table);
    },
    rpc(name) {
      supabaseCalls.push('rpc:' + name);
      throw new Error('unexpected rpc in test: ' + name);
    },
  },
};

// ---------------------------------------------------------------------------
// Network guard: any non-loopback connection or fetch is counted and refused.
// ---------------------------------------------------------------------------
const externalNet = [];
function isLoopback(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}
function hostOf(args) {
  const a = args[0];
  if (typeof a === 'string' || a instanceof URL) {
    try {
      return new URL(String(a)).hostname;
    } catch {
      return String(a);
    }
  }
  if (a && typeof a === 'object') return a.hostname || a.host || null;
  if (typeof a === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
  return null;
}
function guard(mod, name) {
  const orig = mod[name];
  mod[name] = function guarded() {
    const host = hostOf(arguments);
    if (!isLoopback(host)) {
      externalNet.push(name + ':' + host);
      throw new Error('external network blocked in test: ' + name);
    }
    return orig.apply(this, arguments);
  };
}
guard(http, 'request');
guard(http, 'get');
guard(https, 'request');
guard(https, 'get');
guard(net, 'connect');
guard(net, 'createConnection');
guard(tls, 'connect');
globalThis.fetch = async function blockedFetch(url) {
  externalNet.push('fetch:' + String(url));
  throw new Error('fetch blocked in test');
};

// ---------------------------------------------------------------------------
// Log capture (secrets must never reach stdout/stderr).
// ---------------------------------------------------------------------------
const captured = [];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
function startCapture() {
  process.stdout.write = function (chunk) {
    captured.push(String(chunk));
    return true;
  };
  process.stderr.write = function (chunk) {
    captured.push(String(chunk));
    return true;
  };
}
function stopCapture() {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
}

const { S1, S2, CODES, OUTCOME } = require('../src/services/elm/constants');
const { readElmConfig, DEFAULT_IN_FLIGHT_LEASE_SECONDS } = require('../src/services/elm/config');
const {
  SERVICE1_KEYS,
  SERVICE2_KEYS,
  buildService1Payload,
  buildService2Payload,
  formatDateOfBirth,
  formatMobilePhone,
} = require('../src/services/elm/payload');
const {
  normalizeCommercialOrigin,
  evaluateElmEligibility,
} = require('../src/services/elm/eligibility');
const {
  createElmClient,
  classifyService1Result,
  classifyService1Response,
  classifyService2Result,
} = require('../src/services/elm/client');
const { ELM_SOURCE } = require('../src/services/elm/constants');
const { redactSecrets, redactSecretText } = require('../src/services/elm/redact');
const { createElmOrchestrator } = require('../src/services/elm/orchestrator');
const { createPreaprobadosElmRouter } = require('../src/routes/preaprobadosElm');
const { requireAuth, createSessionToken, COOKIE_NAME } = require('../src/middleware/auth');
const {
  requireDashboardPermission,
} = require('../src/middleware/requireDashboardPermission');

const ROOT = path.join(__dirname, '..');
function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Test-only mapping values (clearly fake; production defaults stay empty).
const TEST_CONFIG = readElmConfig({
  ELM_ACTIVITY_TYPE_MAP_JSON: '{"EPR":"TEST_ACTIVITY_EPR"}',
  ELM_DATE_OF_BIRTH_FORMAT: 'D/M/YYYY',
  ELM_MOBILE_PHONE_FORMAT: 'uy_local_0',
});

function solicitudFixture(overrides) {
  return Object.assign(
    {
      cz_id: 1001,
      ci: 12345678,
      nombre: 'Ana',
      apellido: 'Prueba',
      email: 'ana@example.test',
      celular: '59899123456',
      salario: 30000,
      fecha_nacimiento: '1991-07-10',
      relacion_laboral: 'EPR',
      lrw_id: 'LRW-1',
      solicitudes_estados_id: 8,
    },
    overrides || {},
  );
}

/**
 * In-memory repository mirroring the DB RPC semantics (atomic claim via synchronous
 * check-and-set after an await, conditional updates, lease expiry → unknown).
 */
function createFakeRepo(opts) {
  const o = opts || {};
  const solicitudes = o.solicitudes || new Map();
  const granted = o.granted || new Map();
  const bases = o.bases || new Map();
  const now = o.now || Date.now;
  const rows = new Map();
  const calls = [];
  let seq = 0;
  const iso = () => new Date(now()).toISOString();
  const tick = () => new Promise((r) => setImmediate(r));
  function byId(id) {
    for (const r of rows.values()) if (r.id === id) return r;
    return null;
  }
  return {
    rows,
    calls,
    failFinishS1: false,
    async loadSolicitudContext(czId) {
      calls.push('loadSolicitudContext');
      const s = solicitudes.get(czId) || null;
      return { solicitud: s, grantedRow: s ? granted.get(czId) || null : null };
    },
    async resolveBaseLabel(czId) {
      calls.push('resolveBaseLabel');
      return bases.get(czId) || '';
    },
    async getProcessByCzId(czId) {
      calls.push('getProcessByCzId');
      const r = rows.get(czId);
      return r ? Object.assign({}, r) : null;
    },
    async claimProcess(a) {
      calls.push('claimProcess');
      await tick();
      const existing = rows.get(a.czSolicitudId);
      if (existing) return { claimed: false, process: Object.assign({}, existing) };
      seq += 1;
      const row = {
        id: 'proc-' + seq,
        cz_solicitud_id: a.czSolicitudId,
        ci: a.ci,
        source_brand: a.sourceBrand,
        commercial_origin: a.commercialOrigin || null,
        trigger_origin: a.triggerOrigin,
        triggered_by_user_id: a.triggeredByUserId,
        cz_estado_id_at_start: a.czEstadoIdAtStart,
        lrw_id_at_start: a.lrwIdAtStart,
        s1_status: S1.IN_FLIGHT,
        s1_request: a.s1Request,
        s1_started_at: iso(),
        s1_lease_expires_at: new Date(now() + a.leaseSeconds * 1000).toISOString(),
        s2_status: S2.NOT_STARTED,
        referred_at: null,
        created_at: iso(),
      };
      rows.set(a.czSolicitudId, row);
      return { claimed: true, process: Object.assign({}, row) };
    },
    async finishS1(id, r) {
      calls.push('finishS1');
      if (this.failFinishS1) throw new Error('db down');
      const row = byId(id);
      if (!row || row.s1_status !== S1.IN_FLIGHT) return null;
      Object.assign(row, {
        s1_status: r.status,
        s1_response: r.response,
        s1_http_status: r.httpStatus,
        s1_result_message: r.resultMessage,
        s1_latency_ms: r.latencyMs,
        s1_error_code: r.errorCode,
        s1_error_detail: r.errorDetail,
        s1_completed_at: iso(),
        s1_lease_expires_at: null,
      });
      return Object.assign({}, row);
    },
    async beginS2(czId, req, leaseSeconds) {
      calls.push('beginS2');
      const row = rows.get(czId);
      if (!row || row.s1_status !== S1.ELIGIBLE || row.s2_status !== S2.NOT_STARTED) return null;
      Object.assign(row, {
        s2_status: S2.IN_FLIGHT,
        s2_request: req,
        s2_started_at: iso(),
        s2_lease_expires_at: new Date(now() + leaseSeconds * 1000).toISOString(),
      });
      return Object.assign({}, row);
    },
    async finishS2(id, r) {
      calls.push('finishS2');
      const row = byId(id);
      if (!row || row.s2_status !== S2.IN_FLIGHT) return null;
      Object.assign(row, {
        s2_status: r.status,
        s2_response: r.response,
        s2_http_status: r.httpStatus,
        s2_result_message: r.resultMessage,
        s2_latency_ms: r.latencyMs,
        s2_error_code: r.errorCode,
        s2_error_detail: r.errorDetail,
        s2_completed_at: iso(),
        s2_lease_expires_at: null,
        referred_at: r.status === S2.REFERRED ? iso() : null,
      });
      return Object.assign({}, row);
    },
    async expireStaleInFlight(czId) {
      calls.push('expireStaleInFlight');
      const row = rows.get(czId);
      if (!row) return null;
      const t = now();
      if (row.s1_status === S1.IN_FLIGHT && Date.parse(row.s1_lease_expires_at) < t) {
        Object.assign(row, {
          s1_status: S1.UNKNOWN,
          s1_completed_at: iso(),
          s1_error_code: CODES.LEASE_EXPIRED,
          s1_lease_expires_at: null,
        });
      }
      if (row.s2_status === S2.IN_FLIGHT && Date.parse(row.s2_lease_expires_at) < t) {
        Object.assign(row, {
          s2_status: S2.UNKNOWN,
          s2_completed_at: iso(),
          s2_error_code: CODES.LEASE_EXPIRED,
          s2_lease_expires_at: null,
        });
      }
      return Object.assign({}, row);
    },
  };
}

/** Enabled test double (in-memory only; production createElmClient() is disabled by default). */
function createScriptedClient(s1Result, s2Result) {
  const c = {
    enabled: true,
    disabledReason: null,
    s1Calls: 0,
    s2Calls: 0,
    async service1() {
      c.s1Calls += 1;
      if (typeof s1Result === 'function') return s1Result();
      return s1Result;
    },
    async service2() {
      c.s2Calls += 1;
      if (typeof s2Result === 'function') return s2Result();
      return s2Result;
    },
  };
  return c;
}

const S1_OK = {
  sent: true,
  outcome: OUTCOME.POSITIVE,
  httpStatus: 200,
  resultMessage: 'Listo para recibir datos en servicio 2',
  responseBody: { result: 'Listo para recibir datos en servicio 2' },
  latencyMs: 120,
  errorCode: null,
  errorDetail: null,
};
const S1_REJECTED = Object.assign({}, S1_OK, {
  outcome: OUTCOME.NEGATIVE,
  resultMessage: 'SCORE BAJO',
  responseBody: { result: 'SCORE BAJO' },
});
const S2_OK = Object.assign({}, S1_OK, {
  resultMessage: 'Lead Aprobado correctamente',
  responseBody: { result: 'Lead Aprobado correctamente' },
});

const MANUAL = { triggerOrigin: 'janus_manual', triggeredByUserId: 'user-admin-1' };

function setup(extra) {
  const e = extra || {};
  let clock = Date.parse('2026-10-07T12:00:00.000Z');
  const now = () => clock;
  const solicitudes = new Map([[1001, solicitudFixture()]]);
  const bases = new Map([[1001, 'BASE_TEST']]);
  const granted = new Map();
  if (e.mutate) e.mutate({ solicitudes, bases, granted });
  const repo = createFakeRepo({ solicitudes, bases, granted, now });
  const client = e.client || createScriptedClient(S1_OK, S2_OK);
  const orch = createElmOrchestrator({
    repository: repo,
    client: client,
    config: e.config || TEST_CONFIG,
    now: now,
  });
  return {
    repo,
    client,
    orch,
    advance(ms) {
      clock += ms;
    },
  };
}

async function main() {
  startCapture();
  try {
    await runAll();
  } finally {
    stopCapture();
  }
}

const results = [];
async function test(name, fn) {
  await fn();
  results.push(name);
}

async function runAll() {
  // --- config / payload / classification ---------------------------------
  await test('config: business mappings empty by default; lease default + clamp', async () => {
    const c = readElmConfig({});
    assert.deepStrictEqual(c.activityTypeMap, {});
    assert.strictEqual(c.sourceBrandByBase, undefined);
    assert.strictEqual(c.s1InternalIdField, undefined);
    assert.deepStrictEqual(c.retrySafeErrorCodes, []);
    assert.strictEqual(c.dateOfBirthFormat, null);
    assert.strictEqual(c.mobilePhoneFormat, null);
    assert.strictEqual(c.inFlightLeaseSeconds, DEFAULT_IN_FLIGHT_LEASE_SECONDS);
    assert.strictEqual(readElmConfig({ ELM_IN_FLIGHT_LEASE_SECONDS: '5' }).inFlightLeaseSeconds, 90);
    assert.strictEqual(
      readElmConfig({ ELM_IN_FLIGHT_LEASE_SECONDS: '999999' }).inFlightLeaseSeconds,
      86400,
    );
    for (const k of Object.keys(c)) {
      assert.ok(!/secret|token|password|credential|consumer|url/i.test(k), 'no credential config: ' + k);
    }
  });

  await test('payload: S1/S2 exact key sets; source copanel; TrackingId only in S2; formats fail closed', async () => {
    const s1 = buildService1Payload({ czId: 1001, solicitud: solicitudFixture(), config: TEST_CONFIG });
    assert.ok(s1.ok);
    assert.deepStrictEqual(Object.keys(s1.payload).sort(), SERVICE1_KEYS.slice().sort());
    assert.ok(!('TrackingId' in s1.payload));
    assert.ok(!JSON.stringify(s1.payload).includes('1001'), 'S1 carries no cz id');
    assert.strictEqual(s1.payload.source, 'copanel');
    assert.strictEqual(ELM_SOURCE, 'copanel');
    assert.strictEqual(s1.payload.dateOfBirth, '10/7/1991');
    assert.strictEqual(s1.payload.docNumber, '12345678');
    assert.strictEqual(s1.payload.salary, '30000');
    const s2 = buildService2Payload({ ci: 12345678, czId: 1001, solicitud: solicitudFixture(), config: TEST_CONFIG });
    assert.ok(s2.ok);
    assert.deepStrictEqual(Object.keys(s2.payload).sort(), SERVICE2_KEYS.slice().sort());
    assert.strictEqual(s2.payload.source, 'copanel');
    assert.strictEqual(s2.payload.TrackingId, '1001');
    assert.strictEqual(s2.payload.mobilephone, '099123456');
    assert.strictEqual(
      buildService2Payload({ ci: 12345678, solicitud: solicitudFixture(), config: TEST_CONFIG }).code,
      CODES.INVALID_CZ_ID,
      'S2 never built without TrackingId',
    );
    assert.strictEqual(formatDateOfBirth('1991-07-10', null).code, CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED);
    assert.strictEqual(formatMobilePhone('59899123456', null).code, CODES.MOBILEPHONE_FORMAT_UNCONFIRMED);
    assert.strictEqual(formatMobilePhone('59821234567', 'uy_598').code, CODES.MOBILEPHONE_INVALID);
  });

  await test('classification: exact documented texts only; anything else unknown', async () => {
    assert.strictEqual(classifyService1Result('Listo para recibir datos en servicio 2'), OUTCOME.POSITIVE);
    assert.strictEqual(classifyService1Result('Repetido. rechazado'), OUTCOME.NEGATIVE);
    assert.strictEqual(classifyService1Result('BCU'), OUTCOME.NEGATIVE);
    // "BCU error" is an explicit non-credit answer: technical_error, never a rejection.
    assert.strictEqual(classifyService1Result('BCU error'), OUTCOME.TECHNICAL_ERROR);
    assert.deepStrictEqual(classifyService1Response('BCU error'), {
      outcome: OUTCOME.TECHNICAL_ERROR,
      errorCode: CODES.PROVIDER_BCU_ERROR,
    });
    assert.strictEqual(classifyService1Result('OK'), OUTCOME.UNKNOWN);
    assert.strictEqual(classifyService2Result('Lead Aprobado correctamente'), OUTCOME.POSITIVE);
    assert.strictEqual(classifyService2Result('Aprobado sin canal'), OUTCOME.NEGATIVE);
    assert.strictEqual(classifyService2Result(undefined), OUTCOME.UNKNOWN);
  });

  // --- eligibility --------------------------------------------------------
  await test('missing activityType mapping → fail closed', async () => {
    const r = evaluateElmEligibility({
      czId: 1001,
      solicitud: solicitudFixture({ relacion_laboral: 'JUB' }),
      grantedRow: null,
      config: TEST_CONFIG,
    });
    assert.strictEqual(r.eligible, false);
    assert.ok(r.blockers.some((b) => b.code === CODES.ACTIVITY_TYPE_MAPPING_MISSING));
    const p = buildService1Payload({
      czId: 1001,
      solicitud: solicitudFixture(),
      config: readElmConfig({}),
    });
    assert.strictEqual(p.code, CODES.ACTIVITY_TYPE_MAPPING_MISSING);
  });

  await test('organic lead (no base) is not blocked; commercial origin tracked apart from source', async () => {
    assert.strictEqual(normalizeCommercialOrigin(''), null);
    assert.strictEqual(normalizeCommercialOrigin('  BASE_TEST '), 'BASE_TEST');
    const organic = setup({ mutate: (m) => m.bases.delete(1001) });
    const out = await organic.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(organic.client.s1Calls, 1);
    const row = organic.repo.rows.get(1001);
    assert.strictEqual(row.source_brand, 'copanel');
    assert.strictEqual(row.commercial_origin, null);
    assert.strictEqual(row.s1_request.source, 'copanel');

    const sms = setup();
    assert.strictEqual((await sms.orch.evaluateElm(1001, MANUAL)).ok, true);
    const smsRow = sms.repo.rows.get(1001);
    assert.strictEqual(smsRow.source_brand, 'copanel');
    assert.strictEqual(smsRow.commercial_origin, 'BASE_TEST');
    assert.ok(!JSON.stringify(smsRow.s1_request).includes('BASE_TEST'), 'commercial origin never sent');

    const failing = setup();
    failing.repo.resolveBaseLabel = async () => {
      throw new Error('provenance down');
    };
    assert.strictEqual((await failing.orch.evaluateElm(1001, MANUAL)).ok, true, 'tracking failure never blocks');
    assert.strictEqual(failing.repo.rows.get(1001).commercial_origin, null);
  });

  await test('known GRANTED (granted row or estado 11) → not eligible', async () => {
    const a = setup({ mutate: (m) => m.granted.set(1001, { cz_id: 1001, monto_otorgado: 5000 }) });
    const r1 = await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(r1.code, CODES.CDV_GRANTED);
    assert.strictEqual(a.client.s1Calls, 0);
    const b = setup({ mutate: (m) => m.solicitudes.set(1001, solicitudFixture({ solicitudes_estados_id: 11 })) });
    assert.strictEqual((await b.orch.evaluateElm(1001, MANUAL)).code, CODES.CDV_GRANTED);
    assert.strictEqual(b.repo.rows.size, 0);
  });

  await test('identity = cz_id; same CI with another GRANTED solicitud does not block', async () => {
    const { orch, repo, client } = setup({
      mutate: (m) => {
        m.solicitudes.set(2002, solicitudFixture({ cz_id: 2002, solicitudes_estados_id: 11 }));
        m.granted.set(2002, { cz_id: 2002 });
        m.bases.set(2002, 'BASE_TEST');
        m.solicitudes.set(3003, solicitudFixture({ cz_id: 3003 }));
        m.bases.set(3003, 'BASE_TEST');
      },
    });
    const r1 = await orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.process.cz_solicitud_id, 1001);
    assert.strictEqual((await orch.evaluateElm(2002, MANUAL)).code, CODES.CDV_GRANTED);
    const r3 = await orch.evaluateElm(3003, MANUAL);
    assert.strictEqual(r3.ok, true, 'two solicitudes with the same CI are allowed');
    assert.strictEqual(repo.rows.size, 2);
    assert.deepStrictEqual([...repo.rows.keys()].sort(), [1001, 3003]);
    assert.strictEqual(client.s1Calls, 2);
  });

  await test('solicitud not found / missing fields / invalid id / context', async () => {
    const { orch } = setup({
      mutate: (m) => m.solicitudes.set(1001, solicitudFixture({ email: '', celular: null })),
    });
    assert.strictEqual((await orch.evaluateElm(999, MANUAL)).code, CODES.SOLICITUD_NOT_FOUND);
    const miss = await orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(miss.code, CODES.MISSING_REQUIRED_FIELDS);
    assert.deepStrictEqual(miss.blockers[0].fields, ['celular', 'email']);
    assert.strictEqual((await orch.evaluateElm('abc', MANUAL)).code, CODES.INVALID_CZ_ID);
    assert.strictEqual((await orch.evaluateElm(1001, { triggerOrigin: 'janus_manual' })).code, CODES.MANUAL_REQUIRES_USER);
    assert.strictEqual((await orch.evaluateElm(1001, { triggerOrigin: 'janus_batch' })).code, CODES.TRIGGER_ORIGIN_NOT_ENABLED);
    assert.strictEqual((await orch.evaluateElm(1001, { triggerOrigin: 'cz_automatic' })).code, CODES.TRIGGER_ORIGIN_NOT_ENABLED);
    assert.strictEqual((await orch.evaluateElm(1001, { triggerOrigin: 'x' })).code, CODES.INVALID_CONTEXT);
  });

  await test('date of birth: impossible or absent → elm_date_of_birth_invalid, never built nor sent', async () => {
    const NOW = new Date('2026-10-07T12:00:00.000Z');
    const elig = (dob, extra) =>
      evaluateElmEligibility({
        czId: 1001,
        solicitud: solicitudFixture(Object.assign({ fecha_nacimiento: dob }, extra || {})),
        grantedRow: null,
        config: TEST_CONFIG,
        now: NOW,
      });
    for (const dob of ['0174-12-16', '0001-03-31', '0080-01-30', '0088-04-08', '1899-12-31',
      '2026-02-30', '2008-10-08', '1925-10-06', '', null]) {
      const r = elig(dob);
      assert.strictEqual(r.eligible, false, 'blocked ' + dob);
      assert.deepStrictEqual(r.blockers, [{ code: CODES.DATE_OF_BIRTH_INVALID }], 'only DOB blocker ' + dob);
    }
    for (const dob of ['2008-10-07', '1926-10-07', '1991-07-10']) {
      assert.strictEqual(elig(dob).eligible, true, 'eligible ' + dob);
    }
    assert.deepStrictEqual(
      elig('0174-12-16', { relacion_laboral: 'JUB' }).blockers.map((b) => b.code),
      [CODES.DATE_OF_BIRTH_INVALID, CODES.ACTIVITY_TYPE_MAPPING_MISSING],
      'secondary blockers kept',
    );
    const both = elig(null, { email: '' });
    assert.deepStrictEqual(both.blockers, [
      { code: CODES.MISSING_REQUIRED_FIELDS, fields: ['email'] },
      { code: CODES.DATE_OF_BIRTH_INVALID },
    ]);

    assert.strictEqual(formatDateOfBirth('0174-12-16', 'D/M/YYYY', NOW).code, CODES.DATE_OF_BIRTH_INVALID);
    assert.strictEqual(formatDateOfBirth('0174-12-16', null, NOW).code, CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED);
    assert.strictEqual(formatDateOfBirth('2008-10-07', 'D/M/YYYY', NOW).value, '7/10/2008');
    const built = buildService1Payload({
      czId: 1001,
      solicitud: solicitudFixture({ fecha_nacimiento: '0174-12-16' }),
      config: TEST_CONFIG,
      now: NOW,
    });
    assert.deepStrictEqual(built, { ok: false, code: CODES.DATE_OF_BIRTH_INVALID });

    const { orch, repo, client } = setup({
      mutate: (m) => m.solicitudes.set(1001, solicitudFixture({ fecha_nacimiento: '0174-12-16' })),
    });
    const out = await orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, CODES.DATE_OF_BIRTH_INVALID);
    assert.strictEqual(client.s1Calls, 0, 'ELM never called');
    assert.strictEqual(repo.rows.size, 0, 'no process claimed');
  });

  // --- send disabled ------------------------------------------------------
  await test('send disabled → elm_send_disabled, ZERO HTTP, zero DB access, nothing persisted', async () => {
    const before = externalNet.length;
    const repo = createFakeRepo({
      solicitudes: new Map([[1001, solicitudFixture()]]),
      bases: new Map([[1001, 'BASE_TEST']]),
    });
    const orch = createElmOrchestrator({ repository: repo, client: createElmClient(), config: TEST_CONFIG });
    const e = await orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(e.code, CODES.SEND_DISABLED);
    assert.strictEqual(e.reason, CODES.CLIENT_DISABLED);
    const r = await orch.referElm(1001, MANUAL);
    assert.strictEqual(r.code, CODES.SEND_DISABLED);
    assert.deepStrictEqual(repo.calls, []);
    assert.strictEqual(repo.rows.size, 0);
    const disabled = createElmClient();
    assert.strictEqual(disabled.enabled, false);
    const s1 = await disabled.service1({ docNumber: '1' });
    assert.strictEqual(s1.sent, false);
    assert.strictEqual(s1.errorCode, CODES.SEND_DISABLED);
    assert.strictEqual(externalNet.length, before);
    const clientSrc = readSrc('src/services/elm/client.js');
    assert.ok(!/require\(['"](https?|net|tls|axios|node-fetch|undici)['"]\)/.test(clientSrc));
    assert.ok(!/https?:\/\//.test(clientSrc), 'no URLs in client');
  });

  // --- atomic claim / idempotency ----------------------------------------
  await test('atomic claim: concurrent evaluations on the same cz_id → exactly one S1 call', async () => {
    const { orch, client, repo } = setup();
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => orch.evaluateElm(1001, MANUAL)));
    assert.strictEqual(client.s1Calls, 1);
    assert.strictEqual(outs.filter((o) => o.ok).length, 1);
    assert.strictEqual(outs.filter((o) => o.code === CODES.PROCESS_EXISTS).length, 4);
    assert.strictEqual(repo.rows.size, 1);
    const again = await orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(again.code, CODES.PROCESS_EXISTS);
    assert.strictEqual(client.s1Calls, 1, 'no manual retry');
  });

  await test('no SELECT→INSERT: evaluate never reads the process before the claim', async () => {
    const { orch, repo } = setup();
    await orch.evaluateElm(1001, MANUAL);
    const claimIdx = repo.calls.indexOf('claimProcess');
    assert.ok(claimIdx >= 0);
    assert.ok(!repo.calls.slice(0, claimIdx).includes('getProcessByCzId'));
    const repoSrc = readSrc('src/services/elm/repository.js');
    assert.ok(!/\.(insert|upsert|update|delete)\(/.test(repoSrc), 'repository writes only via RPC');
    const orchSrc = readSrc('src/services/elm/orchestrator.js');
    const evalBody = orchSrc.slice(orchSrc.indexOf('async function evaluateElm'), orchSrc.indexOf('async function referElm'));
    assert.ok(!evalBody.includes('getProcessByCzId'));
    const sql = readSrc('migrations/20261007_elm_lead_processes.sql');
    const claimFn = sql.slice(sql.indexOf('FUNCTION public.elm_claim_process('), sql.indexOf('FUNCTION public.elm_finish_s1('));
    assert.ok(claimFn.includes('ON CONFLICT (cz_solicitud_id) DO NOTHING'));
    const insertAt = claimFn.indexOf('INSERT INTO public.elm_lead_processes');
    const selectAt = claimFn.indexOf('FROM public.elm_lead_processes');
    assert.ok(insertAt > 0 && selectAt > insertAt, 'claim: INSERT first, read only on conflict');
    assert.ok(!/IF\s+(NOT\s+)?EXISTS/i.test(claimFn));
    assert.ok(/cz_solicitud_id\s+bigint\s+NOT NULL/i.test(sql));
    assert.ok(/CONSTRAINT elm_lead_processes_cz_solicitud_id_key UNIQUE \(cz_solicitud_id\)/.test(sql));
    assert.ok(!/UNIQUE\s*\(\s*ci\s*\)/i.test(sql), 'CI is not unique');
  });

  // --- S1/S2 state machine ------------------------------------------------
  await test('S2 impossible without S1 eligible', async () => {
    const a = setup({ client: createScriptedClient(S1_REJECTED, S2_OK) });
    assert.strictEqual((await a.orch.referElm(1001, MANUAL)).code, CODES.PROCESS_NOT_FOUND);
    const e = await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(e.process.s1.status, S1.REJECTED);
    assert.strictEqual((await a.orch.referElm(1001, MANUAL)).code, CODES.S1_NOT_ELIGIBLE);
    assert.strictEqual(a.client.s2Calls, 0);
    assert.strictEqual(await a.repo.beginS2(1001, { docNumber: '1' }, 300), null);

    const u = setup({ client: createScriptedClient(Object.assign({}, S1_OK, { outcome: OUTCOME.UNKNOWN, resultMessage: 'raro' }), S2_OK) });
    const eu = await u.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(eu.process.s1.status, S1.UNKNOWN);
    assert.strictEqual((await u.orch.referElm(1001, MANUAL)).code, CODES.S1_NOT_ELIGIBLE);
    assert.strictEqual(u.client.s2Calls, 0);
  });

  await test('referred ≠ granted: S2 positive only sets referred', async () => {
    const { orch, client, repo } = setup();
    await orch.evaluateElm(1001, MANUAL);
    const r = await orch.referElm(1001, MANUAL);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.process.s2.status, S2.REFERRED);
    assert.ok(r.process.referred_at);
    assert.strictEqual(r.process.disbursed_at, null);
    assert.ok(!Object.values(S2).includes('granted'));
    assert.ok(!Object.values(S1).includes('granted'));
    assert.strictEqual(client.s2Calls, 1);
    assert.strictEqual((await orch.referElm(1001, MANUAL)).code, CODES.S2_ALREADY_STARTED);
    assert.strictEqual(client.s2Calls, 1);
    const status = await orch.getElmStatus(1001);
    assert.ok(!status.data.eligibility.blockers.some((b) => b.code === CODES.CDV_GRANTED));
    const sql = readSrc('migrations/20261007_elm_lead_processes.sql');
    const s2Check = /s2_status IN \(([^)]*)\)/.exec(sql);
    assert.ok(s2Check && !s2Check[1].includes('granted'));
    assert.strictEqual(repo.rows.get(1001).referred_at != null, true);
  });

  await test('S2 re-checks GRANTED before sending', async () => {
    const { orch, client, repo } = setup();
    await orch.evaluateElm(1001, MANUAL);
    repo.calls.length = 0;
    const s = solicitudFixture({ solicitudes_estados_id: 11 });
    const fake = createFakeRepo({ solicitudes: new Map([[1001, s]]), bases: new Map([[1001, 'BASE_TEST']]) });
    fake.rows.set(1001, repo.rows.get(1001));
    const orch2 = createElmOrchestrator({ repository: fake, client, config: TEST_CONFIG });
    assert.strictEqual((await orch2.referElm(1001, MANUAL)).code, CODES.CDV_GRANTED);
    assert.strictEqual(client.s2Calls, 0);
  });

  // --- in_flight lease ----------------------------------------------------
  await test('expired in_flight → unknown, and it does NOT retry', async () => {
    const a = setup();
    a.repo.failFinishS1 = true;
    const first = await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(first.code, CODES.PERSIST_FAILED);
    assert.strictEqual(a.repo.rows.get(1001).s1_status, S1.IN_FLIGHT);
    assert.strictEqual(a.client.s1Calls, 1);
    a.repo.failFinishS1 = false;

    const early = await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(early.code, CODES.PROCESS_EXISTS);
    assert.strictEqual(a.repo.rows.get(1001).s1_status, S1.IN_FLIGHT, 'lease not expired yet');

    a.advance((TEST_CONFIG.inFlightLeaseSeconds + 1) * 1000);
    const st = await a.orch.getElmStatus(1001);
    assert.strictEqual(st.data.process.s1.status, S1.IN_FLIGHT, 'GET does not write');
    assert.strictEqual(st.data.process.s1.effective_status, S1.UNKNOWN);

    const after = await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(after.code, CODES.PROCESS_EXISTS);
    assert.strictEqual(after.process.s1.status, S1.UNKNOWN);
    assert.strictEqual(a.repo.rows.get(1001).s1_status, S1.UNKNOWN);
    assert.strictEqual(a.repo.rows.get(1001).s1_error_code, CODES.LEASE_EXPIRED);
    assert.strictEqual(a.client.s1Calls, 1, 'no second S1 call');
    await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(a.client.s1Calls, 1);
    assert.strictEqual((await a.orch.referElm(1001, MANUAL)).code, CODES.S1_NOT_ELIGIBLE);
    assert.strictEqual(a.client.s2Calls, 0);
  });

  await test('client throw → unknown (never retried)', async () => {
    const a = setup({
      client: createScriptedClient(() => {
        throw new Error('socket hang up');
      }, S2_OK),
    });
    const out = await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.process.s1.status, S1.UNKNOWN);
    assert.strictEqual(out.process.s1.error_code, CODES.CLIENT_THREW);
    await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(a.client.s1Calls, 1);
  });

  await test('late S1 result after lease expiry → elm_late_result_discarded, not finished', async () => {
    let a = null;
    a = setup({
      client: createScriptedClient(async () => {
        a.advance((TEST_CONFIG.inFlightLeaseSeconds + 1) * 1000);
        await a.repo.expireStaleInFlight(1001);
        return Object.assign({}, S1_OK, { responseBody: { result: 'Listo para recibir datos en servicio 2', oauth_token: 'LATESECRET111' } });
      }, S2_OK),
    });
    const logStart = captured.length;
    const out = await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, CODES.LATE_RESULT_DISCARDED);
    assert.strictEqual(out.step, 's1');
    const row = a.repo.rows.get(1001);
    assert.strictEqual(row.s1_status, S1.UNKNOWN);
    assert.strictEqual(row.s1_error_code, CODES.LEASE_EXPIRED);
    assert.strictEqual(row.s1_response, undefined, 'late result not overwritten into the row');
    const logs = captured.slice(logStart).join('');
    assert.ok(logs.includes('elm late result discarded'));
    assert.ok(logs.includes('"late_status":"eligible"'));
    assert.ok(!logs.includes('elm s1 finished'));
    assert.ok(!logs.includes('LATESECRET111'));
    assert.ok(!logs.includes('Listo para recibir'), 'no provider text in logs');
    assert.ok(!logs.includes('12345678'));
    await a.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(a.client.s1Calls, 1, 'no retry after late result');
    assert.strictEqual((await a.orch.referElm(1001, MANUAL)).code, CODES.S1_NOT_ELIGIBLE);
    assert.strictEqual(a.client.s2Calls, 0);
  });

  await test('late S2 result after lease expiry → elm_late_result_discarded, never referred', async () => {
    let a = null;
    a = setup({
      client: createScriptedClient(S1_OK, async () => {
        a.advance((TEST_CONFIG.inFlightLeaseSeconds + 1) * 1000);
        await a.repo.expireStaleInFlight(1001);
        return S2_OK;
      }),
    });
    assert.strictEqual((await a.orch.evaluateElm(1001, MANUAL)).ok, true);
    const logStart = captured.length;
    const out = await a.orch.referElm(1001, MANUAL);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, CODES.LATE_RESULT_DISCARDED);
    assert.strictEqual(out.step, 's2');
    const row = a.repo.rows.get(1001);
    assert.strictEqual(row.s2_status, S2.UNKNOWN);
    assert.strictEqual(row.referred_at, null);
    const logs = captured.slice(logStart).join('');
    assert.ok(logs.includes('"late_status":"referred"'));
    assert.ok(!logs.includes('elm s2 finished'));
    assert.strictEqual((await a.orch.referElm(1001, MANUAL)).code, CODES.S2_ALREADY_STARTED);
    assert.strictEqual(a.client.s2Calls, 1);
    const { statusFor } = require('../src/routes/preaprobadosElm');
    assert.strictEqual(statusFor(out), 409);
  });

  // --- secrets ------------------------------------------------------------
  await test('secrets never reach logs or persistence', async () => {
    const SECRETS = ['SIGSECRET999', 'TOKSECRET888', 'BEARERSECRET777', 'CKSECRET666', 'PWSECRET555'];
    const a = setup({
      client: createScriptedClient(
        {
          sent: true,
          outcome: OUTCOME.POSITIVE,
          httpStatus: 200,
          resultMessage: 'Listo para recibir datos en servicio 2',
          responseBody: {
            result: 'Listo para recibir datos en servicio 2',
            oauth_token: 'TOKSECRET888',
            nested: { Authorization: 'OAuth oauth_signature="SIGSECRET999"' },
            note: 'Bearer BEARERSECRET777',
          },
          latencyMs: 10,
          errorCode: null,
          errorDetail: 'Authorization: OAuth oauth_consumer_key="CKSECRET666", password=PWSECRET555',
        },
        () => {
          throw new Error('failed with oauth_signature="SIGSECRET999" token=TOKSECRET888');
        },
      ),
    });
    const logStart = captured.length;
    await a.orch.evaluateElm(1001, MANUAL);
    await a.orch.referElm(1001, MANUAL);
    const persisted = JSON.stringify([...a.repo.rows.values()]);
    const logs = captured.slice(logStart).join('');
    for (const s of SECRETS) {
      assert.ok(!persisted.includes(s), 'persisted leak: ' + s);
      assert.ok(!logs.includes(s), 'log leak: ' + s);
    }
    assert.ok(!logs.includes('12345678'), 'logs carry no CI');
    assert.ok(!logs.includes('ana@example.test'), 'logs carry no email');
    assert.strictEqual(redactSecrets({ api_key: 'x', cookie: 'y', ok: 1 }).api_key, '[REDACTED]');
    assert.ok(!redactSecretText('Basic dXNlcjpwYXNz').includes('dXNlcjpwYXNz'));
    const view = (await a.orch.getElmStatus(1001)).data.process;
    const viewJson = JSON.stringify(view);
    assert.ok(!('s1_request' in view) && !('s1_response' in view));
    assert.ok(!viewJson.includes('12345678'), 'status view carries no CI');
  });

  // --- HTTP routes / permissions -----------------------------------------
  await test('routes: X-Cron-Key cannot run ELM actions; read ≠ execute; body ignored', async () => {
    USERS.set('admin-1', { id: 'admin-1', is_admin: true, active: true });
    USERS.set('reader-1', { id: 'reader-1', is_admin: false, active: true });
    USERS.set('off-1', { id: 'off-1', is_admin: true, active: false });
    SECTION_PERMS.add('reader-1:preaprobados');

    const orchCalls = [];
    const memberCalls = [];
    const fakeOrch = {
      async getElmStatus(czId) {
        orchCalls.push(['get', czId]);
        return { ok: true, data: { cz_solicitud_id: Number(czId), send_enabled: false } };
      },
      getSendReadiness() {
        return { ready: true, reasons: [] };
      },
      async sendElm(czId, ctx) {
        orchCalls.push(['send', czId, ctx]);
        return { ok: false, stage: 's1', code: CODES.SEND_DISABLED };
      },
      async evaluateElm(czId, ctx) {
        orchCalls.push(['evaluate', czId, ctx]);
        return { ok: false, code: CODES.SEND_DISABLED };
      },
      async referElm(czId, ctx) {
        orchCalls.push(['refer', czId, ctx]);
        return { ok: false, code: CODES.SEND_DISABLED };
      },
    };
    const app = express();
    app.use(requireAuth);
    app.use(
      '/preaprobados',
      requireDashboardPermission('preaprobados'),
      createPreaprobadosElmRouter({
        orchestrator: fakeOrch,
        listView: { async cellsForCzIds() { return new Map(); } },
        loadMember: async (czId) => {
          memberCalls.push(czId);
          return { ci: 12345678 };
        },
        loadCiResendHold: async () => null,
      }),
    );
    const realApp = express();
    realApp.use(requireAuth);
    realApp.use('/preaprobados', requireDashboardPermission('preaprobados'), require('../src/routes/preaprobados'));

    const cookie = (uid) => COOKIE_NAME + '=' + encodeURIComponent(createSessionToken(uid));
    const servers = [];
    async function listen(a) {
      const srv = http.createServer(a);
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      servers.push(srv);
      return srv.address().port;
    }
    const port = await listen(app);
    const realPort = await listen(realApp);
    function call(p, method, urlPath, headers, body) {
      return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request(
          {
            host: '127.0.0.1',
            port: p,
            method,
            path: urlPath,
            headers: Object.assign(
              { Accept: 'application/json' },
              data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
              headers || {},
            ),
          },
          (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => {
              let json = null;
              try {
                json = JSON.parse(buf);
              } catch {
                json = null;
              }
              resolve({ status: res.statusCode, body: json });
            });
          },
        );
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
      });
    }

    try {
      const cron = { 'X-Cron-Key': TEST_CRON_SECRET };
      const sendCron = await call(port, 'POST', '/preaprobados/1001/elm/send', cron);
      assert.strictEqual(sendCron.status, 403);
      assert.strictEqual(sendCron.body.code, 'elm_cron_forbidden');
      const cronWithSession = await call(port, 'POST', '/preaprobados/1001/elm/send', Object.assign({ Cookie: cookie('admin-1') }, cron));
      assert.strictEqual(cronWithSession.status, 403);
      assert.strictEqual(orchCalls.filter((c) => c[0] !== 'get').length, 0);
      assert.strictEqual(memberCalls.length, 0);

      // S1 / S2 are not exposed separately any more: no route, the orchestrator is never reached.
      for (const legacy of ['/preaprobados/1001/elm/evaluate', '/preaprobados/1001/elm/refer']) {
        const r = await call(port, 'POST', legacy, { Cookie: cookie('admin-1') });
        assert.strictEqual(r.status, 404, legacy);
        const rc = await call(port, 'POST', legacy, cron);
        assert.strictEqual(rc.status, 404, legacy + ' (cron)');
      }
      assert.strictEqual(orchCalls.filter((c) => c[0] !== 'get').length, 0, 'legacy routes never reach ELM');

      const reader = await call(port, 'POST', '/preaprobados/1001/elm/send', { Cookie: cookie('reader-1') });
      assert.strictEqual(reader.status, 403);
      assert.strictEqual(reader.body.code, 'elm_action_forbidden');
      const readerGet = await call(port, 'GET', '/preaprobados/1001/elm', { Cookie: cookie('reader-1') });
      assert.strictEqual(readerGet.status, 200);
      const inactive = await call(port, 'POST', '/preaprobados/1001/elm/send', { Cookie: cookie('off-1') });
      assert.strictEqual(inactive.status, 401);
      const anon = await call(port, 'POST', '/preaprobados/1001/elm/send', {});
      assert.strictEqual(anon.status, 401);
      assert.strictEqual(memberCalls.length, 0);

      const admin = await call(port, 'POST', '/preaprobados/1001/elm/send', { Cookie: cookie('admin-1') }, {
        ci: 99999999,
        cz_solicitud_id: 2002,
        salario: 1,
        email: 'x@y.z',
        celular: '1',
        source: 'Hack',
        relacion_laboral: 'JUB',
      });
      assert.strictEqual(admin.status, 503);
      assert.strictEqual(admin.body.code, CODES.SEND_DISABLED);
      assert.deepStrictEqual(memberCalls, [1001], 'membership of the URL solicitud only');
      const sendCall = orchCalls.find((c) => c[0] === 'send');
      assert.deepStrictEqual(sendCall, ['send', 1001, { triggerOrigin: 'janus_manual', triggeredByUserId: 'admin-1' }]);

      // Real /preaprobados router wiring (default orchestrator, disabled client): POST is 503
      // before any DB access beyond the auth lookups; the legacy routes do not exist.
      supabaseCalls.length = 0;
      const real = await call(realPort, 'POST', '/preaprobados/1001/elm/send', { Cookie: cookie('admin-1') });
      assert.strictEqual(real.status, 503);
      assert.strictEqual(real.body.code, 'elm_send_not_ready');
      assert.strictEqual(real.body.outcome, 'blocked');
      assert.ok(supabaseCalls.every((t) => t === 'dashboard_users'), 'no ELM DB access: ' + supabaseCalls.join(','));
      const realLegacy = await call(realPort, 'POST', '/preaprobados/1001/elm/evaluate', { Cookie: cookie('admin-1') });
      assert.strictEqual(realLegacy.status, 404);
      const realCron = await call(realPort, 'POST', '/preaprobados/1001/elm/send', cron);
      assert.strictEqual(realCron.status, 403);
    } finally {
      for (const s of servers) await new Promise((r) => s.close(r));
    }
  });

  await test('migration: RLS on, no policies, anon/authenticated revoked, not referenced by runtime insert', async () => {
    const sql = readSrc('migrations/20261007_elm_lead_processes.sql');
    assert.ok(/ALTER TABLE public\.elm_lead_processes ENABLE ROW LEVEL SECURITY/.test(sql));
    assert.ok(!/CREATE POLICY/i.test(sql));
    assert.ok(/REVOKE ALL ON TABLE public\.elm_lead_processes FROM PUBLIC, anon, authenticated/.test(sql));
    assert.ok(!/GRANT[^;]*TO[^;]*\b(anon|authenticated)\b/i.test(sql));
    assert.ok(!/GRANT[^;]*DELETE[^;]*elm_lead_processes/i.test(sql));
  });

  assert.strictEqual(externalNet.length, 0, 'external network attempts: ' + externalNet.join(','));
}

main()
  .then(() => {
    for (const r of results) origOut('ok - ' + r + '\n');
    origOut('unit-elm-phase1a: ' + results.length + ' checks passed; external network attempts: ' + externalNet.length + '\n');
  })
  .catch((err) => {
    origErr('FAIL: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
