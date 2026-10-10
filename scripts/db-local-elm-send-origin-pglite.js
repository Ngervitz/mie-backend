'use strict';

/**
 * LOCAL database test of migrations/20261012_elm_send_origin.sql (step A) and
 * migrations/20261013_elm_send_origin_strict.sql (step B), applied on top of
 * 1A + 1B + 3A + 3B + C1 + 20261011.
 *
 * DB CLASSIFICATION: LOCAL. In-process, in-memory PGlite. Never reads SUPABASE_* env vars and
 * never opens a network connection. PGLITE_DIR as in db-local-provider-fallback-c1-pglite.js.
 *
 * Covers: backfill of existing processes by trigger_origin only (no other column, updated_at
 * untouched), safety stop for janus_manual processes of Preaprobados solicitudes, idempotency,
 * code deployed before the migration (claim without p_send_origin → legacy_default), explicit
 * origins, invalid pairs refused before any write, immutability, origin kept while the process
 * moves on, CI rules shared by both manual origins, step B (origin required), preconditions.
 *
 * Run: node scripts/db-local-elm-send-origin-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIG = (name) => path.join(__dirname, '..', 'migrations', name);
const BASE = [
  '20261007_elm_lead_processes.sql',
  '20261007_elm_postback_events.sql',
  '20261008_provider_fallback_requests.sql',
  '20261009_elm_phase3b_operations.sql',
  '20261010_provider_fallback_c1_events.sql',
];
const RETRY = '20261011_elm_manual_pre_reception_retry.sql';
const STEP_A = fs.readFileSync(MIG('20261012_elm_send_origin.sql'), 'utf8');
const STEP_B = fs.readFileSync(MIG('20261013_elm_send_origin_strict.sql'), 'utf8');

const STUBS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE public.dashboard_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE TABLE public.cz_funnel_solicitud_estados (cz_solicitud_id bigint, solicitudes_estados_id integer);
CREATE TABLE public.cz_funnel_solicitudes (cz_id bigint PRIMARY KEY, solicitudes_estados_id integer);
`;

const REQ = JSON.stringify({ docNumber: '1', source: 'copanel' });
const SIG11 = 'public.elm_claim_process(bigint,bigint,text,text,uuid,integer,text,jsonb,integer,text,text)';

let groups = 0;
function pass(label) {
  groups += 1;
  console.log('ok - ' + label);
}

async function expectSqlError(fn, re, label) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected SQL error: ' + label);
  if (re) assert.match(String(err.message), re, label + ' → ' + err.message);
}

async function freshDb(PGlite, migrations) {
  const db = new PGlite();
  await db.exec(STUBS);
  for (const m of migrations) await db.exec(fs.readFileSync(MIG(m), 'utf8'));
  return db;
}

/** A migration that raises leaves PGlite inside the aborted transaction. */
async function execFailing(db, sql, re, label) {
  await expectSqlError(() => db.exec(sql), re, label);
  await db.exec('ROLLBACK').catch(() => {});
}

