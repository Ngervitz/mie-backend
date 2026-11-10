'use strict';

/**
 * Regression: recalculateCampaignStatus must use exact counts (not first 1000 rows).
 * processQueue({ campaignId }) must be optional (cron-compatible).
 *
 * node scripts/unit-email-recalculate-status-pagination.js
 */

const assert = require('assert');

process.env.APIFY_TOKEN = 'x';
process.env.APIFY_ACTOR_ID = 'x';
process.env.EMAIL_CAMPAIGNS_FROM = 'Credizona <noreply@credizona.com.uy>';
process.env.EMAIL_PROVIDER_MODE = 'log';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://s.credizona.net';

const {
  resolveRecalculatedCampaignStatus,
} = require('../src/lib/rejectedSurveyInviteContinuousCampaigns');
const {
  AUDIENCE_SOURCES,
  resolveSegmentAudienceSource,
} = require('../src/services/email-campaigns/segmentAudienceSource');
const {
  isExcludedTestAddress,
} = require('../src/services/email-campaigns/funnelSolicitudAudience');

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
    emailPublicBaseUrl: 'https://s.credizona.net',
  },
};

/** Simulates the pre-fix bug: only the first `rowLimit` recipient rows visible. */
function legacyStatusFromTruncatedRows(rows, isContinuous) {
  const list = rows.slice(0, 1000);
  let queued = 0;
  let sent = 0;
  let failed = 0;
  for (const r of list) {
    if (r.status === 'queued') queued += 1;
    else if (r.status === 'sent') sent += 1;
    else if (r.status === 'failed') failed += 1;
  }
  return resolveRecalculatedCampaignStatus({
    queued,
    sent,
    failed,
    isContinuous,
  });
}

function buildRecipientRows(sent, queued, failed) {
  const rows = [];
  for (let i = 0; i < sent; i += 1) rows.push({ status: 'sent' });
  for (let i = 0; i < queued; i += 1) rows.push({ status: 'queued' });
  for (let i = 0; i < failed; i += 1) rows.push({ status: 'failed' });
  return rows;
}

(function testResolveRecalculatedCampaignStatusVolumeMatrix() {
  const cases = [
    { sent: 999, queued: 0, failed: 0, want: 'completed' },
    { sent: 1000, queued: 0, failed: 0, want: 'completed' },
    { sent: 1001, queued: 0, failed: 0, want: 'completed' },
    { sent: 1643, queued: 0, failed: 1, want: 'partial_error' },
    { sent: 1644, queued: 0, failed: 0, want: 'completed' },
    { sent: 1100, queued: 544, failed: 0, want: 'sending' },
    { sent: 0, queued: 1644, failed: 0, want: 'sending' },
    { sent: 50, queued: 0, failed: 50, want: 'partial_error' },
    { sent: 0, queued: 0, failed: 0, want: 'sending' },
  ];
  for (const c of cases) {
    const got = resolveRecalculatedCampaignStatus({
      sent: c.sent,
      queued: c.queued,
      failed: c.failed,
      isContinuous: false,
    });
    assert.strictEqual(
      got,
      c.want,
      JSON.stringify(c) + ' got ' + got,
    );
  }
})();

(function testLegacyTruncationWouldMisclassify() {
  const rows = buildRecipientRows(1100, 544, 0);
  const legacy = legacyStatusFromTruncatedRows(rows, false);
  assert.strictEqual(
    legacy,
    'completed',
    'legacy path must misclassify 1100 sent + 544 queued',
  );
  const exact = resolveRecalculatedCampaignStatus({
    sent: 1100,
    queued: 544,
    failed: 0,
    isContinuous: false,
  });
  assert.strictEqual(exact, 'sending');
})();

/** @type {Map<string, number>} */
let statusCounts;
/** @type {string[]} */
let queueFilterLog;

