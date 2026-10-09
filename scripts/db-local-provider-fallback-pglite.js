'use strict';

/**
 * Fase 3A — LOCAL database test of migrations/20261008_provider_fallback_requests.sql
 * (applied on top of 20261007_elm_lead_processes.sql + 20261007_elm_postback_events.sql).
 *
 * DB CLASSIFICATION: LOCAL. In-process, in-memory PGlite. Never reads SUPABASE_* env vars and
 * never opens a network connection. PGLITE_DIR as in db-local-elm-lead-processes-pglite.js.
 *
 * NOT covered here: truly concurrent transactions. PGlite is a single connection, so
 * FOR UPDATE SKIP LOCKED is executed but never contended. Concurrent claim safety is covered by
 * SQL review + sequential claims with distinct workers here, and by the worker-level
 * concurrency tests in scripts/unit-provider-fallback.js.
 *
 * Run: node scripts/db-local-provider-fallback-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIG = (name) => path.join(__dirname, '..', 'migrations', name);
const MIG_1A = MIG('20261007_elm_lead_processes.sql');
const MIG_1B = MIG('20261007_elm_postback_events.sql');
const MIG_3A = MIG('20261008_provider_fallback_requests.sql');

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

const HASH_A = crypto.createHash('sha256').update('a').digest('hex');
const HASH_B = crypto.createHash('sha256').update('b').digest('hex');
const SNAP = JSON.stringify({ v: 1, applicant: { ci: '1' } });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async function enqueue(czId, ci, hash) {
    const r = await svc('SELECT public.provider_fallback_enqueue($1, $2, $3::jsonb, $4) AS r', [
      czId, ci, SNAP, hash || HASH_A,
    ]);
    return r.rows[0].r;
  }
  async function claim(worker, limit, czId, lease) {
    const r = await svc('SELECT * FROM public.provider_fallback_claim($1, $2, $3, $4)', [
      worker, lease || 600, limit || 10, czId == null ? null : czId,
    ]);
    return r.rows;
  }
  async function defer(id, worker, delay, notStarted, reason) {
    const r = await svc('SELECT * FROM public.provider_fallback_defer($1, $2, $3, $4, $5)', [
      id, worker, delay, notStarted, reason || 'x',
    ]);
    return r.rows;
  }
  async function finalize(id, worker, outcome, reason, processId, related) {
    const r = await svc(
      'SELECT * FROM public.provider_fallback_finalize($1, $2, $3, $4, $5::jsonb, $6, $7)',
      [id, worker, outcome, reason || 'elm_s1_rejected', null, processId || null, related || null],
    );
    return r.rows;
  }
  async function ack(czId, outcome) {
    const r = await svc('SELECT public.provider_fallback_ack($1, $2) AS r', [czId, outcome]);
    return r.rows[0].r;
  }
  async function row(czId) {
    return (await db.query('SELECT * FROM public.provider_fallback_requests WHERE cz_solicitud_id = $1', [czId])).rows[0];
  }
  const ids = (rows) => rows.map((r) => Number(r.cz_solicitud_id)).sort((a, b) => a - b);

  await db.exec(STUBS);
  await db.exec(fs.readFileSync(MIG_1A, 'utf8'));
  await db.exec(fs.readFileSync(MIG_1B, 'utf8'));
  const sql3a = fs.readFileSync(MIG_3A, 'utf8');
  await db.exec(sql3a);
  await db.exec(sql3a);
  pass('3A migration applies twice (idempotent) on top of 1A + 1B');

  // Access
  for (const t of ['provider_fallback_requests', 'elm_late_results']) {
    const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || $1)::regclass", [t]);
    assert.strictEqual(rls.rows[0].relrowsecurity, true, t + ' rls');
    const pol = await db.query('SELECT count(*)::int AS n FROM pg_policies WHERE tablename = $1', [t]);
    assert.strictEqual(pol.rows[0].n, 0, t + ' policies');
  }
  for (const role of ['anon', 'authenticated']) {
    await expectSqlError(() => asRole(role, () => db.query('SELECT * FROM public.provider_fallback_requests')), /permission denied/, role + ' select');
    await expectSqlError(() => asRole(role, () => db.query('SELECT * FROM public.elm_late_results')), /permission denied/, role + ' late select');
    await expectSqlError(
      () => asRole(role, () => db.query("SELECT public.provider_fallback_enqueue(1, 1, '{}'::jsonb, $1)", [HASH_A])),
      /permission denied/,
      role + ' enqueue',
    );
    await expectSqlError(() => asRole(role, () => db.query("SELECT * FROM public.provider_fallback_claim('w', 60, 1, null)")), /permission denied/, role + ' claim');
    await expectSqlError(() => asRole(role, () => db.query("SELECT public.provider_fallback_ack(1, 'rejected')")), /permission denied/, role + ' ack');
  }
  await expectSqlError(() => svc('DELETE FROM public.provider_fallback_requests'), /permission denied/, 'svc delete');
  await expectSqlError(() => svc('TRUNCATE public.provider_fallback_requests'), /permission denied/, 'svc truncate');
  await expectSqlError(() => svc('UPDATE public.elm_late_results SET step = step'), /permission denied/, 'svc late update');
  pass('access: RLS on, 0 policies, anon/authenticated denied (table + RPCs), service_role no DELETE/TRUNCATE');

  // Double start of the same solicitud
  const e1 = await enqueue(100, 11111111);
  const e2 = await enqueue(100, 11111111);
  const e3 = await enqueue(100, 11111111, HASH_B);
  assert.strictEqual(e1.created, true);
  assert.strictEqual(e2.created, false);
  assert.strictEqual(e2.conflict, false);
  assert.strictEqual(e3.created, false);
  assert.strictEqual(e3.conflict, true);
  assert.strictEqual(e1.request.id, e2.request.id);
  const n100 = await db.query('SELECT count(*)::int AS n FROM public.provider_fallback_requests WHERE cz_solicitud_id = 100');
  assert.strictEqual(n100.rows[0].n, 1);
  assert.strictEqual((await row(100)).snapshot_hash, HASH_A, 'snapshot never overwritten');
  pass('double start: one row per cz_solicitud_id; same snapshot → existing; different → conflict, not overwritten');

  // Two workers: disjoint claims
  await enqueue(101, 22222222);
  await enqueue(102, 33333333);
  const wA = await claim('worker-A', 2);
  const wB = await claim('worker-B', 10);
  assert.deepStrictEqual(ids(wA), [100, 101]);
  assert.deepStrictEqual(ids(wB), [102]);
  assert.deepStrictEqual(await claim('worker-C', 10), [], 'nothing left while leases are valid');
  for (const r of wA) assert.strictEqual(r.job_lease_owner, 'worker-A');
  pass('two workers: claims are disjoint, running rows with valid lease are not re-claimed');

  // Lost lease: expired job lease → reclaim; previous owner can no longer defer/finalize
  await db.query("UPDATE public.provider_fallback_requests SET job_lease_expires_at = now() - interval '1 second' WHERE cz_solicitud_id = 102");
  const re = await claim('worker-D', 10);
  assert.deepStrictEqual(ids(re), [102]);
  assert.strictEqual(re[0].claim_count, 2);
  assert.deepStrictEqual(await defer(re[0].id, 'worker-B', 0, true), [], 'old owner cannot defer');
  assert.deepStrictEqual(await finalize(re[0].id, 'worker-B', 'rejected'), [], 'old owner cannot finalize');
  pass('expired job lease: reclaimed by another worker; previous owner loses defer/finalize');

  // Defer: not-started counter, run_after, narrowed claim
  const d1 = await defer(re[0].id, 'worker-D', 3600, true, 'not_started:elm_send_disabled');
  assert.strictEqual(d1[0].exec_status, 'queued');
  assert.strictEqual(d1[0].not_started_attempts, 1);
  assert.strictEqual(d1[0].job_lease_owner, null);
  assert.deepStrictEqual(await claim('worker-E', 10, 102), [], 'run_after in the future');
  const d2 = await defer(wA[1].id, 'worker-A', 0, false, 'elm_in_flight');
  assert.strictEqual(d2[0].not_started_attempts, 0, 'started work never counts as not-started');
  const narrowed = await claim('worker-E', 10, 101);
  assert.deepStrictEqual(ids(narrowed), [101], 'immediate trigger claims only its solicitud');
  pass('defer: counts only proven not-started, respects run_after; claim narrowed by cz_solicitud_id');

  // Finalize + frozen outcome + delivery
  const proc = await svc(
    'SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) AS r',
    [101, 22222222, 'TestBrand', 'cz_automatic', null, 3, 'LRW-101', REQ, 300],
  );
  const processId = proc.rows[0].r.process.id;
  const f1 = await finalize(narrowed[0].id, 'worker-E', 'manual_review', 'elm_s1_unknown', processId);
  assert.strictEqual(f1[0].exec_status, 'done');
  assert.strictEqual(f1[0].outcome, 'manual_review');
  assert.strictEqual(f1[0].cz_delivery_status, 'pending');
  assert.ok(f1[0].finalized_at);
  assert.deepStrictEqual(await finalize(narrowed[0].id, 'worker-E', 'referred', 'elm_s2_referred'), [], 'second finalize no-op');
  await expectSqlError(
    () => db.query("UPDATE public.provider_fallback_requests SET outcome = 'referred' WHERE cz_solicitud_id = 101"),
    /frozen once final/,
    'outcome frozen',
  );
  await expectSqlError(
    () => db.query("UPDATE public.provider_fallback_requests SET exec_status = 'queued' WHERE cz_solicitud_id = 101"),
    /illegal_exec_transition|frozen/,
    'done is terminal',
  );
  await expectSqlError(() => svc("SELECT * FROM public.provider_fallback_finalize(gen_random_uuid(), 'w', 'pending', 'x', null, null, null)"), /invalid_outcome/, 'pending not final');
  assert.deepStrictEqual(await claim('worker-F', 10, 101), [], 'done never re-claimed');
  pass('finalize: once, by lease owner; outcome frozen; done never reclaimed; delivery → pending');

  // Ack (duplicate)
  assert.strictEqual((await ack(999, 'rejected')).status, 'not_found');
  assert.strictEqual((await ack(100, 'rejected')).status, 'not_final');
  assert.strictEqual((await ack(101, 'referred')).status, 'outcome_mismatch');
  const a1 = await ack(101, 'manual_review');
  const a2 = await ack(101, 'manual_review');
  assert.strictEqual(a1.status, 'acked');
  assert.strictEqual(a2.status, 'already_acked');
  assert.strictEqual(a2.acked_at, a1.acked_at, 'ack time not moved by duplicate');
  const r101 = await row(101);
  assert.strictEqual(r101.cz_delivery_status, 'acked');
  await expectSqlError(
    () => db.query("UPDATE public.provider_fallback_requests SET cz_delivery_status = 'pending', cz_acked_at = NULL WHERE cz_solicitud_id = 101"),
    /illegal_delivery_transition|immutable/,
    'acked frozen',
  );
  pass('ack: not_found / not_final / outcome_mismatch / acked / duplicate → already_acked (idempotent)');

  // CI serialization: only the oldest open request per CI is claimable; one running per CI
  await enqueue(200, 55555555);
  await sleep(5);
  await enqueue(201, 55555555);
  const c1 = await claim('worker-G', 10, null);
  assert.ok(ids(c1).includes(200) && !ids(c1).includes(201), 'only oldest of CI');
  assert.deepStrictEqual(await claim('worker-H', 10, 201), [], 'newer of same CI waits');
  await expectSqlError(
    () => db.query("UPDATE public.provider_fallback_requests SET exec_status = 'running', job_lease_owner = 'x', job_lease_expires_at = now() + interval '1 minute' WHERE cz_solicitud_id = 201"),
    /uq_provider_fallback_requests_one_running_per_ci|duplicate key/,
    'unique running per CI',
  );
  const job200 = c1.find((r) => Number(r.cz_solicitud_id) === 200);
  await defer(job200.id, 'worker-G', 3600, false, 'elm_in_flight');
  assert.deepStrictEqual(await claim('worker-H', 10, 201), [], 'deferred older still blocks newer of same CI');
  await db.query("UPDATE public.provider_fallback_requests SET run_after = now() - interval '1 second' WHERE cz_solicitud_id = 200");
  const c200 = await claim('worker-H', 10, 200);
  await finalize(c200[0].id, 'worker-H', 'already_referred', 'ci_active_referral');
  const c201 = await claim('worker-H', 10, 201);
  assert.deepStrictEqual(ids(c201), [201], 'newer claimable once older is done');
  for (const r of c1) {
    if (Number(r.cz_solicitud_id) !== 200) await defer(r.id, 'worker-G', 3600, false, 'park');
  }
  pass('CI: one open automatic evaluation per CI (oldest first), unique running per CI enforced by index');

  // Guards
  await expectSqlError(() => db.query('DELETE FROM public.provider_fallback_requests WHERE cz_solicitud_id = 100'), /cannot be deleted/, 'no delete');
  await expectSqlError(
    () => db.query("UPDATE public.provider_fallback_requests SET snapshot = '{}'::jsonb WHERE cz_solicitud_id = 100"),
    /immutable/,
    'snapshot immutable',
  );
  await expectSqlError(
    () => db.query("INSERT INTO public.provider_fallback_requests (cz_solicitud_id, ci, snapshot, snapshot_hash, exec_status, job_lease_owner, job_lease_expires_at) VALUES (300, 1, '{}'::jsonb, $1, 'running', 'x', now())", [HASH_A]),
    /must start queued/,
    'insert must be queued',
  );
  await expectSqlError(() => svc("SELECT * FROM public.provider_fallback_claim('w', 60, 0, null)"), /invalid_limit/, 'limit');
  await expectSqlError(() => svc("SELECT * FROM public.provider_fallback_claim('w', 0, 1, null)"), /invalid_lease_seconds/, 'lease');
  await expectSqlError(() => svc("SELECT * FROM public.provider_fallback_claim('', 60, 1, null)"), /invalid_worker_id/, 'worker id');
  pass('guards: no DELETE, snapshot immutable, insert must be queued, claim argument validation');

  // Late results (append-only)
  const late = await svc(
    'SELECT * FROM public.elm_record_late_result($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)',
    [processId, 101, 's1', 'eligible', 200, 'ok', null, '{}', 12, 'cz_automatic'],
  );
  assert.strictEqual(late.rows[0].late_status, 'eligible');
  await expectSqlError(
    () => svc('SELECT * FROM public.elm_record_late_result($1, $2, $3, $4, null, null, null, null, null, null)', [processId, 101, 's1', 'referred']),
    /elm_late_results_step_status_check/,
    'status must match step',
  );
  await expectSqlError(() => db.query('UPDATE public.elm_late_results SET late_status = late_status'), /append-only/, 'late no update');
  await expectSqlError(() => db.query('DELETE FROM public.elm_late_results'), /append-only/, 'late no delete');
  const p = (await db.query('SELECT s1_status FROM public.elm_lead_processes WHERE id = $1', [processId])).rows[0];
  assert.strictEqual(p.s1_status, 'in_flight', 'late result never applied to the process');
  pass('late results: recorded append-only, step/status validated, process untouched');

  console.log('db-local-provider-fallback-pglite: ' + groups + ' groups passed (LOCAL PGlite; real concurrency NOT executed)');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
