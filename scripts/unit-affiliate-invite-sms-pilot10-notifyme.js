'use strict';

/**
 * node scripts/unit-affiliate-invite-sms-pilot10-notifyme.js
 */

const assert = require('assert');

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
    sessionSecret: 'test-secret',
    apifyToken: 'test-apify',
  },
};

const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from: function () {
      return {
        update: function () {
          return { in: function () { return Promise.resolve({ error: null }); } };
        },
      };
    },
  },
};

const notifyme = require('../src/services/notifyme-client');

const originalInsert = notifyme.insertDeliverAndReconcileSingle;
const originalPoll = notifyme.pollStatus;
const originalPatch = notifyme.patchSmsMessagesByUniqueIds;
const originalDeliver = notifyme.deliverInsertedRows;
const originalClassify = notifyme.classifyNotifymeDeliveryStatus;

let insertCalls = 0;
let pollCalls = 0;

notifyme.insertDeliverAndReconcileSingle = async function (_campaignId, _message, _opts) {
  insertCalls += 1;
  return {
    ok: false,
    unique_id: '9001',
    delivery: 'unknown',
    block_auto_resend: true,
    reason: 'notifyme_delivery_unknown',
  };
};

notifyme.pollStatus = async function (ids) {
  pollCalls += 1;
  assert.deepStrictEqual(ids, ['9001']);
  return { requested: 1, returned: 1, updated: 1 };
};

notifyme.patchSmsMessagesByUniqueIds = async function (ids, patch) {
  assert.deepStrictEqual(ids, ['9001']);
  assert.strictEqual(patch.status, 'unknown');
};

notifyme.classifyNotifymeDeliveryStatus = originalClassify;

const { resumePilot10UnknownDelivery } = require('../src/lib/affiliateInviteSmsPilot10Notifyme');

(async function run() {
  insertCalls = 0;
  pollCalls = 0;

  const supabase = {
    from: function () {
      return {
        select: function () {
          return {
            eq: function () {
              return this;
            },
            order: function () {
              return this;
            },
            limit: function () {
              return this;
            },
            maybeSingle: async function () {
              return {
                data: {
                  unique_id: '9001',
                  status: 'unknown',
                  czuid: '12345678',
                },
                error: null,
              };
            },
          };
        },
      };
    },
  };

  const resumed = await resumePilot10UnknownDelivery(supabase, 'camp-1', 12345678);
  assert.strictEqual(resumed.block_auto_resend, true);
  assert.strictEqual(pollCalls, 1);

  assert.strictEqual(notifyme.classifyNotifymeDeliveryStatus('DELIVERED'), 'delivered');
  assert.strictEqual(notifyme.classifyNotifymeDeliveryStatus('ERROR'), 'not_received');
  assert.strictEqual(notifyme.classifyNotifymeDeliveryStatus('unknown'), 'unknown');

  console.log('OK unit-affiliate-invite-sms-pilot10-notifyme');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
}).finally(function () {
  notifyme.insertDeliverAndReconcileSingle = originalInsert;
  notifyme.pollStatus = originalPoll;
  notifyme.patchSmsMessagesByUniqueIds = originalPatch;
  notifyme.deliverInsertedRows = originalDeliver;
});
