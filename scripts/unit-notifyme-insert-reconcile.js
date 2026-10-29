'use strict';

/**
 * node scripts/unit-notifyme-insert-reconcile.js
 * Timeout → unknown (never failed), poll, not_received → retry allowed, ambiguous → block.
 */

const assert = require('assert');

const supabasePath = require.resolve('../src/clients/supabase');
const soapPath = require.resolve('soap');

const messageStore = new Map();

require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from: function (table) {
      if (table === 'sms_messages') {
        return {
          insert: function (rows) {
            return {
              select: function () {
                const row = Object.assign({}, rows[0], { unique_id: '88001', submission_order: 0 });
                messageStore.set('88001', row);
                return Promise.resolve({ data: [row], error: null });
              },
            };
          },
          update: function (patch) {
            return {
              in: function (_field, ids) {
                ids.forEach(function (id) {
                  const prev = messageStore.get(String(id)) || {};
                  messageStore.set(String(id), Object.assign({}, prev, patch));
                });
                return Promise.resolve({ error: null });
              },
              eq: function (field, value) {
                if (field === 'unique_id') {
                  const prev = messageStore.get(String(value)) || {};
                  messageStore.set(String(value), Object.assign({}, prev, patch));
                }
                return {
                  select: function () {
                    return Promise.resolve({ data: [{ unique_id: String(value) }], error: null });
                  },
                  maybeSingle: function () {
                    return Promise.resolve({
                      data: messageStore.get(String(value)) || null,
                      error: null,
                    });
                  },
                };
              },
            };
          },
          select: function () {
            return {
              eq: function (field, value) {
                return {
                  order: function () {
                    return {
                      limit: function () {
                        return Promise.resolve({ data: [], error: null });
                      },
                    };
                  },
                  maybeSingle: function () {
                    return Promise.resolve({
                      data: messageStore.get(String(value)) || null,
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }
      if (table === 'sms_campaigns') {
        return {
          update: function () {
            return { eq: function () { return Promise.resolve({ error: null }); } };
          },
          select: function () {
            return {
              eq: function () {
                return {
                  order: function () {
                    return {
                      limit: function () {
                        return Promise.resolve({ data: [], error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error('unexpected table ' + table);
    },
  },
};

require.cache[soapPath] = {
  id: soapPath,
  filename: soapPath,
  loaded: true,
  exports: {
    createClientAsync: async function () {
      return {
        deliverMessagesAsync: async function () {
          const err = new Error('ESOCKETTIMEDOUT');
          err.code = 'ESOCKETTIMEDOUT';
          throw err;
        },
        getMessagesStatusAsync: async function () {
          return [
            {
              return: [{ uniqueId: '88001', status: 'ERROR', reason: 'not accepted' }],
            },
          ];
        },
      };
    },
  },
};

process.env.NOTIFYME_USERNAME = 'u';
process.env.NOTIFYME_PASSWORD = 'p';

const notifyme = require('../src/services/notifyme-client');

(async function run() {
  messageStore.clear();
  const result = await notifyme.insertDeliverAndReconcileSingle('camp-x', {
    phone: '59899123456',
    text: 'hello',
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.unique_id, '88001');
  assert.strictEqual(result.delivery, 'not_received_confirmed');
  assert.strictEqual(messageStore.get('88001').status, 'ERROR');

  console.log('OK unit-notifyme-insert-reconcile');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