async function main() {
  let PGlite;
  try {
    PGlite = require(PGLITE_DIR).PGlite;
  } catch (e) {
    console.error('PGlite not available at ' + PGLITE_DIR + ' (set PGLITE_DIR). SKIPPED.');
    process.exit(2);
  }

  // ------------------------------------------------------------------ preconditions
  const early = await freshDb(PGlite, BASE);
  await execFailing(early, STEP_A, /precondition_failed: apply 20261011/, 'step A before 20261011');
  await execFailing(early, STEP_B, /precondition_failed: apply 20261012/, 'step B before step A');
  const cols0 = await early.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'elm_lead_processes' AND column_name = 'send_origin'");
  assert.strictEqual(cols0.rows.length, 0, 'nothing applied');
  pass('preconditions: step A needs 20261011, step B needs step A; a refused migration leaves nothing behind');

  const db = await freshDb(PGlite, BASE.concat([RETRY]));
  async function asRole(role, fn) {
    await db.exec('SET ROLE ' + role);
    try {
      return await fn();
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const svc = (sql, params) => asRole('service_role', () => db.query(sql, params || []));
  const su = async (sql, params) => (await db.query(sql, params || [])).rows;
  const actor = (await db.query('INSERT INTO public.dashboard_users DEFAULT VALUES RETURNING id')).rows[0].id;

  /** Call shape of the code deployed today (10 arguments, no p_send_origin). */
  const legacyClaim = async (czId, ci, origin) =>
    (await svc('SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) AS r', [
      czId, ci, 'copanel', origin, origin === 'janus_manual' ? actor : null, 12, 'LRW-' + czId, REQ, 300, null,
    ])).rows[0].r;
  const claim = async (czId, ci, origin, sendOrigin) =>
    (await svc('SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11) AS r', [
      czId, ci, 'copanel', origin, origin === 'janus_manual' ? actor : null, 12, 'LRW-' + czId, REQ, 300, null, sendOrigin,
    ])).rows[0].r;
  const fin1 = (id, status, body) =>
    svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [id, status, body || '{"r":1}', 200, null, 5, null, null]);
  const beginS2 = (czId) => svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [czId, REQ, 300]);
  const fin2 = (id, status) =>
    svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [id, status, '{"r":2}', 200, 'm', 5, null, null]);
  const proc = async (czId) => (await su('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId]))[0];
  const rowsJson = async () =>
    (await su('SELECT cz_solicitud_id, to_jsonb(p) - $1::text[] AS j FROM public.elm_lead_processes p ORDER BY cz_solicitud_id', [['send_origin', 'send_origin_source']]))
      .map((r) => r.j);
  const count = async (sql, params) => (await su('SELECT count(*)::int AS n FROM ' + sql, params))[0].n;

  // ------------------------------------------------------------------ history before the migration
  const pR = (await legacyClaim(5001, 70000001, 'janus_manual')).process;
  await fin1(pR.id, 'rejected', '{"result":"SCORE BAJO"}');
  const pS = (await legacyClaim(5002, 70000002, 'janus_manual')).process;
  await fin1(pS.id, 'eligible');
  await beginS2(5002);
  await fin2(pS.id, 'referred');
  const pA = (await legacyClaim(5003, 70000003, 'cz_automatic')).process;
  await fin1(pA.id, 'eligible');
  await legacyClaim(5004, 70000004, 'janus_manual');
  await db.query('INSERT INTO public.cz_funnel_solicitud_estados VALUES (5001, 3), (5002, 3), (5003, 3), (5004, 3)');
  const before = await rowsJson();
  assert.strictEqual(before.length, 4);

  await db.query('INSERT INTO public.cz_funnel_solicitud_estados VALUES (5004, 8)');
  await execFailing(db, STEP_A, /send_origin_backfill_ambiguous: janus_manual processes of Preaprobados solicitudes \{5004\}/, 'janus_manual of an estado-8 solicitud');
  await db.query('DELETE FROM public.cz_funnel_solicitud_estados WHERE cz_solicitud_id = 5004 AND solicitudes_estados_id = 8');
  await db.query('INSERT INTO public.cz_funnel_solicitudes VALUES (5004, 8)');
  await execFailing(db, STEP_A, /send_origin_backfill_ambiguous.*\{5004\}/, 'janus_manual of a solicitud currently in estado 8');
  await db.query('DELETE FROM public.cz_funnel_solicitudes WHERE cz_id = 5004');
  assert.deepStrictEqual(await rowsJson(), before, 'refused migration changed nothing');
  assert.strictEqual(
    (await su("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'elm_lead_processes' AND column_name = 'send_origin'"))[0].n,
    0,
  );
  pass('safety stop: a janus_manual process of a Preaprobados solicitud (estado 8 in history or now) aborts the backfill; nothing applied');

  // ------------------------------------------------------------------ step A
  await db.exec(STEP_A);
  await db.exec(STEP_A);
  const after = await su('SELECT cz_solicitud_id::int AS cz, trigger_origin, send_origin, send_origin_source FROM public.elm_lead_processes ORDER BY cz_solicitud_id');
  assert.deepStrictEqual(after.map((r) => [r.cz, r.trigger_origin, r.send_origin, r.send_origin_source]), [
    [5001, 'janus_manual', 'rechazados_manual', 'backfill'],
    [5002, 'janus_manual', 'rechazados_manual', 'backfill'],
    [5003, 'cz_automatic', 'cz_automatic', 'backfill'],
    [5004, 'janus_manual', 'rechazados_manual', 'backfill'],
  ]);
  assert.deepStrictEqual(await rowsJson(), before, 'every other column (updated_at included) unchanged');
  const notNull = await su("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'elm_lead_processes' AND column_name IN ('send_origin', 'send_origin_source') ORDER BY column_name");
  assert.deepStrictEqual(notNull.map((r) => r.is_nullable), ['NO', 'NO']);
  const overloads = await su("SELECT pronargs FROM pg_proc WHERE proname = 'elm_claim_process'");
  assert.deepStrictEqual(overloads.map((r) => r.pronargs), [11], 'one overload (PostgREST unambiguous)');
  const priv = async (role) => (await su('SELECT has_function_privilege($1, $2, $3) AS r', [role, SIG11, 'EXECUTE']))[0].r;
  assert.deepStrictEqual([await priv('anon'), await priv('authenticated'), await priv('service_role')], [false, false, true]);
  pass('step A applies twice (idempotent): history backfilled by trigger_origin only (janus_manual → rechazados_manual, cz_automatic → cz_automatic), source backfill, NOT NULL, other columns and updated_at untouched; one claim overload, service_role only');

  // ------------------------------------------------------------------ code deployed before the migration
  const legacyManual = (await legacyClaim(5101, 70000101, 'janus_manual')).process;
  const legacyAuto = (await legacyClaim(5102, 70000102, 'cz_automatic')).process;
  assert.deepStrictEqual([legacyManual.send_origin, legacyManual.send_origin_source], ['rechazados_manual', 'legacy_default']);
  assert.deepStrictEqual([legacyAuto.send_origin, legacyAuto.send_origin_source], ['cz_automatic', 'legacy_default']);
  const again = await legacyClaim(5101, 70000101, 'janus_manual');
  assert.strictEqual(again.claimed, false, 'one process per solicitud unchanged');
  pass('compatibility: the code running today (claim without p_send_origin) keeps working between step A and the deploy; recorded as legacy_default');

  // ------------------------------------------------------------------ explicit origins
  const pre = await claim(5201, 70000201, 'janus_manual', 'preaprobados_manual');
  const rec = await claim(5202, 70000202, 'janus_manual', 'rechazados_manual');
  const aut = await claim(5203, 70000203, 'cz_automatic', 'cz_automatic');
  assert.deepStrictEqual([pre.claimed, pre.process.send_origin, pre.process.send_origin_source], [true, 'preaprobados_manual', 'explicit']);
  assert.deepStrictEqual([rec.process.send_origin, rec.process.send_origin_source], ['rechazados_manual', 'explicit']);
  assert.deepStrictEqual([aut.process.send_origin, aut.process.send_origin_source], ['cz_automatic', 'explicit']);
  const existing = await claim(5201, 70000201, 'janus_manual', 'rechazados_manual');
  assert.strictEqual(existing.claimed, false);
  assert.strictEqual(existing.process.send_origin, 'preaprobados_manual', 'a second claim never rewrites the origin');
  pass('explicit origins stored as sent (preaprobados_manual / rechazados_manual / cz_automatic, source explicit); a later claim of the same solicitud returns the original origin');

  // ------------------------------------------------------------------ invalid pairs: refused before any write
  const writes = async () => [
    await count('public.elm_lead_processes'),
    await count('public.elm_ci_send_locks'),
  ];
  const w0 = await writes();
  await expectSqlError(() => claim(5301, 70000301, 'janus_manual', 'cz_automatic'), /elm_invalid_send_origin/, 'manual with automatic origin');
  await expectSqlError(() => claim(5302, 70000302, 'cz_automatic', 'preaprobados_manual'), /elm_invalid_send_origin/, 'automatic with manual origin');
  await expectSqlError(() => claim(5303, 70000303, 'janus_manual', 'otro'), /elm_invalid_send_origin/, 'unknown origin');
  await expectSqlError(() => claim(5304, 70000304, 'janus_batch', 'rechazados_manual'), /elm_invalid_send_origin/, 'batch with manual origin');
  assert.deepStrictEqual(await writes(), w0, 'no process, no CI lock');
  pass('invalid trigger/send origin pairs raise elm_invalid_send_origin before the CI lock: nothing written');

  // ------------------------------------------------------------------ immutability
  await expectSqlError(() => db.query("UPDATE public.elm_lead_processes SET send_origin = 'preaprobados_manual' WHERE cz_solicitud_id = 5202"), /send_origin is immutable/, 'origin update');
  await expectSqlError(() => db.query("UPDATE public.elm_lead_processes SET send_origin_source = 'explicit' WHERE cz_solicitud_id = 5001"), /send_origin is immutable/, 'source update');
  await svc('SELECT public.elm_ci_lock_try($1, $2, $3, $4, $5)', [70000401, 5401, null, 'janus_manual', null]);
  await expectSqlError(
    () => db.query(
      "INSERT INTO public.elm_lead_processes (cz_solicitud_id, ci, source_brand, trigger_origin, triggered_by_user_id, send_origin, send_origin_source, s1_status, s1_request, s1_started_at, s1_lease_expires_at) VALUES (5401, 70000401, 'copanel', 'janus_manual', $1, 'preaprobados_manual', 'backfill', 'in_flight', '{}'::jsonb, now(), now() + interval '5 minutes')",
      [actor],
    ),
    /elm_send_origin_source_invalid_on_insert/,
    'backfill source on insert',
  );
  await expectSqlError(
    () => db.query(
      "INSERT INTO public.elm_lead_processes (cz_solicitud_id, ci, source_brand, trigger_origin, triggered_by_user_id, send_origin_source, s1_status, s1_request, s1_started_at, s1_lease_expires_at) VALUES (5401, 70000401, 'copanel', 'janus_manual', $1, 'explicit', 'in_flight', '{}'::jsonb, now(), now() + interval '5 minutes')",
      [actor],
    ),
    /send_origin/,
    'insert without origin',
  );
  pass('immutable: send_origin / send_origin_source cannot be updated; an insert cannot claim "backfill" nor omit the origin');

  // ------------------------------------------------------------------ origin stable while the process moves on
  await fin1(pre.process.id, 'eligible');
  await beginS2(5201);
  await fin2(pre.process.id, 'referred');
  await db.query("UPDATE public.elm_lead_processes SET provider_status = 'Convertido', disbursed_at = now() WHERE cz_solicitud_id = 5201");
  const moved = await proc(5201);
  assert.deepStrictEqual([moved.s2_status, moved.send_origin, moved.send_origin_source], ['referred', 'preaprobados_manual', 'explicit']);
  await db.query('INSERT INTO public.cz_funnel_solicitud_estados VALUES (5201, 3)');
  assert.strictEqual((await proc(5201)).send_origin, 'preaprobados_manual', 'a later CZ estado never changes it');
  pass('origin stable: S1 → S2 referred → disbursed and a later CZ rejection keep preaprobados_manual');

  // ------------------------------------------------------------------ CI rules shared by both manual origins
  const CI = 70000501;
  const first = await claim(5501, CI, 'janus_manual', 'rechazados_manual');
  await fin1(first.process.id, 'rejected', '{"result":"SCORE BAJO"}');
  const second = await claim(5502, CI, 'janus_manual', 'preaprobados_manual');
  assert.strictEqual(second.claimed, false);
  assert.strictEqual(second.blocked.block, 'monthly_quota_used', 'quota is per CI, whatever the screen');
  pass('CI lock unchanged: a Rechazados send uses the monthly quota of the CI for a Preaprobados send too');

  // ------------------------------------------------------------------ step B
  await db.exec(STEP_B);
  await db.exec(STEP_B);
  assert.deepStrictEqual((await su("SELECT pronargs FROM pg_proc WHERE proname = 'elm_claim_process'")).map((r) => r.pronargs), [11]);
  assert.deepStrictEqual([await priv('anon'), await priv('authenticated'), await priv('service_role')], [false, false, true]);
  const w1 = await writes();
  await expectSqlError(() => legacyClaim(5601, 70000601, 'janus_manual'), /elm_send_origin_required/, 'no origin after step B');
  await expectSqlError(() => claim(5602, 70000602, 'janus_manual', '  '), /elm_send_origin_required/, 'blank origin');
  await expectSqlError(() => claim(5603, 70000603, 'cz_automatic', 'rechazados_manual'), /elm_invalid_send_origin/, 'invalid pair after step B');
  assert.deepStrictEqual(await writes(), w1, 'refusals write nothing');
  const strict = await claim(5604, 70000604, 'janus_manual', 'preaprobados_manual');
  assert.deepStrictEqual([strict.claimed, strict.process.send_origin, strict.process.send_origin_source], [true, 'preaprobados_manual', 'explicit']);
  assert.strictEqual((await proc(5101)).send_origin_source, 'legacy_default', 'rows of the transition stay as recorded');
  pass('step B applies twice: the origin is required (NULL / blank → elm_send_origin_required, nothing written); explicit sends unchanged; transition rows kept');

  console.log('\n' + groups + ' groups passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
