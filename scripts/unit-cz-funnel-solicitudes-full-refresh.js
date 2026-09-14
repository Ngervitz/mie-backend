'use strict';

/**
 * Full-refresh solicitudes sync + historico re-upsert.
 * node scripts/unit-cz-funnel-solicitudes-full-refresh.js
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

const cursors = new Map();
const solicitudesById = new Map();
const historicoById = new Map();
const fetchCalls = [];

const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    rpc: async function (name) {
      if (name === 'acquire_job_lock') return { data: true, error: null };
      if (name === 'release_job_lock') return { data: true, error: null };
      if (name === 'sms_contacts_exclude_old_base_by_ci') {
        return { data: null, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
    from: function (table) {
      return {
        select: function () {
          return {
            eq: function (col, val) {
              return {
                maybeSingle: async function () {
                  if (table === 'cz_funnel_sync_cursors' && col === 'source_name') {
                    return { data: cursors.get(val) || null, error: null };
                  }
                  return { data: null, error: null };
                },
                in: async function () {
                  return { data: [], error: null };
                },
              };
            },
            in: async function () {
              return { data: [], error: null };
            },
          };
        },
        upsert: async function (rows, spec) {
          if (table === 'cz_funnel_sync_cursors') {
            const row = Array.isArray(rows) ? rows[0] : rows;
            const prev = cursors.get(row.source_name) || {};
            cursors.set(row.source_name, Object.assign({}, prev, row));
            return { error: null };
          }
          if (table === 'cz_funnel_solicitudes') {
            assert.strictEqual(spec && spec.onConflict, 'cz_id');
            (Array.isArray(rows) ? rows : []).forEach(function (r) {
              solicitudesById.set(Number(r.cz_id), Object.assign({}, r));
            });
            return { error: null };
          }
          if (table === 'cz_funnel_solicitud_estados') {
            assert.strictEqual(spec && spec.onConflict, 'cz_historico_id');
            (Array.isArray(rows) ? rows : []).forEach(function (r) {
              historicoById.set(Number(r.cz_historico_id), Object.assign({}, r));
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
            error: { message: 'unexpected upsert ' + table },
          };
        },
      };
    },
  },
};

const INITIAL_SINCE = '2020-01-01T00:00:00Z';
let fetchPagesImpl = async function () {
  return {
    items: [],
    pagesFetched: 1,
    itemsFetched: 0,
    nextSince: INITIAL_SINCE,
    hitPageLimit: false,
    incomplete: false,
  };
};

const czApiPath = require.resolve('../src/clients/czApiClient');
require.cache[czApiPath] = {
  id: czApiPath,
  filename: czApiPath,
  loaded: true,
  exports: {
    INITIAL_SINCE: INITIAL_SINCE,
    fetchAllCzPages: async function (path, since) {
      fetchCalls.push({ path: path, since: since });
      return fetchPagesImpl(path, since);
    },
    getCzApiBearerTokenDiagnostic: function () {
      return { present: false };
    },
  },
};

delete require.cache[require.resolve('../src/jobs/czFunnelSync')];
const {
  runCzFunnelSync,
  syncSource,
  SOURCE_SOLICITUDES,
  upsertSolicitudes,
  setCdvSheetSyncForTests,
} = require('../src/jobs/czFunnelSync');

setCdvSheetSyncForTests(async function () {});

function resetState() {
  cursors.clear();
  solicitudesById.clear();
  historicoById.clear();
  fetchCalls.length = 0;
}

function solicitudPayload(overrides) {
  return Object.assign(
    {
      id: 1210,
      ci: 44388428,
      solicitudes_estados_id: 1,
      usuarios_id: 1,
      fechaReg: '2026-09-14 13:40:03',
      nombre: 'Test',
      apellido: 'User',
      tracking_data: { utm_source: 'sms' },
      historico: [
        {
          id: 136,
          solicitudes_estados_id: 1,
          estado: 'Autorizando',
          fechahora: '2026-09-14 13:40:03',
        },
      ],
    },
    overrides || {},
  );
}

(async function main() {
  // 1. Initial sync estado 1 → later full refresh estado 3 + hist 3
  resetState();
  cursors.set(SOURCE_SOLICITUDES, {
    source_name: SOURCE_SOLICITUDES,
    last_since: '2026-09-14T14:00:00Z',
  });

  let round = 0;
  fetchPagesImpl = async function (path) {
    if (path !== '/solicitudes') {
      return {
        items: [],
        pagesFetched: 1,
        itemsFetched: 0,
        nextSince: INITIAL_SINCE,
        hitPageLimit: false,
        incomplete: false,
      };
    }
    round += 1;
    if (round === 1) {
      return {
        items: [solicitudPayload()],
        pagesFetched: 1,
        itemsFetched: 1,
        nextSince: '2026-09-14T13:40:03Z',
        hitPageLimit: false,
        incomplete: false,
      };
    }
    return {
      items: [
        solicitudPayload({
          solicitudes_estados_id: 3,
          historico: [
            {
              id: 136,
              solicitudes_estados_id: 1,
              estado: 'Autorizando',
              fechahora: '2026-09-14 13:40:03',
            },
            {
              id: 137,
              solicitudes_estados_id: 3,
              estado: 'Autorizacion negada',
              fechahora: '2026-09-14 13:40:08',
            },
          ],
        }),
      ],
      pagesFetched: 1,
      itemsFetched: 1,
      nextSince: '2026-09-14T13:40:03Z',
      hitPageLimit: false,
      incomplete: false,
    };
  };

  const r1 = await runCzFunnelSync();
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.solicitudes.fullRefresh, true);
  assert.strictEqual(r1.solicitudes.initialSince, INITIAL_SINCE);
  const solFetch1 = fetchCalls.filter(function (c) {
    return c.path === '/solicitudes';
  });
  assert.strictEqual(solFetch1[0].since, INITIAL_SINCE);
  assert.strictEqual(solicitudesById.get(1210).solicitudes_estados_id, 1);
  assert.strictEqual(historicoById.has(136), true);
  assert.strictEqual(historicoById.has(137), false);

  const r2 = await runCzFunnelSync();
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.solicitudes.fullRefresh, true);
  assert.strictEqual(r2.solicitudes.initialSince, INITIAL_SINCE);
  const solFetch2 = fetchCalls.filter(function (c) {
    return c.path === '/solicitudes';
  });
  assert.strictEqual(solFetch2[1].since, INITIAL_SINCE);
  assert.notStrictEqual(
    solFetch2[1].since,
    '2026-09-14T14:00:00Z',
    'full refresh must ignore stored last_since',
  );
  assert.strictEqual(solicitudesById.get(1210).solicitudes_estados_id, 3);
  assert.strictEqual(historicoById.get(137).solicitudes_estados_id, 3);
  assert.strictEqual(historicoById.get(136).solicitudes_estados_id, 1);

  // 2+3. Repeat full refresh → no duplicate keys, historico still present
  const histCountBefore = historicoById.size;
  const r3 = await runCzFunnelSync();
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(historicoById.size, histCountBefore);
  assert.strictEqual(solicitudesById.size, 1);
  assert.strictEqual(historicoById.has(136), true);
  assert.strictEqual(historicoById.has(137), true);

  // 10. Page limit → do not claim complete sync / do not wipe error
  resetState();
  cursors.set(SOURCE_SOLICITUDES, {
    source_name: SOURCE_SOLICITUDES,
    last_since: '2026-09-01T00:00:00Z',
  });
  fetchPagesImpl = async function (path) {
    if (path !== '/solicitudes') {
      return {
        items: [],
        pagesFetched: 1,
        itemsFetched: 0,
        nextSince: INITIAL_SINCE,
        hitPageLimit: false,
        incomplete: false,
      };
    }
    return {
      items: [solicitudPayload({ id: 999 })],
      pagesFetched: 50,
      itemsFetched: 1,
      nextSince: '2026-09-14T13:40:03Z',
      hitPageLimit: true,
      incomplete: true,
    };
  };
  const limited = await syncSource({
    sourceName: SOURCE_SOLICITUDES,
    apiPath: '/solicitudes',
    upsertPage: upsertSolicitudes,
    fullRefresh: true,
  });
  assert.strictEqual(limited.fullRefresh, true);
  assert.strictEqual(limited.initialSince, INITIAL_SINCE);
  assert.strictEqual(limited.hitPageLimit, true);
  assert.ok(String(limited.error || '').indexOf('hit_page_limit') !== -1);
  assert.strictEqual(limited.nextSince, INITIAL_SINCE);
  const cursorAfterLimit = cursors.get(SOURCE_SOLICITUDES);
  assert.ok(cursorAfterLimit);
  assert.ok(
    String(cursorAfterLimit.last_sync_error || '').indexOf('hit_page_limit') !==
      -1,
  );
  assert.notStrictEqual(
    cursorAfterLimit.last_since,
    '2026-09-14T13:40:03Z',
    'incomplete full refresh must not advance last_since to page tip',
  );

  // API error → status error, not false success
  resetState();
  fetchPagesImpl = async function (path) {
    if (path === '/solicitudes') throw new Error('CZ API /solicitudes failed: boom');
    return {
      items: [],
      pagesFetched: 1,
      itemsFetched: 0,
      nextSince: INITIAL_SINCE,
      hitPageLimit: false,
      incomplete: false,
    };
  };
  const failed = await syncSource({
    sourceName: SOURCE_SOLICITUDES,
    apiPath: '/solicitudes',
    upsertPage: upsertSolicitudes,
    fullRefresh: true,
  });
  assert.strictEqual(failed.status, 'error');
  assert.ok(String(failed.error || '').indexOf('boom') !== -1);
  assert.strictEqual(cursors.get(SOURCE_SOLICITUDES).last_sync_status, 'error');

  // Granted/encuestas still use cursor (not fullRefresh) when run via job
  resetState();
  cursors.set('cz_funnel_granted_loans', {
    source_name: 'cz_funnel_granted_loans',
    last_since: '2026-08-01T00:00:00Z',
  });
  cursors.set('cz_funnel_encuestas', {
    source_name: 'cz_funnel_encuestas',
    last_since: '2026-08-15T00:00:00Z',
  });
  fetchPagesImpl = async function (path, since) {
    return {
      items: [],
      pagesFetched: 1,
      itemsFetched: 0,
      nextSince: since,
      hitPageLimit: false,
      incomplete: false,
    };
  };
  await runCzFunnelSync();
  const grantedFetch = fetchCalls.find(function (c) {
    return c.path === '/cdv_granted_loans';
  });
  const encFetch = fetchCalls.find(function (c) {
    return c.path === '/encuestas';
  });
  const solFetch = fetchCalls.find(function (c) {
    return c.path === '/solicitudes';
  });
  assert.strictEqual(grantedFetch.since, '2026-08-01T00:00:00Z');
  assert.strictEqual(encFetch.since, '2026-08-15T00:00:00Z');
  assert.strictEqual(solFetch.since, INITIAL_SINCE);

  console.log('OK unit-cz-funnel-solicitudes-full-refresh');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
