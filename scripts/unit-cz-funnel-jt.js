'use strict';

/**
 * node scripts/unit-cz-funnel-jt.js
 */

const assert = require('assert');

const JT_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const JT_B = 'BBBBBBBBBBBBBBBBBBBBBB';
assert.strictEqual(JT_A.length, 22);
assert.strictEqual(JT_B.length, 22);

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
  },
};

const supabasePath = require.resolve('../src/clients/supabase');
let supabaseImpl = {
  from: function () {
    throw new Error('supabase mock not installed');
  },
  rpc: function () {
    throw new Error('supabase mock not installed');
  },
};
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from: function () {
      return supabaseImpl.from.apply(supabaseImpl, arguments);
    },
    rpc: function () {
      return supabaseImpl.rpc.apply(supabaseImpl, arguments);
    },
  },
};

const logger = require('../src/lib/logger');
const capturedLogs = [];
['info', 'warn', 'error'].forEach(function (level) {
  const orig = logger[level];
  logger[level] = function (message, meta) {
    capturedLogs.push({ level: level, message: message, meta: meta });
    return orig(message, meta);
  };
});

const {
  applyJtFirstValidWins,
  sanitizeTrackingDataSummary,
} = require('../src/lib/sanitizeCzTrackingData');
const {
  SOURCE_SOLICITUDES,
  SOURCE_SOLICITUD_ESTADOS,
  SOURCE_GRANTED,
  EXISTING_SUMMARY_SELECT_CHUNK,
  upsertSolicitudes,
} = require('../src/jobs/czFunnelSync');

assert.strictEqual(EXISTING_SUMMARY_SELECT_CHUNK, 500);

function item(overrides) {
  return Object.assign(
    {
      id: 1153,
      solicitudes_estados_id: 3,
      usuarios_id: 8,
      ci: null,
      fechaReg: '2026-08-20 11:48:20',
      updated: '2026-08-20 11:48:20',
      tracking_data: JSON.stringify({ utm_source: 'sms' }),
      historico: [],
    },
    overrides || {},
  );
}

function createStore(options) {
  const opts = options || {};
  const solicitudes = new Map();
  const estados = new Map();
  const granted = new Map();
  const calls = {
    upserts: [],
    deletes: [],
    rpcs: [],
    tables: [],
    selects: [],
    ins: [],
  };

  supabaseImpl = {
    rpc: function (name, args) {
      calls.rpcs.push({ name: name, args: args });
      return Promise.resolve({ data: true, error: null });
    },
    from: function (table) {
      calls.tables.push(table);
      return {
        select: function (cols) {
          calls.selects.push({ table: table, cols: cols });
          return {
            in: function (column, ids) {
              calls.ins.push({ table: table, column: column, ids: ids });
              if (opts.failSelect && table === SOURCE_SOLICITUDES) {
                return Promise.resolve({
                  data: null,
                  error: { message: 'forced lookup failure' },
                });
              }
              const data = [];
              if (table === SOURCE_SOLICITUDES) {
                (ids || []).forEach(function (id) {
                  const row = solicitudes.get(Number(id)) || solicitudes.get(id);
                  if (row) {
                    data.push({
                      cz_id: row.cz_id,
                      tracking_data_summary: row.tracking_data_summary,
                    });
                  }
                });
              }
              return Promise.resolve({ data: data, error: null });
            },
          };
        },
        upsert: function (rows, spec) {
          calls.upserts.push({
            table: table,
            rows: rows,
            onConflict: spec && spec.onConflict,
          });
          if (table === SOURCE_SOLICITUDES) {
            (rows || []).forEach(function (row) {
              solicitudes.set(
                row.cz_id,
                Object.assign({}, row, {
                  tracking_data_summary: Object.assign(
                    {},
                    row.tracking_data_summary || {},
                  ),
                }),
              );
            });
          } else if (table === SOURCE_SOLICITUD_ESTADOS) {
            (rows || []).forEach(function (row) {
              estados.set(row.cz_historico_id, Object.assign({}, row));
            });
          } else if (table === SOURCE_GRANTED) {
            (rows || []).forEach(function (row) {
              granted.set(row.cz_id, Object.assign({}, row));
            });
          }
          return Promise.resolve({ error: null });
        },
        delete: function () {
          calls.deletes.push({ table: table });
          throw new Error('delete must not be called');
        },
      };
    },
  };

  return {
    calls: calls,
    solicitudes: solicitudes,
    estados: estados,
    granted: granted,
    seedSolicitud: function (row) {
      solicitudes.set(row.cz_id, Object.assign({}, row));
    },
  };
}

