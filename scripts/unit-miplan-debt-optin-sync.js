'use strict';

/**
 * Mi Deuda Stage 2 — job + Mi Plan HTTP client tests (fake Supabase, stateful fake Mi Plan with
 * pending/ACK delivery, no I/O, no sleeps, injectable reconciliation clock).
 * Run: node scripts/unit-miplan-debt-optin-sync.js
 */

const assert = require('assert');

const envPath = require.resolve('../src/config/env');
const ENV = {
  port: 3000,
  nodeEnv: 'test',
  supabaseUrl: 'https://example.supabase.co',
  supabaseServiceRoleKey: 'test',
  apifyToken: 'test',
  apifyActorId: 'test',
  miplanExportBaseUrl: null,
  miplanJanusExportSecret: null,
  miplanHandoffRedeemSecret: 'redeem-secret-value-0123456789abcdef',
};
require.cache[envPath] = { id: envPath, filename: envPath, loaded: true, exports: ENV };
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const { buildCreditorResolver, RESOLUTION } = require('../src/lib/creditorCatalog');
const { fullSeedCatalogRows } = require('../src/lib/creditorCatalogMiplanDeclaredSeed');
const {
  createMiplanDebtOptinSync,
  runMiplanDebtOptinSync,
  ALERT,
} = require('../src/jobs/miplanDebtOptinSync');
const { createMiplanExportClient, MiplanUnavailableError } = require('../src/lib/miplanExportClient');
const { resolveSectionForPath } = require('../src/middleware/dashboardSections');

const RESOLVER = buildCreditorResolver(fullSeedCatalogRows());
const SECRET = 'export-secret-should-never-appear-0123456789';
const HASH_OK = 'a'.repeat(64);
const HASH_ISSUED = 'b'.repeat(64);
const HASH_MISSING = 'c'.repeat(64);
const CI_OK = 41234567;
const TOKEN_OK = '7a000000-0000-4000-8000-000000000001';
const TOKEN_ISSUED = '7a000000-0000-4000-8000-000000000002';
const CONTRACT = 'miplan_debt_optin_export_v1';

let groups = 0;

function uuid(prefix, n) {
  return prefix + '-0000-4000-8000-' + String(n).padStart(12, '0');
}
function eid(n) {
  return uuid('10000000', n);
}

function ev(n, over) {
  return Object.assign({
    event_id: eid(n),
    journey_id: uuid('20000000', n),
    seq: 1,
    state: 'opted_in',
    scope: 'debt_management_interest',
    contract_version: 'debt_management_opt_in_v1',
    source: 'miplan_v2',
    consent_text_version: 'dm-optin-v1',
    created_at: '2026-10-06T20:0' + (n % 10) + ':00.123456+00:00',
    origin_evaluation_id: uuid('30000000', n),
    origin_diagnosis_id: uuid('40000000', n),
    snapshot_diagnosis_id: uuid('40000000', n),
    handoff_token_hash: HASH_OK,
    excluded_count: 0,
    debts: [
      { position: 0, client_debt_id: 'd0', tipo: 'tarjeta', acreedor_raw: 'OCA', acreedor: 'oca', monto: '15000', pago: 1200 },
      { position: 1, client_debt_id: 'd1', tipo: 'servicio', acreedor_raw: 'Tía Marta', acreedor: 'tia marta', monto: 500 },
    ],
  }, over || {});
}

function withdrawn(n, over) {
  return ev(n, Object.assign({ state: 'withdrawn', excluded_count: null, debts: null }, over || {}));
}

const EMPTY_RECONCILE = {
  attempted: 0, resolved: 0, terminal: 0, still_pending: 0, pending_total: 0, terminal_total: 0,
  newly_resolved: [], newly_terminal: [],
};

