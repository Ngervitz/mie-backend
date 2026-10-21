'use strict';

/**
 * Preaprobados V1 — manual Enviar a ELM (mocks only, zero network).
 * Run: node scripts/unit-elm-preaprobados-send-v1.js
 */

const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

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

const netCalls = [];
function guard(mod, name) {
  mod[name] = function blocked() {
    netCalls.push(name);
    throw new Error('network blocked in unit-elm-preaprobados-send-v1: ' + name);
  };
}
guard(http, 'request');
guard(https, 'request');
guard(http, 'get');
guard(https, 'get');
guard(net, 'connect');
guard(tls, 'connect');
globalThis.fetch = async function blockedFetch() {
  netCalls.push('fetch');
  throw new Error('network blocked in unit-elm-preaprobados-send-v1: fetch');
};

const { S1, S2, CODES } = require('../src/services/elm/constants');
const { createElmOrchestrator } = require('../src/services/elm/orchestrator');
const { createElmClient } = require('../src/services/elm/client');
const { readElmConfig } = require('../src/services/elm/config');
const { evaluateElmEligibility } = require('../src/services/elm/eligibility');
const { createElmListView } = require('../src/services/elm/listView');
const { sendPreaprobadoToElm, loadPreaprobadoMember } = require('../src/lib/preaprobadosElmSend');
const { evaluateCiResendHold, HOLD, ELM_RESEND_WINDOW_DAYS } = require('../src/lib/rejectedElmResendGuard');
const ElmUi = require('../public/elm-ui-helpers.js');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const MANUAL = { triggerOrigin: 'janus_manual', triggeredByUserId: 'user-admin-1' };
const ENV = {
  ELM_CLIENT_ENABLED: 'true',
  ELM_SERVICE_1_URL:
    'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=10&deploy=1',
  ELM_SERVICE_2_URL:
    'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=11&deploy=1',
  ELM_CONSUMER_KEY: 'fake-consumer-key-0001',
  ELM_CONSUMER_SECRET: 'fake-consumer-secret-0002',
  ELM_TOKEN_ID: 'fake-token-id-0003',
  ELM_TOKEN_SECRET: 'fake-token-secret-0004',
  ELM_HTTP_TIMEOUT_MS: '40',
  ELM_ACTIVITY_TYPE_MAP_JSON: '{"EPR":"TEST_ACTIVITY_EPR"}',
  ELM_DATE_OF_BIRTH_FORMAT: 'D/M/YYYY',
  ELM_MOBILE_PHONE_FORMAT: 'uy_local_0',
};
const silentLogger = { info() {}, warn() {}, error() {} };

function iso(ms) {
  return new Date(ms).toISOString();
}

function sol(czId, over) {
  return Object.assign(
    {
      cz_id: czId,
      ci: 11111111,
      nombre: 'Ana',
      apellido: 'Prueba',
      email: 'ana@example.test',
      celular: '099123456',
      salario: 30000,
      fecha_nacimiento: '1991-07-10',
      relacion_laboral: 'EPR',
      lrw_id: 'LRW-' + czId,
      solicitudes_estados_id: 8,
    },
    over || {},
  );
}

function fakeFetch(steps) {
  const calls = [];
  async function f(url, init) {
    calls.push({ url: String(url), init: init });
    const step = steps[calls.length - 1];
    if (!step) throw new Error('unexpected ELM call #' + calls.length);
    if (step.throws) throw step.throws;
    return { status: step.status, text: async () => JSON.stringify(step.body) };
  }
  f.calls = calls;
  return f;
}

function createFakeRepo(solicitudes, grantedByCz) {
  const rows = new Map();
  let seq = 0;
  const byId = (id) => [...rows.values()].find((r) => r.id === id) || null;
  return {
    rows,
    claimStarts: 0,
    async loadSolicitudContext(czId) {
      return {
        solicitud: solicitudes.get(czId) || null,
        grantedRow: (grantedByCz && grantedByCz.get(czId)) || null,
      };
    },
    async loadSolicitudContexts(ids) {
      return new Map(
        ids.map((id) => [
          id,
          {
            solicitud: solicitudes.get(id) || null,
            grantedRow: (grantedByCz && grantedByCz.get(id)) || null,
          },
        ]),
      );
    },
    async resolveBaseLabel() {
      return '';
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
      this.claimStarts += 1;
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
    async beginS2(czId, _req, leaseSeconds) {
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
        s2_error_code: r.errorCode,
        s2_lease_expires_at: null,
        referred_at: r.status === S2.REFERRED ? iso(NOW) : null,
      });
      return Object.assign({}, row);
    },
    async expireStaleInFlight() {
      return null;
    },
  };
}