function conflictWarns() {
  return capturedLogs.filter(function (e) {
    return (
      e.level === 'warn' &&
      e.meta &&
      e.meta.kind === 'cz_funnel_jt_conflict'
    );
  });
}

(async function run() {
  capturedLogs.length = 0;

  const appliedNew = applyJtFirstValidWins(
    1,
    sanitizeTrackingDataSummary({ utm_source: 'sms', jt: JT_A }),
    null,
  );
  assert.strictEqual(appliedNew.tracking_data_summary.jt, JT_A);
  assert.strictEqual(appliedNew.conflict, null);

  const keepA = applyJtFirstValidWins(1, { utm_source: 'new' }, JT_A);
  assert.strictEqual(keepA.tracking_data_summary.jt, JT_A);
  assert.strictEqual(keepA.tracking_data_summary.utm_source, 'new');
  assert.strictEqual(keepA.conflict, null);

  const invalidIncoming = applyJtFirstValidWins(1, { jt: 'short' }, JT_A);
  assert.strictEqual(invalidIncoming.tracking_data_summary.jt, JT_A);
  assert.strictEqual(invalidIncoming.conflict, null);

  const sameA = applyJtFirstValidWins(1, { jt: JT_A, utm_source: 'x' }, JT_A);
  assert.strictEqual(sameA.tracking_data_summary.jt, JT_A);
  assert.strictEqual(sameA.conflict, null);

  const clash = applyJtFirstValidWins(99, { jt: JT_B, utm_source: 'x' }, JT_A);
  assert.strictEqual(clash.tracking_data_summary.jt, JT_A);
  assert.ok(clash.conflict);
  assert.strictEqual(clash.conflict.kind, 'cz_funnel_jt_conflict');
  assert.strictEqual(clash.conflict.cz_id, 99);
  assert.strictEqual(clash.conflict.existing_jt_suffix, 'AAAA');
  assert.strictEqual(clash.conflict.incoming_jt_suffix, 'BBBB');
  assert.ok(!JSON.stringify(clash.conflict).includes(JT_A));
  assert.ok(!JSON.stringify(clash.conflict).includes(JT_B));

  const noJt = applyJtFirstValidWins(2, { utm_source: 'sms' }, null);
  assert.strictEqual(noJt.tracking_data_summary.jt, undefined);
  assert.strictEqual(noJt.tracking_data_summary.utm_source, 'sms');

  const store = createStore();
  await upsertSolicitudes([
    item({
      tracking_data: JSON.stringify({ utm_source: 'sms', jt: JT_A }),
    }),
  ]);
  assert.strictEqual(store.solicitudes.get(1153).tracking_data_summary.jt, JT_A);
  assert.strictEqual(store.calls.ins.length, 1);
  assert.strictEqual(store.estados.size, 0);
  assert.strictEqual(store.granted.size, 0);
  assert.ok(
    !store.calls.tables.includes('marketing_impacts') &&
      !store.calls.tables.includes('marketing_impact_events'),
  );

  capturedLogs.length = 0;
  await upsertSolicitudes([
    item({ tracking_data: JSON.stringify({ utm_source: 'new' }) }),
  ]);
  assert.strictEqual(store.solicitudes.get(1153).tracking_data_summary.jt, JT_A);
  assert.strictEqual(
    store.solicitudes.get(1153).tracking_data_summary.utm_source,
    'new',
  );
  assert.strictEqual(conflictWarns().length, 0);

  capturedLogs.length = 0;
  await upsertSolicitudes([
    item({ tracking_data: JSON.stringify({ utm_source: 'newer', jt: 'nope' }) }),
  ]);
  assert.strictEqual(store.solicitudes.get(1153).tracking_data_summary.jt, JT_A);
  assert.strictEqual(conflictWarns().length, 0);

  capturedLogs.length = 0;
  await upsertSolicitudes([
    item({
      tracking_data: JSON.stringify({ utm_source: 'same', jt: JT_A }),
    }),
  ]);
  assert.strictEqual(store.solicitudes.get(1153).tracking_data_summary.jt, JT_A);
  assert.strictEqual(conflictWarns().length, 0);

  capturedLogs.length = 0;
  await upsertSolicitudes([
    item({
      tracking_data: JSON.stringify({ utm_source: 'meta', jt: JT_B }),
    }),
  ]);
  assert.strictEqual(store.solicitudes.get(1153).tracking_data_summary.jt, JT_A);
  assert.strictEqual(
    store.solicitudes.get(1153).tracking_data_summary.utm_source,
    'meta',
  );
  assert.strictEqual(conflictWarns().length, 1);
  const warn = conflictWarns()[0];
  assert.strictEqual(warn.meta.cz_id, 1153);
  assert.strictEqual(warn.meta.existing_jt_suffix, 'AAAA');
  assert.strictEqual(warn.meta.incoming_jt_suffix, 'BBBB');
  const blob = JSON.stringify(warn);
  assert.ok(!blob.includes(JT_A), 'warn must not contain full existing jt');
  assert.ok(!blob.includes(JT_B), 'warn must not contain full incoming jt');

  const fresh = createStore();
  await upsertSolicitudes([item({ id: 1085, tracking_data: '{}' })]);
  const summary = fresh.solicitudes.get(1085).tracking_data_summary;
  assert.strictEqual(summary.jt, undefined);
  assert.deepStrictEqual(summary, {});

  const failLookup = createStore({ failSelect: true });
  let lookupErr = null;
  try {
    await upsertSolicitudes([
      item({ tracking_data: JSON.stringify({ jt: JT_A }) }),
    ]);
  } catch (err) {
    lookupErr = err;
  }
  assert.ok(lookupErr);
  assert.match(String(lookupErr.message), /existing jt lookup failed/);
  assert.strictEqual(failLookup.solicitudes.size, 0);
  assert.ok(
    !failLookup.calls.upserts.some(function (u) {
      return u.table === SOURCE_SOLICITUDES;
    }),
  );

  const chunkStore = createStore();
  const many = [];
  for (let i = 1; i <= 501; i += 1) {
    many.push(item({ id: i, tracking_data: JSON.stringify({ utm_source: 'sms' }) }));
  }
  await upsertSolicitudes(many);
  const ins = chunkStore.calls.ins.filter(function (c) {
    return c.table === SOURCE_SOLICITUDES;
  });
  assert.strictEqual(ins.length, 2);
  assert.strictEqual(ins[0].ids.length, 500);
  assert.strictEqual(ins[1].ids.length, 1);
  assert.strictEqual(chunkStore.solicitudes.size, 501);
  assert.strictEqual(chunkStore.estados.size, 0);

  const other = createStore();
  await upsertSolicitudes([
    item({
      id: 2001,
      tracking_data: JSON.stringify({ jt: JT_B, utm_source: 'sms' }),
    }),
  ]);
  assert.strictEqual(other.solicitudes.get(2001).tracking_data_summary.jt, JT_B);

  console.log('OK unit-cz-funnel-jt');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
