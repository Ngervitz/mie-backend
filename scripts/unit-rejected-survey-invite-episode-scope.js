'use strict';

/**
 * Episode-scoped survey invites — matrix A–M (unit, no prod I/O).
 * node scripts/unit-rejected-survey-invite-episode-scope.js
 */

const assert = require('assert');

process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.RECHAZADOS_SURVEY_INVITE_CAMPAIGN_ID = '6';
process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';
process.env.EMAIL_PROVIDER_MODE = 'log';
process.env.RECHAZADOS_SURVEY_INVITE_NORMAL_CUTOFF_AT = '2026-09-15T00:00:00.000Z';

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
    rechazadosSurveyInviteCampaignId: '6',
    rechazadosSurveyInviteNormalCutoffAt: '2026-09-15T00:00:00.000Z',
  },
};

const {
  PURPOSE,
  REASONS,
  buildSurveyInviteIdempotencyKey,
  evaluateRejectedSurveyInviteEligibility,
} = require('../src/lib/rejectedSurveyInvite');
const {
  attachSurveySequenceToListRows,
} = require('../src/lib/rejectedSurveyInviteDisplay');
const {
  decideSurveyInviteSequenceAction,
} = require('../src/lib/rejectedSurveyInviteEvaluate');
const {
  SEQUENCE_REASONS,
} = require('../src/lib/rejectedSurveyInviteSequence');
const H = require('../public/rechazados-helpers');

const results = [];
function pass(id, ok, detail) {
  results.push({ id: id, ok: Boolean(ok), detail: detail || null });
  if (!ok) {
    console.error('FAIL', id, detail || '');
  }
}

// A — generic same campaign/email still conceptually blocked by partial unique
// (purpose ≠ survey). Documented by key shape: survey keys never use :ci:.
pass(
  'A',
  buildSurveyInviteIdempotencyKey(6, 1357).indexOf(':ci:') === -1 &&
    buildSurveyInviteIdempotencyKey(6, 1357).indexOf(':cz:1357') !== -1,
);

// B — same campaign + same cz → same idempotency key
{
  const a = buildSurveyInviteIdempotencyKey(6, 1357);
  const b = buildSurveyInviteIdempotencyKey(6, 1357);
  pass('B', a === b && a === 'rechazados_survey_invite:campaign:6:cz:1357');
}

// C — same campaign + different cz → different keys (two STEP1 allowed)
pass(
  'C',
  buildSurveyInviteIdempotencyKey(6, 1154) !==
    buildSurveyInviteIdempotencyKey(6, 1357),
);

// D — legacy NULL does not share key with new episode (new always has cz)
pass(
  'D',
  buildSurveyInviteIdempotencyKey(6, 1357) !==
    'rechazados_survey_invite:campaign:6:ci:15088043',
);

