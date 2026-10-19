'use strict';

/**
 * Gestión ELM send plan + actions (mocked orchestrator, no ELM, no Supabase).
 * Run: node scripts/unit-gestion-elm-send.js
 */

Object.assign(process.env, {
  ELM_CLIENT_ENABLED: 'true',
  ELM_ACTIVITY_TYPE_MAP_JSON: '{"EPR":"TEST_ACTIVITY_EPR","OTR":"otro"}',
  ELM_DATE_OF_BIRTH_FORMAT: 'D/M/YYYY',
  ELM_MOBILE_PHONE_FORMAT: 'uy_local_0',
});

const assert = require('assert');
const { S1, S2, CODES } = require('../src/services/elm/constants');
const {
  planGestionSend,
  SEND_MODES,
  sendActionFromPlan,
  sendRowActionFromPlan,
  BLOCK_CODES,
} = require('../src/services/elmOps/gestionElmSendPlan');
const { createGestionActions } = require('../src/services/elmOps/gestionActions');
const { applyGestionSendDisplay } = require('../src/services/elmOps/gestionSendDisplay');
const { classifyOpportunity } = require('../src/services/elmOps/opportunityClassify');
const { mapAdminRpc } = require('../src/services/elmOps/gestionAdminProviderSend');
const { classifyElmProcess } = require('../src/services/elm/classification');

const ADMIN = '33333333-3333-4333-8333-333333333333';
const UPDATED = '2026-10-01T12:00:00.000Z';

