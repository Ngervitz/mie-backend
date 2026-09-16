'use strict';

/**
 * Standard materializer + {{unsubscribe_url}} (Stage 2A token reuse).
 * Run: node scripts/unit-email-materialize-unsubscribe.js
 */

const assert = require('assert');

process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <from@credizona.com.uy>';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://s.credizona.net';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
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
    emailPublicBaseUrl: 'https://s.credizona.net',
  },
};

const unsubPath = require.resolve(
  '../src/services/email-campaigns/unsubscribeToken',
);
const {
  campaignContentNeedsUnsubscribeUrl,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
  UNSUBSCRIBE_PLACEHOLDER,
} = require('../src/services/email-campaigns/unsubscribeToken');

const supabasePath = require.resolve('../src/clients/supabase');
const processorPath = require.resolve(
  '../src/services/email-campaigns/processor',
);

let insertBatches;
let campaignRow;
let segmentRow;
let encuestaRows;
let suppressionRows;
let detectionCallCount;

function installMocks() {
  insertBatches = [];
  detectionCallCount = 0;

  // Ensure unsubscribeToken is loaded before wrapping detection.
  const unsubMod = require('../src/services/email-campaigns/unsubscribeToken');
  const realNeeds = unsubMod.campaignContentNeedsUnsubscribeUrl;
  unsubMod.campaignContentNeedsUnsubscribeUrl = function (subject, bodyHtml) {
    detectionCallCount += 1;
    return realNeeds(subject, bodyHtml);
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
            select: function () {
              return {
                eq: function () {
                  return {
                    // count existence check
                    then: undefined,
                  };
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
                      return { data: segmentRow, error: null };
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
                  return { data: encuestaRows, error: null };
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
                  return { data: suppressionRows, error: null };
                },
              };
            },
          };
        }
        throw new Error('unexpected table ' + table);
      },
    },
  };

  // Fix recipients existence count: supabase chain uses select().eq() then
  // awaits with count head — processor uses:
  // .select('id', { count: 'exact', head: true }).eq('campaign_id', ...)
  require.cache[supabasePath].exports.from = function (table) {
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
                  return { data: segmentRow, error: null };
                },
              };
            },
          };
        },
      };
    }
    if (table === 'cz_encuestas_synced' || table === 'email_suppressions') {
      const rows =
        table === 'cz_encuestas_synced' ? encuestaRows : suppressionRows;
      return {
        select: function () {
          return {
            range: async function () {
              return { data: rows, error: null };
            },
          };
        },
      };
    }
    throw new Error('unexpected table ' + table);
  };

  delete require.cache[processorPath];
}

function loadMaterialize() {
  installMocks();
  return require('../src/services/email-campaigns/processor').materializeCampaign;
}

function seedBase(bodyHtml) {
  campaignRow = {
    id: 99,
    status: 'draft',
    subject: 'Hola {{nombre}}',
    body_html: bodyHtml,
    audience_mode: 'SEGMENT_DRIVEN',
    segment_id: 5,
    segment_rules_snapshot: [
      { field: 'attributes.marker', operator: '=', value: 'unit-unsub' },
    ],
    scheduled_at: null,
  };
  segmentRow = {
    id: 5,
    rules: [{ field: 'attributes.marker', operator: '=', value: 'unit-unsub' }],
  };
  encuestaRows = [
    {
      id: 1,
      ci: 'CI-1',
      email: 'One.User@example.com',
      encuesta_score: 80,
      marketing_consent: true,
      attributes: { marker: 'unit-unsub' },
    },
    {
      id: 2,
      ci: 'CI-2',
      email: 'two.user@example.com',
      encuesta_score: 80,
      marketing_consent: true,
      attributes: { marker: 'unit-unsub' },
    },
  ];
  suppressionRows = [];
}

