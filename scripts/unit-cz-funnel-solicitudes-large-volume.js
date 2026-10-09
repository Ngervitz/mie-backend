'use strict';

/**
 * /solicitudes sync beyond one run's page limit (50 × 500) and at page boundaries.
 * Real czApiClient + syncSource against an in-memory CZ API that mirrors
 * apiController::solicitudes / Solicitudes::getSolicitudesInfo:
 *   WHERE updated > since (second precision), ORDER BY updated ASC (ties unstable),
 *   LIMIT 501, hasMore = count > 500, nextSince = date('c', last.updated).
 * node scripts/unit-cz-funnel-solicitudes-large-volume.js
 */

const assert = require('assert');

delete process.env.CDV_GOOGLE_SERVICE_ACCOUNT_JSON;
delete process.env.CDV_GOOGLE_SHEET_ID;
delete process.env.CDV_GOOGLE_SHEET_TAB;
process.env.CZ_API_BEARER_TOKEN = 'unit-test-token';

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

// ---------------------------------------------------------------------------
// Supabase mirror (upsert semantics of the real tables)
// ---------------------------------------------------------------------------

const cursors = new Map();
const solicitudesById = new Map();
const historicoById = new Map();

function assertNoDuplicateKeys(rows, key, table) {
  const seen = new Set();
  for (const r of rows) {
    const k = String(r[key]);
    // Postgres: ON CONFLICT DO UPDATE command cannot affect row a second time
    assert.ok(!seen.has(k), `${table}: duplicate ${key}=${k} in one upsert`);
    seen.add(k);
  }
}

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
          const list = Array.isArray(rows) ? rows : [rows];
          if (table === 'cz_funnel_sync_cursors') {
            const row = list[0];
            const prev = cursors.get(row.source_name) || {};
            cursors.set(row.source_name, Object.assign({}, prev, row));
            return { error: null };
          }
          if (table === 'cz_funnel_solicitudes') {
            assert.strictEqual(spec && spec.onConflict, 'cz_id');
            assertNoDuplicateKeys(list, 'cz_id', table);
            list.forEach(function (r) {
              solicitudesById.set(Number(r.cz_id), Object.assign({}, r));
            });
            return { error: null };
          }
          if (table === 'cz_funnel_solicitud_estados') {
            assert.strictEqual(spec && spec.onConflict, 'cz_historico_id');
            assertNoDuplicateKeys(list, 'cz_historico_id', table);
            list.forEach(function (r) {
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
          return { error: { message: 'unexpected upsert ' + table } };
        },
      };
    },
  },
};

// ---------------------------------------------------------------------------
// In-memory CZ API (server clock UTC-03:00, like cPanel America/Montevideo)
// ---------------------------------------------------------------------------

const CZ_OFFSET_MS = -3 * 3600 * 1000;
const CZ_PAGE = 500;
const BASE_SEC = Math.floor(Date.parse('2026-01-01T12:00:00Z') / 1000);

/** @type {Map<number, { id:number, updatedSec:number, estado:number, historico:object[] }>} */
const czRows = new Map();
let nextHistId = 1;
let czRequests = [];

function czLocal(sec) {
  return new Date(sec * 1000 + CZ_OFFSET_MS).toISOString().slice(0, 19);
}
function czDateTime(sec) {
  return czLocal(sec).replace('T', ' ');
}
function czDateC(sec) {
  return `${czLocal(sec)}-03:00`;
}

