'use strict';

/**
 * Regression: ELM confirmed that S1 "Repetido. Aprobado" means the client is already approved by
 * ANOTHER channel (not Copanel). It is persisted as s1 rejected + s1_error_code
 * elm_s1_duplicate_other_channel (original response untouched) and read as closed
 * "Duplicado · Otro canal": no S2, no retry, no survey, never a Copanel approval / placement nor
 * a rejection. KPIs, fallback, Ops and the CI resend rules see it as a terminal process.
 * Historical rows (1341, stored as unknown) are not reclassified.
 * Pure functions and in-memory fakes only: no network, no database.
 *
 * Run: node scripts/unit-elm-duplicate-other-channel.js
 */

const assert = require('assert');

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

const { S1, S2, CODES, OUTCOME, PRE_RECEPTION_ERROR_CODES } = require('../src/services/elm/constants');
const { classifyElmProcess, blocksSurveyInvite, COMMERCIAL } = require('../src/services/elm/classification');
const { computeElmKpis } = require('../src/services/elm/kpis');
const { computeElmCell } = require('../src/services/elm/listView');
const { S1_BY_OUTCOME } = require('../src/services/elm/orchestrator');
const { deriveFromProcess } = require('../src/services/providerFallback/outcome');
const {
  OUTCOME: FB_OUTCOME,
  REASONS,
  DEFINITIVE_REJECTION_REASONS,
} = require('../src/services/providerFallback/constants');
const { computeElmSurveyBlocks } = require('../src/lib/rejectedSurveyInviteElmGate');
const { evaluateCiResendHold } = require('../src/lib/rejectedElmResendGuard');
const { outcomeOf, OUTCOMES } = require('../src/lib/rejectedElmSend');
const { createElmOpsService } = require('../src/services/elmOps/service');

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
const iso = (ms) => new Date(ms).toISOString();
const TECH_RETRY = { maxAttempts: 3, retrySafeErrorCodes: [CODES.PROVIDER_BCU_ERROR], baseDelaySeconds: 60 };

function proc(over) {
  return Object.assign(
    {
      id: 'p-' + Math.random().toString(16).slice(2),
      cz_solicitud_id: 1600,
      ci: 1,
      trigger_origin: 'janus_manual',
      created_at: iso(NOW - 3600000),
      updated_at: iso(NOW - 3500000),
      s1_status: S1.NOT_STARTED,
      s1_attempts: 1,
      s1_http_status: 200,
      s1_error_code: null,
      s1_result_message: null,
      s1_started_at: iso(NOW - 3600000),
      s1_completed_at: iso(NOW - 3599000),
      s1_lease_expires_at: null,
      s2_status: S2.NOT_STARTED,
      s2_result_message: null,
      s2_started_at: null,
      s2_lease_expires_at: null,
      referred_at: null,
      provider_status: null,
      disbursed_at: null,
      ops_resolved_at: null,
      ops_resolution_code: null,
    },
    over,
  );
}

const dup = (over) =>
  proc(
    Object.assign(
      {
        s1_status: S1.REJECTED,
        s1_error_code: CODES.S1_DUPLICATE_OTHER_CHANNEL,
        s1_result_message: 'Repetido. Aprobado',
      },
      over,
    ),
  );
const rejectedRep = (over) =>
  proc(Object.assign({ s1_status: S1.REJECTED, s1_result_message: 'Repetido. Rechazado' }, over));
const favorable = (over) =>
  proc(Object.assign({ s1_status: S1.ELIGIBLE, s1_result_message: 'Listo para recibir datos en servicio 2' }, over));
const referred = (over) =>
  favorable(Object.assign({ s2_status: S2.REFERRED, s2_result_message: 'Lead Aprobado correctamente', s2_started_at: iso(NOW - 3000000), referred_at: iso(NOW - 2990000) }, over));
const hist1341 = () =>
  proc({
    cz_solicitud_id: 1341,
    ci: 7,
    s1_status: S1.UNKNOWN,
    s1_error_code: CODES.RESPONSE_UNDOCUMENTED,
    s1_result_message: 'Repetido. Aprobado',
  });