function installSupabaseMocks() {
  const supabasePath = require.resolve('../src/clients/supabase');
  const providerPath = require.resolve('../src/services/email-provider');

  statusCounts = new Map();
  queueFilterLog = [];

  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: {
      from: function (table) {
        const ctx = {
          table,
          filters: [],
          head: false,
          countMode: false,
        };
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
            if (table === 'email_campaign_recipients' && col === 'campaign_id') {
              queueFilterLog.push(String(val));
            }
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
          update: function () {
            return {
              eq: function () {
                return {
                  select: function () {
                    return Promise.resolve({ data: [], error: null });
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
              if (table === 'email_campaign_recipients' && !ctx.head) {
                return Promise.resolve({ data: [], error: null }).then(
                  resolve,
                  reject,
                );
              }
              if (table === 'email_campaigns') {
                return Promise.resolve({
                  data: [
                    {
                      id: '21',
                      status: 'sending',
                      subject: 's',
                      body_html: '<p>{{unsubscribe_url}}</p>',
                    },
                  ],
                  error: null,
                }).then(resolve, reject);
              }
              return Promise.resolve({ data: [], error: null }).then(
                resolve,
                reject,
              );
            } catch (err) {
              return Promise.resolve({ data: null, error: err }).then(
                reject,
                reject,
              );
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

  require.cache[providerPath] = {
    id: providerPath,
    filename: providerPath,
    loaded: true,
    exports: {
      getEmailProvider: function () {
        return {
          send: async function () {
            throw new Error('unit test must not send email');
          },
        };
      },
    },
  };

  delete require.cache[require.resolve('../src/services/email-campaigns/processor')];
}

function setCountsForCampaign(campaignId, sent, queued, failed) {
  statusCounts.set(campaignId + ':sent', sent);
  statusCounts.set(campaignId + ':queued', queued);
  statusCounts.set(campaignId + ':failed', failed);
}

async function testRecalculateAtVolume(label, sent, queued, failed, want) {
  installSupabaseMocks();
  setCountsForCampaign('21', sent, queued, failed);
  const { recalculateCampaignStatus } = require('../src/services/email-campaigns/processor');
  const next = await recalculateCampaignStatus('21');
  assert.strictEqual(next, want, label);
}

(async function main() {
  await testRecalculateAtVolume('999 sent', 999, 0, 0, 'completed');
  await testRecalculateAtVolume('1000 sent', 1000, 0, 0, 'completed');
  await testRecalculateAtVolume('1001 sent', 1001, 0, 0, 'completed');
  await testRecalculateAtVolume('1644 sent', 1644, 0, 0, 'completed');
  await testRecalculateAtVolume('campaign21 partial', 1643, 0, 1, 'partial_error');
  await testRecalculateAtVolume('campaign21 mid-run', 1100, 544, 0, 'sending');

  installSupabaseMocks();
  setCountsForCampaign('77', 0, 5, 0);
  queueFilterLog.length = 0;
  const { processQueue } = require('../src/services/email-campaigns/processor');
  const globalRun = await processQueue();
  assert.strictEqual(globalRun.filterCampaignId, null);
  assert.strictEqual(queueFilterLog.length, 0, 'cron global run must not filter campaign_id');

  installSupabaseMocks();
  setCountsForCampaign('77', 0, 5, 0);
  queueFilterLog.length = 0;
  const { processQueue: pq2 } = require('../src/services/email-campaigns/processor');
  const scoped = await pq2({ campaignId: 77 });
  assert.strictEqual(scoped.filterCampaignId, '77');
  assert.ok(
    queueFilterLog.indexOf('77') >= 0,
    'scoped run must filter campaign_id',
  );

  assert.strictEqual(
    resolveSegmentAudienceSource([]),
    AUDIENCE_SOURCES.ENCUESTAS_SYNCED,
  );
  assert.strictEqual(
    resolveSegmentAudienceSource([
      {
        field: 'attributes.audience_source',
        operator: '=',
        value: 'cz_funnel_solicitudes',
      },
    ]),
    AUDIENCE_SOURCES.FUNNEL_SOLICITUDES,
  );

  assert.strictEqual(isExcludedTestAddress('nico@copanel.uy'), true);
  assert.strictEqual(isExcludedTestAddress('a@example.com'), true);
  assert.strictEqual(isExcludedTestAddress('user@gmail.com'), false);

  console.log('OK unit-email-recalculate-status-pagination');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
