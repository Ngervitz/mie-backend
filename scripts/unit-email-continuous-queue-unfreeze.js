'use strict';

/**
 * Continuous S1/S2/S3: partial_error must not block queued drain.
 * node scripts/unit-email-continuous-queue-unfreeze.js
 */

const assert = require('assert');

process.env.APIFY_TOKEN = 'x';
process.env.APIFY_ACTOR_ID = 'x';
process.env.EMAIL_CAMPAIGNS_FROM = 'Credizona <noreply@credizona.com.uy>';
process.env.EMAIL_PROVIDER_MODE = 'log';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.RECHAZADOS_SURVEY_INVITE_STEP1_CAMPAIGN_ID = '6';
process.env.RECHAZADOS_SURVEY_INVITE_STEP2_CAMPAIGN_ID = '7';
process.env.RECHAZADOS_SURVEY_INVITE_STEP3_CAMPAIGN_ID = '8';

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
    apifyToken: 'x',
    apifyActorId: 'x',
    sessionSecret: 'test-session',
    cronSecret: null,
    czTrackingHmacSecret: null,
    emailUnsubscribeHmacSecret: 'test-email-unsubscribe-secret',
    emailPublicBaseUrl: 'https://janus.test',
    rechazadosSurveyInviteStep1CampaignId: '6',
    rechazadosSurveyInviteStep2CampaignId: '7',
    rechazadosSurveyInviteStep3CampaignId: '8',
  },
};

const {
  isContinuousSurveyCampaignFrozen,
  resolveRecalculatedCampaignStatus,
} = require('../src/lib/rejectedSurveyInviteContinuousCampaigns');

/** @type {Map<string, number>} */
let statusCounts;

function installSupabaseMocks() {
  const supabasePath = require.resolve('../src/clients/supabase');
  statusCounts = new Map();

  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: {
      from: function (table) {
        const ctx = { table, filters: [], head: false, countMode: false };
        const api = {
          select: function (_cols, opts) {
            if (opts && opts.head) {
              ctx.head = true;
              ctx.countMode = opts.count === 'exact';
            }
            return api;
          },
          eq: function (col, val) {
            ctx.filters.push({ col, val });
            return api;
          },
          or: function () {
            return api;
          },
          order: function () {
            return api;
          },
          limit: function () {
            return api;
          },
          update: function (patch) {
            return {
              eq: function () {
                return {
                  select: function () {
                    return Promise.resolve({
                      data: [{ status: patch.status }],
                      error: null,
                    });
                  },
                  maybeSingle: function () {
                    return Promise.resolve({ data: null, error: null });
                  },
                  in: function () {
                    return Promise.resolve({ error: null });
                  },
                };
              },
            };
          },
          in: function () {
            return api;
          },
          then: function (resolve, reject) {
            try {
              if (ctx.head && ctx.countMode && table === 'email_campaign_recipients') {
                const statusEq = ctx.filters.find((f) => f.col === 'status');
                const campEq = ctx.filters.find((f) => f.col === 'campaign_id');
                const key =
                  (campEq ? campEq.val : 'any') +
                  ':' +
                  (statusEq ? statusEq.val : 'any');
                const n = statusCounts.get(key);
                if (typeof n !== 'number') {
                  return Promise.resolve({ count: 0, error: null }).then(
                    resolve,
                    reject,
                  );
                }
                return Promise.resolve({ count: n, error: null }).then(
                  resolve,
                  reject,
                );
              }
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            } catch (err) {
              return Promise.resolve({ data: null, error: err }).then(reject, reject);
            }
          },
        };
        return api;
      },
      rpc: async function (name) {
        if (name === 'acquire_job_lock') return { data: true, error: null };
        if (name === 'release_job_lock') return { data: true, error: null };
        return { data: null, error: { message: 'unknown rpc' } };
      },
    },
  };

  delete require.cache[require.resolve('../src/services/email-campaigns/processor')];
}

function setCounts(campaignId, sent, queued, failed) {
  statusCounts.set(campaignId + ':sent', sent);
  statusCounts.set(campaignId + ':queued', queued);
  statusCounts.set(campaignId + ':failed', failed);
}

// A — production-shaped counts: one failed must not block aggregate reopen
assert.strictEqual(
  resolveRecalculatedCampaignStatus({
    queued: 292,
    sent: 864,
    failed: 1,
    isContinuous: true,
  }),
  'sending',
);

// Frozen detection (continuous only)
assert.strictEqual(isContinuousSurveyCampaignFrozen('partial_error', 6), true);
assert.strictEqual(isContinuousSurveyCampaignFrozen('error', '8'), true);
assert.strictEqual(isContinuousSurveyCampaignFrozen('partial_error', 21), false);
assert.strictEqual(isContinuousSurveyCampaignFrozen('sending', 6), false);

// C — batch manual stays non-sendable in SEND_ALLOWED
{
  const { SEND_ALLOWED_STATUSES } = require('../src/services/email-campaigns/processor');
  assert.ok(!SEND_ALLOWED_STATUSES.has('partial_error'));
}

// B — syncContinuousCampaignsBeforeQueueDrain reopens campaign 6 in memory
(async function main() {
  installSupabaseMocks();
  setCounts('6', 864, 292, 1);

  const {
    syncContinuousCampaignsBeforeQueueDrain,
    SEND_ALLOWED_STATUSES,
  } = require('../src/services/email-campaigns/processor');

  const campaignById = new Map([
    [
      '6',
      {
        id: '6',
        status: 'partial_error',
        subject: 'S1',
        body_html: '<p>x</p>',
      },
    ],
  ]);

  await syncContinuousCampaignsBeforeQueueDrain(campaignById, ['6']);
  const campaign = campaignById.get('6');
  assert.strictEqual(campaign.status, 'sending');
  assert.ok(SEND_ALLOWED_STATUSES.has(campaign.status));

  // Batch campaign 21 partial_error + queued unchanged (no sync)
  installSupabaseMocks();
  setCounts('21', 10, 5, 1);
  const batchMap = new Map([
    ['21', { id: '21', status: 'partial_error', subject: 'X', body_html: '<p/>' }],
  ]);
  await syncContinuousCampaignsBeforeQueueDrain(batchMap, ['21']);
  assert.strictEqual(batchMap.get('21').status, 'partial_error');

  console.log('OK unit-email-continuous-queue-unfreeze');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});