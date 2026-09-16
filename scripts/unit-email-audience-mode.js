'use strict';

/**
 * audience_mode SEGMENT_DRIVEN / DIRECTED — create resolution + generic materialize guard.
 * node scripts/unit-email-audience-mode.js
 */

const assert = require('assert');
const fs = require('fs');

process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <from@credizona.com.uy>';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PROVIDER_MODE = 'log';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://s.credizona.net';

const {
  EMAIL_AUDIENCE_MODES,
  resolveAudienceModeForCreate,
} = require('../src/services/email-campaigns/audienceMode');

(function testResolve() {
  let r = resolveAudienceModeForCreate({ segment_id: 9 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, EMAIL_AUDIENCE_MODES.SEGMENT_DRIVEN);

  r = resolveAudienceModeForCreate({
    audience_mode: 'SEGMENT_DRIVEN',
    segment_id: 9,
  });
  assert.strictEqual(r.ok, true);

  r = resolveAudienceModeForCreate({ audience_mode: 'DIRECTED' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, EMAIL_AUDIENCE_MODES.DIRECTED);

  r = resolveAudienceModeForCreate({ mode: 'DIRECTED' });
  assert.strictEqual(r.ok, true);

  r = resolveAudienceModeForCreate({
    audience_mode: 'DIRECTED',
    segment_id: 3,
  });
  assert.strictEqual(r.ok, false);

  r = resolveAudienceModeForCreate({ audience_mode: 'SEGMENT_DRIVEN' });
  assert.strictEqual(r.ok, false);

  r = resolveAudienceModeForCreate({
    audience_mode: 'WEIRD',
    segment_id: 1,
  });
  assert.strictEqual(r.ok, false);

  r = resolveAudienceModeForCreate({});
  assert.strictEqual(r.ok, false);
})();

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
    emailPublicBaseUrl: 'https://s.credizona.net',
  },
};

const supabasePath = require.resolve('../src/clients/supabase');
const providerPath = require.resolve('../src/services/email-provider');
const processorPath = require.resolve('../src/services/email-campaigns/processor');

let campaignRow;
let insertBatches;
let encuestaFetched;

function installMocks() {
  insertBatches = [];
  encuestaFetched = false;

  require.cache[providerPath] = {
    id: providerPath,
    filename: providerPath,
    loaded: true,
    exports: {
      getEmailProvider: function () {
        return {
          send: async function () {
            return { id: 'x' };
          },
        };
      },
    },
  };

  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: {
      from: function (table) {
        if (table === 'email_campaigns') {
          return {
            select: function () {
              return {
                eq: function () {
                  return {
                    single: async function () {
                      return { data: campaignRow, error: null };
                    },
                  };
                },
              };
            },
            update: function () {
              return {
                eq: async function () {
                  return { error: null };
                },
              };
            },
          };
        }
        if (table === 'email_campaign_recipients') {
          return {
            select: function (_cols, opts) {
              if (opts && opts.head) {
                return {
                  eq: async function () {
                    return { count: 0, error: null };
                  },
                };
              }
              return {
                eq: function () {
                  return this;
                },
              };
            },
            insert: async function (chunk) {
              insertBatches.push(chunk);
              return { error: null };
            },
          };
        }
        if (table === 'email_segments') {
          return {
            select: function () {
              return {
                eq: function () {
                  return {
                    single: async function () {
                      return {
                        data: {
                          id: 5,
                          rules: [
                            {
                              field: 'encuesta_score',
                              operator: '>=',
                              value: 70,
                            },
                          ],
                        },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        }
        if (table === 'cz_encuestas_synced') {
          return {
            select: function () {
              return {
                range: async function () {
                  encuestaFetched = true;
                  return {
                    data: [
                      {
                        id: 1,
                        email: 'a@example.com',
                        encuesta_score: 80,
                        marketing_consent: true,
                        attributes: {},
                      },
                    ],
                    error: null,
                  };
                },
              };
            },
          };
        }
        if (table === 'email_suppressions') {
          return {
            select: function () {
              return {
                range: async function () {
                  return { data: [], error: null };
                },
              };
            },
          };
        }
        throw new Error('unexpected table ' + table);
      },
    },
  };

  delete require.cache[processorPath];
}

function loadMaterialize() {
  installMocks();
  return require('../src/services/email-campaigns/processor').materializeCampaign;
}

(async function main() {
  let materializeCampaign;
  let threw;
  let msg;

  campaignRow = {
    id: 50,
    status: 'draft',
    subject: 'S',
    body_html: '<p>b</p>',
    audience_mode: 'DIRECTED',
    segment_id: null,
    segment_rules_snapshot: null,
    scheduled_at: null,
  };
  materializeCampaign = loadMaterialize();
  threw = false;
  msg = '';
  try {
    await materializeCampaign(50);
  } catch (err) {
    threw = true;
    msg = err.message || '';
  }
  assert.strictEqual(threw, true);
  assert.ok(/DIRECTED/.test(msg), msg);
  assert.strictEqual(insertBatches.length, 0);
  assert.strictEqual(encuestaFetched, false);

  campaignRow = {
    id: 51,
    status: 'draft',
    subject: 'S',
    body_html: '<p>b</p>',
    audience_mode: 'SEGMENT_DRIVEN',
    segment_id: null,
    segment_rules_snapshot: [
      { field: 'encuesta_score', operator: '>=', value: 70 },
    ],
    scheduled_at: null,
  };
  materializeCampaign = loadMaterialize();
  threw = false;
  msg = '';
  try {
    await materializeCampaign(51);
  } catch (err) {
    threw = true;
    msg = err.message || '';
  }
  assert.strictEqual(threw, true);
  assert.ok(/no segment_id|corrupt SEGMENT_DRIVEN/i.test(msg), msg);
  assert.strictEqual(insertBatches.length, 0);
  assert.strictEqual(encuestaFetched, false);

  campaignRow = {
    id: 52,
    status: 'draft',
    subject: 'Hola',
    body_html: '<p>hi</p>',
    audience_mode: 'SEGMENT_DRIVEN',
    segment_id: 5,
    segment_rules_snapshot: [
      { field: 'encuesta_score', operator: '>=', value: 70 },
    ],
    scheduled_at: null,
  };
  materializeCampaign = loadMaterialize();
  const result = await materializeCampaign(52);
  assert.ok(result.recipientCount >= 1);
  assert.strictEqual(encuestaFetched, true);
  assert.ok(insertBatches.length >= 1);

  const surveySrc = fs.readFileSync(
    require.resolve('../src/lib/rejectedSurveyInviteMaterialize'),
    'utf8',
  );
  assert.strictEqual(/email_segments/.test(surveySrc), false);
  assert.strictEqual(/segment_rules_snapshot/.test(surveySrc), false);
  assert.strictEqual(/audience_mode/.test(surveySrc), false);

  console.log('unit-email-audience-mode: OK');
})().catch(function (err) {
  console.error('unit-email-audience-mode FAILED');
  console.error(err);
  process.exit(1);
});
