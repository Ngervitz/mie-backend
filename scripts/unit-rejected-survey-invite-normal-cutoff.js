'use strict';

/**
 * Normal cutoff fail-closed + decide/job gates.
 * node scripts/unit-rejected-survey-invite-normal-cutoff.js
 */

const assert = require('assert');

process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';
process.env.RECHAZADOS_SURVEY_INVITE_STEP1_CAMPAIGN_ID = '101';
process.env.RECHAZADOS_SURVEY_INVITE_STEP2_CAMPAIGN_ID = '102';
process.env.RECHAZADOS_SURVEY_INVITE_STEP3_CAMPAIGN_ID = '103';
delete process.env.RECHAZADOS_SURVEY_INVITE_NORMAL_CUTOFF_AT;

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
    rechazadosSurveyInviteCampaignId: null,
    rechazadosSurveyInviteStep1CampaignId: '101',
    rechazadosSurveyInviteStep2CampaignId: '102',
    rechazadosSurveyInviteStep3CampaignId: '103',
    rechazadosSurveyInviteNormalCutoffAt: null,
  },
};

const {
  parseNormalCutoffAt,
  resolveNormalCutoffAt,
  isT0AtOrAfterNormalCutoff,
  CUTOFF_ENV_NAME,
  NORMAL_CUTOFF_REASONS,
} = require('../src/lib/rejectedSurveyInviteNormalCutoff');
const {
  decideSurveyInviteSequenceAction,
  SEQUENCE_REASONS,
  REASONS,
} = require('../src/lib/rejectedSurveyInviteEvaluate');
const {
  resolveDueSurveyInviteStep,
  MS_HOUR,
} = require('../src/lib/rejectedSurveyInviteSequence');
const {
  runRechazadosSurveyInviteDue,
} = require('../src/jobs/rechazadosSurveyInviteDue');
const {
  runHistoricalSurveyInvitePilot,
} = require('../src/lib/rejectedSurveyInviteHistoricalPilot');
const {
  HISTORICAL_PILOT_STEP_CAMPAIGN_IDS,
} = require('../src/lib/rejectedSurveyInviteHistorical');

const CUTOFF = '2026-09-19T15:42:45.000Z';
const CUTOFF_MS = Date.parse(CUTOFF);
const CI = 42424242;

function lastAt(iso) {
  return {
    ci: CI,
    cz_solicitud_id: 5001,
    cz_historico_id: 9001,
    fechahora_src: iso,
  };
}

function decide(over) {
  return decideSurveyInviteSequenceAction(
    Object.assign(
      {
        ci: CI,
        now: new Date(CUTOFF_MS + 3 * MS_HOUR),
        lastRejection: lastAt(CUTOFF),
        solicitud: {
          cz_id: 5001,
          ci: CI,
          email: 'a@example.com',
          lrw_id: 'L1',
          nombre: 'A',
        },
        hasEncuesta: false,
        isSuppressed: false,
        stepCampaignIds: { 1: '101', 2: '102', 3: '103' },
        attemptsByStep: { 1: null, 2: null, 3: null },
        publicBaseUrlConfigured: true,
        normalCutoffAtMs: CUTOFF_MS,
      },
      over || {},
    ),
  );
}

// parse
assert.strictEqual(CUTOFF_ENV_NAME, 'RECHAZADOS_SURVEY_INVITE_NORMAL_CUTOFF_AT');
assert.strictEqual(parseNormalCutoffAt(null).ok, false);
assert.strictEqual(parseNormalCutoffAt('').ok, false);
assert.strictEqual(parseNormalCutoffAt('   ').ok, false);
assert.strictEqual(parseNormalCutoffAt('not-a-date').ok, false);
assert.strictEqual(parseNormalCutoffAt('2026-09-19T15:42:45').ok, false); // no TZ
assert.strictEqual(parseNormalCutoffAt(CUTOFF).ok, true);
assert.strictEqual(parseNormalCutoffAt(CUTOFF).ms, CUTOFF_MS);

// 1-3 fail-closed resolve
assert.strictEqual(resolveNormalCutoffAt({}).ok, false);
assert.strictEqual(resolveNormalCutoffAt({ cutoffRaw: '' }).ok, false);
assert.strictEqual(resolveNormalCutoffAt({ cutoffRaw: 'bad' }).ok, false);

// 4-6 boundary
assert.strictEqual(
  isT0AtOrAfterNormalCutoff(
    new Date(CUTOFF_MS - 1).toISOString(),
    CUTOFF_MS,
  ),
  false,
);
assert.strictEqual(isT0AtOrAfterNormalCutoff(CUTOFF, CUTOFF_MS), true);
assert.strictEqual(
  isT0AtOrAfterNormalCutoff(
    new Date(CUTOFF_MS + 1).toISOString(),
    CUTOFF_MS,
  ),
  true,
);

