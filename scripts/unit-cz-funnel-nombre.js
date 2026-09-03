'use strict';

/**
 * node scripts/unit-cz-funnel-nombre.js
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

const {
  SOURCE_SOLICITUDES,
  upsertSolicitudes,
  nullablePersonName,
} = require('../src/jobs/czFunnelSync');

assert.strictEqual(nullablePersonName('Jonathan'), 'Jonathan');
assert.strictEqual(nullablePersonName('  Ana  '), 'Ana');
assert.strictEqual(nullablePersonName(null), null);
assert.strictEqual(nullablePersonName(undefined), null);
assert.strictEqual(nullablePersonName(''), null);
assert.strictEqual(nullablePersonName('   '), null);

function item(overrides) {
  return Object.assign(
    {
      id: 1153,
      solicitudes_estados_id: 3,
      usuarios_id: 8,
      ci: 45006120,
      fechaReg: '2026-08-20 11:48:20',
      updated: '2026-08-20 11:48:20',
      tracking_data: JSON.stringify({ utm_source: 'sms' }),
      historico: [],
    },
    overrides || {},
  );
}

function createStore() {
  const solicitudes = new Map();
  const upserts = [];
  supabaseImpl = {
    rpc: function () {
      return Promise.resolve({ data: true, error: null });
    },
    from: function (table) {
      return {
        select: function () {
          return {
            in: function () {
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
        upsert: function (rows, spec) {
          upserts.push({
            table: table,
            rows: rows,
            onConflict: spec && spec.onConflict,
          });
          if (table === SOURCE_SOLICITUDES) {
            (rows || []).forEach(function (row) {
              solicitudes.set(row.cz_id, Object.assign({}, row));
            });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { solicitudes: solicitudes, upserts: upserts };
}

(async function run() {
  const store = createStore();
  await upsertSolicitudes([
    item({
      nombre: 'Jonathan',
      apellido: 'Pérez',
    }),
  ]);
  const normal = store.solicitudes.get(1153);
  assert.strictEqual(normal.nombre, 'Jonathan');
  assert.strictEqual(normal.apellido, 'Pérez');
  assert.strictEqual(normal.cz_id, 1153);
  assert.strictEqual(normal.ci, 45006120);
  assert.strictEqual(normal.usuarios_id, 8);
  assert.strictEqual(normal.solicitudes_estados_id, 3);
  assert.ok(normal.tracking_data_summary);
  assert.strictEqual(normal.tracking_data_summary.utm_source, 'sms');

  const storeNull = createStore();
  await upsertSolicitudes([item({ nombre: null, apellido: undefined })]);
  const nulled = storeNull.solicitudes.get(1153);
  assert.strictEqual(nulled.nombre, null);
  assert.strictEqual(nulled.apellido, null);
  assert.strictEqual(nulled.ci, 45006120);
  assert.strictEqual(nulled.usuarios_id, 8);

  const storeEmpty = createStore();
  await upsertSolicitudes([item({ nombre: '', apellido: '   ' })]);
  const emptied = storeEmpty.solicitudes.get(1153);
  assert.strictEqual(emptied.nombre, null);
  assert.strictEqual(emptied.apellido, null);
  assert.strictEqual(emptied.solicitudes_estados_id, 3);

  const solUpserts = store.upserts.filter(function (u) {
    return u.table === SOURCE_SOLICITUDES;
  });
  assert.strictEqual(solUpserts[0].onConflict, 'cz_id');

  console.log('OK unit-cz-funnel-nombre');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