/** Fake JANUS Supabase: locks, handoff tokens, idempotent ingest RPC, reconcile RPC (in memory). */
function fakeSupabase(opts) {
  const o = opts || {};
  const state = {
    locked: false,
    releaseCalls: 0,
    tokenQueries: 0,
    tokens: o.tokens || [
      { id: TOKEN_OK, token_hash: HASH_OK, status: 'consumed', ci: CI_OK },
      { id: TOKEN_ISSUED, token_hash: HASH_ISSUED, status: 'issued', ci: null },
    ],
    events: new Map(),
    ingestCalls: [],
    reconcileCalls: [],
    failIngestOn: o.failIngestOn || null,
  };
  function core(p) {
    return JSON.stringify([p.event.journey_id, p.event.seq, p.event.state, p.event.snapshot_diagnosis_id, p.event.miplan_created_at]);
  }
  return {
    state: state,
    rpc: async function (name, params) {
      if (name === 'acquire_job_lock') {
        if (o.lockHeld || state.locked) return { data: false, error: null };
        state.locked = true;
        return { data: true, error: null };
      }
      if (name === 'release_job_lock') {
        state.releaseCalls += 1;
        state.locked = false;
        return { data: true, error: null };
      }
      if (name === 'ingest_miplan_debt_optin_event') {
        const p = params.p_payload;
        state.ingestCalls.push(p);
        if (state.failIngestOn && state.failIngestOn(p)) {
          return { data: null, error: { message: 'MIPLAN_OPTIN_INGEST_CONFLICT for ci=' + p.event.ci + ' hash ' + HASH_OK, code: 'P0001' } };
        }
        const prev = state.events.get(p.event.event_id);
        if (prev) {
          if (core(prev) !== core(p)) return { data: null, error: { message: 'MIPLAN_OPTIN_INGEST_CONFLICT', code: 'P0001' } };
          return { data: { status: 'already_ingested', event_id: p.event.event_id, debts_inserted: 0 }, error: null };
        }
        state.events.set(p.event.event_id, p);
        return { data: { status: 'inserted', event_id: p.event.event_id, debts_inserted: p.debts.length }, error: null };
      }
      if (name === 'reconcile_miplan_optin_ci') {
        state.reconcileCalls.push(Object.assign({}, params));
        if (o.reconcileFails) return { data: null, error: { message: 'boom ' + HASH_OK, code: '57014' } };
        const r = typeof o.reconcile === 'function' ? o.reconcile(params) : (o.reconcile || EMPTY_RECONCILE);
        return { data: r, error: null };
      }
      return { data: null, error: { message: 'unknown rpc' } };
    },
    from: function (table) {
      if (table === 'miplan_handoff_tokens') {
        return {
          select: function () {
            return {
              in: async function (_col, hashes) {
                state.tokenQueries += 1;
                return { data: state.tokens.filter(function (t) { return hashes.indexOf(t.token_hash) >= 0; }), error: null };
              },
            };
          },
        };
      }
      throw new Error('unexpected table ' + table);
    },
  };
}

/**
 * Stateful fake Mi Plan: export = events without ACK (order kept), ACK fail-closed + idempotent.
 * opts.fetchFail / opts.ackFail / opts.bodyOverride: per-call queues (undefined = normal).
 * ackFail entry 'lost-response' = ACK persisted by Mi Plan but the HTTP response is lost.
 */
function fakeMiplan(events, opts) {
  const o = opts || {};
  const state = {
    events: events.slice(),
    acked: new Map(),
    fetchCalls: [],
    ackCalls: [],
    fetchFail: (o.fetchFail || []).slice(),
    ackFail: (o.ackFail || []).slice(),
    bodyOverride: (o.bodyOverride || []).slice(),
    reexportAcked: !!o.reexportAcked,
  };
  function pending() {
    return state.events.filter(function (e) { return state.reexportAcked || !state.acked.has(e.event_id); });
  }
  return {
    state: state,
    pendingIds: function () {
      return state.events.filter(function (e) { return !state.acked.has(e.event_id); }).map(function (e) { return e.event_id; });
    },
    fetchPage: async function (args) {
      state.fetchCalls.push(Object.assign({}, args));
      const f = state.fetchFail.shift();
      if (f) throw f;
      const ov = state.bodyOverride.shift();
      if (ov) return typeof ov === 'function' ? ov(args) : ov;
      const p = pending();
      return { contract_version: CONTRACT, events: JSON.parse(JSON.stringify(p.slice(0, args.limit))), has_more: p.length > args.limit };
    },
    ackEvents: async function (acks) {
      state.ackCalls.push(acks.map(function (a) { return Object.assign({}, a); }));
      const f = state.ackFail.shift();
      if (f && f !== 'lost-response') throw f;
      if (acks.some(function (a) { return !state.events.some(function (e) { return e.event_id === a.event_id; }); })) {
        throw new MiplanUnavailableError('miplan ack http 422', { status: 422, retryable: false });
      }
      let acked = 0;
      let already = 0;
      acks.forEach(function (a) {
        if (state.acked.has(a.event_id)) already += 1;
        else {
          state.acked.set(a.event_id, a.janus_status);
          acked += 1;
        }
      });
      if (f === 'lost-response') throw new MiplanUnavailableError('miplan ack network error');
      return { acked: acked, already_acked: already };
    },
  };
}

