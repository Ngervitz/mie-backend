'use strict';

/**
 * LOCAL database test of migrations/20261019_elm_s1_module_missing_retry.sql.
 * In-process PGlite. No SUPABASE_* and no network. Does not send to ELM.
 *
 * Run: node scripts/db-local-elm-s1-module-missing-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIG = (name) => path.join(__dirname, '..', 'migrations', name);
const MIGRATIONS = [
  '20261007_elm_lead_processes.sql',
  '20261007_elm_postback_events.sql',
  '20261008_provider_fallback_requests.sql',
  '20261009_elm_phase3b_operations.sql',
  '20261010_provider_fallback_c1_events.sql',
  '20261011_elm_manual_pre_reception_retry.sql',
  '20261016_elm_gestion_send_audit.sql',
  '20261017_elm_admin_provider_resend.sql',
  '20261019_elm_s1_module_missing_retry.sql',
];

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

const REQ = JSON.stringify({ docNumber: '50562896', source: 'copanel', salary: 1 });
const MODULE_BODY = JSON.stringify({
  error: {
    code: 'MODULE_DOES_NOT_EXIST',
    message: 'Module does not exist: /SuiteScripts/adapters/equifaxAdapter.js',
  },
});
const SIG = 'public.elm_s1_module_missing_retry(bigint,integer,integer,uuid)';
const NOTE = 'ELM respondió Repetido. Rechazado. Sin derivación. Cupo de octubre consumido.';

let groups = 0;
function pass(label) {
  groups += 1;
  console.log('ok - ' + label);
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
  const one = async (sql, params) => (await svc(sql, params)).rows[0];
  const val = async (sql, params) => (await one(sql, params)).r;
  const su = async (sql, params) => (await db.query(sql, params || [])).rows;

  await db.exec(STUBS);
  for (const m of MIGRATIONS) await db.exec(fs.readFileSync(MIG(m), 'utf8'));
  await db.exec(fs.readFileSync(MIG('20261019_elm_s1_module_missing_retry.sql'), 'utf8'));
  const actor = (await db.query('INSERT INTO public.dashboard_users DEFAULT VALUES RETURNING id')).rows[0].id;

  const priv = async (role) =>
    (await su('SELECT has_function_privilege($1, $2, $3) AS r', [role, SIG, 'EXECUTE']))[0].r;
  assert.deepStrictEqual(
    [await priv('anon'), await priv('authenticated'), await priv('service_role')],
    [false, false, true],
  );
  pass('migration applies twice; only service_role executes elm_s1_module_missing_retry');

  const claim = async (czId, ci) =>
    (await val('SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) AS r', [
      czId, ci, 'copanel', 'janus_manual', actor, 14, 'LRW-' + czId, REQ, 300, null,
    ])).process;
  const fin1 = (id, status, http, message, code, body) =>
    svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, status, body, http, message, 12, code, null,
    ]);
  const retry = (czId, expected) =>
    val('SELECT public.elm_s1_module_missing_retry($1, $2, $3, $4) AS r', [czId, expected, 300, actor]);
  const attempts = async (czId) =>
    Number((await one('SELECT count(*)::int AS r FROM public.elm_step_attempts WHERE cz_solicitud_id = $1', [czId])).r);
  const locks = async (czId) =>
    (await svc(
      'SELECT id, state, blocks_future, settle_reason, month_key::text AS month FROM public.elm_ci_send_locks WHERE cz_solicitud_id = $1 ORDER BY reserved_at',
      [czId],
    )).rows;

  const other = await retry(2143, 1);
  assert.strictEqual(other.status, 'not_allowed');
  assert.strictEqual(other.reason, 'not_this_case');
  assert.strictEqual(await attempts(2143), 0);
  pass('another solicitud is refused and writes nothing');

  await db.exec('BEGIN');
  const wrong = await claim(2056, 50562896);
  await fin1(wrong.id, 'unknown', 401, null, 'elm_http_auth_rejected', '{"error":{"code":"INVALID_LOGIN"}}');
  const refusedHttp = await retry(2056, 1);
  assert.strictEqual(refusedHttp.status, 'not_allowed');
  assert.strictEqual(refusedHttp.reason, 'not_module_missing');
  assert.strictEqual(await attempts(2056), 0);
  await db.exec('ROLLBACK');
  pass('HTTP 401 on CZ 2056 is refused and archives nothing');

  await db.exec('BEGIN');
  const missingLock = await claim(2056, 50562896);
  await fin1(missingLock.id, 'unknown', 400, null, 'elm_http_error', MODULE_BODY);
  await db.exec('ALTER TABLE public.elm_ci_send_locks DISABLE TRIGGER USER');
  await db.query(
    "UPDATE public.elm_ci_send_locks SET state = 'released', released_at = now(), settle_reason = 'not_received' WHERE cz_solicitud_id = 2056",
  );
  await db.exec('ALTER TABLE public.elm_ci_send_locks ENABLE TRIGGER USER');
  const noLock = await retry(2056, 1);
  assert.strictEqual(noLock.status, 'not_allowed');
  assert.strictEqual(noLock.reason, 'lock_not_reserved');
  assert.strictEqual(await attempts(2056), 0);
  const stillUnknown = await one('SELECT s1_status, s1_attempts FROM public.elm_lead_processes WHERE cz_solicitud_id = 2056');
  assert.strictEqual(stillUnknown.s1_status, 'unknown');
  assert.strictEqual(Number(stillUnknown.s1_attempts), 1);
  await db.exec('ROLLBACK');
  pass('CZ 2056 without the reserved lock is refused');

  const seeded = await claim(2056, 50562896);
  await fin1(seeded.id, 'unknown', 400, null, 'elm_http_error', MODULE_BODY);
  const beforeLocks = await locks(2056);
  assert.strictEqual(beforeLocks.length, 1);
  assert.strictEqual(beforeLocks[0].state, 'reserved');
  await db.exec('ALTER TABLE public.elm_ci_send_locks DISABLE TRIGGER USER');
  await db.query(
    "INSERT INTO public.elm_ci_send_locks (ci, month_key, cz_solicitud_id, trigger_origin, state, blocks_future, settle_reason, released_at) VALUES (50562896, '2026-10-01', 2056, 'cz_automatic', 'released', false, 'not_received', now())",
  );
  await db.exec('ALTER TABLE public.elm_ci_send_locks ENABLE TRIGGER USER');
  assert.strictEqual((await locks(2056)).length, 2);
  const stale = await retry(2056, 9);
  assert.strictEqual(stale.status, 'stale');
  assert.strictEqual(await attempts(2056), 0);

  const out = await retry(2056, 1);
  assert.strictEqual(out.status, 'retried');
  assert.strictEqual(out.process.id, seeded.id);
  assert.strictEqual(out.process.s1_status, 'in_flight');
  assert.strictEqual(Number(out.process.s1_attempts), 2);
  assert.strictEqual(out.process.s2_status, 'not_started');
  assert.deepStrictEqual(out.process.s1_request, JSON.parse(REQ));
  assert.strictEqual(out.process.s1_response, null);
  assert.strictEqual(out.lock.status, 'held');
  assert.strictEqual(out.lock.state, 'reserved');
  assert.strictEqual(out.lock.lock_id, beforeLocks[0].id);
  const afterLocks = (await locks(2056)).filter((l) => l.state === 'reserved');
  assert.strictEqual(afterLocks.length, 1);
  assert.strictEqual(afterLocks[0].id, beforeLocks[0].id);
  assert.strictEqual((await locks(2056)).filter((l) => l.state === 'released').length, 1);
  const archived = await one(
    'SELECT status, attempt_no, http_status, error_code, response::text AS response FROM public.elm_step_attempts WHERE cz_solicitud_id = 2056',
  );
  assert.strictEqual(archived.status, 'unknown');
  assert.strictEqual(Number(archived.attempt_no), 1);
  assert.strictEqual(Number(archived.http_status), 400);
  assert.ok(archived.response.indexOf('MODULE_DOES_NOT_EXIST') !== -1);
  const audit = await one(
    "SELECT action, detail->>'kind' AS kind FROM public.elm_ops_audit_events WHERE cz_solicitud_id = 2056 AND action = 'retried'",
  );
  assert.strictEqual(audit.kind, 's1_module_missing');
  const again = await retry(2056, 2);
  assert.strictEqual(again.status, 'not_allowed');
  assert.strictEqual(again.reason, 'not_module_missing');
  assert.strictEqual(await attempts(2056), 1);
  pass('CZ 2056 reuses the same process, frozen request and reserved lock; the unknown attempt stays archived');

  const prior = await claim(1498, 35027627);
  await fin1(prior.id, 'unknown', 200, 'Repetido. Rechazado', 'elm_response_undocumented', '{"result":"Repetido. Rechazado","success":false}');
  const priorLock = (await locks(1498))[0];
  assert.strictEqual(priorLock.state, 'reserved');
  const row = await one('SELECT id, updated_at, s1_result_message FROM public.elm_lead_processes WHERE cz_solicitud_id = 1498');
  const resolved = await val(
    'SELECT public.elm_resolve_process($1, $2::timestamptz, $3, $4, $5, $6) AS r',
    [row.id, row.updated_at, 'provider_confirmed_no_referral', NOTE, actor, 'none'],
  );
  assert.strictEqual(resolved.status, 'resolved');
  assert.strictEqual(resolved.cz_event, null);
  const after = await one(
    'SELECT s1_status, s1_result_message, ops_resolution_code FROM public.elm_lead_processes WHERE cz_solicitud_id = 1498',
  );
  assert.strictEqual(after.s1_status, 'unknown');
  assert.strictEqual(after.s1_result_message, 'Repetido. Rechazado');
  assert.strictEqual(after.ops_resolution_code, 'provider_confirmed_no_referral');
  const consumed = (await locks(1498))[0];
  assert.strictEqual(consumed.id, priorLock.id);
  assert.strictEqual(consumed.state, 'consumed');
  assert.strictEqual(consumed.blocks_future, false);
  assert.strictEqual(consumed.settle_reason, 'received');
  const events = await svc('SELECT count(*)::int AS n FROM public.provider_cz_events WHERE cz_solicitud_id = 1498');
  assert.strictEqual(events.rows[0].n, 0);
  const next = await val(
    'SELECT public.elm_ci_lock_try($1, $2, $3, $4, $5) AS r',
    [35027627, 2149, null, 'cz_automatic', null],
  );
  assert.strictEqual(next.status, 'blocked');
  assert.strictEqual(next.block, 'monthly_quota_used');
  assert.strictEqual(Number(next.related_cz_solicitud_id), 1498);
  const created = await one('SELECT count(*)::int AS n FROM public.elm_lead_processes WHERE cz_solicitud_id = 2149');
  assert.strictEqual(created.n, 0);
  pass('CZ 1498 resolution consumes the October lock without changing the rejection; CZ 2149 is not sent');

  console.log('\n' + groups + ' groups passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