(async function main() {
  await test('1 persistence: terminal S1 that satisfies the existing DB rules (no new state, no S2)', () => {
    assert.strictEqual(S1_BY_OUTCOME[OUTCOME.DUPLICATE_OTHER_CHANNEL], S1.REJECTED, 'allowed by elm_finish_s1 and the S1 trigger');
    assert.ok(Object.values(S1).includes(S1_BY_OUTCOME[OUTCOME.DUPLICATE_OTHER_CHANNEL]), 's1_status CHECK');
    assert.ok(CODES.S1_DUPLICATE_OTHER_CHANNEL.length <= 100, 's1_error_code stored without truncation');
    assert.ok(!PRE_RECEPTION_ERROR_CODES.includes(CODES.S1_DUPLICATE_OTHER_CHANNEL), 'never a pre-reception code');
  });

  await test('2 commercial reading: closed "Duplicado · Otro canal", stage S1, survey held', () => {
    const c = classifyElmProcess(dup(), { nowMs: NOW });
    assert.deepStrictEqual(
      { state: c.state, detail: c.detail, detail_label: c.detail_label, stage: c.stage },
      { state: COMMERCIAL.CLOSED, detail: 's1_duplicate_other_channel', detail_label: 'Duplicado · Otro canal', stage: 's1' },
    );
    assert.strictEqual(blocksSurveyInvite(c), true);
    for (const p of [dup({ trigger_origin: 'cz_automatic' }), dup({ trigger_origin: 'janus_batch' })]) {
      assert.strictEqual(classifyElmProcess(p, { nowMs: NOW, projectedEstado: 14 }).detail, 's1_duplicate_other_channel', p.trigger_origin);
    }
  });

  await test('3 "Repetido. Rechazado" stays a definitive rejection everywhere', () => {
    const c = classifyElmProcess(rejectedRep(), { nowMs: NOW });
    assert.strictEqual(c.state, COMMERCIAL.REJECTED);
    assert.strictEqual(c.detail, 's1_negative');
    assert.strictEqual(blocksSurveyInvite(c), false, 'rejected-lead survey circuit unchanged');
    const d = deriveFromProcess(rejectedRep(), NOW, TECH_RETRY);
    assert.strictEqual(d.outcome, FB_OUTCOME.REJECTED);
    assert.strictEqual(d.reasonCode, REASONS.ELM_S1_REJECTED);
    assert.strictEqual(outcomeOf(computeElmCell({ process: rejectedRep(), nowMs: NOW })), OUTCOMES.S1_REJECTED);
  });

  await test('4 favorable S1 still continues: in evaluation until S2, then Preaprobado', () => {
    const pending = classifyElmProcess(favorable(), { nowMs: NOW });
    assert.strictEqual(pending.detail, 's1_eligible_pending_s2');
    assert.strictEqual(deriveFromProcess(favorable(), NOW, TECH_RETRY).kind, 'refer', 'fallback still starts S2');
    assert.strictEqual(classifyElmProcess(referred(), { nowMs: NOW }).state, COMMERCIAL.REFERRED);
  });

  await test('5 no retries: no retry action, fallback finalizes (manual review, never a rejection)', () => {
    const cell = computeElmCell({
      process: dup(),
      nowMs: NOW,
      allowSend: true,
      sendReadiness: { ready: true, reasons: [] },
      maxRetryAttempts: 3,
    });
    assert.strictEqual(cell.retry, null);
    assert.strictEqual(cell.action.show, false);
    for (const origin of ['janus_manual', 'cz_automatic']) {
      const d = deriveFromProcess(dup({ trigger_origin: origin }), NOW, TECH_RETRY);
      assert.strictEqual(d.kind, 'final', origin);
      assert.strictEqual(d.outcome, FB_OUTCOME.MANUAL_REVIEW, origin);
      assert.strictEqual(d.reasonCode, REASONS.ELM_S1_DUPLICATE_OTHER_CHANNEL, origin);
      assert.deepStrictEqual(d.detail, { result_message: 'Repetido. Aprobado' }, origin);
    }
    assert.ok(!DEFINITIVE_REJECTION_REASONS.includes(REASONS.ELM_S1_DUPLICATE_OTHER_CHANNEL), 'DB refuses it as rejected / not_eligible');
  });

  await test('6 surveys: the CI is held for a duplicate, released for a definitive rejection', () => {
    const blocks = computeElmSurveyBlocks({
      processes: [dup({ ci: 11 }), rejectedRep({ ci: 12, cz_solicitud_id: 1601 })],
      states: [],
      openRequests: [],
      nowMs: NOW,
    });
    assert.deepStrictEqual(blocks.get(11), { cz_solicitud_id: 1600, state: 'closed', source: 'elm_process' });
    assert.strictEqual(blocks.has(12), false);
  });

  await test('7 KPIs: not favorable, not referred, not granted, not rejected, not pending; counted as closed', () => {
    const k = computeElmKpis([dup()], { nowMs: NOW });
    const f = k.flow.janus_manual;
    assert.strictEqual(f.started, 1);
    assert.strictEqual(f.s1_executed, 1);
    assert.strictEqual(f.s1_favorable, 0);
    assert.strictEqual(f.referred_s2, 0);
    assert.strictEqual(f.granted, 0);
    assert.strictEqual(f.rejected_definitive, 0);
    assert.strictEqual(f.pending_or_review, 0);
    assert.strictEqual(f.distinct_ci_referred, 0);
    assert.deepStrictEqual(k.current.janus_manual, {
      in_evaluation: 0, referred: 0, granted: 0, rejected: 0, review: 0, closed: 1,
    });
  });

  await test('8 KPIs of the other readings are unchanged next to a duplicate', () => {
    const rows = [dup(), rejectedRep({ cz_solicitud_id: 2 }), favorable({ cz_solicitud_id: 3 }), referred({ cz_solicitud_id: 4, ci: 4 }), hist1341()];
    const t = computeElmKpis(rows, { nowMs: NOW }).flow.total;
    assert.deepStrictEqual(
      { s1_favorable: t.s1_favorable, referred_s2: t.referred_s2, rejected_definitive: t.rejected_definitive, pending_or_review: t.pending_or_review, granted: t.granted },
      { s1_favorable: 2, referred_s2: 1, rejected_definitive: 1, pending_or_review: 2, granted: 0 },
    );
  });

  await test('9 send outcome and CI resend: terminal, the next solicitud waits the ELM window', () => {
    const cell = computeElmCell({ process: dup(), nowMs: NOW });
    assert.strictEqual(outcomeOf(cell), OUTCOMES.DUPLICATE_OTHER_CHANNEL);
    const opsClosed = computeElmCell({ process: proc({ s1_status: S1.UNKNOWN, ops_resolved_at: iso(NOW), ops_resolution_code: 'customer_withdrew' }), nowMs: NOW });
    assert.strictEqual(outcomeOf(opsClosed), OUTCOMES.CLOSED, 'other closures unchanged');
    const holdOther = evaluateCiResendHold({ ci: 1, czSolicitudId: 1700, processes: [dup()], locks: [], nowMs: NOW });
    assert.strictEqual(holdOther && holdOther.reason, 'elm_ci_recent_send', 'not an active process, but ELM saw the lead');
    const later = evaluateCiResendHold({ ci: 1, czSolicitudId: 1700, processes: [dup()], locks: [], nowMs: NOW + 40 * 24 * 3600 * 1000 });
    assert.strictEqual(later, null, 'same rules as any finished process once the window and month pass');
  });

  await test('10 ELM Ops follow-up: a duplicate is not an open item; 1341 still is', async () => {
    const ops = createElmOpsService({
      repository: { czIdsWithEstado3: async () => new Set(), listOpenFallbackRequests: async () => [] },
      elmRepository: {
        listAllProcesses: async () => [dup(), hist1341()],
        getProjectedEstadosByCzIds: async () => new Map(),
      },
      fallbackRepository: {},
      now: () => NOW,
      logger: { info() {}, warn() {}, error() {} },
      c1StaleHours: 72,
      postReferralRejectionStatuses: [],
    });
    const items = await ops.followup(50);
    const ids = items.map((i) => i.cz_solicitud_id);
    assert.ok(!ids.includes(1600), JSON.stringify(items));
    assert.ok(ids.includes(1341), JSON.stringify(items));
  });

  await test('11 historical 1341 (stored unknown) keeps its reading: review, fallback ELM_S1_UNKNOWN', () => {
    const c = classifyElmProcess(hist1341(), { nowMs: NOW });
    assert.strictEqual(c.state, COMMERCIAL.REVIEW);
    assert.strictEqual(c.detail, 's1_unknown');
    assert.strictEqual(blocksSurveyInvite(c), true);
    assert.strictEqual(deriveFromProcess(hist1341(), NOW, TECH_RETRY).reasonCode, REASONS.ELM_S1_UNKNOWN);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