function orchOf(opts) {
  const o = opts || {};
  const solicitudes = o.solicitudes || new Map([[100, sol(100)]]);
  const repo = o.repo || createFakeRepo(solicitudes, o.grantedByCz);
  const fetchImpl = fakeFetch(o.steps || []);
  const orch = createElmOrchestrator({
    repository: repo,
    client: createElmClient({ env: Object.assign({}, ENV, o.env || {}), fetchImpl: fetchImpl }),
    config: readElmConfig(Object.assign({}, ENV, o.env || {})),
    logger: silentLogger,
    now: () => NOW,
  });
  return { orch: orch, repo: repo, fetchImpl: fetchImpl, solicitudes: solicitudes };
}

function sendDeps(h, extra) {
  return Object.assign(
    {
      orchestrator: h.orch,
      listView: createElmListView({
        repository: h.repo,
        config: readElmConfig(ENV),
        now: () => NOW,
        sendReadiness: () => h.orch.getSendReadiness(),
      }),
      loadMember: async () => ({ ci: 11111111 }),
      loadCiResendHold: async () => null,
    },
    extra || {},
  );
}

const tests = [];
function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

test('manual send has no consent gate; readiness is transport/config only', async () => {
  const prod = orchOf({
    steps: [
      { status: 200, body: { result: 'Listo para recibir datos en servicio 2' } },
      { status: 200, body: { result: 'Lead Aprobado correctamente' } },
    ],
  });
  const ready = prod.orch.getSendReadiness();
  assert.strictEqual(ready.ready, true, String(ready.reasons));
  assert.ok(!ready.reasons.includes('elm_consent_unverifiable'));
  const out = await prod.orch.sendElm(100, MANUAL);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.stage, 's2');
  assert.strictEqual(prod.fetchImpl.calls.length, 2);
});

test('S1 favorable then S2 referred; actor and origin persisted', async () => {
  const h = orchOf({
    steps: [
      { status: 200, body: { result: 'Listo para recibir datos en servicio 2' } },
      { status: 200, body: { result: 'Lead Aprobado correctamente' } },
    ],
  });
  const out = await h.orch.sendElm(100, MANUAL);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.stage, 's2');
  assert.strictEqual(out.process.s1.effective_status, S1.ELIGIBLE);
  assert.strictEqual(out.process.s2.effective_status, S2.REFERRED);
  assert.strictEqual(h.fetchImpl.calls.length, 2);
  const row = h.repo.rows.get(100);
  assert.strictEqual(row.trigger_origin, 'janus_manual');
  assert.strictEqual(row.triggered_by_user_id, 'user-admin-1');
});

test('S1 rejection does not call S2', async () => {
  const h = orchOf({ steps: [{ status: 200, body: { result: 'Blacklist' } }] });
  const out = await h.orch.sendElm(100, MANUAL);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.stage, 's1');
  assert.strictEqual(out.process.s1.effective_status, S1.REJECTED);
  assert.strictEqual(h.fetchImpl.calls.length, 1);
});

test('technical S1 is not a rejection and does not start S2', async () => {
  const h = orchOf({ steps: [{ status: 200, body: { result: 'BCU error' } }] });
  const out = await h.orch.sendElm(100, MANUAL);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.stage, 's1');
  assert.notStrictEqual(out.process.s1.effective_status, S1.ELIGIBLE);
  assert.strictEqual(h.fetchImpl.calls.length, 1);
});

test('client throw becomes unknown and is not retried', async () => {
  const h = orchOf({ steps: [{ throws: new Error('socket down') }] });
  const out = await h.orch.sendElm(100, MANUAL);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.stage, 's1');
  assert.strictEqual(out.process.s1.effective_status, S1.UNKNOWN);
  assert.strictEqual(h.fetchImpl.calls.length, 1);
});

