'use strict';

/**
 * Continuous rejected-survey campaigns — lifecycle always-open.
 * node scripts/unit-rejected-survey-invite-continuous-campaigns.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.RECHAZADOS_SURVEY_INVITE_STEP1_CAMPAIGN_ID = '6';
process.env.RECHAZADOS_SURVEY_INVITE_STEP2_CAMPAIGN_ID = '7';
process.env.RECHAZADOS_SURVEY_INVITE_STEP3_CAMPAIGN_ID = '8';
process.env.RECHAZADOS_SURVEY_INVITE_NORMAL_CUTOFF_AT =
  '2026-09-15T00:00:00.000Z';

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
    czTrackingHmacSecret: null,
    emailUnsubscribeHmacSecret: 'test-email-unsubscribe-secret',
    emailPublicBaseUrl: 'https://janus.test',
    rechazadosSurveyInviteCampaignId: null,
    rechazadosSurveyInviteStep1CampaignId: '6',
    rechazadosSurveyInviteStep2CampaignId: '7',
    rechazadosSurveyInviteStep3CampaignId: '8',
    rechazadosSurveyInviteNormalCutoffAt: '2026-09-15T00:00:00.000Z',
  },
};

const {
  isContinuousRejectedSurveyCampaign,
  resolveRecalculatedCampaignStatus,
} = require('../src/lib/rejectedSurveyInviteContinuousCampaigns');
const {
  decideSurveyInviteSequenceAction,
} = require('../src/lib/rejectedSurveyInviteEvaluate');
const {
  SEQUENCE_REASONS,
} = require('../src/lib/rejectedSurveyInviteSequence');
const { PURPOSE } = require('../src/lib/rejectedSurveyInvite');

const CUTOFF = {
  ok: true,
  ms: Date.parse('2026-09-15T00:00:00.000Z'),
};
const T0 = '2026-09-20T12:00:00.000Z';
const hoursAfter = function (h) {
  return new Date(Date.parse(T0) + h * 3600 * 1000);
};

function decide(opts) {
  return decideSurveyInviteSequenceAction({
    ci: 12345678,
    now: opts.now,
    lastRejection: {
      cz_solicitud_id: 1370,
      fechahora_src: T0,
    },
    solicitud: {
      cz_id: 1370,
      email: 'a@example.com',
      lrw_id: 'LRW-1',
      nombre: 'A',
    },
    hasEncuesta: false,
    isSuppressed: false,
    stepCampaignIds: { 1: '6', 2: '7', 3: '8' },
    attemptsByStep: opts.attemptsByStep || { 1: null, 2: null, 3: null },
    publicBaseUrlConfigured: true,
    normalCutoff: CUTOFF,
  });
}

// --- Config detection ---
assert.strictEqual(isContinuousRejectedSurveyCampaign(6), true);
assert.strictEqual(isContinuousRejectedSurveyCampaign('7'), true);
assert.strictEqual(isContinuousRejectedSurveyCampaign(8), true);
assert.strictEqual(isContinuousRejectedSurveyCampaign(11), false);
assert.strictEqual(isContinuousRejectedSurveyCampaign(999), false);

// CONFIG CHANGE semantics: A→B
{
  const before = { 1: '6', 2: '7', 3: '8' };
  const after = { 1: '106', 2: '7', 3: '8' };
  assert.strictEqual(
    isContinuousRejectedSurveyCampaign(6, before),
    true,
    'A continuous before flip',
  );
  assert.strictEqual(
    isContinuousRejectedSurveyCampaign(6, after),
    false,
    'A not continuous after STEP1 points to B',
  );
  assert.strictEqual(
    isContinuousRejectedSurveyCampaign(106, after),
    true,
    'B continuous after flip',
  );
}

// Test 1 — CONTINUOUS EMPTY AFTER SEND → sending
assert.strictEqual(
  resolveRecalculatedCampaignStatus({
    queued: 0,
    sent: 10,
    failed: 0,
    isContinuous: true,
  }),
  'sending',
);

// Test 2 — NORMAL BATCH → completed
assert.strictEqual(
  resolveRecalculatedCampaignStatus({
    queued: 0,
    sent: 10,
    failed: 0,
    isContinuous: false,
  }),
  'completed',
);

// queued continuous stays sending
assert.strictEqual(
  resolveRecalculatedCampaignStatus({
    queued: 2,
    sent: 10,
    failed: 0,
    isContinuous: true,
  }),
  'sending',
);

// partial_error unchanged for continuous
assert.strictEqual(
  resolveRecalculatedCampaignStatus({
    queued: 0,
    sent: 5,
    failed: 1,
    isContinuous: true,
  }),
  'partial_error',
);

assert.strictEqual(
  resolveRecalculatedCampaignStatus({
    queued: 0,
    sent: 0,
    failed: 2,
    isContinuous: false,
  }),
  'error',
);

// Test 5 — WRONG CAMPAIGN uses batch
assert.strictEqual(isContinuousRejectedSurveyCampaign(42), false);
assert.strictEqual(
  resolveRecalculatedCampaignStatus({
    queued: 0,
    sent: 1,
    failed: 0,
    isContinuous: isContinuousRejectedSurveyCampaign(42),
  }),
  'completed',
);

// Test 6 — STEP1 PENDING blocks STEP2
{
  const d = decide({
    now: hoursAfter(25),
    attemptsByStep: {
      1: { status: 'queued', created_at: hoursAfter(3).toISOString() },
      2: null,
      3: null,
    },
  });
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.result, SEQUENCE_REASONS.PREVIOUS_PENDING);
  assert.strictEqual(d.due_step, 2);
}

// Test 3 — REOPEN ON MATERIALIZATION (migration SQL atomicity contract)
{
  const migPath = path.join(
    __dirname,
    '..',
    'migrations',
    '20260921_email_survey_invite_continuous_campaign_reopen.sql',
  );
  const sql = fs.readFileSync(migPath, 'utf8');
  assert.ok(
    sql.indexOf("status = 'sending'") !== -1,
    'migration reopens to sending',
  );
  assert.ok(
    sql.indexOf("status = 'completed'") !== -1,
    'migration only from completed',
  );
  assert.ok(
    sql.indexOf("btrim(p_purpose) = 'rechazados_survey_invite'") !== -1,
    'reopen gated by survey purpose',
  );
  // Reopen after recipient FOR UPDATE, before RETURN → same function TX
  const forUpdateIdx = sql.indexOf('FOR UPDATE');
  const reopenIdx = sql.indexOf(
    "UPDATE public.email_campaigns",
  );
  const returnIdx = sql.indexOf('RETURN jsonb_build_object');
  assert.ok(forUpdateIdx > 0, 'locks recipient row');
  assert.ok(
    reopenIdx > forUpdateIdx && returnIdx > reopenIdx,
    'reopen between recipient lock and return (same TX)',
  );
  assert.ok(
    sql.indexOf('AND status = \'completed\'') !== -1 ||
      sql.indexOf("AND status = 'completed'") !== -1,
    'idempotent: only completed→sending',
  );
  assert.ok(
    sql.toLowerCase().indexOf('does not touch partial_error') !== -1,
    'must not auto-recover partial_error',
  );
  // No hardcode of campaign ids 6/7/8 in reopen predicate
  assert.ok(
    !/WHERE id = p_campaign_id\s+AND status = 'completed'\s+AND id IN \(6/.test(
      sql,
    ),
    'no hardcoded continuous IDs in reopen',
  );
}

// ---------------------------------------------------------------------------
// REOPEN_VS_PROCESSQUEUE_CONCURRENCY_TEST
// Type: deterministic contract (not live Postgres interleaving)
// ---------------------------------------------------------------------------
// Proves (from code + migration structure):
//   A) PQ before RPC commit cannot see uncommitted recipient (Postgres TX)
//   B) PQ after commit sees recipient queued + campaign sending together
//      because reopen UPDATE is in the same PL/pgSQL function body before RETURN
//   C) No committed observable state "queued + completed" from this RPC path
//   D) Duplicate send prevented by recipient idempotency_key / provider key
//      (existing processor semantics; not re-tested here)
//   E) Recipient not lost: INSERT … ON CONFLICT DO NOTHING + SELECT FOR UPDATE
//   F) Locks due vs processQueue are independent — NOT the atomicity guarantee;
//      atomicity is the RPC transaction.
// Does NOT prove: live race under concurrent sessions; snapshot frontier after RPC.
{
  const label = 'REOPEN_VS_PROCESSQUEUE_CONCURRENCY_TEST';
  const migPath = path.join(
    __dirname,
    '..',
    'migrations',
    '20260921_email_survey_invite_continuous_campaign_reopen.sql',
  );
  const sql = fs.readFileSync(migPath, 'utf8');
  const dueJob = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'jobs', 'rechazadosSurveyInviteDue.js'),
    'utf8',
  );
  const proc = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'src',
      'services',
      'email-campaigns',
      'processor.js',
    ),
    'utf8',
  );

  // F — independent locks
  assert.ok(
    dueJob.indexOf("'rechazados_survey_invite_due'") !== -1 ||
      dueJob.indexOf('rechazados_survey_invite_due') !== -1,
    label + ' F due lock name',
  );
  assert.ok(
    proc.indexOf('email_campaigns_process_queue') !== -1,
    label + ' F processQueue lock name',
  );
  assert.ok(
    dueJob.indexOf('email_campaigns_process_queue') === -1,
    label + ' F locks are independent',
  );

  // B+C — reopen in same function before any RETURN (single TX with recipient)
  const insertIdx = sql.indexOf('INSERT INTO public.email_campaign_recipients');
  const reopenIdx = sql.indexOf('UPDATE public.email_campaigns');
  const firstReturn = sql.indexOf('RETURN jsonb_build_object');
  assert.ok(insertIdx > 0 && reopenIdx > insertIdx && firstReturn > reopenIdx, label + ' B/C order');

  // E — recipient retained via conflict + for update
  assert.ok(sql.indexOf('ON CONFLICT (idempotency_key) DO NOTHING') !== -1, label + ' E');
  assert.ok(sql.indexOf('FOR UPDATE') !== -1, label + ' E lock');

  // A — modeled: uncommitted work invisible to concurrent PQ (Postgres default READ COMMITTED)
  // Documented contract; cannot observe phantom without live harness.
  assert.ok(sql.indexOf('LANGUAGE plpgsql') !== -1, label + ' A plpgsql single TX');

  console.log(label + ': PASS (deterministic contract)');
}

// Test 7 — PROCESSQUEUE ELIGIBILITY: sending is send-allowed; completed is not
{
  const proc = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'src',
      'services',
      'email-campaigns',
      'processor.js',
    ),
    'utf8',
  );
  assert.ok(
    proc.indexOf(
      "SEND_ALLOWED_STATUSES = new Set(['draft', 'scheduled', 'sending'])",
    ) !== -1,
  );
  assert.ok(proc.indexOf('isContinuousRejectedSurveyCampaign') !== -1);
  assert.ok(proc.indexOf('resolveRecalculatedCampaignStatus') !== -1);
}

// Snapshot frontier remains outside RPC (existing architecture)
{
  const mat = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'src',
      'lib',
      'rejectedSurveyInviteMaterialize.js',
    ),
    'utf8',
  );
  assert.ok(
    mat.indexOf('RPC→snapshot frontier is not') !== -1 ||
      mat.indexOf('frontier is not') !== -1,
  );
}

console.log('unit-rejected-survey-invite-continuous-campaigns: PASS');
console.log(
  JSON.stringify(
    {
      CONFIG_CHANGE_ASSUMPTION:
        'Continuity follows active STEP1/2/3 env only',
      CONFIG_CHANGE_RISK:
        'Old STEP campaign becomes batch; pending queued may complete after drain',
      FUTURE_MIGRATION_REQUIREMENT:
        'Drain/verify queued on previous campaign before flipping STEP env',
      DUE_AND_PROCESS_QUEUE_LOCKS_COORDINATED: false,
      ATOMICITY_GUARANTEE:
        'Postgres function TX: recipient row + reopen completed→sending before commit',
      CONCURRENCY_TEST_NAME: 'REOPEN_VS_PROCESSQUEUE_CONCURRENCY_TEST',
      CONCURRENCY_TEST_TYPE: 'deterministic contract',
    },
    null,
    2,
  ),
);