function captureLogger() {
  const lines = [];
  const records = [];
  function rec(level) {
    return function (msg, meta) {
      lines.push(level + ' ' + msg + ' ' + JSON.stringify(meta || {}));
      records.push({ level: level, msg: msg, meta: meta || {} });
    };
  }
  return { lines: lines, records: records, info: rec('info'), error: rec('error'), warn: rec('warn') };
}

function job(sb, client, logger, extra) {
  let catalogLoads = 0;
  const j = createMiplanDebtOptinSync(Object.assign({
    supabase: sb,
    client: client,
    logger: logger,
    loadCatalog: async function () {
      catalogLoads += 1;
      return RESOLVER;
    },
  }, extra || {}));
  j.catalogLoads = function () { return catalogLoads; };
  return j;
}

async function expectFail(promise, code, stage) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected failure ' + code);
  assert.strictEqual(err.code, code, 'code: ' + (err && err.code));
  if (stage) assert.strictEqual(err.stage, stage, 'stage: ' + (err && err.stage));
  return err;
}

function assertNoSensitive(lines) {
  const all = lines.join('\n');
  [SECRET, HASH_OK, HASH_ISSUED, HASH_MISSING, String(CI_OK), 'Tía Marta', 'OCA', TOKEN_OK].forEach(function (needle) {
    assert.ok(all.indexOf(needle) === -1, 'sensitive value leaked into logs: ' + needle.slice(0, 6));
  });
}

function ackedIds(mp) {
  return mp.state.ackCalls.reduce(function (acc, batch) {
    return acc.concat(batch.map(function (a) { return a.event_id; }));
  }, []);
}

