'use strict';

/**
 * Retries on estado-8 queue must not start a second S1 for the same CI (orchestrator contract).
 * node scripts/unit-cdv-estado8-sendelm-idempotency.js
 */

const assert = require('assert');

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

const { S1, S2, CODES } = require('../src/services/elm/constants');
const { createElmOrchestrator } = require('../src/services/elm/orchestrator');

const CZ = 88001;
const CI = 40000001;
const silentLogger = { info() {}, warn() {}, error() {} };

let service1Calls = 0;

function enabledClient() {
  return {
    enabled: true,
    service1: async function () {
      service1Calls += 1;
      throw new Error('service1 must not run when elm_lead_processes already exists');
    },
    service2: async function () {
      return { sent: true, outcome: 'positive', httpStatus: 200, responseBody: { success: true, result: null } };
    },
  };
}

function solicitudContext() {
  return {
    solicitud: {
      cz_id: CZ,
      ci: CI,
      nombre: 'A',
      apellido: 'B',
      email: 'a@b.com',
      celular: '59891234567',
      salario: 50000,
      fecha_nacimiento: '1990-01-01',
      relacion_laboral: 'EPR',
    },
    grantedRow: null,
  };
}

function baseRepo(claimResult) {
  return {
    loadSolicitudContext: async function () {
      return solicitudContext();
    },
    resolveBaseLabel: async function () {
      return '';
    },
    claimProcess: async function () {
      return claimResult;
    },
    getProcessByCzId: async function () {
      return claimResult && !claimResult.claimed ? claimResult.process : null;
    },
    beginS2: async function () {
      return { id: 'proc-eligible', cz_solicitud_id: CZ, s2_status: S2.IN_FLIGHT };
    },
    finishS2: async function () {
      return {
        id: 'proc-eligible',
        cz_solicitud_id: CZ,
        s2_status: S2.REFERRED,
        referred_at: new Date().toISOString(),
        s2_request: { mobilephone: '091234567' },
      };
    },
    recordLateResult() {},
    expireStaleInFlight: async function (_cz, proc) {
      return proc;
    },
  };
}

function orch(repo) {
  return createElmOrchestrator({
    repository: repo,
    client: enabledClient(),
    logger: silentLogger,
    enabledTriggerOrigins: ['cdv_estado_8', 'janus_manual'],
    config: {
      inFlightLeaseSeconds: 120,
      activityTypeMap: { EPR: 'TEST' },
      dateOfBirthFormat: 'D/M/YYYY',
      mobilePhoneFormat: 'uy_local_0',
    },
  });
}

function existingProcess(s1Status, s2Status, lease) {
  return {
    id: 'proc-existing',
    cz_solicitud_id: CZ,
    ci: CI,
    s1_status: s1Status,
    s2_status: s2Status,
    s1_lease_expires_at: lease || null,
  };
}

(async function () {
  service1Calls = 0;
  const unknown = await orch(
    baseRepo({ claimed: false, process: existingProcess(S1.UNKNOWN, S2.NOT_STARTED) }),
  ).sendElm(CZ, { triggerOrigin: 'cdv_estado_8' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, CODES.PROCESS_EXISTS);
  assert.equal(service1Calls, 0, 'no S1 HTTP when process unknown');

  service1Calls = 0;
  const inflight = await orch(
    baseRepo({
      claimed: false,
      process: existingProcess(S1.IN_FLIGHT, S2.NOT_STARTED, new Date(Date.now() + 60000).toISOString()),
    }),
  ).sendElm(CZ, { triggerOrigin: 'cdv_estado_8' });
  assert.equal(inflight.ok, false);
  assert.equal(inflight.code, CODES.PROCESS_EXISTS);
  assert.equal(service1Calls, 0, 'no S1 HTTP when S1 in_flight');

  service1Calls = 0;
  let referCalls = 0;
  const resumeRepo = baseRepo({
    claimed: false,
    process: existingProcess(S1.ELIGIBLE, S2.NOT_STARTED),
  });
  resumeRepo.beginS2 = async function () {
    referCalls += 1;
    return { id: 'proc-eligible', cz_solicitud_id: CZ, s2_status: S2.IN_FLIGHT };
  };
  const resumed = await orch(resumeRepo).sendElm(CZ, { triggerOrigin: 'cdv_estado_8' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.stage, 's2');
  assert.equal(service1Calls, 0, 'resume S2 must not re-call ELM S1');
  assert.equal(referCalls, 1, 'S2 refer path taken once');

  console.log('unit-cdv-estado8-sendelm-idempotency: OK');
})();