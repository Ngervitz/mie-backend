'use strict';

/**
 * ELM Fase 1A — LOCAL database test of migrations/20261007_elm_lead_processes.sql.
 *
 * DB CLASSIFICATION: LOCAL. Runs an in-process, in-memory PGlite (Postgres compiled to WASM).
 * It never reads SUPABASE_* env vars and never opens a network connection.
 * PGlite is not a repo dependency: point PGLITE_DIR at an installed @electric-sql/pglite
 * (default: %TEMP%/stage2-pglite/node_modules/@electric-sql/pglite).
 *
 * Applies the migration twice (idempotency) over minimal Supabase stubs (roles
 * anon/authenticated/service_role with Supabase-like default privileges, dashboard_users,
 * set_updated_at) and exercises claim / transitions / lease expiry / access as service_role.
 *
 * Run: node scripts/db-local-elm-lead-processes-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIGRATION = path.join(__dirname, '..', 'migrations', '20261007_elm_lead_processes.sql');

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
const S1_REQ = JSON.stringify({ docNumber: '12345678', source: 'TestBrand' });
const S2_REQ = JSON.stringify({ docNumber: '12345678', source: 'TestBrand' });

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

  function claim(czId, ci, leaseSeconds, opts) {
    const o = opts || {};
    return svc(
      'SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) AS r',
      [
        czId,
        ci,
        'TestBrand',
        o.origin || 'janus_manual',
        o.userId === undefined ? USER_ID : o.userId,
        8,
        'LRW-' + czId,
        o.request || S1_REQ,
        leaseSeconds,
      ],
    ).then((res) => res.rows[0].r);
  }
  function finishS1(id, status) {
    return svc(
      'SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)',
      [id, status, JSON.stringify({ result: 'x' }), 200, 'x', 10, null, null],
    ).then((r) => r.rows);
  }
  function beginS2(czId, leaseSeconds) {
    return svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [czId, S2_REQ, leaseSeconds || 300])
      .then((r) => r.rows);
  }
  function finishS2(id, status) {
    return svc(
      'SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)',
      [id, status, JSON.stringify({ result: 'y' }), 200, 'y', 10, null, null],
    ).then((r) => r.rows);
  }
  function expire(czId) {
    return svc('SELECT * FROM public.elm_expire_stale_in_flight($1)', [czId]).then((r) => r.rows);
  }
  async function row(czId) {
    return (await db.query('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId])).rows[0] || null;
  }

  await db.exec(STUBS);
  await db.query('INSERT INTO public.dashboard_users (id) VALUES ($1)', [USER_ID]);
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  pass('migration applies twice (idempotent) on local PGlite');

  // RLS + access
  const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.elm_lead_processes'::regclass");
  assert.strictEqual(rls.rows[0].relrowsecurity, true);
  const pol = await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'elm_lead_processes'");
  assert.strictEqual(pol.rows[0].n, 0);
  for (const role of ['anon', 'authenticated']) {
    await expectSqlError(() => asRole(role, () => db.query('SELECT * FROM public.elm_lead_processes')), /permission denied/, role + ' select');
    await expectSqlError(
      () => asRole(role, () => db.query("INSERT INTO public.elm_lead_processes (cz_solicitud_id, ci, source_brand, trigger_origin) VALUES (1, 1, 'x', 'janus_batch')")),
      /permission denied/,
      role + ' insert',
    );
    await expectSqlError(
      () => asRole(role, () => db.query("SELECT public.elm_claim_process(1, 1, 'x', 'janus_batch', NULL, NULL, NULL, '{}'::jsonb, 60)")),
      /permission denied/,
      role + ' execute claim',
    );
    await expectSqlError(() => asRole(role, () => db.query('SELECT * FROM public.elm_expire_stale_in_flight(1)')), /permission denied/, role + ' execute expire');
  }
  pass('RLS on, no policies; anon/authenticated cannot read, write or execute RPCs');

  // Atomic claim, identity = cz_id
  const c1 = await claim(1001, 12345678, 300);
  assert.strictEqual(c1.claimed, true);
  assert.strictEqual(c1.process.s1_status, 'in_flight');
  assert.ok(c1.process.s1_lease_expires_at);
  const c2 = await claim(1001, 12345678, 300);
  assert.strictEqual(c2.claimed, false);
  assert.strictEqual(c2.process.id, c1.process.id);
  const n1001 = await db.query('SELECT count(*)::int AS n FROM public.elm_lead_processes WHERE cz_solicitud_id = 1001');
  assert.strictEqual(n1001.rows[0].n, 1);
  const c3 = await claim(1002, 12345678, 300);
  assert.strictEqual(c3.claimed, true, 'same CI, other solicitud → own process');
  const sameCi = await db.query('SELECT count(*)::int AS n FROM public.elm_lead_processes WHERE ci = 12345678');
  assert.strictEqual(sameCi.rows[0].n, 2);
  await expectSqlError(
    () => svc("INSERT INTO public.elm_lead_processes (cz_solicitud_id, ci, source_brand, trigger_origin) VALUES (1001, 1, 'x', 'janus_batch')"),
    /duplicate key|unique/i,
    'unique cz_solicitud_id',
  );
  pass('claim: second claim on same cz_id returns existing (claimed=false); same CI allowed twice');

  // Claim validation
  await expectSqlError(() => claim(1003, 1, 300, { userId: null }), /elm_manual_trigger_requires_user/, 'manual needs user');
  await expectSqlError(() => claim(1003, 1, 0), /elm_invalid_lease_seconds/, 'lease 0');
  await expectSqlError(() => claim(1003, 1, 300, { request: '[]' }), /elm_invalid_s1_request/, 'request array');
  await expectSqlError(() => claim(1003, 1, 300, { origin: 'nope' }), /check/i, 'origin check');
  assert.strictEqual(await row(1003), null);
  pass('claim validates lease, request shape, manual user and trigger_origin');

  // S2 requires S1 eligible
  assert.strictEqual((await beginS2(1001)).length, 0, 'S2 not startable while S1 in_flight');
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s2_status = 'in_flight', s2_request = '{}'::jsonb, s2_started_at = now(), s2_lease_expires_at = now() + interval '1 minute' WHERE cz_solicitud_id = 1001"),
    /check|s2_requires_s1/i,
    'direct S2 without S1 eligible',
  );
  const rej = await finishS1(c3.process.id, 'rejected');
  assert.strictEqual(rej[0].s1_status, 'rejected');
  assert.strictEqual((await beginS2(1002)).length, 0, 'S2 not startable after S1 rejected');
  pass('S2 impossible without S1 eligible (RPC and CHECK)');

  // finish only from in_flight
  const el = await finishS1(c1.process.id, 'eligible');
  assert.strictEqual(el[0].s1_status, 'eligible');
  assert.strictEqual(el[0].s1_lease_expires_at, null);
  assert.ok(el[0].s1_completed_at);
  assert.strictEqual((await finishS1(c1.process.id, 'rejected')).length, 0, 'terminal S1 frozen');
  assert.strictEqual((await row(1001)).s1_status, 'eligible');
  await expectSqlError(() => finishS1(c1.process.id, 'in_flight'), /elm_invalid_s1_final_status/, 'finish to in_flight');
  pass('finish_s1 only from in_flight; terminal result frozen');

  // S2 referred sets referred_at; referred ≠ granted
  const b = await beginS2(1001);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].s2_status, 'in_flight');
  assert.strictEqual((await beginS2(1001)).length, 0, 'S2 begins once');
  const ref = await finishS2(c1.process.id, 'referred');
  assert.strictEqual(ref[0].s2_status, 'referred');
  assert.ok(ref[0].referred_at);
  assert.strictEqual(ref[0].disbursed_at, null);
  await expectSqlError(() => finishS2(c1.process.id, 'granted'), /elm_invalid_s2_final_status/, 'no granted status');
  assert.strictEqual((await finishS2(c1.process.id, 'rejected')).length, 0);
  pass('S2 referred sets referred_at once; no granted state; S2 begins once');

  // Illegal transitions / immutability / delete
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s1_status = 'in_flight', s1_lease_expires_at = now() + interval '1 minute', s1_completed_at = NULL WHERE cz_solicitud_id = 1002"),
    /elm_illegal_s1_transition/,
    'rejected → in_flight',
  );
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s1_request = '{\"docNumber\":\"9\"}'::jsonb WHERE cz_solicitud_id = 1002"),
    /frozen/,
    's1_request frozen',
  );
  await expectSqlError(
    () => svc('UPDATE public.elm_lead_processes SET cz_solicitud_id = 9999 WHERE cz_solicitud_id = 1002'),
    /immutable/,
    'identity immutable',
  );
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s1_result_message = 'otro' WHERE cz_solicitud_id = 1002"),
    /frozen once terminal/,
    'terminal result frozen',
  );
  await expectSqlError(
    () => svc("INSERT INTO public.elm_lead_processes (cz_solicitud_id, ci, source_brand, trigger_origin, s1_status, s1_request, s1_started_at, s1_completed_at) VALUES (5005, 1, 'x', 'janus_batch', 'eligible', '{}'::jsonb, now(), now())"),
    /must start/,
    'insert directly as eligible',
  );
  await expectSqlError(() => svc('DELETE FROM public.elm_lead_processes WHERE cz_solicitud_id = 1002'), /permission denied/, 'service_role delete');
  await expectSqlError(() => svc('TRUNCATE public.elm_lead_processes'), /permission denied/, 'service_role truncate');
  await expectSqlError(() => db.query('DELETE FROM public.elm_lead_processes WHERE cz_solicitud_id = 1002'), /cannot be deleted/, 'owner delete');
  pass('illegal transitions, frozen requests/results, immutable identity and DELETE rejected');

  // Lease expiry → unknown, never re-claimed
  const c4 = await claim(1004, 22222222, 1);
  assert.strictEqual(c4.claimed, true);
  const early = await expire(1004);
  assert.strictEqual(early[0].s1_status, 'in_flight', 'not expired yet');
  await new Promise((r) => setTimeout(r, 1300));
  const exp = await expire(1004);
  assert.strictEqual(exp[0].s1_status, 'unknown');
  assert.strictEqual(exp[0].s1_error_code, 'elm_in_flight_lease_expired');
  assert.strictEqual(exp[0].s1_lease_expires_at, null);
  const again = await claim(1004, 22222222, 300);
  assert.strictEqual(again.claimed, false);
  assert.strictEqual(again.process.s1_status, 'unknown');
  assert.strictEqual((await finishS1(c4.process.id, 'eligible')).length, 0, 'late result cannot overwrite unknown');
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s1_status = 'in_flight', s1_lease_expires_at = now() + interval '1 minute' WHERE cz_solicitud_id = 1004"),
    /elm_illegal_s1_transition/,
    'unknown → in_flight',
  );
  assert.strictEqual((await beginS2(1004)).length, 0);
  pass('expired in_flight → unknown; no re-claim, no late overwrite, no S2');

  // Lease fixed per step (R8)
  const c6 = await claim(1006, 44444444, 300);
  const lease6 = (await row(1006)).s1_lease_expires_at;
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s1_lease_expires_at = s1_lease_expires_at + interval '1 hour' WHERE cz_solicitud_id = 1006"),
    /elm_s1_lease_immutable_while_in_flight/,
    'extend s1 lease while in_flight',
  );
  await expectSqlError(
    () => svc('UPDATE public.elm_lead_processes SET s1_lease_expires_at = NULL WHERE cz_solicitud_id = 1006'),
    /check|lease/i,
    'clear s1 lease while staying in_flight',
  );
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s1_status = 'unknown', s1_completed_at = now() WHERE cz_solicitud_id = 1006"),
    /elm_lease_only_while_in_flight/,
    'leave in_flight without clearing lease',
  );
  assert.strictEqual(String((await row(1006)).s1_lease_expires_at), String(lease6));
  await finishS1(c6.process.id, 'eligible');
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s1_lease_expires_at = now() + interval '1 hour' WHERE cz_solicitud_id = 1006"),
    /elm_lease_only_while_in_flight/,
    'set s1 lease on terminal',
  );
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s2_lease_expires_at = now() + interval '1 hour' WHERE cz_solicitud_id = 1006"),
    /elm_lease_only_while_in_flight/,
    'set s2 lease while s2 not_started',
  );
  assert.strictEqual((await beginS2(1006)).length, 1);
  await expectSqlError(
    () => svc("UPDATE public.elm_lead_processes SET s2_lease_expires_at = s2_lease_expires_at + interval '1 hour' WHERE cz_solicitud_id = 1006"),
    /elm_s2_lease_immutable_while_in_flight/,
    'extend s2 lease while in_flight',
  );
  const done6 = await finishS2(c6.process.id, 'rejected');
  assert.strictEqual(done6[0].s2_lease_expires_at, null);
  await expectSqlError(
    () => svc("INSERT INTO public.elm_lead_processes (cz_solicitud_id, ci, source_brand, trigger_origin, s1_lease_expires_at) VALUES (6006, 1, 'x', 'janus_batch', now() + interval '1 hour')"),
    /elm_lease_only_while_in_flight/,
    'insert not_started with lease',
  );
  await expectSqlError(
    () => db.query("UPDATE public.elm_lead_processes SET s1_lease_expires_at = now() + interval '1 day' WHERE cz_solicitud_id = 1001"),
    /elm_lease_only_while_in_flight/,
    'owner cannot set lease on terminal either',
  );
  pass('lease set only when entering in_flight, cleared on exit, never extended (R8)');

  // S2 lease expiry
  const c5 = await claim(1005, 33333333, 300);
  await finishS1(c5.process.id, 'eligible');
  assert.strictEqual((await beginS2(1005, 1)).length, 1);
  await new Promise((r) => setTimeout(r, 1300));
  const exp2 = await expire(1005);
  assert.strictEqual(exp2[0].s2_status, 'unknown');
  assert.strictEqual(exp2[0].referred_at, null);
  assert.strictEqual((await beginS2(1005)).length, 0);
  pass('expired S2 in_flight → unknown, never referred, no second S2');

  console.log('db-local-elm-lead-processes-pglite: ' + groups + ' groups passed (LOCAL PGlite only)');
}

main().catch((err) => {
  console.error('FAIL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