async function main() {
  // 1. Not configured / reused secret → dormant (no lock, no I/O).
  {
    let r = await runMiplanDebtOptinSync();
    assert.deepStrictEqual(r, { ok: false, reason: 'not_configured' });
    ENV.miplanExportBaseUrl = 'https://miplan.test';
    ENV.miplanJanusExportSecret = ENV.miplanHandoffRedeemSecret;
    r = await runMiplanDebtOptinSync();
    assert.deepStrictEqual(r, { ok: false, reason: 'not_configured' }, 'reused redeem secret refused');
    ENV.miplanExportBaseUrl = null;
    ENV.miplanJanusExportSecret = null;
    assert.strictEqual(resolveSectionForPath('/jobs/run-miplan-debt-optin-sync'), 'rechazados');
    groups += 1;
  }

  // 2. Lock held → nothing fetched, nothing acked, no reconciliation.
  {
    const sb = fakeSupabase({ lockHeld: true });
    const mp = fakeMiplan([ev(1)]);
    const r = await job(sb, mp, captureLogger()).run();
    assert.deepStrictEqual(r, { ok: false, reason: 'lock_not_acquired' });
    assert.strictEqual(mp.state.fetchCalls.length, 0);
    assert.strictEqual(mp.state.ackCalls.length, 0);
    assert.strictEqual(sb.state.reconcileCalls.length, 0);
    assert.strictEqual(sb.state.releaseCalls, 0);
    groups += 1;
  }

  // 3. [B][J] Happy path, 2 pages: ingest → ACK exactly the persisted events (incl. CI unresolved),
  //    catalog once, no cursor, unresolved CI → WARN alert from the first appearance.
  {
    const sb = fakeSupabase();
    const mp = fakeMiplan([ev(1), ev(2, { handoff_token_hash: HASH_ISSUED }), ev(3, { handoff_token_hash: null }),
      withdrawn(4, { handoff_token_hash: HASH_MISSING, seq: 2 })]);
    const log = captureLogger();
    const j = job(sb, mp, log, { pageLimit: 2 });
    const r = await j.run();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pages, 2);
    assert.strictEqual(r.events_inserted, 4);
    assert.strictEqual(r.events_acked, 4);
    assert.strictEqual(r.events_already_acked, 0);
    assert.strictEqual(r.ci_unresolvable, 3, 'issued / null / missing token → unresolvable, run continues');
    assert.strictEqual(r.debts_inserted, 6);
    assert.strictEqual(r.debts_unknown, 3, 'Tía Marta stays UNKNOWN (no generic creditor)');
    assert.ok(!('cursor_advanced' in r), 'no cursor in the job result');
    assert.strictEqual(j.catalogLoads(), 1, 'catalog loaded once per run');
    assert.deepStrictEqual(mp.state.fetchCalls, [{ limit: 2 }, { limit: 2 }], 'fetch carries only the limit');
    assert.deepStrictEqual(mp.state.ackCalls, [
      [{ event_id: eid(1), janus_status: 'inserted' }, { event_id: eid(2), janus_status: 'inserted' }],
      [{ event_id: eid(3), janus_status: 'inserted' }, { event_id: eid(4), janus_status: 'inserted' }],
    ], 'one ACK per page, after its ingests');
    assert.deepStrictEqual(mp.pendingIds(), [], 'nothing pending in Mi Plan');
    assert.strictEqual(sb.state.tokenQueries, 2, 'one token lookup per page');
    const byId = new Map(sb.state.ingestCalls.map(function (p) { return [p.event.event_id, p]; }));
    const e1 = byId.get(eid(1)).event;
    assert.strictEqual(e1.ci, CI_OK);
    assert.strictEqual(e1.ci_resolution, 'resolved');
    assert.strictEqual(e1.handoff_token_id, TOKEN_OK);
    assert.ok(!('handoff_token_hash' in e1) && !('ci_unresolved_reason' in e1), 'resolved event carries no reconciliation inputs');
    const e2 = byId.get(eid(2)).event;
    assert.strictEqual(e2.ci, null);
    assert.strictEqual(e2.ci_resolution, 'unresolvable');
    assert.strictEqual(e2.handoff_token_id, TOKEN_ISSUED);
    assert.strictEqual(e2.handoff_token_hash, HASH_ISSUED, 'unresolved event carries its hash for reconciliation');
    assert.strictEqual(e2.ci_unresolved_reason, 'TOKEN_NOT_CONSUMED');
    assert.strictEqual(byId.get(eid(3)).event.ci_unresolved_reason, 'NO_TOKEN_HASH');
    assert.strictEqual(byId.get(eid(3)).event.handoff_token_hash, null);
    assert.strictEqual(byId.get(eid(4)).event.ci_unresolved_reason, 'TOKEN_NOT_FOUND');
    const d = byId.get(eid(1)).debts;
    assert.strictEqual(d[0].ingestion_resolution, RESOLUTION.RESOLVED);
    assert.strictEqual(d[0].monto, 15000, 'numeric string coerced');
    assert.strictEqual(d[1].ingestion_resolution, RESOLUTION.UNKNOWN);
    assert.strictEqual(byId.get(eid(4)).debts.length, 0, 'withdrawn carries no debts');
    const warns = log.records.filter(function (x) { return x.level === 'warn' && x.meta.alert === ALERT.CI_UNRESOLVED; });
    assert.deepStrictEqual(warns.map(function (x) { return x.meta.event_id; }), [eid(2), eid(3), eid(4)], 'WARN per unresolved event at first ingest');
    assert.deepStrictEqual(warns.map(function (x) { return x.meta.reason; }), ['TOKEN_NOT_CONSUMED', 'NO_TOKEN_HASH', 'TOKEN_NOT_FOUND']);
    assert.deepStrictEqual(sb.state.reconcileCalls, [{ p_now: null, p_limit: 200 }], 'reconciliation pass after the pull (DB clock by default)');
    assert.deepStrictEqual(r.reconciliation, { attempted: 0, resolved: 0, terminal: 0, still_pending: 0, pending_total: 0, terminal_total: 0 });
    assert.strictEqual(sb.state.releaseCalls, 1);
    assertNoSensitive(log.lines);
    groups += 1;
  }

  // 4. [A] Malformed page → nothing ingested, NOTHING acked; next run (fixed export) delivers.
  {
    const sb = fakeSupabase();
    const bad = { contract_version: 'v999', events: [ev(1)], has_more: false };
    const mp = fakeMiplan([ev(1)], { bodyOverride: [bad] });
    const log = captureLogger();
    const err = await expectFail(job(sb, mp, log).run(), 'MIPLAN_OPTIN_PAYLOAD_INVALID', 'validate');
    assert.strictEqual(err.detail, 'unsupported export contract_version');
    assert.strictEqual(sb.state.ingestCalls.length, 0);
    assert.strictEqual(mp.state.ackCalls.length, 0, '[A] exported but not ingested → no ACK');
    assert.deepStrictEqual(mp.pendingIds(), [eid(1)], 'still pending in Mi Plan');
    assert.strictEqual(sb.state.reconcileCalls.length, 1, 'reconciliation still runs');
    assert.strictEqual(sb.state.releaseCalls, 1, 'lock released on failure');
    const r = await job(sb, mp, captureLogger()).run();
    assert.strictEqual(r.events_inserted, 1);
    assert.deepStrictEqual(mp.pendingIds(), []);
    assertNoSensitive(log.lines);
    groups += 1;
  }

  // 5. [A] Page with one malformed event → whole page rejected (no partial ingest, no ACK).
  {
    const sb = fakeSupabase();
    const mp = fakeMiplan([ev(1), ev(2, { debts: [{ position: 0, acreedor_raw: 'OCA', situacion_ui: 'pagada' }] })]);
    await expectFail(job(sb, mp, captureLogger()).run(), 'MIPLAN_OPTIN_PAYLOAD_INVALID', 'validate');
    assert.strictEqual(sb.state.ingestCalls.length, 0);
    assert.strictEqual(mp.state.ackCalls.length, 0);
    assert.deepStrictEqual(mp.pendingIds(), [eid(1), eid(2)]);
    groups += 1;
  }

  // 6. [A] Mi Plan unavailable → FAIL fetch, no ACK; next run delivers everything (no cursor state).
  {
    const sb = fakeSupabase();
    const mp = fakeMiplan([ev(1)], { fetchFail: [new MiplanUnavailableError('miplan export timeout')] });
    await expectFail(job(sb, mp, captureLogger()).run(), 'MIPLAN_UNAVAILABLE', 'fetch');
    assert.strictEqual(mp.state.ackCalls.length, 0);
    const r = await job(sb, mp, captureLogger()).run();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.events_acked, 1);
    groups += 1;
  }

  // 7. [C] Ingest OK, failure before ACK → Mi Plan re-exports, JANUS detects the replay (no
  //    duplicate), ACK later, event no longer pending. Replayed events are acked as already_ingested.
  {
    const sb = fakeSupabase();
    const mp = fakeMiplan([ev(1), ev(2, { handoff_token_hash: HASH_MISSING })], { ackFail: [new MiplanUnavailableError('miplan ack timeout')] });
    await expectFail(job(sb, mp, captureLogger()).run(), 'MIPLAN_UNAVAILABLE', 'ack');
    assert.strictEqual(sb.state.events.size, 2, 'both durably persisted');
    assert.deepStrictEqual(mp.pendingIds(), [eid(1), eid(2)], 'ACK lost → still pending');
    const log = captureLogger();
    const r = await job(sb, mp, log).run();
    assert.strictEqual(r.events_inserted, 0);
    assert.strictEqual(r.events_already_ingested, 2, 'replay detected');
    assert.strictEqual(sb.state.events.size, 2, 'never duplicated');
    assert.deepStrictEqual(mp.state.ackCalls[1], [
      { event_id: eid(1), janus_status: 'already_ingested' }, { event_id: eid(2), janus_status: 'already_ingested' }]);
    assert.deepStrictEqual(mp.pendingIds(), [], 'no longer pending');
    assert.ok(!log.records.some(function (x) { return x.msg === 'miplan_optin_ci_unresolved'; }), 'first-appearance WARN not repeated on replay');
    groups += 1;
  }

  // 8. RPC failure mid-page → only the persisted prefix is acked; the rest stays pending.
  {
    let failOnce = true;
    const sb = fakeSupabase({
      failIngestOn: function (p) {
        if (failOnce && p.event.event_id === eid(2)) {
          failOnce = false;
          return true;
        }
        return false;
      },
    });
    const mp = fakeMiplan([ev(1), ev(2), ev(3)]);
    const log = captureLogger();
    await expectFail(job(sb, mp, log).run(), 'MIPLAN_OPTIN_INGEST_CONFLICT', 'ingest');
    assert.deepStrictEqual(ackedIds(mp), [eid(1)], 'never ACK an event that was not persisted');
    assert.deepStrictEqual(mp.pendingIds(), [eid(2), eid(3)]);
    assertNoSensitive(log.lines);
    const r = await job(sb, mp, captureLogger()).run();
    assert.strictEqual(r.events_inserted, 2);
    assert.strictEqual(r.events_already_ingested, 0, 'acked event 1 not re-exported');
    assert.strictEqual(sb.state.events.size, 3);
    assert.deepStrictEqual(mp.pendingIds(), []);
    groups += 1;
  }

  // 9. [D] Repeated ACK is a safe no-op: ACK persisted but response lost → next run sees nothing
  //    pending; a Mi Plan that re-exports acked events gets already_acked.
  {
    const sb = fakeSupabase();
    const mp = fakeMiplan([ev(1)], { ackFail: ['lost-response'] });
    await expectFail(job(sb, mp, captureLogger()).run(), 'MIPLAN_UNAVAILABLE', 'ack');
    assert.deepStrictEqual(mp.pendingIds(), [], 'Mi Plan persisted the ACK');
    const r = await job(sb, mp, captureLogger()).run();
    assert.strictEqual(r.events_seen, 0);
    assert.strictEqual(mp.state.ackCalls.length, 1, 'no ACK without events');

    const sb2 = fakeSupabase();
    const mp2 = fakeMiplan([ev(1)], { reexportAcked: true });
    await job(sb2, mp2, captureLogger(), { maxPages: 1 }).run();
    const r2 = await job(sb2, mp2, captureLogger(), { maxPages: 1 }).run();
    assert.strictEqual(r2.events_already_ingested, 1);
    assert.strictEqual(r2.events_acked, 0);
    assert.strictEqual(r2.events_already_acked, 1, 'repeated ACK reported as already_acked');
    assert.strictEqual(sb2.state.events.size, 1);
    groups += 1;
  }

  // 10. [E] Mi Plan rejects an ACK (unknown event, 422) → run fails closed, nothing marked delivered.
  {
    const sb = fakeSupabase();
    const mp = fakeMiplan([ev(1)], { bodyOverride: [{ contract_version: CONTRACT, events: [ev(9)], has_more: false }] });
    await expectFail(job(sb, mp, captureLogger()).run(), 'MIPLAN_UNAVAILABLE', 'ack');
    assert.deepStrictEqual(mp.pendingIds(), [eid(1)]);
    groups += 1;
  }

  // 11. Catalog unavailable → FAIL before any ingest/ACK; empty pending → success, no ACK call.
  {
    const sb = fakeSupabase();
    const mp = fakeMiplan([ev(1)]);
    const j = createMiplanDebtOptinSync({
      supabase: sb,
      client: mp,
      logger: captureLogger(),
      loadCatalog: async function () { throw new Error('catalog down'); },
    });
    await expectFail(j.run(), 'CREDITOR_CATALOG_UNAVAILABLE', 'catalog');
    assert.strictEqual(sb.state.ingestCalls.length, 0);
    assert.strictEqual(mp.state.ackCalls.length, 0);

    const sb2 = fakeSupabase();
    const mp2 = fakeMiplan([]);
    const j2 = job(sb2, mp2, captureLogger());
    const r = await j2.run();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.events_seen, 0);
    assert.strictEqual(j2.catalogLoads(), 0, 'no catalog load without events');
    assert.strictEqual(mp2.state.ackCalls.length, 0);
    groups += 1;
  }

  // 12. maxPages bound (default keeps GET+ACK under Mi Plan's rate limit); remaining stay pending.
  {
    const sb = fakeSupabase();
    const mp = fakeMiplan([ev(1), ev(2), ev(3), ev(4), ev(5)]);
    const r = await job(sb, mp, captureLogger(), { maxPages: 3, pageLimit: 1 }).run();
    assert.strictEqual(r.pages, 3);
    assert.strictEqual(r.has_more, true);
    assert.deepStrictEqual(mp.pendingIds(), [eid(4), eid(5)]);
    const many = [];
    for (let i = 1; i <= 15; i += 1) many.push(ev(i));
    const mpDefault = fakeMiplan(many);
    await job(fakeSupabase(), mpDefault, captureLogger(), { pageLimit: 1 }).run();
    assert.ok(mpDefault.state.fetchCalls.length + mpDefault.state.ackCalls.length <= 20, 'default run ≤ 20 Mi Plan requests');
    groups += 1;
  }

  // 13. Duplicate event_id inside a page → rejected; out-of-order seq inside a page → both stored.
  {
    const sb = fakeSupabase();
    const mp = fakeMiplan([], { bodyOverride: [{ contract_version: CONTRACT, events: [ev(1), ev(1)], has_more: false }] });
    await expectFail(job(sb, mp, captureLogger()).run(), 'MIPLAN_OPTIN_PAYLOAD_INVALID', 'validate');
    assert.strictEqual(sb.state.ingestCalls.length, 0);
    const later = withdrawn(5, { journey_id: uuid('20000000', 9), seq: 2 });
    const older = ev(6, { journey_id: uuid('20000000', 9), seq: 1 });
    const r = await job(sb, fakeMiplan([later, older]), captureLogger()).run();
    assert.strictEqual(r.events_inserted, 2, 'arrival order is irrelevant; state derives from max(seq)');
    groups += 1;
  }

  // 14. [N][J][L] Reconciliation: injectable clock reaches the RPC; alerts on pending / terminal;
  //     reconcile failure fails the run (after the pull was acked).
  {
    const FIXED = new Date('2026-10-13T12:00:00.000Z');
    const sb = fakeSupabase({
      reconcile: {
        attempted: 3, resolved: 1, terminal: 1, still_pending: 1, pending_total: 1, terminal_total: 2,
        newly_resolved: [{ event_id: eid(7) }],
        newly_terminal: [{ event_id: eid(8), terminal_reason: 'HORIZON_EXCEEDED' }],
      },
    });
    const log = captureLogger();
    const r = await job(sb, fakeMiplan([]), log, { now: function () { return FIXED; } }).run();
    assert.deepStrictEqual(sb.state.reconcileCalls, [{ p_now: '2026-10-13T12:00:00.000Z', p_limit: 200 }], 'clock injected, no system time');
    assert.deepStrictEqual(r.reconciliation, { attempted: 3, resolved: 1, terminal: 1, still_pending: 1, pending_total: 1, terminal_total: 2 });
    const terminalErr = log.records.filter(function (x) { return x.level === 'error' && x.meta.alert === ALERT.CI_TERMINAL; });
    assert.deepStrictEqual(terminalErr.map(function (x) { return x.meta; }), [{ alert: ALERT.CI_TERMINAL, event_id: eid(8), terminal_reason: 'HORIZON_EXCEEDED' }]);
    assert.ok(log.records.some(function (x) { return x.level === 'warn' && x.meta.alert === ALERT.CI_UNRESOLVED && x.meta.pending_total === 1; }), 'WARN while pending');
    assert.ok(log.records.some(function (x) { return x.level === 'warn' && x.meta.alert === ALERT.CI_TERMINAL && x.meta.terminal_total === 2; }), 'WARN while terminal rows exist');
    assert.ok(log.records.some(function (x) { return x.level === 'info' && x.msg === 'miplan_optin_ci_resolved' && x.meta.event_id === eid(7); }));

    const sbFail = fakeSupabase({ reconcileFails: true });
    const mp = fakeMiplan([ev(1)]);
    const logF = captureLogger();
    await expectFail(job(sbFail, mp, logF).run(), 'SQLSTATE_57014', 'reconcile');
    assert.deepStrictEqual(mp.pendingIds(), [], 'pull already acked before reconciliation');
    assertNoSensitive(logF.lines);

    const sbBoth = fakeSupabase({ reconcileFails: true });
    await expectFail(job(sbBoth, fakeMiplan([ev(1)], { fetchFail: [new MiplanUnavailableError('x')] }), captureLogger()).run(), 'MIPLAN_UNAVAILABLE', 'fetch');
    const sbBad = fakeSupabase({ reconcile: { nope: true } });
    await expectFail(job(sbBad, fakeMiplan([]), captureLogger()).run(), 'RECONCILE_UNEXPECTED_RESULT', 'reconcile');
    groups += 1;
  }

  // 15. HTTP client: fetch URL (limit only), ACK POST body/headers, status mapping, no secret in errors.
  {
    const seen = [];
    const client = createMiplanExportClient({
      baseUrl: 'https://miplan.test/',
      secret: SECRET,
      fetchImpl: async function (url, init) {
        seen.push({ url: url, init: init });
        if (init.method === 'POST') {
          const n = JSON.parse(init.body).acks.length;
          return { ok: true, status: 200, text: async function () { return JSON.stringify({ contract_version: CONTRACT, acked: n, already_acked: 0 }); } };
        }
        return { ok: true, status: 200, text: async function () { return JSON.stringify({ contract_version: CONTRACT, events: [], has_more: false }); } };
      },
    });
    const body = await client.fetchPage({ limit: 50 });
    assert.strictEqual(body.contract_version, CONTRACT);
    assert.strictEqual(seen[0].url, 'https://miplan.test/internal/janus/v1/debt-optin-events?limit=50');
    assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer ' + SECRET);
    assert.strictEqual(seen[0].init.method, 'GET');
    const ackRes = await client.ackEvents([{ event_id: eid(1), janus_status: 'inserted' }]);
    assert.deepStrictEqual(ackRes, { contract_version: CONTRACT, acked: 1, already_acked: 0 });
    assert.strictEqual(seen[1].url, 'https://miplan.test/internal/janus/v1/debt-optin-events/ack');
    assert.strictEqual(seen[1].init.method, 'POST');
    assert.strictEqual(seen[1].init.headers.Authorization, 'Bearer ' + SECRET);
    assert.strictEqual(seen[1].init.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(seen[1].init.body), { contract_version: CONTRACT, acks: [{ event_id: eid(1), janus_status: 'inserted' }] });

    async function failing(fetchImpl, timeoutMs, call) {
      const c = createMiplanExportClient({ baseUrl: 'https://miplan.test', secret: SECRET, fetchImpl: fetchImpl, timeoutMs: timeoutMs });
      try {
        if (call === 'ack') await c.ackEvents([{ event_id: eid(1), janus_status: 'inserted' }]);
        else await c.fetchPage({ limit: 10 });
      } catch (e) {
        return e;
      }
      return null;
    }
    const t = await failing(function (_u, init) {
      return new Promise(function (_res, rej) {
        init.signal.addEventListener('abort', function () {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      });
    }, 20);
    assert.strictEqual(t.code, 'MIPLAN_UNAVAILABLE');
    assert.strictEqual(t.retryable, true);
    assert.ok(/timeout/.test(t.message));
    const u = await failing(async function () { return { ok: false, status: 401, text: async function () { return 'secret ' + SECRET; } }; });
    assert.strictEqual(u.status, 401);
    assert.strictEqual(u.retryable, false);
    const s = await failing(async function () { return { ok: false, status: 503, text: async function () { return ''; } }; });
    assert.strictEqual(s.retryable, true);
    const nj = await failing(async function () { return { ok: true, status: 200, text: async function () { return '<html>'; } }; });
    assert.strictEqual(nj.code, 'MIPLAN_UNAVAILABLE');
    const net = await failing(async function () { throw new Error('ECONNREFUSED ' + SECRET); });
    const a422 = await failing(async function () { return { ok: false, status: 422, text: async function () { return ''; } }; }, undefined, 'ack');
    assert.strictEqual(a422.status, 422);
    assert.strictEqual(a422.retryable, false, '[E] non-exportable ACK is not retryable');
    const aBad = await failing(async function () { return { ok: true, status: 200, text: async function () { return JSON.stringify({ acked: 5, already_acked: 0 }); } }; }, undefined, 'ack');
    assert.ok(/ack response invalid/.test(aBad.message), 'ACK count must match the batch');
    [t, u, s, nj, net, a422, aBad].forEach(function (e) {
      assert.ok(String(e.message).indexOf(SECRET) === -1, 'secret not in client error');
      assert.ok(String(e.stack).indexOf(SECRET) === -1, 'secret not in client stack');
    });
    assert.throws(function () { createMiplanExportClient({ baseUrl: 'ftp://x', secret: SECRET }); }, /not configured/);
    assert.throws(function () { createMiplanExportClient({ baseUrl: 'https://x', secret: '' }); }, /not configured/);
    groups += 1;
  }

  // 16. Logs of failure paths stay free of CI / hash / token / secret / raw creditor.
  {
    const log = captureLogger();
    const sb = fakeSupabase({ failIngestOn: function () { return true; } });
    await expectFail(job(sb, fakeMiplan([ev(1)]), log).run(), 'MIPLAN_OPTIN_INGEST_CONFLICT', 'ingest');
    assert.ok(log.lines.some(function (l) { return /miplan_debt_optin_sync failed/.test(l); }));
    assertNoSensitive(log.lines);
    groups += 1;
  }

  console.log('unit-miplan-debt-optin-sync: ' + groups + ' groups OK');
}

main().catch(function (err) {
  console.error('unit-miplan-debt-optin-sync: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
