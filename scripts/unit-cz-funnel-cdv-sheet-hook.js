'use strict';

/**
 * node scripts/unit-cz-funnel-cdv-sheet-hook.js
 *
 * Proves CDV Sheet reconcile runs once per runCzFunnelSync,
 * including when solicitudes itemsFetched=0.
 */

const assert = require('assert');

delete process.env.CDV_GOOGLE_SERVICE_ACCOUNT_JSON;
delete process.env.CDV_GOOGLE_SHEET_ID;
delete process.env.CDV_GOOGLE_SHEET_TAB;

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
const cursors = new Map();
const estado8Rows = [];
const solicitudesById = new Map();

function resetDb() {
  cursors.clear();
  estado8Rows.length = 0;
  solicitudesById.clear();
  ['cz_funnel_granted_loans', 'cz_funnel_solicitudes', 'cz_funnel_encuestas'].forEach(
    function (name) {
      cursors.set(name, {
        source_name: name,
        last_since: '2026-09-01T00:00:00Z',
        last_sync_status: 'success',
      });
    },
  );
}

require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    rpc: async function (name) {
      if (name === 'acquire_job_lock') return { data: true, error: null };
      if (name === 'release_job_lock') return { data: true, error: null };
      if (name === 'sms_contacts_exclude_old_base_by_ci') {
        return { data: true, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
    from: function (table) {
      return {
        select: function () {
          return {
            eq: function (col, val) {
              if (
                table === 'cz_funnel_sync_cursors' &&
                col === 'source_name'
              ) {
                return {
                  maybeSingle: async function () {
                    return {
                      data: cursors.get(val) || null,
                      error: null,
                    };
                  },
                };
              }
              if (
                table === 'cz_funnel_solicitud_estados' &&
                col === 'solicitudes_estados_id'
              ) {
                return Promise.resolve({
                  data: estado8Rows.filter(function (r) {
                    return Number(r.solicitudes_estados_id) === Number(val);
                  }),
                  error: null,
                });
              }
              return {
                maybeSingle: async function () {
                  return { data: null, error: null };
                },
              };
            },
            maybeSingle: async function () {
              return { data: null, error: null };
            },
            in: async function (col, ids) {
              if (table === 'cz_funnel_solicitudes' && col === 'cz_id') {
                const data = [];
                (ids || []).forEach(function (id) {
                  const row = solicitudesById.get(Number(id));
                  if (row) data.push(row);
                });
                return { data: data, error: null };
              }
              return { data: [], error: null };
            },
          };
        },
        upsert: async function (rows, spec) {
          if (table === 'cz_funnel_sync_cursors') {
            const row = Array.isArray(rows) ? rows[0] : rows;
            cursors.set(row.source_name, Object.assign({}, row));
            return { error: null };
          }
          if (table === 'cz_funnel_solicitudes') {
            (rows || []).forEach(function (r) {
              solicitudesById.set(Number(r.cz_id), {
                cz_id: r.cz_id,
                ci: r.ci,
                tracking_data_summary: r.tracking_data_summary || {},
              });
            });
            return { error: null };
          }
          if (table === 'cz_funnel_solicitud_estados') {
            (rows || []).forEach(function (r) {
              if (Number(r.solicitudes_estados_id) === 8) {
                estado8Rows.push({
                  cz_solicitud_id: r.cz_solicitud_id,
                  solicitudes_estados_id: 8,
                  fechahora_src: r.fechahora_src,
                });
              }
            });
            return { error: null };
          }
          if (
            table === 'cz_funnel_granted_loans' ||
            table === 'cz_funnel_encuestas'
          ) {
            return { error: null };
          }
          return {
            error: {
              message:
                'unexpected upsert ' +
                table +
                ' ' +
                (spec && spec.onConflict),
            },
          };
        },
      };
    },
  },
};

const czApiPath = require.resolve('../src/clients/czApiClient');
let fetchPagesImpl = async function () {
  return {
    items: [],
    pagesFetched: 1,
    itemsFetched: 0,
    nextSince: '2026-09-01T00:00:00Z',
    hitPageLimit: false,
    incomplete: false,
  };
};
require.cache[czApiPath] = {
  id: czApiPath,
  filename: czApiPath,
  loaded: true,
  exports: {
    INITIAL_SINCE: '2020-01-01T00:00:00Z',
    fetchAllCzPages: async function (path) {
      return fetchPagesImpl(path);
    },
    getCzApiBearerTokenDiagnostic: function () {
      return { present: false };
    },
  },
};

delete require.cache[require.resolve('../src/jobs/czFunnelSync')];
const {
  runCzFunnelSync,
  upsertSolicitudes,
  setCdvSheetSyncForTests,
} = require('../src/jobs/czFunnelSync');

(async function main() {
  // 1 + 2: itemsFetched=0 → still reconciles persisted estado 8 once
  resetDb();
  estado8Rows.push({
    cz_solicitud_id: 1168,
    solicitudes_estados_id: 8,
    fechahora_src: '2026-09-01T21:33:40.000Z',
  });
  solicitudesById.set(1168, { cz_id: 1168, ci: 29108021 });

  let cdvCalls = [];
  setCdvSheetSyncForTests(async function (payload) {
    cdvCalls.push(payload);
  });
  fetchPagesImpl = async function () {
    return {
      items: [],
      pagesFetched: 1,
      itemsFetched: 0,
      nextSince: '2026-09-01T00:00:00Z',
      hitPageLimit: false,
      incomplete: false,
    };
  };

  const emptyResult = await runCzFunnelSync();
  assert.strictEqual(emptyResult.ok, true);
  assert.strictEqual(emptyResult.solicitudes.itemsFetched, 0);
  assert.strictEqual(cdvCalls.length, 1, 'reconcile must run once when items=0');
  assert.ok(cdvCalls[0].supabase, 'payload must include supabase for Janus load');

  // 3: Google fails → job still OK
  resetDb();
  estado8Rows.push({
    cz_solicitud_id: 1168,
    solicitudes_estados_id: 8,
    fechahora_src: '2026-09-01T21:33:40.000Z',
  });
  solicitudesById.set(1168, { cz_id: 1168, ci: 29108021 });
  cdvCalls = [];
  setCdvSheetSyncForTests(async function () {
    cdvCalls.push(1);
    throw new Error('google sheets boom');
  });
  const failResult = await runCzFunnelSync();
  assert.strictEqual(failResult.ok, true);
  assert.strictEqual(cdvCalls.length, 1);

  // 4: new solicitudes → reconcile exactly once (not per item / not from upsert)
  resetDb();
  cdvCalls = [];
  setCdvSheetSyncForTests(async function (payload) {
    cdvCalls.push(payload);
  });
  fetchPagesImpl = async function (path) {
    if (path === '/solicitudes') {
      return {
        items: [
          {
            id: 2001,
            ci: 111,
            solicitudes_estados_id: 8,
            fechaReg: '2026-09-10 10:00:00',
            updated: '2026-09-10 10:00:00',
            tracking_data: {},
            historico: [
              {
                id: 900,
                solicitudes_estados_id: 8,
                estado: '🟡 En Créditos de valor',
                fechahora: '2026-09-10 10:00:05',
              },
            ],
          },
          {
            id: 2002,
            ci: 222,
            solicitudes_estados_id: 1,
            fechaReg: '2026-09-10 11:00:00',
            updated: '2026-09-10 11:00:00',
            tracking_data: {},
            historico: [
              {
                id: 901,
                solicitudes_estados_id: 1,
                estado: '⏺ Autorizando',
                fechahora: '2026-09-10 11:00:00',
              },
            ],
          },
        ],
        pagesFetched: 1,
        itemsFetched: 2,
        nextSince: '2026-09-10T11:00:00-03:00',
        hitPageLimit: false,
        incomplete: false,
      };
    }
    return {
      items: [],
      pagesFetched: 1,
      itemsFetched: 0,
      nextSince: '2026-09-01T00:00:00Z',
      hitPageLimit: false,
      incomplete: false,
    };
  };

  const withItems = await runCzFunnelSync();
  assert.strictEqual(withItems.ok, true);
  assert.strictEqual(withItems.solicitudes.itemsFetched, 2);
  assert.strictEqual(
    cdvCalls.length,
    1,
    'reconcile must run exactly once with new solicitudes',
  );
  assert.ok(solicitudesById.has(2001));
  assert.ok(
    estado8Rows.some(function (r) {
      return Number(r.cz_solicitud_id) === 2001;
    }),
    'estado 8 from batch must be persisted before reconcile',
  );

  // upsertSolicitudes alone must NOT call CDV sheet (hook moved to job level)
  cdvCalls = [];
  setCdvSheetSyncForTests(async function () {
    cdvCalls.push(1);
  });
  await upsertSolicitudes([
    {
      id: 3001,
      ci: 333,
      solicitudes_estados_id: 8,
      fechaReg: '2026-09-11 10:00:00',
      updated: '2026-09-11 10:00:00',
      tracking_data: {},
      historico: [
        {
          id: 950,
          solicitudes_estados_id: 8,
          estado: '🟡 En Créditos de valor',
          fechahora: '2026-09-11 10:00:01',
        },
      ],
    },
  ]);
  assert.strictEqual(
    cdvCalls.length,
    0,
    'upsertSolicitudes must not invoke CDV sheet sync',
  );

  setCdvSheetSyncForTests(null);
  console.log('OK unit-cz-funnel-cdv-sheet-hook');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