// decide: missing cutoff
{
  const d = decide({ normalCutoffAtMs: null, normalCutoff: { ok: false } });
  assert.strictEqual(
    d.result,
    SEQUENCE_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
  );
  assert.strictEqual(d.action, 'skip');
}

// 4 T0 1ms before
{
  const d = decide({
    lastRejection: lastAt(new Date(CUTOFF_MS - 1).toISOString()),
    now: new Date(CUTOFF_MS + 10 * MS_HOUR),
  });
  assert.strictEqual(d.result, SEQUENCE_REASONS.BEFORE_NORMAL_CUTOFF);
  assert.strictEqual(d.action, 'skip');
}

// 5 exact cutoff + age 3h → STEP1
{
  const d = decide({
    lastRejection: lastAt(CUTOFF),
    now: new Date(CUTOFF_MS + 3 * MS_HOUR),
  });
  assert.strictEqual(d.action, 'materialize');
  assert.strictEqual(d.due_step, 1);
}

// 6 after cutoff
{
  const d = decide({
    lastRejection: lastAt(new Date(CUTOFF_MS + 1000).toISOString()),
    now: new Date(CUTOFF_MS + 1000 + 3 * MS_HOUR),
  });
  assert.strictEqual(d.due_step, 1);
  assert.strictEqual(d.action, 'materialize');
}

// 7 age <2h
{
  const d = decide({
    lastRejection: lastAt(CUTOFF),
    now: new Date(CUTOFF_MS + 1 * MS_HOUR),
  });
  assert.strictEqual(d.result, SEQUENCE_REASONS.NOT_DUE);
}

// 8 STEP1 window
assert.strictEqual(
  resolveDueSurveyInviteStep(CUTOFF, new Date(CUTOFF_MS + 3 * MS_HOUR)),
  1,
);

// 9 STEP2 catch-up
{
  const d = decide({
    lastRejection: lastAt(CUTOFF),
    now: new Date(CUTOFF_MS + 30 * MS_HOUR),
  });
  assert.strictEqual(d.due_step, 2);
  assert.strictEqual(d.action, 'materialize');
}

// 10 STEP3 catch-up
{
  const d = decide({
    lastRejection: lastAt(CUTOFF),
    now: new Date(CUTOFF_MS + 80 * MS_HOUR),
  });
  assert.strictEqual(d.due_step, 3);
  assert.strictEqual(d.action, 'materialize');
}

// --- CUTOFF × CATCH-UP cross matrix (no prior STEP attempts) ---
// Real semantics (audited): resolveDueSurveyInviteStep is pure age catch-up;
// there is NO "never received STEP → force STEP1" gate. Missing prior steps
// do not block; only PENDING/REPAIRABLE earlier attempts block via previous_pending.
{
  const noPrior = { 1: null, 2: null, 3: null };

  // A) T0 == cutoff, STEP1 age → materialize STEP1
  {
    const d = decide({
      lastRejection: lastAt(CUTOFF),
      now: new Date(CUTOFF_MS + 3 * MS_HOUR),
      attemptsByStep: noPrior,
    });
    assert.strictEqual(d.result, REASONS.ELIGIBLE);
    assert.strictEqual(d.action, 'materialize');
    assert.strictEqual(d.due_step, 1);
    assert.strictEqual(String(d.campaign_id), '101');
  }

  // B) T0 == cutoff, STEP2 chronological age, no prior → catch-up STEP2
  {
    const d = decide({
      lastRejection: lastAt(CUTOFF),
      now: new Date(CUTOFF_MS + 30 * MS_HOUR),
      attemptsByStep: noPrior,
    });
    assert.strictEqual(d.action, 'materialize');
    assert.strictEqual(d.due_step, 2);
    assert.strictEqual(String(d.campaign_id), '102');
  }

  // C) T0 == cutoff, STEP3 chronological age, no prior → catch-up STEP3
  {
    const d = decide({
      lastRejection: lastAt(CUTOFF),
      now: new Date(CUTOFF_MS + 80 * MS_HOUR),
      attemptsByStep: noPrior,
    });
    assert.strictEqual(d.action, 'materialize');
    assert.strictEqual(d.due_step, 3);
    assert.strictEqual(String(d.campaign_id), '103');
  }

  // D) T0 = cutoff - 1ms, age would be STEP3 → before_normal_cutoff (no materialize)
  {
    const t0 = new Date(CUTOFF_MS - 1).toISOString();
    const now = new Date(CUTOFF_MS - 1 + 80 * MS_HOUR);
    assert.strictEqual(resolveDueSurveyInviteStep(t0, now), 3);
    const d = decide({
      lastRejection: lastAt(t0),
      now: now,
      attemptsByStep: noPrior,
    });
    assert.strictEqual(d.result, SEQUENCE_REASONS.BEFORE_NORMAL_CUTOFF);
    assert.strictEqual(d.action, 'skip');
    assert.strictEqual(d.due_step, null);
  }

  // E) T0 = cutoff + 1ms → enters normal; catch-up by age applies
  {
    const t0 = new Date(CUTOFF_MS + 1).toISOString();
    const nowStep1 = new Date(CUTOFF_MS + 1 + 3 * MS_HOUR);
    const d1 = decide({
      lastRejection: lastAt(t0),
      now: nowStep1,
      attemptsByStep: noPrior,
    });
    assert.strictEqual(d1.action, 'materialize');
    assert.strictEqual(d1.due_step, 1);

    const nowStep2 = new Date(CUTOFF_MS + 1 + 30 * MS_HOUR);
    const d2 = decide({
      lastRejection: lastAt(t0),
      now: nowStep2,
      attemptsByStep: noPrior,
    });
    assert.strictEqual(d2.action, 'materialize');
    assert.strictEqual(d2.due_step, 2);
  }
}

