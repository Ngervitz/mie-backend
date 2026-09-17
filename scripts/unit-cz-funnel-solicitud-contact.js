'use strict';

/**
 * node scripts/unit-cz-funnel-solicitud-contact.js
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
  nullableTrimmedText,
} = require('../src/jobs/czFunnelSync');

const {
  isValidEmail,
  isValidLrwId,
  indexApiContactByCzId,
  resolveLastRejectionByCi,
  planSolicitudContactRehydration,
  evaluateRehydrationGate,
} = require('../src/lib/czFunnelSolicitudContact');

assert.strictEqual(nullableTrimmedText('a@b.co'), 'a@b.co');
assert.strictEqual(nullableTrimmedText('  x  '), 'x');
assert.strictEqual(nullableTrimmedText(''), null);
assert.strictEqual(nullableTrimmedText('   '), null);
assert.strictEqual(nullableTrimmedText(null), null);
assert.strictEqual(nullableTrimmedText(undefined), null);

assert.strictEqual(isValidEmail('a@b.co'), true);
assert.strictEqual(isValidEmail(''), false);
assert.strictEqual(isValidEmail('nope'), false);
assert.strictEqual(isValidLrwId('LRW-1'), true);
assert.strictEqual(isValidLrwId(''), false);

function item(overrides) {
  return Object.assign(
    {
      id: 1153,
      solicitudes_estados_id: 3,
      usuarios_id: 8,
      ci: 45006120,
      email: 'user@example.com',
      lrw_id: 'LRW-111-222-333',
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
  await upsertSolicitudes([item()]);
  const row = store.solicitudes.get(1153);
  assert.strictEqual(row.email, 'user@example.com');
  assert.strictEqual(row.lrw_id, 'LRW-111-222-333');
  assert.strictEqual(row.ci, 45006120);
  // existing fields still mapped
  assert.strictEqual(row.solicitudes_estados_id, 3);
  assert.strictEqual(row.usuarios_id, 8);
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'email'));
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'lrw_id'));
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'tracking_data_summary'));
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'synced_at'));

  const storeNull = createStore();
  await upsertSolicitudes([item({ email: null, lrw_id: undefined })]);
  const nulled = storeNull.solicitudes.get(1153);
  assert.strictEqual(nulled.email, null);
  assert.strictEqual(nulled.lrw_id, null);

  const storeEmpty = createStore();
  await upsertSolicitudes([item({ email: '', lrw_id: '   ' })]);
  const emptied = storeEmpty.solicitudes.get(1153);
  assert.strictEqual(emptied.email, null);
  assert.strictEqual(emptied.lrw_id, null);

  const storeTrim = createStore();
  await upsertSolicitudes([
    item({ email: '  a@b.co  ', lrw_id: '  LRW-9  ' }),
  ]);
  const trimmed = storeTrim.solicitudes.get(1153);
  assert.strictEqual(trimmed.email, 'a@b.co');
  assert.strictEqual(trimmed.lrw_id, 'LRW-9');

  // Pure plan helpers
  const apiMap = indexApiContactByCzId([
    {
      id: 10,
      ci: 111,
      email: 'one@ex.com',
      lrw_id: 'LRW-A',
    },
    {
      id: 11,
      ci: 111,
      email: 'one@ex.com',
      lrw_id: 'LRW-B',
    },
  ]);
  const last = resolveLastRejectionByCi(
    [
      {
        cz_historico_id: 1,
        cz_solicitud_id: 10,
        solicitudes_estados_id: 3,
        fechahora_src: '2026-09-01T00:00:00Z',
      },
      {
        cz_historico_id: 2,
        cz_solicitud_id: 11,
        solicitudes_estados_id: 3,
        fechahora_src: '2026-09-02T00:00:00Z',
      },
    ],
    [
      { cz_id: 10, ci: 111 },
      { cz_id: 11, ci: 111 },
    ],
  );
  assert.strictEqual(last.get(111).cz_solicitud_id, 11);

  const plan = planSolicitudContactRehydration({
    apiContactByCzId: apiMap,
    existingCzIds: new Set([10, 11]),
    lastRejectionByCi: last,
    janusContactByCzId: new Map(),
  });
  assert.strictEqual(plan.rejected_ci_count, 1);
  assert.strictEqual(plan.with_both_count, 1);
  assert.strictEqual(plan.rows_would_update, 1);
  assert.strictEqual(plan.updates[0].cz_id, 11);
  assert.strictEqual(plan.updates[0].lrw_id, 'LRW-B');

  const gateFail = evaluateRehydrationGate(plan, { expectedRejectedCi: 35 });
  assert.strictEqual(gateFail.ok, false);

  const gateOk = evaluateRehydrationGate(
    {
      rejected_ci_count: 35,
      with_email_count: 35,
      with_lrw_count: 35,
      with_both_count: 35,
      missing_solicitud_in_janus: 0,
      missing_solicitud_in_api: 0,
    },
    { expectedRejectedCi: 35 },
  );
  assert.strictEqual(gateOk.ok, true);

  console.log('OK unit-cz-funnel-solicitud-contact');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