function hashTie(id, salt) {
  let h = 2166136261 ^ id;
  for (let i = 0; i < salt.length; i += 1) {
    h = Math.imul(h ^ salt.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function addCzSolicitud(id, updatedSec, estado) {
  const row = { id, updatedSec, estado: estado || 1, historico: [] };
  row.historico.push({
    id: nextHistId++,
    solicitudes_id: id,
    solicitudes_estados_id: 1,
    estado: 'Autorizando',
    fechahora: czDateTime(updatedSec),
  });
  if (row.estado !== 1) {
    row.historico.push({
      id: nextHistId++,
      solicitudes_id: id,
      solicitudes_estados_id: row.estado,
      estado: 'Estado ' + row.estado,
      fechahora: czDateTime(updatedSec + 5),
    });
  }
  czRows.set(id, row);
  return row;
}

/** updateEstado + createHistoric: `updated` is NOT touched. */
function czUpdateEstado(id, estado, atSec) {
  const row = czRows.get(id);
  row.estado = estado;
  row.historico.push({
    id: nextHistId++,
    solicitudes_id: id,
    solicitudes_estados_id: estado,
    estado: 'Estado ' + estado,
    fechahora: czDateTime(atSec),
  });
}

function czSolicitudesPage(since) {
  const sinceMs = Date.parse(since);
  assert.ok(Number.isFinite(sinceMs), 'CZ strtotime(since) must parse: ' + since);
  const sinceSec = Math.floor(sinceMs / 1000);
  const matched = [];
  for (const r of czRows.values()) {
    if (r.updatedSec > sinceSec) matched.push(r);
  }
  matched.sort(function (a, b) {
    if (a.updatedSec !== b.updatedSec) return a.updatedSec - b.updatedSec;
    return hashTie(a.id, since) - hashTie(b.id, since);
  });
  const slice = matched.slice(0, CZ_PAGE + 1);
  const hasMore = slice.length > CZ_PAGE;
  if (hasMore) slice.pop();
  const items = slice.map(function (r) {
    return {
      id: r.id,
      solicitudes_estados_id: r.estado,
      usuarios_id: r.id,
      ci: 10000000 + r.id,
      fechaReg: czDateTime(r.updatedSec),
      updated: czDateTime(r.updatedSec),
      historico: r.historico
        .slice()
        .reverse()
        .map(function (h) {
          return Object.assign({}, h);
        }),
    };
  });
  const last = slice[slice.length - 1];
  return {
    items,
    hasMore,
    nextSince: last ? czDateC(last.updatedSec) : null,
  };
}

global.fetch = async function (url) {
  const u = new URL(String(url));
  const path = u.pathname.replace(/^\/api/, '');
  const since = u.searchParams.get('since');
  czRequests.push({ path, since });
  const data =
    path === '/solicitudes'
      ? czSolicitudesPage(since)
      : { items: [], hasMore: false, nextSince: null };
  const body = JSON.stringify({ data });
  return {
    ok: true,
    status: 200,
    text: async function () {
      return body;
    },
  };
};

// ---------------------------------------------------------------------------

const czApi = require('../src/clients/czApiClient');
delete require.cache[require.resolve('../src/jobs/czFunnelSync')];
const {
  runCzFunnelSync,
  syncSource,
  SOURCE_SOLICITUDES,
  upsertSolicitudes,
  FULL_REFRESH_RESUME_MARKER,
  setCdvSheetSyncForTests,
} = require('../src/jobs/czFunnelSync');

setCdvSheetSyncForTests(async function () {});

const PER_RUN = czApi.MAX_PAGES_PER_RUN * CZ_PAGE;

function resetAll() {
  cursors.clear();
  solicitudesById.clear();
  historicoById.clear();
  czRows.clear();
  nextHistId = 1;
  czRequests = [];
}

function runSolicitudes() {
  return syncSource({
    sourceName: SOURCE_SOLICITUDES,
    apiPath: '/solicitudes',
    upsertPage: upsertSolicitudes,
    fullRefresh: true,
  });
}

function seedDistinctSeconds(count, rejectedFromId) {
  for (let i = 1; i <= count; i += 1) {
    addCzSolicitud(i, BASE_SEC + i * 10, i >= rejectedFromId ? 3 : 1);
  }
}

function hasHist3(czId) {
  for (const h of historicoById.values()) {
    if (h.cz_solicitud_id === czId && h.solicitudes_estados_id === 3) return true;
  }
  return false;
}

(async function main() {
  // overlapSince: CZ date('c') with offset → UTC one second earlier
  assert.strictEqual(
    czApi.overlapSince('2026-10-06T11:58:40-03:00'),
    '2026-10-06T14:58:39Z',
  );
  assert.strictEqual(czApi.overlapSince('2020-01-01T00:00:00Z'), '2019-12-31T23:59:59Z');
  assert.strictEqual(czApi.overlapSince('not a date'), null);
  assert.strictEqual(czApi.overlapSince(null), null);

  // 1. Reproduction: restarting from INITIAL_SINCE with the per-run page limit
  //    never reaches rows beyond PER_RUN (the newest ones, incl. rejected).
  resetAll();
  const TOTAL = PER_RUN + 1000;
  seedDistinctSeconds(TOTAL, PER_RUN + 1);
  const legacyA = await czApi.fetchAllCzPages('/solicitudes', czApi.INITIAL_SINCE);
  const legacyB = await czApi.fetchAllCzPages('/solicitudes', czApi.INITIAL_SINCE);
  assert.strictEqual(legacyA.incomplete, true);
  assert.strictEqual(legacyA.items.length, PER_RUN);
  const legacyMaxId = Math.max.apply(
    null,
    legacyB.items.map(function (i) {
      return i.id;
    }),
  );
  assert.strictEqual(legacyMaxId, PER_RUN, 'restart-from-zero never passes the limit');

  // 2. Fix: full refresh resumes across runs → every row reached, no duplicates
  resetAll();
  seedDistinctSeconds(TOTAL, PER_RUN + 1);
  const run1 = await runSolicitudes();
  assert.strictEqual(run1.status, 'success');
  assert.strictEqual(run1.hitPageLimit, true);
  assert.strictEqual(run1.resumed, false);
  assert.strictEqual(run1.initialSince, czApi.INITIAL_SINCE);
  // each page after the first re-reads the previous page's boundary row
  assert.strictEqual(solicitudesById.size, PER_RUN - (czApi.MAX_PAGES_PER_RUN - 1));
  assert.strictEqual(run1.itemsUpserted, solicitudesById.size);
  assert.strictEqual(run1.passComplete, false, 'partial run is never reported as a complete pass');
  const c1 = cursors.get(SOURCE_SOLICITUDES);
  assert.strictEqual(c1.last_sync_status, 'success');
  assert.ok(String(c1.last_sync_error).startsWith(FULL_REFRESH_RESUME_MARKER));
  assert.ok(String(c1.last_sync_error).indexOf('hit_page_limit') !== -1);
  assert.strictEqual(c1.last_since, run1.nextSince);
  assert.ok(!hasHist3(PER_RUN + 1), 'tail rejection not yet visible after run 1');

  const run2 = await runSolicitudes();
  assert.strictEqual(run2.status, 'success');
  assert.strictEqual(run2.resumed, true);
  assert.strictEqual(run2.hitPageLimit, false);
  assert.strictEqual(run2.passComplete, true);
  assert.strictEqual(run2.initialSince, c1.last_since);
  assert.strictEqual(solicitudesById.size, TOTAL, 'all solicitudes mirrored');
  for (let id = 1; id <= TOTAL; id += 1) {
    assert.ok(solicitudesById.has(id), 'missing cz_id ' + id);
  }
  assert.strictEqual(solicitudesById.get(TOTAL).solicitudes_estados_id, 3);
  assert.ok(hasHist3(TOTAL), 'newest rejection historico reaches JANUS');
  const histExpected = Array.from(czRows.values()).reduce(function (n, r) {
    return n + r.historico.length;
  }, 0);
  assert.strictEqual(historicoById.size, histExpected);
  const c2 = cursors.get(SOURCE_SOLICITUDES);
  assert.strictEqual(c2.last_sync_error, null, 'complete pass clears resume marker');
  assert.strictEqual(c2.last_since, czDateC(BASE_SEC + TOTAL * 10));

  // 3. Estado change on an old row (updated untouched) and on a tail row
  //    reaches JANUS within the next pass.
  czUpdateEstado(7, 3, BASE_SEC + TOTAL * 10 + 100);
  czUpdateEstado(TOTAL - 1, 3, BASE_SEC + TOTAL * 10 + 101);
  const run3 = await runSolicitudes();
  assert.strictEqual(run3.resumed, false);
  assert.strictEqual(run3.initialSince, czApi.INITIAL_SINCE, 'new pass after complete');
  assert.strictEqual(solicitudesById.get(7).solicitudes_estados_id, 3);
  assert.ok(hasHist3(7));
  const run4 = await runSolicitudes();
  assert.strictEqual(run4.resumed, true);
  assert.strictEqual(solicitudesById.get(TOTAL - 1).solicitudes_estados_id, 3);
  assert.ok(hasHist3(TOTAL - 1));
  assert.strictEqual(solicitudesById.size, TOTAL, 'no extra rows');

  // 4. Page boundary inside one second: strict nextSince skips rows;
  //    overlap + dedupe keeps all of them.
  resetAll();
  for (let i = 1; i <= 498; i += 1) addCzSolicitud(i, BASE_SEC + i * 10);
  const tieSec = BASE_SEC + 499 * 10;
  for (let i = 499; i <= 510; i += 1) addCzSolicitud(i, tieSec, i % 2 ? 3 : 1);
  for (let i = 511; i <= 700; i += 1) addCzSolicitud(i, BASE_SEC + i * 10);
  const strict = await czApi.fetchAllCzPages('/solicitudes', czApi.INITIAL_SINCE);
  const strictIds = new Set(
    strict.items.map(function (i) {
      return i.id;
    }),
  );
  assert.ok(strictIds.size < 700, 'reproduces boundary skip without overlap');
  const overlapped = await czApi.fetchAllCzPages('/solicitudes', czApi.INITIAL_SINCE, {
    boundaryOverlap: true,
  });
  assert.strictEqual(overlapped.items.length, 700);
  assert.strictEqual(
    new Set(
      overlapped.items.map(function (i) {
        return i.id;
      }),
    ).size,
    700,
  );
  assert.strictEqual(overlapped.incomplete, false);
  assert.strictEqual(overlapped.boundaryStalls, 0);
  const boundaryRun = await runSolicitudes();
  assert.strictEqual(boundaryRun.status, 'success');
  assert.strictEqual(solicitudesById.size, 700);

  // 5. More rows in one second than a page: no infinite loop, stall reported
  resetAll();
  for (let i = 1; i <= 600; i += 1) addCzSolicitud(i, BASE_SEC + 50);
  for (let i = 601; i <= 650; i += 1) addCzSolicitud(i, BASE_SEC + 100 + i);
  const stalled = await czApi.fetchAllCzPages('/solicitudes', czApi.INITIAL_SINCE, {
    boundaryOverlap: true,
  });
  assert.strictEqual(stalled.incomplete, false);
  assert.ok(stalled.boundaryStalls >= 1);
  assert.ok(stalled.pagesFetched <= 4);
  for (let id = 601; id <= 650; id += 1) {
    assert.ok(
      stalled.items.some(function (i) {
        return i.id === id;
      }),
      'rows after the stalled second still synced',
    );
  }

  // 6. Error mid-pass drops the resume marker → next run restarts (never skips)
  resetAll();
  seedDistinctSeconds(TOTAL, PER_RUN + 1);
  await runSolicitudes();
  assert.ok(
    String(cursors.get(SOURCE_SOLICITUDES).last_sync_error).startsWith(
      FULL_REFRESH_RESUME_MARKER,
    ),
  );
  const realFetch = global.fetch;
  global.fetch = async function () {
    throw new Error('boom');
  };
  const errRun = await runSolicitudes();
  global.fetch = realFetch;
  assert.strictEqual(errRun.status, 'error');
  assert.strictEqual(errRun.resumed, true);
  assert.strictEqual(errRun.passComplete, false);
  const afterErr = await runSolicitudes();
  assert.strictEqual(afterErr.resumed, false);
  assert.strictEqual(afterErr.initialSince, czApi.INITIAL_SINCE);

  // 6b. Pass needing three runs: each partial run keeps the marker and moves the
  //     resume point forward; only the last run reports passComplete.
  resetAll();
  const TOTAL3 = 2 * PER_RUN + 500;
  seedDistinctSeconds(TOTAL3, 2 * PER_RUN + 1);
  const p1 = await runSolicitudes();
  const r1 = cursors.get(SOURCE_SOLICITUDES).last_since;
  const p2 = await runSolicitudes();
  const r2 = cursors.get(SOURCE_SOLICITUDES).last_since;
  assert.deepStrictEqual(
    [p1.resumed, p1.passComplete, p2.resumed, p2.passComplete],
    [false, false, true, false],
  );
  assert.strictEqual(p2.initialSince, r1);
  assert.ok(Date.parse(r2) > Date.parse(r1), 'resume point advances');
  assert.ok(
    String(cursors.get(SOURCE_SOLICITUDES).last_sync_error).startsWith(FULL_REFRESH_RESUME_MARKER),
  );
  const p3 = await runSolicitudes();
  assert.deepStrictEqual([p3.resumed, p3.passComplete, p3.hitPageLimit], [true, true, false]);
  assert.strictEqual(p3.initialSince, r2);
  assert.strictEqual(solicitudesById.size, TOTAL3);
  assert.ok(hasHist3(TOTAL3));
  assert.strictEqual(cursors.get(SOURCE_SOLICITUDES).last_sync_error, null);
  const p4 = await runSolicitudes();
  assert.strictEqual(p4.resumed, false, 'next pass starts over after completion');

  // 7. Job wiring: solicitudes overlap/resume; other sources keep stored cursor
  resetAll();
  for (let i = 1; i <= 3; i += 1) addCzSolicitud(i, BASE_SEC + i);
  cursors.set('cz_funnel_granted_loans', {
    source_name: 'cz_funnel_granted_loans',
    last_since: '2026-08-01T00:00:00Z',
  });
  cursors.set('cz_funnel_encuestas', {
    source_name: 'cz_funnel_encuestas',
    last_since: '2026-08-15T00:00:00Z',
  });
  const job = await runCzFunnelSync();
  assert.strictEqual(job.ok, true);
  assert.strictEqual(job.solicitudes.itemsUpserted, 3);
  assert.strictEqual(job.solicitudes.passComplete, true);
  assert.strictEqual(
    czRequests.find(function (r) {
      return r.path === '/cdv_granted_loans';
    }).since,
    '2026-08-01T00:00:00Z',
  );
  assert.strictEqual(
    czRequests.find(function (r) {
      return r.path === '/encuestas';
    }).since,
    '2026-08-15T00:00:00Z',
  );

  console.log('OK unit-cz-funnel-solicitudes-large-volume');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