// E — CI 15088043: legacy S1/S2 NULL excluded; current cz 1357 → clock
(async function () {
  const sb = {
    from: function () {
      return {
        select: function () {
          return {
            in: function () {
              return {
                eq: function () {
                  return {
                    eq: function () {
                      return {
                        in: async function () {
                          // Episode query for 1357 returns empty (legacy NULL not matched)
                          return { data: [], error: null };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const rows = await attachSurveySequenceToListRows(sb, [
    { ci: 15088043, cz_solicitud_id: 1357 },
  ]);
  const seq = rows[0].survey_sequence;
  const cell = H.scoreCell(null, seq);
  pass(
    'E',
    seq.step1_sent_at == null &&
      seq.step2_sent_at == null &&
      seq.step3_sent_at == null &&
      cell.kind === 'clock',
  );

  // F — after STEP1 for cz 1357 → display S1
  const sbF = {
    from: function () {
      return {
        select: function () {
          return {
            in: function () {
              return {
                eq: function () {
                  return {
                    eq: function () {
                      return {
                        in: async function () {
                          return {
                            data: [
                              {
                                ci: '15088043',
                                campaign_id: 6,
                                status: 'sent',
                                purpose: PURPOSE,
                                sent_at: '2026-09-20T12:00:00.000Z',
                                cz_solicitud_id: 1357,
                              },
                            ],
                            error: null,
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const rowsF = await attachSurveySequenceToListRows(sbF, [
    { ci: 15088043, cz_solicitud_id: 1357 },
  ]);
  pass(
    'F',
    H.scoreCell(null, rowsF[0].survey_sequence).label === 'S1' &&
      rowsF[0].survey_sequence.step1_sent_at === '2026-09-20T12:00:00.000Z',
  );

  // G — rematerialize same key (idempotent shape)
  pass(
    'G',
    buildSurveyInviteIdempotencyKey(6, 1357) ===
      buildSurveyInviteIdempotencyKey('6', '1357'),
  );

  // H — future cz same CI → new STEP1 key
  pass(
    'H',
    buildSurveyInviteIdempotencyKey(6, 9999) !==
      buildSurveyInviteIdempotencyKey(6, 1357),
  );

  // I — completion lifetime: hasEncuesta → SURVEY_ALREADY_COMPLETED
  {
    const elig = evaluateRejectedSurveyInviteEligibility({
      ci: 15088043,
      campaignId: '6',
      publicBaseUrlConfigured: true,
      lastRejection: { cz_solicitud_id: 9999 },
      solicitud: {
        cz_id: 9999,
        email: 'x@example.com',
        lrw_id: 'LRW',
        nombre: 'X',
      },
      hasEncuesta: true,
      isSuppressed: false,
      priorRecipient: null,
    });
    pass(
      'I',
      elig.eligible === false &&
        elig.reason === REASONS.SURVEY_ALREADY_COMPLETED,
    );
  }

  // J — unsubscribe global: suppressed on new episode
  {
    const elig = evaluateRejectedSurveyInviteEligibility({
      ci: 15088043,
      campaignId: '6',
      publicBaseUrlConfigured: true,
      lastRejection: { cz_solicitud_id: 9999 },
      solicitud: {
        cz_id: 9999,
        email: 'x@example.com',
        lrw_id: 'LRW',
        nombre: 'X',
      },
      hasEncuesta: false,
      isSuppressed: true,
      priorRecipient: null,
    });
    pass(
      'J',
      elig.eligible === false && elig.reason === REASONS.EMAIL_SUPPRESSED,
    );
  }

  // K — cutoff: old T0 before cutoff skipped; new episode after cutoff can enter
  {
    const stepIds = { 1: '6', 2: '7', 3: '8' };
    const cutoff = {
      ok: true,
      ms: Date.parse('2026-09-15T00:00:00.000Z'),
    };
    const oldDec = decideSurveyInviteSequenceAction({
      ci: 15088043,
      now: new Date('2026-09-20T12:00:00.000Z'),
      lastRejection: {
        cz_solicitud_id: 1154,
        fechahora_src: '2026-09-01T00:00:00.000Z',
      },
      solicitud: {
        email: 'x@example.com',
        lrw_id: 'LRW',
        nombre: 'X',
      },
      hasEncuesta: false,
      isSuppressed: false,
      stepCampaignIds: stepIds,
      attemptsByStep: { 1: null, 2: null, 3: null },
      publicBaseUrlConfigured: true,
      normalCutoff: cutoff,
    });
    const newDec = decideSurveyInviteSequenceAction({
      ci: 15088043,
      now: new Date('2026-09-20T12:00:00.000Z'),
      lastRejection: {
        cz_solicitud_id: 1357,
        fechahora_src: '2026-09-20T07:00:10.000Z',
      },
      solicitud: {
        email: 'x@example.com',
        lrw_id: 'LRW',
        nombre: 'X',
      },
      hasEncuesta: false,
      isSuppressed: false,
      stepCampaignIds: stepIds,
      attemptsByStep: { 1: null, 2: null, 3: null },
      publicBaseUrlConfigured: true,
      normalCutoff: cutoff,
    });
    pass(
      'K',
      oldDec.result === SEQUENCE_REASONS.BEFORE_NORMAL_CUTOFF &&
        newDec.action === 'materialize' &&
        newDec.due_step === 1,
      JSON.stringify({
        old: oldDec.result,
        newAction: newDec.action,
        newStep: newDec.due_step,
        newResult: newDec.result,
      }),
    );
  }

  // L — concurrency: same campaign+cz → one key
  pass(
    'L',
    buildSurveyInviteIdempotencyKey(6, 1357) ===
      buildSurveyInviteIdempotencyKey(6, 1357),
  );

  // M — historical timing constants unchanged (24h / 72h)
  {
    const {
      STEP2_OFFSET_MS,
      STEP3_OFFSET_MS,
      MS_HOUR,
    } = require('../src/lib/rejectedSurveyInviteHistorical');
    pass(
      'M',
      STEP2_OFFSET_MS === 24 * MS_HOUR && STEP3_OFFSET_MS === 72 * MS_HOUR,
    );
  }

  // Fail closed without cz
  {
    let threw = false;
    try {
      buildSurveyInviteIdempotencyKey(6, null);
    } catch (e) {
      threw = true;
    }
    pass('FAIL_CLOSED_NO_CZ', threw);
  }

  const failed = results.filter(function (r) {
    return !r.ok;
  });
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        results: results,
      },
      null,
      2,
    ),
  );
  if (failed.length) process.exit(1);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
