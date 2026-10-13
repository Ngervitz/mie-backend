'use strict';

/**
 * node scripts/unit-cz-salario-boundary.js
 * CZ-SALARIO-BOUNDARY-FIX-01 — salario 65000 declared in Credizona reaches the JANUS row
 * (cz_funnel_solicitudes.salario) and the Mi Plan handoff context (financial_prefill.ingreso)
 * as the number 65000, through the real sync mapper and handoff builder.
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

const rows = new Map();
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    rpc: function () {
      return Promise.resolve({ data: true, error: null });
    },
    from: function () {
      return {
        select: function () {
          return {
            in: function () {
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
        upsert: function (upsertRows) {
          (upsertRows || []).forEach(function (row) {
            rows.set(row.cz_id, Object.assign({}, row));
          });
          return Promise.resolve({ error: null });
        },
      };
    },
  },
};

const { upsertSolicitudes, SOURCE_SOLICITUDES } = require('../src/jobs/czFunnelSync');
const { buildAllowlistedContext } = require('../src/lib/miplanHandoffTokens');

function czApiItem(id, salario) {
  return {
    id: id,
    solicitudes_estados_id: 3,
    usuarios_id: 8,
    ci: 11111111,
    lrw_id: 'LRW-SAL-' + id,
    relacion_laboral: 'EPR',
    salario: salario,
    fechaReg: '2026-09-29 10:00:00',
    updated: '2026-09-29 10:00:00',
    tracking_data: '{}',
    historico: [],
  };
}

(async function run() {
  assert.ok(SOURCE_SOLICITUDES);

  // CZ-SAL-5 — Credizona /api/solicitudes returns salario as a JSON number (int column).
  await upsertSolicitudes([czApiItem(1, 65000)]);
  const row = rows.get(1);
  assert.strictEqual(row.salario, 65000);
  assert.strictEqual(typeof row.salario, 'number');

  // Same value if the export ever serialises the int column as a digit string.
  await upsertSolicitudes([czApiItem(2, '65000')]);
  assert.strictEqual(rows.get(2).salario, 65000);
  assert.strictEqual(typeof rows.get(2).salario, 'number');

  // CZ-SAL-6 — handoff context built from that JANUS row carries ingreso 65000 (number).
  const episode = Object.assign({}, row, { synced_at: '2026-09-29T13:00:00.000Z' });
  const ctx = buildAllowlistedContext(episode, null, '2026-09-29T13:05:00.000Z', {});
  assert.strictEqual(ctx.financial_prefill.ingreso, 65000);
  assert.strictEqual(typeof ctx.financial_prefill.ingreso, 'number');

  // Supabase numeric may come back as a string; still 65000, never reformatted.
  const ctxStr = buildAllowlistedContext(
    Object.assign({}, episode, { salario: '65000' }),
    null,
    '2026-09-29T13:05:00.000Z',
    {},
  );
  assert.strictEqual(ctxStr.financial_prefill.ingreso, 65000);

  console.log('OK unit-cz-salario-boundary');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
