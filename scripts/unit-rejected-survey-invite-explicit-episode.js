'use strict';
/**
 * Explicit episode materialize + historical pilot cz preservation.
 * node scripts/unit-rejected-survey-invite-explicit-episode.js
 */

const assert = require('assert');

process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';
process.env.EMAIL_PROVIDER_MODE = 'log';

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
    rechazadosSurveyInviteStep1CampaignId: '6',
    rechazadosSurveyInviteStep2CampaignId: '7',
    rechazadosSurveyInviteStep3CampaignId: '8',
  },
};

const {
  REASONS,
  buildSurveyInviteIdempotencyKey,
} = require('../src/lib/rejectedSurveyInvite');
const {
  HISTORICAL_PILOT_CZ_IDS,
  decideHistoricalSurveyInviteAction,
  buildHistoricalPilotAttemptsByStep,
  putPreferredAttempt,
  MS_HOUR,
} = require('../src/lib/rejectedSurveyInviteHistorical');

const CI = 15088043;
const HIST_CZ = 1154;
const CUR_CZ = 1357;

function makeEligibilitySupabase(opts) {
  const state = opts || {};
  const solicitudes = state.solicitudes || [
    {
      cz_id: HIST_CZ,
      ci: CI,
      email: 'jp@example.com',
      lrw_id: 'LRW-HIST',
      nombre: 'Hist',
    },
    {
      cz_id: CUR_CZ,
      ci: CI,
      email: 'jp@example.com',
      lrw_id: 'LRW-CUR',
      nombre: 'Cur',
    },
  ];
  const estados = state.estados || [
    {
      cz_historico_id: 1,
      cz_solicitud_id: HIST_CZ,
      fechahora_src: '2026-08-01T00:00:00Z',
      solicitudes_estados_id: 3,
    },
    {
      cz_historico_id: 2,
      cz_solicitud_id: CUR_CZ,
      fechahora_src: '2026-09-20T00:00:00Z',
      solicitudes_estados_id: 3,
    },
  ];
  const recipients = state.recipients || [];

  return {
    from: function (table) {
      const q = {
        _table: table,
        _filters: {},
        select: function () {
          return q;
        },
        eq: function (col, val) {
          q._filters[col] = val;
          return q;
        },
        order: function () {
          return q;
        },
        limit: function () {
          return q;
        },
        maybeSingle: async function () {
          if (table === 'email_suppressions') {
            return { data: null, error: null };
          }
          if (table === 'email_campaign_recipients') {
            const camp = q._filters.campaign_id;
            const cz = q._filters.cz_solicitud_id;
            const row =
              recipients.find(function (r) {
                return (
                  String(r.campaign_id) === String(camp) &&
                  Number(r.cz_solicitud_id) === Number(cz)
                );
              }) || null;
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
        then: undefined,
      };
      // Make thenable for await supabase.from().select()...
      q.then = function (resolve, reject) {
        return (async function () {
          if (table === 'cz_funnel_solicitud_estados') {
            return { data: estados, error: null };
          }
          if (table === 'cz_funnel_solicitudes') {
            return { data: solicitudes, error: null };
          }
          if (table === 'cz_funnel_encuestas') {
            return { data: null, error: null, count: state.encCount || 0 };
          }
          return { data: [], error: null };
        })().then(resolve, reject);
      };
      // head count for encuestas
      q.select = function (cols, opts2) {
        q._selectOpts = opts2;
        return q;
      };
      return q;
    },
  };
}

(async function main() {
  delete require.cache[
    require.resolve('../src/lib/rejectedSurveyInviteEligibility')
  ];
  const {
    getRejectedSurveyInviteEligibility,
  } = require('../src/lib/rejectedSurveyInviteEligibility');

  // TEST 1 — historical explicit episode 1154 (latest global is 1357)
  {
    const sb = makeEligibilitySupabase();
    const elig = await getRejectedSurveyInviteEligibility(sb, CI, {
      campaignId: 8,
      czSolicitudId: HIST_CZ,
    });
    assert.strictEqual(elig.eligible, true, 'hist eligible');
    assert.strictEqual(Number(elig.cz_solicitud_id), HIST_CZ);
    assert.strictEqual(elig.lrw_id, 'LRW-HIST');
    assert.notStrictEqual(Number(elig.cz_solicitud_id), CUR_CZ);
  }

  // TEST 2 — normal (no explicit) uses latest rejection 1357
  {
    const sb = makeEligibilitySupabase();
    const elig = await getRejectedSurveyInviteEligibility(sb, CI, {
      campaignId: 8,
    });
    assert.strictEqual(elig.eligible, true, 'normal eligible');
    assert.strictEqual(Number(elig.cz_solicitud_id), CUR_CZ);
    assert.strictEqual(elig.lrw_id, 'LRW-CUR');
  }

  // TEST 3 — all 10 historical targets via decide + attempt bridge
  {
    const tHist = '2026-09-17T21:26:00.000Z';
    for (let i = 0; i < HISTORICAL_PILOT_CZ_IDS.length; i += 1) {
      const cz = HISTORICAL_PILOT_CZ_IDS[i];
      const ci = 10000000 + cz;
      const episodeScoped = new Map();
      const legacyNull = new Map();
      putPreferredAttempt(legacyNull, '6:' + ci, {
        id: 1,
        campaign_id: 6,
        ci: String(ci),
        status: 'sent',
        sent_at: tHist,
        cz_solicitud_id: null,
      });
      putPreferredAttempt(legacyNull, '7:' + ci, {
        id: 2,
        campaign_id: 7,
        ci: String(ci),
        status: 'sent',
        sent_at: '2026-09-19T14:20:00.000Z',
        cz_solicitud_id: null,
      });
      const attempts = buildHistoricalPilotAttemptsByStep({
        episodeId: cz,
        ci: ci,
        episodeScopedByCampaignEpisode: episodeScoped,
        legacyNullByCiCampaign: legacyNull,
      });
      const d = decideHistoricalSurveyInviteAction({
        now: new Date(Date.parse(tHist) + 72 * MS_HOUR + 1),
        inCohort: true,
        dataEligible: true,
        hasEncuesta: false,
        isSuppressed: false,
        attemptsByStep: attempts,
      });
      assert.strictEqual(d.due_step, 3);
      assert.strictEqual(d.campaign_id, 8);
      // Materialize target episode is the pilot cz itself
      assert.strictEqual(cz, HISTORICAL_PILOT_CZ_IDS[i]);
    }
  }

  // TEST 4 — explicit episode CI mismatch rejected
  {
    const sb = makeEligibilitySupabase({
      solicitudes: [
        {
          cz_id: 9999,
          ci: 11111111,
          email: 'other@example.com',
          lrw_id: 'LRW-X',
          nombre: 'X',
        },
        {
          cz_id: CUR_CZ,
          ci: CI,
          email: 'jp@example.com',
          lrw_id: 'LRW-CUR',
          nombre: 'Cur',
        },
      ],
    });
    const elig = await getRejectedSurveyInviteEligibility(sb, CI, {
      campaignId: 8,
      czSolicitudId: 9999,
    });
    assert.strictEqual(elig.eligible, false);
    assert.strictEqual(elig.reason, REASONS.EPISODE_CI_MISMATCH);
  }

  // TEST 6 — idempotency key is episode-scoped (1154 ≠ 1357)
  {
    const k1154 = buildSurveyInviteIdempotencyKey(8, HIST_CZ);
    const k1357 = buildSurveyInviteIdempotencyKey(8, CUR_CZ);
    assert.strictEqual(
      k1154,
      'rechazados_survey_invite:campaign:8:cz:1154',
    );
    assert.notStrictEqual(k1154, k1357);
  }

  // Prior for explicit episode ignores sibling episode recipient
  {
    const sb = makeEligibilitySupabase({
      recipients: [
        {
          id: 32,
          campaign_id: 8,
          ci: String(CI),
          status: 'queued',
          cz_solicitud_id: CUR_CZ,
          purpose: 'rechazados_survey_invite',
        },
      ],
    });
    const elig = await getRejectedSurveyInviteEligibility(sb, CI, {
      campaignId: 8,
      czSolicitudId: HIST_CZ,
    });
    assert.strictEqual(elig.eligible, true);
    assert.strictEqual(elig.prior_recipient_id, null);
    assert.strictEqual(Number(elig.cz_solicitud_id), HIST_CZ);
  }

  console.log('OK unit-rejected-survey-invite-explicit-episode');
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