test('duplicate: existing process is never sent as new', async () => {
  const h = orchOf({
    steps: [
      { status: 200, body: { result: 'Listo para recibir datos en servicio 2' } },
      { status: 200, body: { result: 'Lead Aprobado correctamente' } },
    ],
  });
  const first = await h.orch.sendElm(100, MANUAL);
  assert.strictEqual(first.ok, true);
  const again = await h.orch.sendElm(100, MANUAL);
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, CODES.PROCESS_EXISTS);
  assert.strictEqual(h.fetchImpl.calls.length, 2);
});

test('concurrency: two sendElm on the same cz_id → one process', async () => {
  const h = orchOf({
    steps: [
      { status: 200, body: { result: 'Listo para recibir datos en servicio 2' } },
      { status: 200, body: { result: 'Lead Aprobado correctamente' } },
      { status: 200, body: { result: 'Listo para recibir datos en servicio 2' } },
      { status: 200, body: { result: 'Lead Aprobado correctamente' } },
    ],
  });
  const [a, b] = await Promise.all([h.orch.sendElm(100, MANUAL), h.orch.sendElm(100, MANUAL)]);
  const oks = [a, b].filter((x) => x.ok === true);
  const blocked = [a, b].filter((x) => x.ok !== true);
  assert.ok(oks.length >= 1, JSON.stringify([a.code, b.code]));
  assert.ok(blocked.some((x) => x.code === CODES.PROCESS_EXISTS) || h.repo.rows.size === 1);
  assert.strictEqual(h.repo.rows.size, 1);
});

test('GRANTED CDV blocks send', async () => {
  const granted = new Map([[100, { cz_id: 100, ci: 11111111, monto_otorgado: 12000 }]]);
  const h = orchOf({
    grantedByCz: granted,
    steps: [{ status: 200, body: { result: 'Listo para recibir datos en servicio 2' } }],
  });
  const out = await h.orch.sendElm(100, MANUAL);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, CODES.CDV_GRANTED);
  assert.strictEqual(h.fetchImpl.calls.length, 0);
});

test('CI 30-day window and uncertain process hold a new send', () => {
  const recent = evaluateCiResendHold({
    ci: 11111111,
    czSolicitudId: 200,
    processes: [
      {
        ci: 11111111,
        cz_solicitud_id: 100,
        created_at: iso(NOW - 10 * DAY),
        s1_started_at: iso(NOW - 10 * DAY),
        s2_started_at: iso(NOW - 10 * DAY),
        referred_at: iso(NOW - 10 * DAY),
        s1_status: S1.REJECTED,
        s1_result_message: 'Blacklist',
        s2_status: S2.NOT_STARTED,
        trigger_origin: 'janus_manual',
      },
    ],
    locks: [],
    nowMs: NOW,
    postReferralRejectionStatuses: [],
  });
  assert.ok(recent);
  assert.strictEqual(recent.reason, HOLD.RECENT_SEND);
  assert.ok(ELM_RESEND_WINDOW_DAYS >= 30);

  const uncertain = evaluateCiResendHold({
    ci: 11111111,
    czSolicitudId: 200,
    processes: [
      {
        ci: 11111111,
        cz_solicitud_id: 100,
        created_at: iso(NOW - 40 * DAY),
        s1_started_at: iso(NOW - 40 * DAY),
        s1_status: S1.UNKNOWN,
        s2_status: S2.NOT_STARTED,
        trigger_origin: 'janus_manual',
      },
    ],
    locks: [],
    nowMs: NOW,
    postReferralRejectionStatuses: [],
  });
  assert.ok(uncertain);
  assert.ok([HOLD.ACTIVE, HOLD.UNVERIFIABLE].includes(uncertain.reason), uncertain.reason);
});

test('estado 8 is eligible and carries CDV-active notice into the confirm attribute', () => {
  const elig = evaluateElmEligibility({
    czId: 100,
    solicitud: sol(100, { solicitudes_estados_id: 8 }),
    grantedRow: null,
    config: readElmConfig(ENV),
  });
  assert.strictEqual(elig.eligible, true);
  assert.ok(elig.notices.includes('elm_cdv_possibly_active'));
  const text = ElmUi.sendNoticeText(elig.notices);
  assert.ok(/CDV puede seguir trabajando/.test(text), text);
  const helpers = fs.readFileSync(path.join(__dirname, '../public/elm-ui-helpers.js'), 'utf8');
  assert.ok(helpers.includes('data-elm-notice'));
  assert.ok(helpers.includes('elm_cdv_possibly_active'));

  const later = evaluateElmEligibility({
    czId: 101,
    solicitud: sol(101, { solicitudes_estados_id: 3 }),
    grantedRow: null,
    config: readElmConfig(ENV),
  });
  assert.ok(!later.notices.includes('elm_cdv_possibly_active'));
});

