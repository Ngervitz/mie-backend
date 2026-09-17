'use strict';

/**
 * Materializer integration with mocked RPC (no real DB / no sends).
 * Covers: tracked URL before freeze, retry reuses unit, processor frozen html.
 *
 * node scripts/unit-email-survey-click-materialize.js
 */

const assert = require('assert');

process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.RECHAZADOS_SURVEY_INVITE_CAMPAIGN_ID = '42';
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
    rechazadosSurveyInviteCampaignId: '42',
  },
};

const TOKEN = 'abcdefghijABCDEFGHIJ12';
const IMPACT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let recipientStore = null;
let rpcCalls = 0;
let forceSnapshotFail = false;

function resetStore() {
  recipientStore = null;
  rpcCalls = 0;
  forceSnapshotFail = false;
}

function makeSupabase() {
  return {
    rpc: async function (name, params) {
      assert.strictEqual(name, 'upsert_email_survey_invite_recipient_impact');
      rpcCalls += 1;
      if (!recipientStore) {
        recipientStore = {
          id: 9001,
          campaign_id: Number(params.p_campaign_id),
          idempotency_key: params.p_idempotency_key,
          ci: params.p_ci,
          email: params.p_email,
          status: 'queued',
          purpose: params.p_purpose,
          marketing_impact_id: IMPACT_ID,
          provider_send_started_at: null,
          template_vars: {},
          payload_html: null,
          payload_to: null,
          payload_from: null,
          payload_subject: null,
          template_subject_snapshot: null,
          template_body_html_snapshot: null,
          error_reason: null,
          next_attempt_at: null,
        };
        return {
          data: {
            created: true,
            recipient_id: recipientStore.id,
            impact_id: IMPACT_ID,
            tracking_token: TOKEN,
            destination_url: params.p_destination_url,
            campaign_id: recipientStore.campaign_id,
            idempotency_key: recipientStore.idempotency_key,
            status: 'queued',
            provider_send_started_at: null,
          },
          error: null,
        };
      }
      return {
        data: {
          created: false,
          recipient_id: recipientStore.id,
          impact_id: IMPACT_ID,
          tracking_token: TOKEN,
          destination_url: params.p_destination_url,
          campaign_id: recipientStore.campaign_id,
          idempotency_key: recipientStore.idempotency_key,
          status: recipientStore.status,
          provider_send_started_at: recipientStore.provider_send_started_at,
        },
        error: null,
      };
    },
    from: function (table) {
      return {
        select: function (cols) {
          return {
            eq: function (col, val) {
              const chain = {
                eq: function (col2, val2) {
                  return {
                    maybeSingle: async function () {
                      if (table === 'email_campaigns') {
                        return {
                          data: {
                            id: 42,
                            subject: 'Subj {{nombre}}',
                            body_html:
                              '<a href="{{survey_url}}">x</a> {{unsubscribe_url}}',
                          },
                          error: null,
                        };
                      }
                      if (table === 'email_campaign_recipients') {
                        if (
                          recipientStore &&
                          String(recipientStore.id) === String(val) &&
                          (col2 !== 'idempotency_key' ||
                            recipientStore.idempotency_key === val2)
                        ) {
                          return { data: Object.assign({}, recipientStore), error: null };
                        }
                        return { data: null, error: null };
                      }
                      return { data: null, error: null };
                    },
                  };
                },
                maybeSingle: async function () {
                  if (table === 'email_campaigns') {
                    return {
                      data: {
                        id: 42,
                        subject: 'Subj {{nombre}}',
                        body_html:
                          '<a href="{{survey_url}}">x</a> {{unsubscribe_url}}',
                      },
                      error: null,
                    };
                  }
                  return { data: null, error: null };
                },
                in: function () {
                  return chain;
                },
                order: function () {
                  return {
                    limit: function () {
                      return {
                        maybeSingle: async function () {
                          return { data: null, error: null };
                        },
                      };
                    },
                  };
                },
              };
              return chain;
            },
          };
        },
        update: function (patch) {
          return {
            eq: function () {
              return {
                eq: function () {
                  return {
                    is: function () {
                      return {
                        select: function () {
                          return {
                            maybeSingle: async function () {
                              if (forceSnapshotFail) {
                                return { data: null, error: null };
                              }
                              Object.assign(recipientStore, patch);
                              return {
                                data: {
                                  id: recipientStore.id,
                                  status: recipientStore.status,
                                  email: recipientStore.email,
                                  marketing_impact_id:
                                    recipientStore.marketing_impact_id,
                                },
                                error: null,
                              };
                            },
                          };
                        },
                      };
                    },
                    select: function () {
                      return {
                        maybeSingle: async function () {
                          Object.assign(recipientStore, patch);
                          return {
                            data: {
                              id: recipientStore.id,
                              status: recipientStore.status,
                              email: recipientStore.email,
                              marketing_impact_id:
                                recipientStore.marketing_impact_id,
                            },
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
}

const eligibilityPath = require.resolve(
  '../src/lib/rejectedSurveyInviteEligibility',
);
require.cache[eligibilityPath] = {
  id: eligibilityPath,
  filename: eligibilityPath,
  loaded: true,
  exports: {
    getWave1CampaignId: function () {
      return '42';
    },
    getEmailPublicBaseUrl: function () {
      return 'https://janus.test';
    },
    getRejectedSurveyInviteEligibility: async function () {
      return {
        eligible: true,
        reason: 'eligible',
        ci: 12345678,
        email: 'ana@example.com',
        email_masked: 'a***@example.com',
        lrw_id: 'LRW-TEST',
        nombre: 'Ana',
        prior_recipient_id: null,
        repairable: false,
      };
    },
    getAllSurveyInviteStepCampaignIds: function () {
      return { 1: null, 2: null, 3: null };
    },
  },
};

delete require.cache[require.resolve('../src/lib/rejectedSurveyInviteMaterialize')];
const {
  materializeRejectedSurveyInvite,
} = require('../src/lib/rejectedSurveyInviteMaterialize');

(async function main() {
  resetStore();
  const sb = makeSupabase();
  const first = await materializeRejectedSurveyInvite(sb, 12345678, 42);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.tracking_token, TOKEN);
  assert.strictEqual(String(first.marketing_impact_id), IMPACT_ID);
  assert.ok(recipientStore.payload_html.indexOf('/email/c/' + TOKEN) !== -1);
  assert.ok(
    recipientStore.payload_html.indexOf(
      'https://www.credizona.com.uy/solicitudes/sinoferta?lrw=',
    ) === -1,
  );
  assert.strictEqual(
    recipientStore.template_vars.survey_url,
    'https://janus.test/email/c/' + TOKEN,
  );
  assert.strictEqual(rpcCalls, 1);

  // Retry: same unit, no second impact token
  const second = await materializeRejectedSurveyInvite(sb, 12345678, 42);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.tracking_token, TOKEN);
  assert.strictEqual(rpcCalls, 2);
  assert.strictEqual(String(second.marketing_impact_id), IMPACT_ID);

  // RPC success → snapshot fail → retry recovers same token
  resetStore();
  const sb2 = makeSupabase();
  forceSnapshotFail = true;
  let failed = false;
  try {
    await materializeRejectedSurveyInvite(sb2, 12345678, 42);
  } catch (_e) {
    failed = true;
  }
  assert.ok(failed);
  assert.ok(recipientStore);
  assert.strictEqual(recipientStore.payload_html, null);
  assert.strictEqual(rpcCalls, 1);

  forceSnapshotFail = false;
  const recovered = await materializeRejectedSurveyInvite(sb2, 12345678, 42);
  assert.strictEqual(recovered.ok, true);
  assert.strictEqual(recovered.tracking_token, TOKEN);
  assert.ok(recipientStore.payload_html.indexOf('/email/c/' + TOKEN) !== -1);
  assert.strictEqual(rpcCalls, 2);

  console.log('unit-email-survey-click-materialize: PASS');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
