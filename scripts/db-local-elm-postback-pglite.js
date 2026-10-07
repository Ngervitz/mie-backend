'use strict';

/**
 * ELM Fase 1B — LOCAL database test of migrations/20261007_elm_postback_events.sql
 * (applied on top of 20261007_elm_lead_processes.sql).
 *
 * DB CLASSIFICATION: LOCAL. In-process, in-memory PGlite. Never reads SUPABASE_* env vars and
 * never opens a network connection. PGLITE_DIR as in db-local-elm-lead-processes-pglite.js.
 *
 * NOT covered here: concurrent transactions. PGlite is a single connection, so every
 * statement runs sequentially. The Convertido-vs-other-status race is verified by SQL review
 * only (row locks in elm_postback_resolve_event + granted guard); real concurrency NOT executed.
 *
 * Run: node scripts/db-local-elm-postback-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIG_1A = path.join(__dirname, '..', 'migrations', '20261007_elm_lead_processes.sql');
const MIG_1B = path.join(__dirname, '..', 'migrations', '20261007_elm_postback_events.sql');

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
`;

const USER_ID = '5e000000-0000-4000-8000-000000000001';
const REQ = JSON.stringify({ docNumber: '12345678', source: 'TestBrand' });

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

async function main() {
  let PGlite;
  try {
    PGlite = require(PGLITE_DIR).PGlite;
  } catch (e) {
    console.error('PGlite not available at ' + PGLITE_DIR + ' (set PGLITE_DIR). SKIPPED.');
    process.exit(2);
  }
  const db = new PGlite();

  async function asRole(role, fn) {
    await db.exec('SET ROLE ' + role);
    try {
      return await fn();
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const svc = (sql, params) => asRole('service_role', () => db.query(sql, params || []));

  async function makeProcess(czId, ci, s2) {
    const claimed = await svc(
      'SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) AS r',
      [czId, ci, 'TestBrand', 'janus_manual', USER_ID, 8, 'LRW-' + czId, REQ, 300],
    );
    const id = claimed.rows[0].r.process.id;
    await svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, 'eligible', '{}', 200, 'ok', 5, null, null,
    ]);
    if (s2 === 'not_started') return id;
    await svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [czId, REQ, 300]);
    if (s2 === 'in_flight') return id;
    await svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, s2, '{}', 200, 'ok', 5, null, null,
    ]);
    return id;
  }
  async function record(raw, norm, ci, czId, eventAt) {
    const r = await svc(
      'SELECT * FROM public.elm_postback_record_event($1, $2, $3, $4, $5, $6, $7::jsonb)',
      [raw, norm, ci, null, czId, eventAt || null, JSON.stringify({ status: raw })],
    );
    return r.rows[0];
  }
  async function resolve(eventId, processId, method, unresolved, code) {
    const r = await svc('SELECT * FROM public.elm_postback_resolve_event($1, $2, $3, $4, $5)', [
      eventId, processId, method, unresolved || null, code || null,
    ]);
    return r.rows[0];
  }
  async function proc(czId) {
    return (await db.query('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId])).rows[0];
  }

  await db.exec(STUBS);
  await db.query('INSERT INTO public.dashboard_users (id) VALUES ($1)', [USER_ID]);
  await db.exec(fs.readFileSync(MIG_1A, 'utf8'));
  const sql1b = fs.readFileSync(MIG_1B, 'utf8');
  await db.exec(sql1b);
  await db.exec(sql1b);
  pass('1B migration applies twice (idempotent) on top of 1A');

  // Access
  const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.elm_postback_events'::regclass");
  assert.strictEqual(rls.rows[0].relrowsecurity, true);
  const pol = await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'elm_postback_events'");
  assert.strictEqual(pol.rows[0].n, 0);
  for (const role of ['anon', 'authenticated']) {
    await expectSqlError(() => asRole(role, () => db.query('SELECT * FROM public.elm_postback_events')), /permission denied/, role + ' select');
    await expectSqlError(
      () => asRole(role, () => db.query("SELECT * FROM public.elm_postback_record_event('Convertido','convertido',1,null,null,null,'{}'::jsonb)")),
      /permission denied/,
      role + ' record rpc',
    );
    await expectSqlError(
      () => asRole(role, () => db.query("SELECT * FROM public.elm_postback_resolve_event(gen_random_uuid(), null, null, 'unmatched', 'x')")),
      /permission denied/,
      role + ' resolve rpc',
    );
  }
  pass('#17 RLS on, 0 policies, anon/authenticated denied on table + both RPCs');

  // Fixtures (same CI 12345678)
  const pOld = await makeProcess(900, 12345678, 'referred');
  const pNew = await makeProcess(700, 12345678, 'referred');
  const pNever = await makeProcess(950, 12345678, 'not_started');
  const pUnknown = await makeProcess(960, 22222222, 'unknown');
  const pRejected = await makeProcess(970, 33333333, 'rejected');
  const pInFlight = await makeProcess(980, 44444444, 'in_flight');

  // Convertido → GRANTED ELM (exact cz_solicitud_id)
  const M = 'cz_solicitud_id';
  const before = await proc(700);
  const e1 = await record('Convertido', 'convertido', 12345678, 700, '2026-10-06T10:00:00Z');
  assert.strictEqual(e1.processing_status, 'received');
  const r1 = await resolve(e1.id, pNew, M);
  assert.strictEqual(r1.processing_status, 'applied');
  assert.strictEqual(Number(r1.matched_cz_solicitud_id), 700);
  const g = await proc(700);
  assert.ok(g.disbursed_at);
  assert.strictEqual(new Date(g.disbursed_at).toISOString(), '2026-10-06T10:00:00.000Z');
  assert.strictEqual(g.disbursed_amount, null);
  assert.strictEqual(g.provider_status, 'Convertido');
  assert.strictEqual(g.granted_event_id, e1.id);
  assert.strictEqual(g.s2_status, before.s2_status);
  assert.strictEqual(String(g.referred_at), String(before.referred_at));
  pass('#1 #2 Convertido → disbursed_at = event time, amount NULL, granted_event_id, S1/S2 untouched');

  // Repeated / later / earlier events (sequential execution)
  const e2 = await record('Convertido', 'convertido', 12345678, 700, '2026-10-06T10:00:00Z');
  assert.strictEqual((await resolve(e2.id, pNew, M)).processing_status, 'ignored_granted');
  const e3 = await record('Desiste', 'desiste', 12345678, 700, '2026-10-08T10:00:00Z');
  assert.strictEqual((await resolve(e3.id, pNew, M)).processing_status, 'ignored_granted');
  const e4 = await record('Convertido', 'convertido', 12345678, 700, '2026-09-01T10:00:00Z');
  assert.strictEqual((await resolve(e4.id, pNew, M)).processing_status, 'ignored_granted');
  const g2 = await proc(700);
  assert.strictEqual(String(g2.disbursed_at), String(g.disbursed_at));
  assert.strictEqual(g2.provider_status, 'Convertido');
  assert.strictEqual(g2.granted_event_id, e1.id);
  assert.strictEqual(g2.last_postback_event_id, e4.id);
  const again = await resolve(e1.id, pNew, M);
  assert.strictEqual(again.processing_status, 'applied', 're-resolve returns frozen event unchanged');
  pass('#10 #11 #12 duplicates / later / earlier events → ignored_granted; GRANTED + disbursed_at frozen (sequential)');

  // GRANTED guard: direct writes cannot revert
  await expectSqlError(() => svc('UPDATE public.elm_lead_processes SET disbursed_at = NULL WHERE id = $1', [pNew]), /elm_granted_disbursed_at_frozen/, 'clear disbursed_at');
  await expectSqlError(() => svc("UPDATE public.elm_lead_processes SET disbursed_at = now() WHERE id = $1", [pNew]), /elm_granted_disbursed_at_frozen/, 'move disbursed_at');
  await expectSqlError(() => svc("UPDATE public.elm_lead_processes SET provider_status = 'Rechazado' WHERE id = $1", [pNew]), /elm_granted_provider_status_frozen/, 'lower status');
  await svc('UPDATE public.elm_lead_processes SET disbursed_amount = 1000 WHERE id = $1', [pNew]);
  await expectSqlError(() => svc('UPDATE public.elm_lead_processes SET disbursed_amount = 2000 WHERE id = $1', [pNew]), /elm_disbursed_amount_frozen/, 'amount frozen');
  await expectSqlError(() => svc('DELETE FROM public.elm_lead_processes WHERE id = $1', [pNew]), /permission denied|cannot be deleted/, 'delete process');
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET disbursed_at = now() WHERE id = $1", [pNever]),
    /elm_lead_processes_disbursed_requires_s2_check/,
    'granted without S2',
  );
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET disbursed_amount = 5 WHERE id = $1", [pOld]),
    /elm_lead_processes_disbursed_amount_requires_at_check/,
    'amount without disbursed_at',
  );
  pass('GRANTED guard: no clear/move/lower; amount frozen once set; CHECKs require S2 + disbursed_at');

  // Other statuses + ordering on pOld
  const s1 = await record('Pendiente de Doc', 'pendiente de doc', 12345678, 900, '2026-10-05T10:00:00Z');
  assert.strictEqual((await resolve(s1.id, pOld, M)).processing_status, 'applied');
  const s2 = await record('Inicial', 'inicial', 12345678, 900, '2026-10-04T10:00:00Z');
  assert.strictEqual((await resolve(s2.id, pOld, M)).processing_status, 'stale');
  const o = await proc(900);
  assert.strictEqual(o.provider_status, 'Pendiente de Doc');
  assert.strictEqual(o.disbursed_at, null);
  const s3 = await record('Aprobado', 'aprobado', null, 900, null);
  assert.strictEqual((await resolve(s3.id, pOld, M)).processing_status, 'applied');
  const o2 = await proc(900);
  assert.strictEqual(o2.provider_status, 'Aprobado');
  assert.strictEqual(o2.disbursed_at, null);
  pass('#3 non-Convertido statuses update provider_status only (never GRANTED); older → stale, kept');

  // Compatibility re-checked in DB
  const before950 = JSON.stringify(await proc(950));
  for (const [pid, cz, ci] of [[pNever, 950, 12345678], [pRejected, 970, 33333333], [pInFlight, 980, 44444444]]) {
    const ev = await record('Convertido', 'convertido', ci, cz, null);
    const r = await resolve(ev.id, pid, M);
    assert.strictEqual(r.processing_status, 'unmatched', 'cz ' + cz);
    assert.strictEqual(r.error_code, 'elm_postback_process_not_compatible');
    assert.strictEqual(r.matched_elm_process_id, null);
    assert.strictEqual((await proc(cz)).disbursed_at, null);
  }
  assert.strictEqual(JSON.stringify(await proc(950)), before950);
  const eu = await record('Convertido', 'convertido', 22222222, 960, null);
  assert.strictEqual((await resolve(eu.id, pUnknown, M)).processing_status, 'applied');
  assert.ok((await proc(960)).disbursed_at);
  pass('#6 #7 DB rejects never-S2 / rejected / in_flight; S2 unknown (started) accepted');

  // Identity: exact id only; CI audit-only; unmatched never mutates
  const snapshot = JSON.stringify((await db.query('SELECT * FROM public.elm_lead_processes ORDER BY cz_solicitud_id')).rows);
  const ex = await record('Aprobado', 'aprobado', 12345678, 900, null);
  const exr = await resolve(ex.id, pNew, M);
  assert.strictEqual(exr.processing_status, 'unmatched');
  assert.strictEqual(exr.error_code, 'elm_postback_cz_id_mismatch');
  const noId = await record('Aprobado', 'aprobado', 12345678, null, null);
  const noIdR = await resolve(noId.id, pOld, M);
  assert.strictEqual(noIdR.processing_status, 'unmatched');
  assert.strictEqual(noIdR.error_code, 'elm_postback_cz_id_missing', 'DB refuses to apply without exact id');
  const cm = await record('Convertido', 'convertido', 99999999, 900, null);
  const cmr = await resolve(cm.id, pOld, M);
  assert.strictEqual(cmr.processing_status, 'unmatched');
  assert.strictEqual(cmr.error_code, 'elm_postback_ci_mismatch');
  const byCi = await record('Aprobado', 'aprobado', 12345678, 900, null);
  await expectSqlError(() => resolve(byCi.id, pOld, 'latest_elm_process_by_ci'), /elm_postback_invalid_match_method/, 'CI match method refused');
  await expectSqlError(
    () => svc("UPDATE public.elm_postback_events SET processing_status = 'unmatched', processed_at = now(), match_method = 'latest_elm_process_by_ci', error_code = 'x' WHERE id = $1", [byCi.id]),
    /elm_postback_events_match_method_check/,
    'CHECK refuses CI match method',
  );
  const um = await record('Convertido', 'convertido', 55555555, null, null);
  const umr = await resolve(um.id, null, null, 'unmatched', 'elm_postback_cz_id_missing');
  assert.strictEqual(umr.processing_status, 'unmatched');
  const inv = await record('Raro', 'raro', null, null, null);
  assert.strictEqual((await resolve(inv.id, null, null, 'invalid', 'elm_postback_status_unknown')).processing_status, 'invalid');
  assert.strictEqual(JSON.stringify((await db.query('SELECT * FROM public.elm_lead_processes ORDER BY cz_solicitud_id')).rows), snapshot);
  const keptUnresolved = await db.query('SELECT count(*)::int AS n FROM public.elm_postback_events WHERE id = ANY($1::uuid[])', [[ex.id, noId.id, cm.id, um.id, inv.id]]);
  assert.strictEqual(keptUnresolved.rows[0].n, 5, 'unmatched/invalid events kept');
  const bad = await record('Aprobado', 'aprobado', 1, null, null);
  await expectSqlError(() => resolve(bad.id, null, null, 'applied', 'x'), /elm_postback_invalid_unresolved_status/, 'unresolved must be unmatched/invalid');
  pass('#8 #9 #14 #15 exact id required in DB; CI mismatch → unmatched; CI match method refused; zero mutation');

  // Raw events immutable, never deleted
  await expectSqlError(() => svc("UPDATE public.elm_postback_events SET raw_status = 'X' WHERE id = $1", [e1.id]), /raw event is immutable/, 'raw immutable');
  await expectSqlError(() => svc("UPDATE public.elm_postback_events SET processing_status = 'stale' WHERE id = $1", [e1.id]), /resolved event is frozen/, 'resolution frozen');
  await expectSqlError(() => svc('DELETE FROM public.elm_postback_events WHERE id = $1', [e1.id]), /permission denied|cannot be deleted/, 'delete event');
  await expectSqlError(() => svc('TRUNCATE public.elm_postback_events'), /permission denied/, 'truncate events');
  await expectSqlError(
    () => svc("INSERT INTO public.elm_postback_events (payload, processing_status, processed_at) VALUES ('{}'::jsonb, 'applied', now())"),
    /insert must start as received/,
    'insert pre-resolved',
  );
  const all = await db.query('SELECT count(*)::int AS n FROM public.elm_postback_events');
  assert.ok(all.rows[0].n >= 15);
  const kept = await db.query('SELECT raw_status, payload FROM public.elm_postback_events WHERE id = $1', [e1.id]);
  assert.strictEqual(kept.rows[0].raw_status, 'Convertido');
  assert.deepStrictEqual(kept.rows[0].payload, { status: 'Convertido' });
  pass('#13 raw events kept: immutable raw part, resolved once, no DELETE/TRUNCATE, insert only as received');

  const dmlByAnon = await db.query(
    "SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'elm_postback_events' AND grantee IN ('anon','authenticated','PUBLIC')",
  );
  assert.strictEqual(dmlByAnon.rows.length, 0);
  const svcPriv = await db.query(
    "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'elm_postback_events' AND grantee = 'service_role' ORDER BY 1",
  );
  const privs = svcPriv.rows.map((r) => r.privilege_type);
  assert.ok(privs.includes('SELECT') && privs.includes('INSERT') && privs.includes('UPDATE'));
  assert.ok(!privs.includes('DELETE') && !privs.includes('TRUNCATE'));
  pass('grants: anon/authenticated/PUBLIC none; service_role SELECT/INSERT/UPDATE, no DELETE/TRUNCATE');

  console.log('db-local-elm-postback-pglite: ' + groups + ' groups passed (LOCAL PGlite, no network)');
  await db.close();
}

main().catch((err) => {
  console.error('FAIL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