test('dashboard detail confirm + POST /preaprobados/:czId/elm/send; tray rules untouched', () => {
  const dash = fs.readFileSync(path.join(__dirname, '../public/mie-dashboard.js'), 'utf8');
  assert.ok(dash.includes("API + '/preaprobados/' + encodeURIComponent(czId) + '/elm/send'"));
  assert.ok(/action === 'elm-send' && !btn\.disabled/.test(dash));
  assert.ok(dash.includes('window.confirm('));
  assert.ok(dash.includes('data-elm-notice'));
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/preaprobadosElm.js'), 'utf8');
  assert.ok(/router\.post\(\s*'\/:czId\/elm\/send',\s*requireElmAction/.test(route));
  const readLib = fs.readFileSync(path.join(__dirname, '../src/lib/preaprobadosRead.js'), 'utf8');
  assert.ok(/PREAPROBADOS_ESTADO_ID = 8/.test(readLib));
  assert.ok(
    /historico estado 8 UNION current solicitud estado 8/.test(readLib) ||
      /EVER reached solicitudes_estados_id = 8/.test(readLib),
  );
  const cfg = fs.readFileSync(path.join(__dirname, '../src/services/elm/config.js'), 'utf8');
  assert.ok(!/ELM_CLIENT_ENABLED\s*=\s*['"]true['"]/.test(cfg));
});

test('sendPreaprobadoToElm returns an explicit operator result', async () => {
  const h = orchOf({
    steps: [
      { status: 200, body: { result: 'Listo para recibir datos en servicio 2' } },
      { status: 200, body: { result: 'Lead Aprobado correctamente' } },
    ],
  });
  const out = await sendPreaprobadoToElm(sendDeps(h), {
    czSolicitudId: 100,
    actorUserId: 'user-admin-1',
  });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(out.body.outcome, 'referred');
  const msg = ElmUi.sendResultMessage(out.body);
  assert.strictEqual(msg.tone, 'ok');
  assert.ok(/Aceptado ELM/.test(msg.text), msg.text);
  const rejected = await sendPreaprobadoToElm(
    sendDeps(
      orchOf({
        solicitudes: new Map([[101, sol(101)]]),
        steps: [{ status: 200, body: { result: 'Blacklist' } }],
      }),
    ),
    { czSolicitudId: 101, actorUserId: 'user-admin-1' },
  );
  assert.strictEqual(rejected.body.outcome, 's1_rejected');
  const rmsg = ElmUi.sendResultMessage(rejected.body);
  assert.ok(/evaluaci\u00f3n inicial \(S1\)/.test(rmsg.text), rmsg.text);
  const dash = fs.readFileSync(path.join(__dirname, '../public/mie-dashboard.js'), 'utf8');
  assert.ok(dash.includes('state.elmSendMessage'));
  assert.ok(dash.includes('rechazados-elm-msg is-'));
  assert.ok(dash.includes('ElmUi.sendResultMessage(data)'));
});

test('loadPreaprobadoMember stays on the CDV cohort (no tray change)', async () => {
  const sb = {
    from(table) {
      const q = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        range() {
          return Promise.resolve({ data: [], error: null });
        },
        maybeSingle() {
          if (table === 'cz_funnel_solicitudes') {
            return Promise.resolve({
              data: sol(4242, { solicitudes_estados_id: 3 }),
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return q;
    },
  };
  const member = await loadPreaprobadoMember(sb, 4242);
  assert.strictEqual(member.status, 404);
  assert.strictEqual(member.body.code, 'elm_solicitud_not_in_preaprobados');
});

test('zero external network attempts', () => {
  assert.strictEqual(netCalls.length, 0, netCalls.join(','));
});

(async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('ok  ' + t.name);
    } catch (err) {
      failed += 1;
      console.log('FAIL ' + t.name);
      console.log('  ' + (err && err.stack ? err.stack : err));
    }
  }
  console.log((tests.length - failed) + '/' + tests.length + (failed ? ' FAIL' : ' PASS'));
  process.exit(failed ? 1 : 0);
})();