function solicitudFixture(czId) {
  return {
    cz_id: czId,
    ci: 52764618,
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

function proc(over) {
  return Object.assign(
    {
      id: '11111111-1111-4111-8111-111111111111',
      cz_solicitud_id: 1630,
      ci: 52764618,
      trigger_origin: 'cz_automatic',
      s1_status: S1.ELIGIBLE,
      s2_status: S2.NOT_STARTED,
      s1_started_at: '2026-09-01T10:00:00Z',
      created_at: '2026-09-01T09:00:00Z',
      updated_at: UPDATED,
    },
    over || {},
  );
}

function ready() {
  return { ready: true, reasons: [] };
}

function mockActions(over) {
  const o = over || {};
  const process1912 = proc({
    cz_solicitud_id: 1912,
    s1_status: S1.REJECTED,
    s2_status: S2.NOT_STARTED,
    s1_result_message: 'SCORE BAJO',
    updated_at: UPDATED,
  });
  return createGestionActions({
    repository: Object.assign(
      {
        async getProcessByCzId(cz) {
          if (Number(cz) === 1630) return proc({ cz_solicitud_id: 1630 });
          if (Number(cz) === 1912) return process1912;
          return null;
        },
        async getOpenReviewCaseByCzId() {
          return null;
        },
        async appendGestionSendAudit() {},
      },
      o.repository || {},
    ),
    elmRepository: Object.assign(
      {
        async getProjectedEstadosByCzIds() {
          return new Map();
        },
        async loadSolicitudContext(cz) {
          return { solicitud: solicitudFixture(cz || 1912), grantedRow: null };
        },
        async adminProviderResend(args) {
          return o.adminRpc ? o.adminRpc(args) : { status: 'ready', process: { id: process1912.id } };
        },
      },
      o.elmRepository || {},
    ),
    sendDeps: Object.assign(
      {
        orchestrator: {
          getSendReadiness: ready,
          async getElmStatus() {
            return { ok: true, data: { eligibility: { eligible: false, blockers: [{ code: CODES.PROCESS_EXISTS }] } } };
          },
          async continueSendAfterProviderResend() {
            return { ok: true, stage: 's2', process: {} };
          },
        },
        listView: {
          async cellsForCzIds(ids) {
            const m = new Map();
            ids.forEach(function (id) {
              m.set(id, { state: 'referred' });
            });
            return m;
          },
        },
        elmRepository: {
          async loadSolicitudContext(cz) {
            return { solicitud: solicitudFixture(cz || 1912), grantedRow: null };
          },
          async adminProviderResend(args) {
            return o.adminRpc ? o.adminRpc(args) : { status: 'ready', process: { id: process1912.id } };
          },
        },
        loadCiResendHold: async function () {
          return null;
        },
      },
      o.sendDeps || {},
    ),
    logger: { info() {}, warn() {}, error() {} },
  });
}

async function run(name, fn) {
  await fn();
  console.log('ok — ' + name);
}

(async function main() {
  await run('CZ 1630: resume S2', async function () {
    const plan = planGestionSend({
      czId: 1630,
      process: proc({ cz_solicitud_id: 1630 }),
      bag: { recoverable: true, s1_status: S1.ELIGIBLE, s2_status: S2.NOT_STARTED },
      readiness: ready(),
      hold: null,
      eligibility: { eligible: true, blockers: [] },
    });
    assert.strictEqual(plan.can_send, true);
    assert.strictEqual(plan.mode, SEND_MODES.RESUME_S2);
    assert.ok(sendActionFromPlan(plan));
    const row = sendRowActionFromPlan(plan);
    assert.strictEqual(row.enabled, true);
    assert.strictEqual(row.id, 'send_elm');
  });

  await run('sendRowActionFromPlan: blocked hold → disabled row button', async function () {
    const plan = {
      can_send: false,
      code: 'recent_send',
      hold: { reason: 'recent_send' },
      warnings: ['dup'],
    };
    const row = sendRowActionFromPlan(plan);
    assert.strictEqual(row.id, 'send_elm');
    assert.strictEqual(row.enabled, false);
  });

  await run('sendRowActionFromPlan: reconcile → hidden', async function () {
    const row = sendRowActionFromPlan({ can_send: false, code: BLOCK_CODES.RECONCILE });
    assert.strictEqual(row, null);
  });

  await run('CZ 1912 shape: eligible + S2 unknown + CI hold → disabled row + intended_mode', async function () {
    const { HOLD } = require('../src/lib/rejectedElmResendGuard');
    const plan = planGestionSend({
      czId: 1912,
      process: proc({
        cz_solicitud_id: 1912,
        ci: 18165244,
        s1_status: S1.ELIGIBLE,
        s2_status: S2.UNKNOWN,
      }),
      bag: { s1_status: S1.ELIGIBLE, s2_status: S2.UNKNOWN, reason_code: 'elm_s2_unknown' },
      readiness: ready(),
      hold: { reason: HOLD.RECENT_SEND },
      eligibility: { eligible: false, blockers: [{ code: CODES.PROCESS_EXISTS }] },
      gestionAuthorized: false,
    });
    assert.strictEqual(plan.can_send, false);
    const intended = planGestionSend({
      czId: 1912,
      process: proc({
        cz_solicitud_id: 1912,
        ci: 18165244,
        s1_status: S1.ELIGIBLE,
        s2_status: S2.UNKNOWN,
      }),
      bag: { s1_status: S1.ELIGIBLE, s2_status: S2.UNKNOWN },
      readiness: ready(),
      hold: null,
      eligibility: { eligible: false, blockers: [{ code: CODES.PROCESS_EXISTS }] },
      gestionAuthorized: false,
    });
    assert.strictEqual(intended.mode, SEND_MODES.ADMIN_PROVIDER_RESEND);
    const preview = Object.assign({}, plan, { intended_mode: intended.mode });
    const row = sendRowActionFromPlan(preview);
    assert.strictEqual(row.enabled, false);
    assert.ok(row.explanation.includes('S1+S2'));
    const item = classifyOpportunity({
      cz_solicitud_id: 1912,
      ci: '18165244',
      s1_status: S1.ELIGIBLE,
      s2_status: S2.UNKNOWN,
      reason_code: 'elm_s2_unknown',
      since: '2026-10-05T12:00:00Z',
    });
    applyGestionSendDisplay(item, preview);
    assert.strictEqual(item.next_step_key, 'admin_provider_resend');
  });

  await run('CZ 1912: admin provider resend in preview (no ref yet)', async function () {
    const plan = planGestionSend({
      czId: 1912,
      process: proc({
        cz_solicitud_id: 1912,
        s1_status: S1.REJECTED,
        s2_status: S2.NOT_STARTED,
        s1_result_message: 'SCORE BAJO',
      }),
      bag: { s1_status: S1.REJECTED, s2_status: S2.NOT_STARTED },
      readiness: ready(),
      hold: null,
      eligibility: { eligible: false, blockers: [{ code: CODES.PROCESS_EXISTS }] },
      gestionAuthorized: false,
    });
    assert.strictEqual(plan.can_send, true);
    assert.strictEqual(plan.mode, SEND_MODES.ADMIN_PROVIDER_RESEND);
    assert.strictEqual(plan.requires_provider_reference, true);
    assert.strictEqual(plan.expected_updated_at, UPDATED);
  });

  await run('admin resend blocked while in_flight', async function () {
    const plan = planGestionSend({
      czId: 1912,
      process: proc({ s1_status: S1.IN_FLIGHT, s2_status: S2.NOT_STARTED }),
      bag: {},
      readiness: ready(),
      hold: null,
      eligibility: { eligible: false, blockers: [{ code: CODES.PROCESS_EXISTS }] },
    });
    assert.strictEqual(plan.can_send, false);
    assert.strictEqual(plan.code, CODES.ADMIN_PROVIDER_RESEND_NOT_ALLOWED);
  });

  await run('projected 3 → rejected (automatic)', async function () {
    const c = classifyElmProcess(
      proc({ s1_status: S1.UNKNOWN, trigger_origin: 'cz_automatic' }),
      { projectedEstado: 3 },
    );
    assert.strictEqual(c.state, 'rejected');
  });

  await run('sendToElm requires confirm', async function () {
    const actions = mockActions({
      sendDeps: {
        orchestrator: {
          getSendReadiness: ready,
          async getElmStatus() {
            return { ok: true, data: { eligibility: { eligible: true, blockers: [] } } };
          },
        },
        listView: { async cellsForCzIds() { return new Map(); } },
        elmRepository: {
          async loadSolicitudContext(cz) {
            return { solicitud: solicitudFixture(cz || 1630), grantedRow: null };
          },
        },
        loadCiResendHold: async function () { return null; },
      },
    });
    assert.strictEqual((await actions.sendToElm(1630, {}, ADMIN)).status, 'confirm_required');
  });

  await run('admin send requires provider reference', async function () {
    const actions = mockActions();
    const out = await actions.sendToElm(
      1912,
      { confirm: true, expected_updated_at: UPDATED },
      ADMIN,
    );
    assert.strictEqual(out.status, 'provider_reference_required');
  });

  await run('admin send happy path (RPC + continue)', async function () {
    let rpcCalled = false;
    let contCalled = false;
    const actions = mockActions({
      adminRpc: function (args) {
        rpcCalled = true;
        assert.strictEqual(args.providerReference, 'REF-ELM-9912');
        assert.strictEqual(args.expectedUpdatedAt, UPDATED);
        return { status: 'ready', process: { id: '11111111-1111-4111-8111-111111111111' } };
      },
      sendDeps: {
        orchestrator: {
          getSendReadiness: ready,
          async getElmStatus() {
            return { ok: true, data: { eligibility: { eligible: false, blockers: [{ code: CODES.PROCESS_EXISTS }] } } };
          },
          async continueSendAfterProviderResend(czId) {
            contCalled = true;
            assert.strictEqual(czId, 1912);
            return { ok: true, stage: 's2', process: {} };
          },
        },
        listView: {
          async cellsForCzIds() {
            return new Map([[1912, { state: 'referred' }]]);
          },
        },
        elmRepository: {
          async loadSolicitudContext(cz) {
            return { solicitud: solicitudFixture(cz || 1912), grantedRow: null };
          },
          async adminProviderResend(args) {
            rpcCalled = true;
            assert.strictEqual(args.providerReference, 'REF-ELM-9912');
            return { status: 'ready', process: { id: '11111111-1111-4111-8111-111111111111' } };
          },
        },
        loadCiResendHold: async function () { return null; },
      },
    });
    const out = await actions.sendToElm(
      1912,
      {
        confirm: true,
        confirm_duplicate: true,
        provider_reference: 'REF-ELM-9912',
        expected_updated_at: UPDATED,
      },
      ADMIN,
    );
    assert.strictEqual(rpcCalled, true);
    assert.strictEqual(contCalled, true);
    assert.strictEqual(out.status, 'sent');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.mode, SEND_MODES.ADMIN_PROVIDER_RESEND);
  });

  await run('admin RPC duplicate reference maps to code', async function () {
    const mapped = mapAdminRpc({ status: 'not_allowed', reason: 'duplicate_provider_reference' });
    assert.strictEqual(mapped.ok, false);
    assert.strictEqual(mapped.code, CODES.ADMIN_PROVIDER_DUPLICATE_REFERENCE);
  });

  await run('admin send surfaces duplicate provider reference', async function () {
    const actions = mockActions({
      sendDeps: {
        orchestrator: {
          getSendReadiness: ready,
          async getElmStatus() {
            return { ok: true, data: { eligibility: { eligible: false, blockers: [{ code: CODES.PROCESS_EXISTS }] } } };
          },
        },
        listView: { async cellsForCzIds() { return new Map([[1912, {}]]); } },
        elmRepository: {
          async loadSolicitudContext(cz) {
            return { solicitud: solicitudFixture(cz || 1912), grantedRow: null };
          },
          async adminProviderResend() {
            return { status: 'not_allowed', reason: 'duplicate_provider_reference' };
          },
        },
        loadCiResendHold: async function () { return null; },
      },
    });
    const out = await actions.sendToElm(
      1912,
      {
        confirm: true,
        confirm_duplicate: true,
        provider_reference: 'REF-DUP',
        expected_updated_at: UPDATED,
      },
      ADMIN,
    );
    assert.strictEqual(out.status, 'send_failed');
    assert.strictEqual(out.code, CODES.ADMIN_PROVIDER_DUPLICATE_REFERENCE);
  });

  await run('admin RPC blocked CI lock', async function () {
    const mapped = mapAdminRpc({ status: 'blocked', lock: { status: 'held' } });
    assert.strictEqual(mapped.code, CODES.CI_LOCK_BLOCKED);
  });

  await run('admin send stale expected_updated_at', async function () {
    const actions = mockActions();
    const out = await actions.sendToElm(
      1912,
      {
        confirm: true,
        confirm_duplicate: true,
        provider_reference: 'REF-ELM-9912',
        expected_updated_at: '2020-01-01T00:00:00.000Z',
      },
      ADMIN,
    );
    assert.strictEqual(out.status, 'stale');
  });

  await run('concurrent send on same cz → in_flight', async function () {
    const actions = mockActions();
    const body = {
      confirm: true,
      confirm_duplicate: true,
      provider_reference: 'REF-ELM-9912',
      expected_updated_at: UPDATED,
    };
    const slow = mockActions({
      adminRpc: function () {
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve({ status: 'ready', process: { id: '11111111-1111-4111-8111-111111111111' } });
          }, 50);
        });
      },
      sendDeps: {
        orchestrator: {
          getSendReadiness: ready,
          async getElmStatus() {
            return { ok: true, data: { eligibility: { eligible: false, blockers: [{ code: CODES.PROCESS_EXISTS }] } } };
          },
          async continueSendAfterProviderResend() {
            return { ok: true, stage: 's2', process: {} };
          },
        },
        listView: { async cellsForCzIds() { return new Map([[1912, {}]]); } },
        elmRepository: {
          async loadSolicitudContext(cz) {
            return { solicitud: solicitudFixture(cz || 1912), grantedRow: null };
          },
          async adminProviderResend() {
            return new Promise(function (resolve) {
              setTimeout(function () {
                resolve({ status: 'ready', process: { id: '11111111-1111-4111-8111-111111111111' } });
              }, 50);
            });
          },
        },
        loadCiResendHold: async function () { return null; },
      },
    });
    const p1 = slow.sendToElm(1912, body, ADMIN);
    const p2 = slow.sendToElm(1912, body, ADMIN);
    const results = await Promise.all([p1, p2]);
    const statuses = results.map(function (r) { return r.status; }).sort();
    assert.ok(statuses.includes('in_flight'), statuses.join(','));
    assert.ok(statuses.includes('sent') || statuses.includes('send_failed'), statuses.join(','));
  });

  await run('invalid phone exception sends S1 only for CZ 2049 and 2056', async function () {
    const elig = {
      eligible: true,
      blockers: [],
      s2_withheld: CODES.MOBILEPHONE_NEEDS_CORRECTION,
    };
    const plan = planGestionSend({
      czId: 2049,
      process: null,
      readiness: { ready: true },
      hold: null,
      eligibility: elig,
    });
    assert.strictEqual(plan.can_send, true);
    assert.deepStrictEqual(plan.steps, ['s1']);
    const act = sendActionFromPlan(plan);
    assert.ok(act.explanation.indexOf('solo el paso 1') !== -1);
    const afterS1 = planGestionSend({
      czId: 2049,
      process: { s1_status: S1.ELIGIBLE, s2_status: S2.NOT_STARTED, id: 'p' },
      readiness: { ready: true },
      hold: null,
      eligibility: elig,
    });
    assert.strictEqual(afterS1.can_send, false);
    assert.strictEqual(afterS1.code, CODES.MOBILEPHONE_NEEDS_CORRECTION);
  });

  console.log('unit-gestion-elm-send: all passed');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