(async function main() {
  // Helper detection is per campaign content (once), not purpose-specific.
  assert.strictEqual(
    campaignContentNeedsUnsubscribeUrl(
      'x',
      '<a href="' + UNSUBSCRIBE_PLACEHOLDER + '">b</a>',
    ),
    true,
  );
  assert.strictEqual(
    campaignContentNeedsUnsubscribeUrl('plain', '<p>no link</p>'),
    false,
  );

  // A/B/C/D — materialize with unsubscribe placeholder
  let materializeCampaign = loadMaterialize();
  seedBase(
    '<p>Hola {{nombre}}</p><p><a href="{{unsubscribe_url}}">Baja</a></p>',
  );
  const result = await materializeCampaign(99);
  assert.strictEqual(result.recipientCount, 2);
  assert.strictEqual(insertBatches.length, 1);
  assert.strictEqual(insertBatches[0].length, 2);
  // I — detection once before recipient loop (not 2x)
  assert.strictEqual(detectionCallCount, 1);

  for (const row of insertBatches[0]) {
    assert.ok(row.template_vars && row.template_vars.unsubscribe_url);
    assert.strictEqual(
      String(row.payload_html).indexOf('{{unsubscribe_url}}'),
      -1,
    );
    assert.ok(
      String(row.payload_html).indexOf(
        'https://s.credizona.net/email/unsubscribe?t=',
      ) !== -1,
    );
    const m = String(row.payload_html).match(
      /https:\/\/s\.credizona\.net\/email\/unsubscribe\?t=([^"'<\s]+)/,
    );
    assert.ok(m);
    const token = decodeURIComponent(m[1]);
    const verified = verifyUnsubscribeToken(token);
    assert.strictEqual(verified.ok, true);
    assert.strictEqual(verified.email, row.email);
    assert.strictEqual(row.template_vars.unsubscribe_url, m[0]);
    assert.ok(/Hola Cliente/.test(row.payload_html));
  }
  // Distinct tokens per recipient
  assert.notStrictEqual(
    insertBatches[0][0].template_vars.unsubscribe_url,
    insertBatches[0][1].template_vars.unsubscribe_url,
  );

  // E — immutability of snapshot fields vs later template edit (snapshot frozen)
  const frozenHtml = insertBatches[0][0].payload_html;
  const frozenSubjectSnap = insertBatches[0][0].template_subject_snapshot;
  const frozenBodySnap = insertBatches[0][0].template_body_html_snapshot;
  campaignRow.body_html = '<p>MUTATED</p>{{unsubscribe_url}}';
  assert.strictEqual(insertBatches[0][0].payload_html, frozenHtml);
  assert.strictEqual(
    insertBatches[0][0].template_subject_snapshot,
    frozenSubjectSnap,
  );
  assert.strictEqual(
    insertBatches[0][0].template_body_html_snapshot,
    frozenBodySnap,
  );

  // F — missing HMAC with unsubscribe template → no partial insert
  materializeCampaign = loadMaterialize();
  seedBase('<a href="{{unsubscribe_url}}">x</a>');
  require.cache[envPath].exports.emailUnsubscribeHmacSecret = '';
  delete process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET;
  // reload unsub + processor with empty secret
  delete require.cache[unsubPath];
  delete require.cache[processorPath];
  require.cache[envPath].exports.emailUnsubscribeHmacSecret = '';
  process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = '';
  installMocks();
  // re-apply empty secret after installMocks reloads processor deps
  require.cache[envPath].exports.emailUnsubscribeHmacSecret = '';
  process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = '';
  delete require.cache[unsubPath];
  delete require.cache[processorPath];
  installMocks();
  materializeCampaign = require('../src/services/email-campaigns/processor')
    .materializeCampaign;
  seedBase('<a href="{{unsubscribe_url}}">x</a>');
  let threwHmac = false;
  try {
    await materializeCampaign(99);
  } catch (err) {
    threwHmac = /EMAIL_UNSUBSCRIBE_HMAC_SECRET/.test(err.message);
  }
  assert.strictEqual(threwHmac, true);
  assert.strictEqual(insertBatches.length, 0);

  // restore secret
  process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
  require.cache[envPath].exports.emailUnsubscribeHmacSecret =
    'test-email-unsubscribe-secret';
  delete require.cache[unsubPath];
  delete require.cache[processorPath];

  // G — missing PUBLIC_BASE_URL → no partial insert
  materializeCampaign = loadMaterialize();
  require.cache[envPath].exports.emailPublicBaseUrl = '';
  process.env.EMAIL_PUBLIC_BASE_URL = '';
  delete require.cache[unsubPath];
  delete require.cache[processorPath];
  installMocks();
  materializeCampaign = require('../src/services/email-campaigns/processor')
    .materializeCampaign;
  seedBase('<a href="{{unsubscribe_url}}">x</a>');
  let threwBase = false;
  try {
    await materializeCampaign(99);
  } catch (err) {
    threwBase = /EMAIL_PUBLIC_BASE_URL/.test(err.message);
  }
  assert.strictEqual(threwBase, true);
  assert.strictEqual(insertBatches.length, 0);

  // restore base
  process.env.EMAIL_PUBLIC_BASE_URL = 'https://s.credizona.net';
  require.cache[envPath].exports.emailPublicBaseUrl = 'https://s.credizona.net';
  delete require.cache[unsubPath];
  delete require.cache[processorPath];

  // H — template without unsubscribe keeps prior behavior
  materializeCampaign = loadMaterialize();
  seedBase('<p>Hola {{nombre}}</p><p>sin baja</p>');
  const plain = await materializeCampaign(99);
  assert.strictEqual(plain.recipientCount, 2);
  assert.strictEqual(detectionCallCount, 1);
  for (const row of insertBatches[0]) {
    assert.deepStrictEqual(row.template_vars, {});
    assert.strictEqual(
      String(row.payload_html).indexOf('unsubscribe'),
      -1,
    );
    assert.ok(/Hola Cliente/.test(row.payload_html));
  }

  // Stage 2A helper still works (same URL builder)
  const u = buildUnsubscribeUrl(
    'https://s.credizona.net',
    'check@example.com',
  );
  assert.ok(u.startsWith('https://s.credizona.net/email/unsubscribe?t='));

  console.log('OK unit-email-materialize-unsubscribe');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
