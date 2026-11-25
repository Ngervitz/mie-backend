'use strict';

/**
 * Tip sync + dual-pass guard tests (in-memory).
 * node scripts/unit-cz-funnel-solicitudes-tip-sync.js
 */

const assert = require('assert');

delete process.env.CDV_GOOGLE_SERVICE_ACCOUNT_JSON;
delete process.env.CDV_GOOGLE_SHEET_ID;
delete process.env.CDV_GOOGLE_SHEET_TAB;
process.env.CZ_API_BEARER_TOKEN = 'unit-test-token';
process.env.CDV_ESTADO8_ELM_AUTOMATION_ENABLED = 'true';

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
    cdvEstado8ElmAutomationEnabled: true,
  },
};

const cursors = new Map();
const solicitudesById = new Map();
const historicoById = new Map();
const enqueueCalls = [];
const {
  handleGuardedUpsertRpc,
} = require('./lib/mock-cz-funnel-guarded-upsert-rpc');

const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    rpc: async function (name, args) {
      if (name === 'acquire_job_lock') return { data: true, error: null };
      if (name === 'release_job_lock') return { data: true, error: null };
      if (name === 'sms_contacts_exclude_old_base_by_ci') return { data: null, error: null };
      if (name === 'cz_funnel_upsert_solicitudes_guarded') {
        const stats = handleGuardedUpsertRpc(args, solicitudesById, historicoById);
        return { data: stats, error: null };
      }
      if (name === 'cdv_estado8_elm_try_enqueue') {
        enqueueCalls.push(args);
        const czId = Number(args.p_cz_solicitud_id);
        const dup = enqueueCalls.filter(function (c) {
          return Number(c.p_cz_solicitud_id) === czId;
        }).length;
        return { data: dup === 1, error: null };
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
              };
            },
            in: async function (col, ids) {
              if (table === 'cz_funnel_solicitudes') {
                const data = (ids || [])
                  .map(function (id) {
                    return solicitudesById.get(Number(id));
                  })
                  .filter(Boolean);
                return { data, error: null };
              }
              return { data: [], error: null };
            },
          };
        },
        upsert: async function (rows, spec) {
          const list = Array.isArray(rows) ? rows : [rows];
          if (table === 'cz_funnel_sync_cursors') {
            const row = list[0];
            const prev = cursors.get(row.source_name) || {};
            cursors.set(row.source_name, Object.assign({}, prev, row));
            return { error: null };
          }
          if (table === 'cz_funnel_solicitudes') {
            list.forEach(function (r) {
              solicitudesById.set(Number(r.cz_id), Object.assign({}, r));
            });
            return { error: null };
          }
          if (table === 'cz_funnel_solicitud_estados') {
            list.forEach(function (r) {
              historicoById.set(Number(r.cz_historico_id), Object.assign({}, r));
            });
            return { error: null };
          }
          return { error: null };
        },
      };
    },
  },
};

const {
  runCzFunnelSolicitudesTipSync,
  resolveTipReadSince,
  TIP_RESUME_MARKER,
  setFetchPagesForTests,
} = require('../src/jobs/czFunnelSolicitudesTipSync');

const nowMs = Date.parse('2026-11-25T15:00:00.000Z');

function apiItem(id, overrides) {
  return Object.assign(
    {
      id,
      ci: 50000000 + id,
      solicitudes_estados_id: 5,
      updated: '2026-11-25T14:00:00Z',
      fechaReg: '2026-11-25T14:00:00Z',
      historico: [],
    },
    overrides,
  );
}