// Job: cutoff absent → 0 materializations even with STEP envs
(async function main() {
  {
    const out = await runRechazadosSurveyInviteDue({
      skipLock: true,
      cutoffRaw: null,
      materializeFn: async function () {
        throw new Error('must not materialize');
      },
      supabase: {
        from: function () {
          throw new Error('must not query when cutoff missing');
        },
      },
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(
      out.reason,
      SEQUENCE_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
    );
    assert.strictEqual(out.materialized_step1, 0);
    assert.strictEqual(out.materialized_step2, 0);
    assert.strictEqual(out.materialized_step3, 0);
  }

  // Job: STEP configured + invalid cutoff → 0 writes
  {
    const out = await runRechazadosSurveyInviteDue({
      skipLock: true,
      cutoffRaw: 'invalid',
      materializeFn: async function () {
        throw new Error('must not materialize');
      },
      supabase: {
        from: function () {
          throw new Error('must not query');
        },
      },
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(
      out.reason,
      SEQUENCE_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
    );
  }

  // Job mixed CIs: only normal materializes
  {
    const histIso = new Date(CUTOFF_MS - 86400000).toISOString();
    const normIso = CUTOFF;
    const now = new Date(CUTOFF_MS + 3 * MS_HOUR);
    const materializeCalls = [];
    function makeChain(result) {
      const chain = {
        select: function () {
          return chain;
        },
        eq: function () {
          return chain;
        },
        in: function () {
          return chain;
        },
        then: function (resolve, reject) {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }
    const supabase = {
      from: function (table) {
        if (table === 'cz_funnel_solicitud_estados') {
          return makeChain({
            data: [
              {
                cz_historico_id: 1,
                cz_solicitud_id: 10,
                fechahora_src: histIso,
                solicitudes_estados_id: 3,
              },
              {
                cz_historico_id: 2,
                cz_solicitud_id: 20,
                fechahora_src: normIso,
                solicitudes_estados_id: 3,
              },
            ],
            error: null,
          });
        }
        if (table === 'cz_funnel_solicitudes') {
          return makeChain({
            data: [
              {
                cz_id: 10,
                ci: 111,
                email: 'h@example.com',
                lrw_id: 'H',
                nombre: 'H',
              },
              {
                cz_id: 20,
                ci: 222,
                email: 'n@example.com',
                lrw_id: 'N',
                nombre: 'N',
              },
            ],
            error: null,
          });
        }
        return makeChain({ data: [], error: null });
      },
    };

    const out = await runRechazadosSurveyInviteDue({
      skipLock: true,
      now: now,
      cutoffMs: CUTOFF_MS,
      supabase: supabase,
      materializeFn: async function (_sb, ci, campaignId) {
        materializeCalls.push({ ci: ci, campaignId: campaignId });
        return { ok: true, result: 'queued', recipient_id: 1 };
      },
    });
    assert.strictEqual(out.ok, true);
    assert.ok(out.before_normal_cutoff >= 1);
    assert.strictEqual(materializeCalls.length, 1);
    assert.strictEqual(Number(materializeCalls[0].ci), 222);
    assert.strictEqual(String(materializeCalls[0].campaignId), '101');
  }

  // Historical: materialize primitive still exported; NORMAL decide fail-closed
  // does not live inside materializeRejectedSurveyInvite
  {
    const {
      materializeRejectedSurveyInvite,
    } = require('../src/lib/rejectedSurveyInviteMaterialize');
    assert.strictEqual(typeof materializeRejectedSurveyInvite, 'function');
    assert.strictEqual(HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[1], 6);
    const blocked = decideSurveyInviteSequenceAction({
      ci: CI,
      now: new Date(),
      lastRejection: lastAt(CUTOFF),
      solicitud: null,
      hasEncuesta: false,
      isSuppressed: false,
      stepCampaignIds: { 1: '6', 2: '7', 3: '8' },
      attemptsByStep: { 1: null, 2: null, 3: null },
      publicBaseUrlConfigured: true,
    });
    assert.strictEqual(
      blocked.result,
      SEQUENCE_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
    );
  }

  console.log('unit-rejected-survey-invite-normal-cutoff: PASS');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
