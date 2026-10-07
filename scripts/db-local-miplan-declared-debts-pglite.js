'use strict';

/**
 * Mi Deuda Stage 2 — LOCAL database test of migrations/20261006_mi_deuda_miplan_declared_debts.sql.
 *
 * DB CLASSIFICATION: LOCAL. Runs an in-process, in-memory PGlite (Postgres compiled to WASM).
 * It never reads SUPABASE_* env vars and never opens a network connection.
 * PGlite is not a repo dependency: point PGLITE_DIR at an installed @electric-sql/pglite
 * (default: %TEMP%/stage2-pglite/node_modules/@electric-sql/pglite).
 *
 * Applies real migrations (handoff tokens, Stage 1 catalog, Stage 2) over minimal Supabase stubs
 * (roles anon/authenticated/service_role with Supabase-like default privileges, dashboard_users,
 * set_updated_at, cz_funnel_sync_cursors, extensions.uuid-ossp).
 *
 * Run: node scripts/db-local-miplan-declared-debts-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCreditorResolver, RESOLUTION } = require('../src/lib/creditorCatalog');
const {
  validateExportEvent,
  resolveCiForEvent,
  buildIngestPayload,
} = require('../src/lib/miplanDebtOptinContract');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

const STUBS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
CREATE TABLE public.dashboard_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE TABLE public.cz_funnel_sync_cursors (
  source_name text PRIMARY KEY, last_since text, last_synced_at timestamptz,
  last_sync_status text CHECK (last_sync_status IN ('success','error') OR last_sync_status IS NULL),
  last_sync_error text, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cz_funnel_sync_cursors_source_name_check CHECK (source_name IN
    ('cz_funnel_granted_loans','cz_funnel_solicitudes','cz_funnel_encuestas')));
`;

let groups = 0;
function pass() {
  groups += 1;
}

async function expectSqlError(db, sql, params, re, label) {
  let err = null;
  try {
    await db.query(sql, params || []);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected SQL error: ' + label);
  if (re) assert.match(String(err.message), re, label + ' → ' + err.message);
}

const TOKEN_OK = '7a000000-0000-4000-8000-000000000001';
const TOKEN_ISSUED = '7a000000-0000-4000-8000-000000000002';
const HASH_OK = 'a'.repeat(64);
const HASH_ISSUED = 'b'.repeat(64);
const D1 = '40000000-0000-4000-8000-000000000001';
const EVAL = '30000000-0000-4000-8000-000000000001';

function exportEvent(over) {
  return Object.assign({
    event_id: '10000000-0000-4000-8000-000000000001',
    journey_id: '20000000-0000-4000-8000-000000000001',
    seq: 1,
    state: 'opted_in',
    scope: 'debt_management_interest',
    contract_version: 'debt_management_opt_in_v1',
    source: 'miplan_v2',
    consent_text_version: 'dm-optin-v1',
    created_at: '2026-10-06T20:01:46.123456+00:00',
    origin_evaluation_id: EVAL,
    origin_diagnosis_id: D1,
    snapshot_diagnosis_id: D1,
    handoff_token_hash: HASH_OK,
    excluded_count: 1,
    debts: [],
  }, over || {});
}

async function main() {
  let PGlite;
  let uuidOssp;
  try {
    PGlite = require(PGLITE_DIR).PGlite;
    uuidOssp = require(path.join(PGLITE_DIR, 'dist', 'contrib', 'uuid_ossp.cjs')).uuid_ossp;
  } catch (e) {
    console.error('PGlite not available at ' + PGLITE_DIR + ' (set PGLITE_DIR). SKIPPED.');
    process.exit(2);
  }
  const db = new PGlite({ extensions: { uuid_ossp: uuidOssp } });

  async function asRole(role, fn) {
    await db.exec('SET ROLE ' + role);
    try {
      return await fn();
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  async function catalogResolver() {
    const creditors = (await db.query('SELECT creditor_id, slug, display_name, status, merged_into_creditor_id FROM public.creditors')).rows;
    const aliases = (await db.query('SELECT id, source, normalized_key, creditor_id, status FROM public.creditor_aliases')).rows;
    return buildCreditorResolver({ creditors: creditors, aliases: aliases });
  }
  async function tokenByHash(hash) {
    const r = await db.query('SELECT id, status, ci FROM public.miplan_handoff_tokens WHERE token_hash = $1', [hash]);
    return r.rows[0] || null;
  }
  async function ingest(payload) {
    return asRole('service_role', async function () {
      const r = await db.query('SELECT public.ingest_miplan_debt_optin_event($1::jsonb) AS out', [JSON.stringify(payload)]);
      return r.rows[0].out;
    });
  }
  async function payloadFor(ev, resolver) {
    const v = validateExportEvent(ev);
    const token = v.handoff_token_hash ? await tokenByHash(v.handoff_token_hash) : null;
    return buildIngestPayload(v, resolveCiForEvent(v, token), resolver || (await catalogResolver()));
  }
  async function reconRow(eventId) {
    return (await db.query('SELECT * FROM public.miplan_optin_ci_reconciliation WHERE event_id = $1', [eventId])).rows[0] || null;
  }
  async function reconcile(pNow, limit) {
    return asRole('service_role', async function () {
      const r = await db.query('SELECT public.reconcile_miplan_optin_ci($1::timestamptz, $2) AS out', [pNow, limit == null ? 200 : limit]);
      return r.rows[0].out;
    });
  }
  async function plus(ts, interval) {
    return (await db.query('SELECT ($1::timestamptz + $2::interval) AS t', [ts, interval])).rows[0].t;
  }
  async function count(sql) {
    return Number((await db.query(sql)).rows[0].n);
  }

  // Migrations apply cleanly and Stage 2 is idempotent (re-run)
  {
    await db.exec(STUBS);
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, '20260925_miplan_handoff_tokens.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, '20261006_mi_deuda_creditor_catalog.sql'), 'utf8'));
    const stage2 = fs.readFileSync(path.join(MIGRATIONS, '20261006_mi_deuda_miplan_declared_debts.sql'), 'utf8');
    await db.exec(stage2);
    await db.exec(stage2);
    assert.strictEqual(await count('SELECT count(*) n FROM public.creditors'), 29);
    assert.strictEqual(await count("SELECT count(*) n FROM public.creditor_aliases WHERE source='miplan_declared' AND status='approved'"), 35);
    assert.strictEqual(await count("SELECT count(*) n FROM public.creditor_aliases WHERE source='miplan_declared' AND status='ambiguous' AND creditor_id IS NULL"), 31);
    assert.strictEqual(await count("SELECT count(*) n FROM public.creditor_aliases WHERE source='bcu'"), 16);
    await db.query(
      "INSERT INTO public.miplan_handoff_tokens (id, token_hash, purpose, external_ref, ci, status, expires_at) VALUES ($1,$2,'miplan_handoff','LRW1',12345678,'consumed',now()), ($3,$4,'miplan_handoff','LRW2',87654321,'issued',now())",
      [TOKEN_OK, HASH_OK, TOKEN_ISSUED, HASH_ISSUED],
    );
    pass();
  }

  // No sync cursor: cz_funnel_sync_cursors is left untouched (delivery = Mi Plan pending/ACK)
  {
    await expectSqlError(db, "INSERT INTO public.cz_funnel_sync_cursors (source_name, last_since) VALUES ('miplan_debt_optin_events', NULL)", [], /check/i, 'cursor CHECK not extended');
    pass();
  }

  // Insert: event + debts (financial, non-financial, comercio, unknown, ambiguous, empty, numeric raw)
  const ev1 = exportEvent({
    debts: [
      { position: 0, client_debt_id: 'deuda_1', tipo: 'prestamo', acreedor_raw: 'BROU', monto: 5000, pago: '500' },
      { position: 2, acreedor_raw: 'UTE', monto: '1200,50', situacion_ui: 'reclamo_disputa' },
      { position: 3, acreedor_raw: 'Divino', monto: 'mucho' },
      { position: 4, acreedor_raw: 'HSBC', monto: 100 },
      { position: 5, acreedor_raw: 'Tío', monto: 100 },
      { position: 6, acreedor_raw: '', acreedor: '  ', monto: 100 },
      { position: 7, acreedor_raw: 'BROU', monto: 5000, pago: '500' },
    ],
  });
  {
    const out = await ingest(await payloadFor(ev1));
    assert.deepStrictEqual(out, { status: 'inserted', event_id: ev1.event_id, debts_inserted: 7 });
    const ev = (await db.query('SELECT * FROM public.miplan_debt_optin_events WHERE event_id = $1', [ev1.event_id])).rows[0];
    assert.strictEqual(Number(ev.ci), 12345678);
    assert.strictEqual(ev.ci_resolution, 'resolved');
    assert.strictEqual(ev.handoff_token_id, TOKEN_OK);
    assert.strictEqual(ev.excluded_count, 1);
    const rows = (await db.query('SELECT d.*, c.slug FROM public.miplan_declared_debts d LEFT JOIN public.creditors c ON c.creditor_id = d.ingestion_creditor_id WHERE optin_event_id = $1 ORDER BY position', [ev1.event_id])).rows;
    assert.deepStrictEqual(rows.map(function (r) { return [r.position, r.ingestion_resolution, r.slug]; }), [
      [0, RESOLUTION.RESOLVED, 'brou'],
      [2, RESOLUTION.RESOLVED, 'ute'],
      [3, RESOLUTION.RESOLVED, 'divino'],
      [4, RESOLUTION.UNKNOWN, null],
      [5, RESOLUTION.UNKNOWN_REVIEWED, null],
      [6, RESOLUTION.EMPTY, null],
      [7, RESOLUTION.RESOLVED, 'brou'],
    ]);
    assert.strictEqual(Number(rows[1].monto), 1200.5);
    assert.strictEqual(rows[1].situacion_ui, 'reclamo_disputa');
    assert.strictEqual(rows[2].monto, null);
    assert.strictEqual(rows[2].monto_raw, 'mucho');
    assert.notStrictEqual(rows[0].declared_debt_id, rows[6].declared_debt_id); // same creditor/amount/person
    rows.forEach(function (r) { assert.strictEqual(Number(r.ci), 12345678); });
    pass();
  }

  // Idempotency: same event twice; same event with different payload never rewrites the snapshot
  {
    const again = await ingest(await payloadFor(ev1));
    assert.strictEqual(again.status, 'already_ingested');
    const altered = exportEvent({ debts: [{ position: 0, acreedor_raw: 'Creditel', monto: 1 }] });
    const out = await ingest(await payloadFor(altered));
    assert.strictEqual(out.status, 'already_ingested');
    assert.strictEqual(await count("SELECT count(*) n FROM public.miplan_declared_debts WHERE optin_event_id = '" + ev1.event_id + "'"), 7);
    const first = (await db.query('SELECT creditor_raw FROM public.miplan_declared_debts WHERE optin_event_id = $1 AND position = 0', [ev1.event_id])).rows[0];
    assert.strictEqual(first.creditor_raw, 'BROU');
    // Core-field conflict on replay fails (source inconsistency) and changes nothing
    const conflicting = await payloadFor(exportEvent({ state: 'withdrawn', excluded_count: null, debts: undefined }));
    await asRole('service_role', function () {
      return expectSqlError(db, 'SELECT public.ingest_miplan_debt_optin_event($1::jsonb)', [JSON.stringify(conflicting)], /CONFLICT/, 'core conflict');
    });
    // Same (journey, seq) under a different event_id
    const dupSeq = await payloadFor(exportEvent({ event_id: '10000000-0000-4000-8000-0000000000ff' }));
    await asRole('service_role', function () {
      return expectSqlError(db, 'SELECT public.ingest_miplan_debt_optin_event($1::jsonb)', [JSON.stringify(dupSeq)], /journey_seq|duplicate key/, 'journey seq');
    });
    assert.strictEqual(await count('SELECT count(*) n FROM public.miplan_debt_optin_events'), 1);
    pass();
  }

  // Withdraw → re-accept; same position in different events → distinct debts
  {
    const w = exportEvent({ event_id: '10000000-0000-4000-8000-000000000002', seq: 2, state: 'withdrawn', excluded_count: null, debts: undefined, created_at: '2026-10-07T10:00:00+00:00' });
    assert.strictEqual((await ingest(await payloadFor(w))).status, 'inserted');
    assert.strictEqual((await ingest(await payloadFor(w))).status, 'already_ingested'); // withdraw repeated
    const a3 = exportEvent({ event_id: '10000000-0000-4000-8000-000000000003', seq: 3, created_at: '2026-10-08T10:00:00+00:00', excluded_count: 0, debts: [{ position: 0, acreedor_raw: 'BROU', monto: 5000 }] });
    assert.strictEqual((await ingest(await payloadFor(a3))).debts_inserted, 1);
    const ids = (await db.query('SELECT declared_debt_id FROM public.miplan_declared_debts WHERE position = 0')).rows;
    assert.strictEqual(ids.length, 2);
    assert.notStrictEqual(ids[0].declared_debt_id, ids[1].declared_debt_id);
    // Withdrawn event with debts is rejected by the DB
    const bad = await payloadFor(exportEvent({ event_id: '10000000-0000-4000-8000-000000000004', seq: 4, state: 'withdrawn', excluded_count: null, debts: undefined }));
    bad.debts = (await payloadFor(a3)).debts;
    await asRole('service_role', function () {
      return expectSqlError(db, 'SELECT public.ingest_miplan_debt_optin_event($1::jsonb)', [JSON.stringify(bad)], /withdrawn event with debts/, 'withdrawn debts');
    });
    pass();
  }

  // CI: unresolvable stored with NULL CI; a 'resolved' claim must be backed by a consumed token
  {
    const u = exportEvent({ event_id: '10000000-0000-4000-8000-000000000010', journey_id: '20000000-0000-4000-8000-000000000010', handoff_token_hash: HASH_ISSUED, debts: [{ position: 0, acreedor_raw: 'UTE' }] });
    const p = await payloadFor(u);
    assert.strictEqual(p.event.ci_resolution, 'unresolvable');
    assert.strictEqual(p.event.handoff_token_id, TOKEN_ISSUED);
    assert.strictEqual((await ingest(p)).status, 'inserted');
    assert.strictEqual(await count("SELECT count(*) n FROM public.miplan_declared_debts WHERE optin_event_id = '" + u.event_id + "' AND ci IS NULL"), 1);
    const rec = await reconRow(u.event_id);
    assert.ok(rec, 'reconciliation row written in the same ingest transaction');
    assert.strictEqual(rec.status, 'PENDING');
    assert.strictEqual(rec.last_unresolved_reason, 'TOKEN_NOT_CONSUMED');
    assert.strictEqual(rec.handoff_token_hash, HASH_ISSUED);
    assert.strictEqual(rec.resolution_attempt_count, 1);
    assert.strictEqual(rec.horizon_seconds, 604800);
    assert.strictEqual(await count("SELECT count(*) n FROM public.miplan_optin_ci_reconciliation WHERE event_id = '" + ev1.event_id + "'"), 0, 'resolved events get no reconciliation row');
    const forged = await payloadFor(exportEvent({ event_id: '10000000-0000-4000-8000-000000000011', journey_id: '20000000-0000-4000-8000-000000000011', handoff_token_hash: HASH_ISSUED }));
    forged.event.ci = 87654321;
    forged.event.ci_resolution = 'resolved';
    await asRole('service_role', function () {
      return expectSqlError(db, 'SELECT public.ingest_miplan_debt_optin_event($1::jsonb)', [JSON.stringify(forged)], /reconciliation inputs/, 'resolved claim with reconciliation inputs');
    });
    delete forged.event.handoff_token_hash;
    delete forged.event.ci_unresolved_reason;
    await asRole('service_role', function () {
      return expectSqlError(db, 'SELECT public.ingest_miplan_debt_optin_event($1::jsonb)', [JSON.stringify(forged)], /consumed handoff token/, 'forged ci');
    });
    const noReason = await payloadFor(exportEvent({ event_id: '10000000-0000-4000-8000-000000000012', journey_id: '20000000-0000-4000-8000-000000000012', handoff_token_hash: HASH_ISSUED }));
    delete noReason.event.ci_unresolved_reason;
    await asRole('service_role', function () {
      return expectSqlError(db, 'SELECT public.ingest_miplan_debt_optin_event($1::jsonb)', [JSON.stringify(noReason)], /ci_unresolved_reason/, 'unresolved without reason');
    });
    const lying = await payloadFor(exportEvent({ event_id: '10000000-0000-4000-8000-000000000013', journey_id: '20000000-0000-4000-8000-000000000013', handoff_token_hash: HASH_ISSUED }));
    lying.event.ci_unresolved_reason = 'NO_TOKEN_HASH';
    await asRole('service_role', function () {
      return expectSqlError(db, 'SELECT public.ingest_miplan_debt_optin_event($1::jsonb)', [JSON.stringify(lying)], /ci_unresolved_reason/, 'NO_TOKEN_HASH with a hash');
    });
    assert.strictEqual(await count("SELECT count(*) n FROM public.miplan_debt_optin_events WHERE event_id IN ('10000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000013')"), 0, 'rejected ingests leave nothing');
    pass();
  }

  // [J][K][L][M][N] CI reconciliation with the real SQL and an injected clock (no sleeps).
  {
    const HASH_LATE = 'e'.repeat(64);
    const HASH_NEVER = 'f'.repeat(64);
    const TOKEN_LATE = '7a000000-0000-4000-8000-000000000003';
    const evLate = exportEvent({ event_id: '10000000-0000-4000-8000-000000000040', journey_id: '20000000-0000-4000-8000-000000000040', handoff_token_hash: HASH_LATE, debts: [{ position: 0, acreedor_raw: 'BROU' }] });
    const evNever = exportEvent({ event_id: '10000000-0000-4000-8000-000000000041', journey_id: '20000000-0000-4000-8000-000000000041', handoff_token_hash: HASH_NEVER, debts: [{ position: 0, acreedor_raw: 'UTE' }] });
    const evNoHash = exportEvent({ event_id: '10000000-0000-4000-8000-000000000042', journey_id: '20000000-0000-4000-8000-000000000042', handoff_token_hash: null, debts: [] });

    // J: persisted, CI NULL, PENDING with the right reason from the first appearance.
    for (const e of [evLate, evNever, evNoHash]) assert.strictEqual((await ingest(await payloadFor(e))).status, 'inserted');
    const rLate0 = await reconRow(evLate.event_id);
    const rNever0 = await reconRow(evNever.event_id);
    const rNoHash0 = await reconRow(evNoHash.event_id);
    assert.deepStrictEqual([rLate0.status, rLate0.last_unresolved_reason], ['PENDING', 'TOKEN_NOT_FOUND']);
    assert.deepStrictEqual([rNoHash0.status, rNoHash0.last_unresolved_reason, rNoHash0.handoff_token_hash], ['PENDING', 'NO_TOKEN_HASH', null]);
    const T0 = rNever0.first_unresolved_at;

    // N + first pass at T0+1d: no hash → terminal at once; the others stay PENDING (attempt 2).
    const pass1 = await reconcile(await plus(T0, '1 day'));
    assert.ok(pass1.attempted >= 3);
    assert.ok(pass1.newly_terminal.some(function (x) { return x.event_id === evNoHash.event_id && x.terminal_reason === 'NO_TOKEN_HASH'; }));
    const rNoHash1 = await reconRow(evNoHash.event_id);
    assert.deepStrictEqual([rNoHash1.status, rNoHash1.terminal_reason], ['TERMINAL_UNRESOLVABLE', 'NO_TOKEN_HASH']);
    const rNever1 = await reconRow(evNever.event_id);
    assert.deepStrictEqual([rNever1.status, rNever1.resolution_attempt_count], ['PENDING', 2]);
    assert.strictEqual(rNever1.last_resolution_attempt_at.getTime(), (await plus(T0, '1 day')).getTime(), 'attempt time = injected clock');
    assert.strictEqual(rNever1.first_unresolved_at.getTime(), T0.getTime(), 'first_unresolved_at never moves');

    // K: the token appears later (consumed, with CI) → next pass resolves; the event row is untouched.
    await db.query("INSERT INTO public.miplan_handoff_tokens (id, token_hash, purpose, external_ref, ci, status, expires_at) VALUES ($1,$2,'miplan_handoff','LRW3',55555555,'consumed',now())", [TOKEN_LATE, HASH_LATE]);
    const pass2 = await reconcile(await plus(T0, '2 days'));
    assert.ok(pass2.newly_resolved.some(function (x) { return x.event_id === evLate.event_id; }));
    const rLate2 = await reconRow(evLate.event_id);
    assert.deepStrictEqual([rLate2.status, Number(rLate2.resolved_ci), rLate2.resolved_handoff_token_id], ['RESOLVED', 55555555, TOKEN_LATE]);
    const evRow = (await db.query('SELECT ci, ci_resolution, handoff_token_id FROM public.miplan_debt_optin_events WHERE event_id = $1', [evLate.event_id])).rows[0];
    assert.deepStrictEqual([evRow.ci, evRow.ci_resolution, evRow.handoff_token_id], [null, 'unresolvable', null], 'immutable event keeps its ingest-time CI');
    const eff = (await db.query("SELECT coalesce(e.ci, r.resolved_ci) AS ci FROM public.miplan_debt_optin_events e LEFT JOIN public.miplan_optin_ci_reconciliation r ON r.event_id = e.event_id AND r.status = 'RESOLVED' WHERE e.event_id = $1", [evLate.event_id])).rows[0];
    assert.strictEqual(Number(eff.ci), 55555555, 'effective CI available to derived state / bags');
    // Replay after resolution (payload now claims resolved) → no-op, no conflict.
    assert.strictEqual((await ingest(await payloadFor(evLate))).status, 'already_ingested');

    // L: never appears → PENDING just before the horizon, TERMINAL exactly at first_unresolved_at + 7d.
    const before = await reconcile(await plus(T0, '6 days 23 hours 59 minutes'));
    assert.ok(!before.newly_terminal.some(function (x) { return x.event_id === evNever.event_id; }));
    assert.strictEqual((await reconRow(evNever.event_id)).status, 'PENDING');
    const atHorizon = await reconcile(await plus(T0, '7 days'));
    assert.ok(atHorizon.newly_terminal.some(function (x) { return x.event_id === evNever.event_id && x.terminal_reason === 'HORIZON_EXCEEDED'; }));
    const rNever2 = await reconRow(evNever.event_id);
    assert.deepStrictEqual([rNever2.status, rNever2.terminal_reason, rNever2.last_unresolved_reason], ['TERMINAL_UNRESOLVABLE', 'HORIZON_EXCEEDED', 'TOKEN_NOT_FOUND']);
    assert.strictEqual(rNever2.resolution_attempt_count, 5, 'every pass counted');
    assert.ok(atHorizon.terminal_total >= 2);

    // M: replay after terminal → no duplicate, horizon / status / attempts unchanged; final even if the token shows up.
    assert.strictEqual((await ingest(await payloadFor(evNever))).status, 'already_ingested');
    assert.strictEqual(await count("SELECT count(*) n FROM public.miplan_debt_optin_events WHERE event_id = '" + evNever.event_id + "'"), 1);
    assert.strictEqual(await count("SELECT count(*) n FROM public.miplan_declared_debts WHERE optin_event_id = '" + evNever.event_id + "'"), 1);
    await db.query("INSERT INTO public.miplan_handoff_tokens (id, token_hash, purpose, external_ref, ci, status, expires_at) VALUES ('7a000000-0000-4000-8000-000000000004',$1,'miplan_handoff','LRW4',66666666,'consumed',now())", [HASH_NEVER]);
    await reconcile(await plus(T0, '30 days'));
    const rNever3 = await reconRow(evNever.event_id);
    assert.deepStrictEqual(rNever3, rNever2, 'terminal row never changes (replay or later token)');

    // Guard: final states, immutable fields, attempts, backed resolution, no delete / truncate.
    const evGuard = exportEvent({ event_id: '10000000-0000-4000-8000-000000000043', journey_id: '20000000-0000-4000-8000-000000000043', handoff_token_hash: '9'.repeat(64), debts: [] });
    assert.strictEqual((await ingest(await payloadFor(evGuard))).status, 'inserted');
    assert.strictEqual(await count("SELECT count(*) n FROM public.miplan_optin_ci_reconciliation WHERE status = 'PENDING'"), 1);
    await expectSqlError(db, "UPDATE public.miplan_optin_ci_reconciliation SET status = 'PENDING', terminal_at = NULL, terminal_reason = NULL, resolution_attempt_count = resolution_attempt_count + 1 WHERE event_id = $1", [evNever.event_id], /final/, 'terminal is final');
    await expectSqlError(db, "UPDATE public.miplan_optin_ci_reconciliation SET first_unresolved_at = first_unresolved_at + interval '1 day', resolution_attempt_count = resolution_attempt_count + 1 WHERE status = 'PENDING'", [], /immutable/, 'horizon start immutable');
    await expectSqlError(db, "UPDATE public.miplan_optin_ci_reconciliation SET resolution_attempt_count = resolution_attempt_count + 5 WHERE status = 'PENDING'", [], /one later attempt/, 'attempt count');
    await expectSqlError(db, "UPDATE public.miplan_optin_ci_reconciliation SET status = 'RESOLVED', resolved_ci = 12345678, resolved_handoff_token_id = $1, resolved_at = now(), resolution_attempt_count = resolution_attempt_count + 1 WHERE status = 'PENDING'", [TOKEN_OK], /not backed/, 'forged resolution');
    await expectSqlError(db, "UPDATE public.miplan_optin_ci_reconciliation SET status = 'TERMINAL_UNRESOLVABLE', terminal_reason = 'HORIZON_EXCEEDED', terminal_at = first_unresolved_at, resolution_attempt_count = resolution_attempt_count + 1, last_resolution_attempt_at = greatest(last_resolution_attempt_at, first_unresolved_at) WHERE status = 'PENDING'", [], /horizon not reached/, 'early terminal');
    await expectSqlError(db, 'DELETE FROM public.miplan_optin_ci_reconciliation', [], /never deleted/, 'delete');
    await expectSqlError(db, 'TRUNCATE public.miplan_optin_ci_reconciliation', [], /never deleted/, 'truncate');
    await asRole('service_role', function () {
      return expectSqlError(db, 'DELETE FROM public.miplan_optin_ci_reconciliation', [], /never deleted/, 'delete service_role');
    });
    await expectSqlError(db, "INSERT INTO public.miplan_optin_ci_reconciliation (event_id, status, last_unresolved_reason, first_unresolved_at, last_resolution_attempt_at, resolution_attempt_count, horizon_seconds) VALUES ($1,'PENDING','TOKEN_NOT_FOUND',now(),now(),1,604800)", [ev1.event_id], /without CI/, 'no row for resolved event');
    await expectSqlError(db, 'SELECT public.reconcile_miplan_optin_ci(now(), 0)', [], /RECONCILE_INVALID/, 'limit');
    pass();
  }

  // DB re-checks identity + resolution; failures are atomic (no partial event)
  {
    const base = exportEvent({ event_id: '10000000-0000-4000-8000-000000000020', journey_id: '20000000-0000-4000-8000-000000000020', debts: [{ position: 0, acreedor_raw: 'Creditel' }, { position: 1, acreedor_raw: 'Banco Santander S.A.' }] });
    const mutations = [
      [function (p) { p.debts[0].declared_debt_id = '99999999-0000-5000-8000-000000000000'; }, /uuidv5/],
      [function (p) { p.debts[1].ingestion_resolution = 'RESOLVED'; p.debts[1].ingestion_creditor_id = '0039dcbe-0af2-5a2d-a025-3a94e072ed95'; p.debts[1].ingestion_alias_id = '25c150e1-eb95-5805-9dfe-3f7284607361'; }, /RESOLUTION_MISMATCH/], // bcu alias
      [function (p) { p.debts[0].ingestion_creditor_id = '89311a19-c966-5a9e-818e-87c9149bd049'; }, /RESOLUTION_MISMATCH/], // re-interpret creditel → UTE
      [function (p) { p.debts[0].ingestion_resolution = 'UNKNOWN'; p.debts[0].ingestion_creditor_id = null; p.debts[0].ingestion_alias_id = null; }, /RESOLUTION_MISMATCH/], // hides an alias
      [function (p) { p.debts[1].creditor_normalized_key = 'Bad Key'; }, /check/i],
      [function (p) { p.debts[1].position = 0; p.debts[1].declared_debt_id = p.debts[0].declared_debt_id; }, /duplicate/],
      [function (p) { p.debts[0].situacion_ui = 'pagada'; }, /not_paid|check/i],
    ];
    for (let i = 0; i < mutations.length; i++) {
      const p = await payloadFor(base);
      mutations[i][0](p);
      await asRole('service_role', function () {
        return expectSqlError(db, 'SELECT public.ingest_miplan_debt_optin_event($1::jsonb)', [JSON.stringify(p)], mutations[i][1], 'mutation ' + i);
      });
    }
    assert.strictEqual(await count("SELECT count(*) n FROM public.miplan_debt_optin_events WHERE event_id = '" + base.event_id + "'"), 0);
    assert.strictEqual((await ingest(await payloadFor(base))).debts_inserted, 2); // the honest payload still works
    pass();
  }

  // Merged creditor: resolution follows one hop at ingestion; stored rows are never re-pointed
  {
    await db.exec(`
      INSERT INTO public.creditors (creditor_id, slug, display_name, status) VALUES ('aaaaaaaa-0000-4000-8000-0000000000aa', 'old-brand', 'Old brand', 'active');
      INSERT INTO public.creditor_aliases (id, source, normalized_key, creditor_id, status) VALUES ('bbbbbbbb-0000-4000-8000-0000000000aa', 'miplan_declared', 'old brand', 'aaaaaaaa-0000-4000-8000-0000000000aa', 'approved');
      UPDATE public.creditors SET status = 'merged', merged_into_creditor_id = '89311a19-c966-5a9e-818e-87c9149bd049' WHERE slug = 'old-brand';
    `);
    const m = exportEvent({ event_id: '10000000-0000-4000-8000-000000000030', journey_id: '20000000-0000-4000-8000-000000000030', debts: [{ position: 0, acreedor_raw: 'Old Brand' }] });
    await ingest(await payloadFor(m));
    const row = (await db.query("SELECT ingestion_creditor_id FROM public.miplan_declared_debts WHERE optin_event_id = $1", [m.event_id])).rows[0];
    assert.strictEqual(row.ingestion_creditor_id, '89311a19-c966-5a9e-818e-87c9149bd049');
    pass();
  }

  // Immutability: UPDATE / DELETE / TRUNCATE forbidden (even for service_role / owner)
  {
    for (const t of ['miplan_debt_optin_events', 'miplan_declared_debts']) {
      await expectSqlError(db, 'UPDATE public.' + t + ' SET received_at = now()', [], /immutable/, t + ' update');
      await expectSqlError(db, 'DELETE FROM public.' + t, [], /immutable/, t + ' delete');
      await expectSqlError(db, 'TRUNCATE public.' + t + ' CASCADE', [], /immutable/, t + ' truncate');
      await asRole('service_role', function () {
        return expectSqlError(db, 'DELETE FROM public.' + t, [], /immutable/, t + ' delete service_role');
      });
    }
    // Direct insert bypassing the RPC must still match the event CI / state
    await expectSqlError(db,
      "INSERT INTO public.miplan_declared_debts (declared_debt_id, optin_event_id, ci, snapshot_diagnosis_id, position, creditor_key_version, ingestion_resolution) VALUES (gen_random_uuid(), '10000000-0000-4000-8000-000000000001', 999, '" + D1 + "', 99, 'creditor_key_v1', 'EMPTY')",
      [], /ci must equal/, 'guard ci');
    await expectSqlError(db,
      "INSERT INTO public.miplan_declared_debts (declared_debt_id, optin_event_id, ci, snapshot_diagnosis_id, position, creditor_key_version, ingestion_resolution) VALUES (gen_random_uuid(), '10000000-0000-4000-8000-000000000002', 12345678, '" + D1 + "', 99, 'creditor_key_v1', 'EMPTY')",
      [], /not opted_in/, 'guard state');
    pass();
  }

  // Access: anon / authenticated cannot read tables nor execute the RPC; RLS enabled
  {
    for (const role of ['anon', 'authenticated']) {
      await asRole(role, async function () {
        await expectSqlError(db, 'SELECT * FROM public.miplan_debt_optin_events', [], /permission denied/, role + ' events');
        await expectSqlError(db, 'SELECT * FROM public.miplan_declared_debts', [], /permission denied/, role + ' debts');
        await expectSqlError(db, "SELECT public.ingest_miplan_debt_optin_event('{}'::jsonb)", [], /permission denied/, role + ' rpc');
        await expectSqlError(db, 'SELECT * FROM public.miplan_optin_ci_reconciliation', [], /permission denied/, role + ' reconciliation');
        await expectSqlError(db, 'SELECT public.reconcile_miplan_optin_ci(NULL, 10)', [], /permission denied/, role + ' reconcile rpc');
      });
    }
    const rls = (await db.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('miplan_debt_optin_events','miplan_declared_debts','miplan_optin_ci_reconciliation') ORDER BY relname")).rows;
    assert.deepStrictEqual(rls.map(function (r) { return r.relrowsecurity; }), [true, true, true]);
    const srCount = await asRole('service_role', function () {
      return count('SELECT count(*) n FROM public.miplan_declared_debts');
    });
    assert.ok(srCount > 0);
    pass();
  }

  await db.close();
  console.log('db-local-miplan-declared-debts-pglite [LOCAL]: ' + groups + ' groups OK');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