async function testNewEstado8() {
  enqueueCalls.length = 0;
  solicitudesById.clear();
  historicoById.clear();
  cursors.clear();

  setFetchPagesForTests(async function () {
    return {
      items: [
        apiItem(9001, {
          solicitudes_estados_id: 8,
          historico: [
            { id: 1, solicitudes_estados_id: 8, fechahora: '2026-11-25T14:00:05Z' },
          ],
        }),
      ],
      pagesFetched: 1,
      itemsFetched: 1,
      nextSince: '2026-11-25T14:30:00Z',
      incomplete: false,
      hitPageLimit: false,
      resumeSince: null,
    };
  });

  const result = await runCzFunnelSolicitudesTipSync({
    skipLock: true,
    nowMs,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.passComplete, true);
  assert.ok(result.cdvEstado8Elm && result.cdvEstado8Elm.enqueue.enqueued >= 1);
  assert.strictEqual(solicitudesById.get(9001).solicitudes_estados_id, 8);
}

async function testLaterEstado8Transition() {
  solicitudesById.set(9002, {
    cz_id: 9002,
    solicitudes_estados_id: 5,
    updated_at_src: '2026-11-25T13:00:00Z',
    tracking_data_summary: {},
    celular: null,
  });
  setFetchPagesForTests(async function () {
    return {
      items: [
        apiItem(9002, {
          solicitudes_estados_id: 8,
          updated: '2026-11-25T14:10:00Z',
          historico: [
            { id: 2, solicitudes_estados_id: 8, fechahora: '2026-11-25T14:10:03Z' },
          ],
        }),
      ],
      pagesFetched: 1,
      itemsFetched: 1,
      nextSince: '2026-11-25T14:30:00Z',
      incomplete: false,
    };
  });
  const result = await runCzFunnelSolicitudesTipSync({ skipLock: true, nowMs });
  assert.strictEqual(result.itemsUpserted, 1);
  assert.strictEqual(solicitudesById.get(9002).solicitudes_estados_id, 8);
}

async function testConcurrencyStaleParent() {
  solicitudesById.set(9003, {
    cz_id: 9003,
    solicitudes_estados_id: 8,
    updated_at_src: '2026-11-25T14:30:00Z',
    updated_raw: '2026-11-25T14:30:00Z',
    tracking_data_summary: {},
    celular: null,
  });
  setFetchPagesForTests(async function () {
    return {
      items: [
        apiItem(9003, {
          solicitudes_estados_id: 4,
          updated: '2026-11-25T14:00:00Z',
          historico: [],
        }),
      ],
      pagesFetched: 1,
      itemsFetched: 1,
      nextSince: '2026-11-25T14:30:00Z',
      incomplete: false,
    };
  });
  const result = await runCzFunnelSolicitudesTipSync({ skipLock: true, nowMs });
  assert.strictEqual(result.parentSkippedStale, 1);
  assert.strictEqual(result.itemsUpserted, 0);
  assert.strictEqual(solicitudesById.get(9003).solicitudes_estados_id, 8);
}

async function testDuplicateEnqueue() {
  enqueueCalls.length = 0;
  setFetchPagesForTests(async function () {
    return {
      items: [apiItem(9004, { solicitudes_estados_id: 8 })],
      pagesFetched: 1,
      itemsFetched: 1,
      nextSince: '2026-11-25T14:30:00Z',
      incomplete: false,
    };
  });
  await runCzFunnelSolicitudesTipSync({ skipLock: true, nowMs });
  await runCzFunnelSolicitudesTipSync({ skipLock: true, nowMs });
  const n = enqueueCalls.filter(function (c) {
    return Number(c.p_cz_solicitud_id) === 9004;
  }).length;
  assert.ok(n >= 2);
}

async function testIncompleteCursor() {
  cursors.clear();
  setFetchPagesForTests(async function () {
    return {
      items: [apiItem(9005)],
      pagesFetched: 3,
      itemsFetched: 1,
      nextSince: '2026-11-25T14:01:00Z',
      resumeSince: '2026-11-25T14:01:00Z',
      incomplete: true,
      hitPageLimit: true,
    };
  });
  const result = await runCzFunnelSolicitudesTipSync({ skipLock: true, nowMs });
  assert.strictEqual(result.passComplete, false);
  assert.strictEqual(result.hitPageLimit, true);
  const cur = cursors.get('cz_funnel_solicitudes_tip');
  assert.ok(String(cur.last_sync_error).startsWith(TIP_RESUME_MARKER));
  assert.strictEqual(cur.last_since, '2026-11-25T14:01:00Z');
  const resolved = resolveTipReadSince(cur, nowMs);
  assert.strictEqual(resolved.resumed, true);
}

function testLongGapWithoutResumeMarker() {
  const oldTip = '2026-11-20T10:00:00Z';
  const resolved = resolveTipReadSince(
    {
      last_since: oldTip,
      last_sync_status: 'success',
      last_sync_error: null,
    },
    nowMs,
  );
  assert.strictEqual(resolved.longGapFromCursor, true);
  assert.ok(Date.parse(resolved.sinceIso) < nowMs - 48 * 60 * 60 * 1000);
  assert.strictEqual(
    resolved.sinceIso,
    new Date(Date.parse(oldTip) - 2 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z'),
  );
}

function testResumeBeyond48h() {
  const oldResume = '2026-11-20T10:00:00Z';
  const resolved = resolveTipReadSince(
    {
      last_since: oldResume,
      last_sync_error: TIP_RESUME_MARKER + ' — hit_page_limit',
    },
    nowMs,
  );
  assert.strictEqual(resolved.sinceIso, oldResume);
  assert.strictEqual(resolved.resumed, true);
}

async function testErrorRecoveryCursor() {
  cursors.clear();
  setFetchPagesForTests(async function () {
    throw new Error('CZ API timeout (/solicitudes)');
  });
  const result = await runCzFunnelSolicitudesTipSync({ skipLock: true, nowMs });
  assert.strictEqual(result.ok, false);
  const cur = cursors.get('cz_funnel_solicitudes_tip');
  assert.strictEqual(cur.last_sync_status, 'error');
}

(async function main() {
  await testNewEstado8();
  await testLaterEstado8Transition();
  await testConcurrencyStaleParent();
  await testDuplicateEnqueue();
  await testIncompleteCursor();
  testLongGapWithoutResumeMarker();
  testResumeBeyond48h();
  await testErrorRecoveryCursor();
  console.log('unit-cz-funnel-solicitudes-tip-sync: OK');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});