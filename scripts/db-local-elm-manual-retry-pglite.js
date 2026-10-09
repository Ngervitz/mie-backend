'use strict';

/**
 * LOCAL database test of migrations/20261011_elm_manual_pre_reception_retry.sql
 * (applied on top of 1A + 1B + 3A + 3B + C1).
 *
 * DB CLASSIFICATION: LOCAL. In-process, in-memory PGlite. Never reads SUPABASE_* env vars and
 * never opens a network connection. PGLITE_DIR as in db-local-provider-fallback-c1-pglite.js.
 *
 * Covers: reference case 1430 (S1 403 elm_http_auth_rejected, lock released not_received) →
 * same process, archived attempt, new reservation, audit; every refusal writes nothing;
 * atomicity (a failure at the archive, the process update or the audit leaves no new lock and
 * no partial change); the automatic path (elm_retry_step) is unchanged.
 * Truly concurrent callers: scripts/db-local-provider-fallback-c1-realpg.js.
 *
 * Run: node scripts/db-local-elm-manual-retry-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIG = (name) => path.join(__dirname, '..', 'migrations', name);
const MIGRATIONS = [
  '20261007_elm_lead_processes.sql',
  '20261007_elm_postback_events.sql',
  '20261008_provider_fallback_requests.sql',
  '20261009_elm_phase3b_operations.sql',
  '20261010_provider_fallback_c1_events.sql',
];
const MIG_RETRY = MIG('20261011_elm_manual_pre_reception_retry.sql');

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

const REQ = JSON.stringify({ docNumber: '51001152', source: 'copanel' });
const AUTH_BODY = JSON.stringify({ error: { code: 'INVALID_LOGIN_ATTEMPT' } });
const HASH = crypto.createHash('sha256').update('manual-retry').digest('hex');
const SNAP = JSON.stringify({ v: 1, cz_estado_id: 12, applicant: { ci: '1' } });
const SIG = 'public.elm_manual_retry_s1(bigint,integer,integer,integer,uuid)';

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
  const one = async (sql, params) => (await svc(sql, params)).rows[0];
  const val = async (sql, params) => (await one(sql, params)).r;
  const su = async (sql, params) => (await db.query(sql, params || [])).rows;

  await db.exec(STUBS);
  for (const m of MIGRATIONS) await db.exec(fs.readFileSync(MIG(m), 'utf8'));
  const mig = fs.readFileSync(MIG_RETRY, 'utf8');
  await db.exec(mig);
  await db.exec(mig);
  const actor = (await db.query('INSERT INTO public.dashboard_users DEFAULT VALUES RETURNING id')).rows[0].id;

  const priv = async (role) =>
    (await su('SELECT has_function_privilege($1, $2, $3) AS r', [role, SIG, 'EXECUTE']))[0].r;
  assert.deepStrictEqual([await priv('anon'), await priv('authenticated'), await priv('service_role')], [false, false, true]);
  const sigs = async (name) => (await su('SELECT pronargs FROM pg_proc WHERE proname = $1', [name])).map((r) => r.pronargs);
  assert.deepStrictEqual(await sigs('elm_manual_retry_s1'), [5]);
  assert.deepStrictEqual(await sigs('elm_retry_step'), [6], 'automatic retry RPC untouched');
  pass('migration applies twice (idempotent) on 1A+1B+3A+3B+C1; only service_role may execute elm_manual_retry_s1; elm_retry_step keeps its signature');

  // ------------------------------------------------------------------ helpers
  const claim = async (czId, ci, origin, lease) =>
    (await val('SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) AS r', [
      czId, ci, 'copanel', origin || 'janus_manual', (origin || 'janus_manual') === 'janus_manual' ? actor : null,
      12, 'LRW-' + czId, REQ, lease || 300, null,
    ])).process;
  const fin1 = (id, status, http, code, body) =>
    svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, status, body || '{"r":1}', http, null, 487, code || null, null,
    ]);
  const auth403 = (id) => fin1(id, 'technical_error', 403, 'elm_http_auth_rejected', AUTH_BODY);
  const beginS2 = (czId) => svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [czId, REQ, 300]);
  const fin2 = (id, status) =>
    svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [id, status, '{"r":2}', 200, 'm', 5, null, null]);
  const mretry = (czId, expected, max, user) =>
    val('SELECT public.elm_manual_retry_s1($1, $2, $3, $4, $5) AS r', [czId, expected, max || 3, 300, user === undefined ? actor : user]);
  const workerRetry = (czId, expected, codes) =>
    svc('SELECT * FROM public.elm_retry_step($1, $2, $3, $4, $5::text[], $6)', [czId, 's1', expected, 3, codes || [], 300]);
  const proc = async (czId) => (await su('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId]))[0];
  const locks = (czId) =>
    su('SELECT id, state, settle_reason, trigger_origin, month_key::text AS month FROM public.elm_ci_send_locks WHERE cz_solicitud_id = $1 ORDER BY reserved_at, id', [czId]);
  const archived = (czId) =>
    su('SELECT attempt_no, status, http_status, error_code, response FROM public.elm_step_attempts WHERE cz_solicitud_id = $1 ORDER BY attempt_no', [czId]);
  const audits = (czId) =>
    su("SELECT action, actor_user_id, detail FROM public.elm_ops_audit_events WHERE cz_solicitud_id = $1 AND entity_type = 'elm_process' ORDER BY created_at", [czId]);
  const currentMonth = async () => (await su('SELECT public.elm_month_key(now())::text AS m'))[0].m;
  /** Everything a retry could write, for one CI. */
  const snapshot = async (ci) => ({
    processes: await su('SELECT to_jsonb(p) AS j FROM public.elm_lead_processes p WHERE ci = $1 ORDER BY cz_solicitud_id', [ci]),
    locks: await su('SELECT to_jsonb(l) AS j FROM public.elm_ci_send_locks l WHERE ci = $1 ORDER BY reserved_at, id', [ci]),
    attempts: await su('SELECT to_jsonb(a) AS j FROM public.elm_step_attempts a JOIN public.elm_lead_processes p ON p.id = a.elm_process_id WHERE p.ci = $1 ORDER BY a.attempt_no', [ci]),
    audits: await su("SELECT to_jsonb(e) AS j FROM public.elm_ops_audit_events e JOIN public.elm_lead_processes p ON p.id = e.entity_id WHERE p.ci = $1 AND e.action = 'retried'", [ci]),
  });
  const backdate = async (czId, col, interval) => {
    await db.exec('ALTER TABLE public.elm_lead_processes DISABLE TRIGGER USER');
    try {
      await db.query('UPDATE public.elm_lead_processes SET ' + col + ' = ' + col + ' - $2::interval WHERE cz_solicitud_id = $1', [czId, interval]);
    } finally {
      await db.exec('ALTER TABLE public.elm_lead_processes ENABLE TRIGGER USER');
    }
  };
  /** Refusal: exact status and nothing written for the CI. */
  const refused = async (czId, ci, expected, status, label, extra) => {
    const before = await snapshot(ci);
    const out = await mretry(czId, expected, extra && extra.max);
    assert.strictEqual(out.status, status, label + ' → ' + JSON.stringify(out));
    assert.deepStrictEqual(await snapshot(ci), before, label + ': nothing written');
    return out;
  };

  // ------------------------------------------------------------------ reference case 1430
  const CZ = 1430;
  const CI = 51001152;
  const p0 = await claim(CZ, CI);
  await auth403(p0.id);
  const before = await proc(CZ);
  assert.deepStrictEqual([before.s1_status, before.s1_attempts, before.s1_http_status, before.s1_error_code, before.s2_status],
    ['technical_error', 1, 403, 'elm_http_auth_rejected', 'not_started']);
  assert.deepStrictEqual((await locks(CZ)).map((l) => [l.state, l.settle_reason]), [['released', 'not_received']]);
  assert.deepStrictEqual((await workerRetry(CZ, 1, ['elm_http_auth_rejected'])).rows, [],
    'automatic elm_retry_step still refuses (no live lock), even with the code declared safe');
  assert.deepStrictEqual((await workerRetry(CZ, 1, [])).rows, []);
  assert.strictEqual((await claim(CZ, CI)).id, p0.id, 'a second claim returns the existing process (no new one)');
  pass('case 1430 reproduced: S1 technical_error 403 elm_http_auth_rejected, S2 not_started, lock released not_received; automatic retry and claim refuse');

  const r1 = await mretry(CZ, 1);
  assert.strictEqual(r1.status, 'retried');
  assert.strictEqual(r1.process.id, p0.id, 'same process');
  const after = await proc(CZ);
  assert.deepStrictEqual([after.id, after.s1_status, after.s1_attempts, after.s2_status], [p0.id, 'in_flight', 2, 'not_started']);
  assert.deepStrictEqual(after.s1_request, before.s1_request, 'same frozen S1 request');
  assert.deepStrictEqual([after.s1_http_status, after.s1_error_code, after.s1_response, after.s1_completed_at], [null, null, null, null]);
  assert.ok(after.s1_lease_expires_at, 'lease set');
  assert.strictEqual((await su('SELECT count(*)::int AS n FROM public.elm_lead_processes WHERE ci = $1', [CI]))[0].n, 1);
  const l1 = await locks(CZ);
  assert.deepStrictEqual(l1.map((l) => [l.state, l.settle_reason, l.trigger_origin]),
    [['released', 'not_received', 'janus_manual'], ['reserved', null, 'janus_manual']], 'released kept as history + new reservation');
  assert.strictEqual(l1[1].month, await currentMonth());
  assert.strictEqual(r1.lock.status, 'acquired');
  assert.strictEqual(r1.lock.lock_id, l1[1].id);
  const a1 = await archived(CZ);
  assert.deepStrictEqual(a1.map((a) => [a.attempt_no, a.status, a.http_status, a.error_code]), [[1, 'technical_error', 403, 'elm_http_auth_rejected']]);
  assert.deepStrictEqual(a1[0].response, JSON.parse(AUTH_BODY), 'original answer preserved');
  const au1 = await audits(CZ);
  assert.strictEqual(au1.length, 1);
  assert.deepStrictEqual([au1[0].action, au1[0].actor_user_id, au1[0].detail.step, au1[0].detail.kind, au1[0].detail.archived_attempt, au1[0].detail.attempt, au1[0].detail.lock_status],
    ['retried', actor, 's1', 'pre_reception', 1, 2, 'acquired']);
  pass('1430 retry: same process back to S1 in_flight (attempt 2, same frozen request), attempt 1 archived with the 403 answer, new reservation this month (released lock kept), audit "retried" with the admin');

  const busyStale = await mretry(CZ, 1);
  assert.strictEqual(busyStale.status, 'stale', 'double click with the old attempt count');
  assert.strictEqual((await mretry(CZ, 2)).status, 'not_pre_reception', 'S1 in flight: not retryable');
  assert.strictEqual((await locks(CZ)).length, 2);
  assert.strictEqual((await archived(CZ)).length, 1);
  assert.strictEqual((await audits(CZ)).length, 1);
  pass('replay / double click: stale; while the retry is in flight nothing else is written');

  await auth403(p0.id);
  assert.deepStrictEqual((await locks(CZ)).map((l) => [l.state, l.settle_reason]),
    [['released', 'not_received'], ['released', 'not_received']], 'a new 403 releases the new reservation too (no quota used)');
  assert.strictEqual((await mretry(CZ, 2)).status, 'retried');
  await auth403(p0.id);
  const ex = await refused(CZ, CI, 3, 'attempts_exhausted', 'third failure with max 3');
  assert.ok(ex);
  assert.deepStrictEqual((await archived(CZ)).map((a) => a.attempt_no), [1, 2]);
  assert.strictEqual((await mretry(CZ, 3, 4)).status, 'retried', 'limit comes from the caller (config), max 20');
  pass('repeated 403: every reservation is released (not_received); attempts are capped by p_max_attempts (attempts_exhausted writes nothing)');

  // ------------------------------------------------------------------ outcome of the retried S1 settles the new lock
  const CI2 = 51001153;
  const pE = await claim(1431, CI2);
  await auth403(pE.id);
  assert.strictEqual((await mretry(1431, 1)).status, 'retried');
  await fin1(pE.id, 'eligible', 200, null, '{"result":"Listo para recibir datos en servicio 2"}');
  assert.deepStrictEqual((await locks(1431)).map((l) => l.state), ['released', 'reserved'], 'S1 eligible waiting for S2 keeps the reservation');
  assert.strictEqual((await beginS2(1431)).rows.length, 1, 'S2 can start on the same process');
  await fin2(pE.id, 'referred');
  const lE = (await su("SELECT state, block_reason FROM public.elm_ci_send_locks WHERE cz_solicitud_id = 1431 AND state <> 'released'"))[0];
  assert.deepStrictEqual([lE.state, lE.block_reason], ['consumed', 'active_referral']);

  const CI3 = 51001154;
  const pR = await claim(1432, CI3);
  await auth403(pR.id);
  assert.strictEqual((await mretry(1432, 1)).status, 'retried');
  await fin1(pR.id, 'technical_error', 200, 'elm_provider_bcu_error', '{"result":"BCU error"}');
  assert.deepStrictEqual((await locks(1432)).map((l) => [l.state, l.settle_reason]),
    [['released', 'not_received'], ['consumed', 'received']], 'ELM received the retried lead: quota consumed');
  await refused(1432, CI3, 2, 'not_pre_reception', 'BCU error after the retry (received)');
  pass('after the retry the lock follows the new result: eligible keeps it reserved and S2 runs; referred blocks the CI; a received error consumes it and is no longer manually retryable');

  // ------------------------------------------------------------------ never when ELM may have received the lead
  const CI4 = 51001155;
  const pU = await claim(1440, CI4);
  await fin1(pU.id, 'unknown', null, 'elm_http_timeout', null);
  await refused(1440, CI4, 1, 'not_pre_reception', 'timeout → unknown');

  const CI5 = 51001156;
  const pX = await claim(1441, CI5, 'janus_manual', 1);
  await sleep(1300);
  await svc('SELECT * FROM public.elm_expire_stale_in_flight($1)', [1441]);
  assert.strictEqual((await proc(1441)).s1_status, 'unknown');
  await refused(1441, CI5, 1, 'not_pre_reception', 'expired in_flight (lost answer)');
  assert.ok(pX);

  const CI6 = 51001157;
  await claim(1442, CI6);
  await refused(1442, CI6, 1, 'not_pre_reception', 'S1 still in flight');

  const CI7 = 51001158;
  const pB = await claim(1443, CI7);
  await fin1(pB.id, 'technical_error', 200, 'elm_provider_bcu_error', '{"result":"BCU error"}');
  await refused(1443, CI7, 1, 'not_pre_reception', 'BCU error (explicit ELM answer = received)');

  const CI8 = 51001159;
  const pH = await claim(1444, CI8);
  await fin1(pH.id, 'technical_error', 500, 'elm_http_error', null);
  await refused(1444, CI8, 1, 'not_pre_reception', 'other technical error code');

  const CI9 = 51001160;
  const pZ = await claim(1445, CI9);
  await fin1(pZ.id, 'technical_error', 200, 'elm_http_auth_rejected', null);
  await refused(1445, CI9, 1, 'not_pre_reception', 'auth code without HTTP 401/403');

  const CI10 = 51001161;
  const pJ = await claim(1446, CI10);
  await fin1(pJ.id, 'rejected', 200, null, '{"result":"SCORE BAJO"}');
  await refused(1446, CI10, 1, 'not_pre_reception', 'S1 rejected');

  const CI11 = 51001162;
  const pS = await claim(1447, CI11);
  await fin1(pS.id, 'eligible', 200, null, null);
  await beginS2(1447);
  await svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [pS.id, 'technical_error', null, 403, null, 5, 'elm_http_auth_rejected', null]);
  await refused(1447, CI11, 1, 'not_pre_reception', 'S2 technical error (S1 was received)');

  // History: an earlier received error (BCU, consumed lock) followed by a 403 is not pre-reception.
  const CI12 = 51001163;
  const pM = await claim(1448, CI12);
  await fin1(pM.id, 'technical_error', 200, 'elm_provider_bcu_error', '{"result":"BCU error"}');
  await backdate(1448, 's1_completed_at', '25 hours');
  assert.strictEqual((await workerRetry(1448, 1, [])).rows.length, 1, 'BCU automatic retry (existing C1 rule)');
  await auth403(pM.id);
  assert.deepStrictEqual((await locks(1448)).map((l) => l.state), ['consumed']);
  await refused(1448, CI12, 2, 'not_pre_reception', 'archived received attempt + consumed lock');
  pass('refused, nothing written: timeout/unknown, expired in_flight, in flight, BCU error, other error codes, auth code without 401/403, S1 rejected, S2 technical error, history with a received attempt');

  const CI13 = 51001164;
  const pA = await claim(1449, CI13, 'cz_automatic');
  await auth403(pA.id);
  const na = await refused(1449, CI13, 1, 'not_allowed', 'cz_automatic origin');
  assert.strictEqual(na.reason, 'automatic_origin');

  const CI14 = 51001165;
  const pF = await claim(1450, CI14);
  await auth403(pF.id);
  await val('SELECT public.provider_fallback_enqueue($1, $2, $3::jsonb, $4) AS r', [1450, CI14, SNAP, HASH]);
  assert.strictEqual((await refused(1450, CI14, 1, 'not_allowed', 'solicitud with a CZ fallback request')).reason, 'automatic_origin');

  const CI15 = 51001166;
  const pO = await claim(1451, CI15);
  await auth403(pO.id);
  await db.exec('ALTER TABLE public.elm_lead_processes DISABLE TRIGGER USER');
  await db.query("UPDATE public.elm_lead_processes SET ops_resolution_code = 'other', ops_resolution_note = 'Cerrado por operaciones', ops_resolved_by = $2, ops_resolved_at = now() WHERE cz_solicitud_id = $1", [1451, actor]);
  await db.exec('ALTER TABLE public.elm_lead_processes ENABLE TRIGGER USER');
  assert.strictEqual((await refused(1451, CI15, 1, 'not_allowed', 'resolved by operations')).reason, 'ops_resolved');

  await refused(1430, CI, 1, 'stale', 'wrong expected attempt count');
  assert.deepStrictEqual(await mretry(999999, 1), { status: 'not_found' });
  await expectSqlError(() => mretry(1450, 1, 3, null), /elm_ops_actor_required/, 'actor required');
  await expectSqlError(() => mretry(1450, 1, 21), /elm_invalid_max_attempts/, 'max attempts bounded');
  await expectSqlError(() => mretry(1450, 0), /elm_invalid_expected_attempts/, 'expected attempts >= 1');
  await expectSqlError(
    () => asRole('authenticated', () => db.query('SELECT public.elm_manual_retry_s1($1, $2, $3, $4, $5)', [1450, 1, 3, 300, actor])),
    /permission denied/,
    'authenticated cannot execute',
  );
  pass('not allowed: cz_automatic process, solicitud with a fallback request, resolved by operations; stale / not_found / invalid args; authenticated role denied');

  // ------------------------------------------------------------------ CI controls (same as a first send)
  const CIa = 51002001;
  const pa = await claim(1460, CIa);
  await auth403(pa.id);
  await claim(1461, CIa);
  const bInProgress = await refused(1460, CIa, 1, 'blocked', 'another solicitud of the CI in flight');
  assert.deepStrictEqual([bInProgress.lock.block, Number(bInProgress.lock.related_cz_solicitud_id)], ['send_in_progress', 1461]);

  const CIb = 51002002;
  const pb = await claim(1462, CIb);
  await auth403(pb.id);
  const pb2 = await claim(1463, CIb);
  await fin1(pb2.id, 'eligible', 200, null, null);
  await beginS2(1463);
  await fin2(pb2.id, 'referred');
  assert.strictEqual((await refused(1462, CIb, 1, 'blocked', 'active referral of the CI')).lock.block, 'active_referral');

  const CIc = 51002003;
  const pc = await claim(1464, CIc);
  await auth403(pc.id);
  const pc2 = await claim(1465, CIc);
  await fin1(pc2.id, 'rejected', 200, null, '{"result":"SCORE BAJO"}');
  assert.strictEqual((await refused(1464, CIc, 1, 'blocked', 'monthly quota used by another solicitud')).lock.block, 'monthly_quota_used');

  const CId = 51002004;
  const pd = await claim(1466, CId);
  await auth403(pd.id);
  const pd2 = await claim(1467, CId);
  await fin1(pd2.id, 'unknown', null, 'elm_http_timeout', null);
  assert.strictEqual((await refused(1466, CId, 1, 'blocked', 'uncertain result of another solicitud')).lock.block, 'uncertain');
  pass('CI controls reused (elm_ci_lock_try): send in progress, active referral, monthly quota, uncertain result → blocked, nothing written');

  // ------------------------------------------------------------------ atomicity
  const CIx = 51003001;
  const px = await claim(1470, CIx);
  await auth403(px.id);
  const failAt = async (table, when, label) => {
    await db.exec(`CREATE OR REPLACE FUNCTION public._test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test_injected_failure'; END; $$;`);
    await db.exec(`CREATE TRIGGER _test_fail BEFORE ${when} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public._test_fail()`);
    const snap = await snapshot(CIx);
    try {
      await expectSqlError(() => mretry(1470, 1), /test_injected_failure/, label);
    } finally {
      await db.exec(`DROP TRIGGER _test_fail ON public.${table}`);
    }
    assert.deepStrictEqual(await snapshot(CIx), snap, label + ': full rollback');
    const live = await su("SELECT count(*)::int AS n FROM public.elm_ci_send_locks WHERE ci = $1 AND state <> 'released'", [CIx]);
    assert.strictEqual(live[0].n, 0, label + ': no new reservation left behind');
  };
  await failAt('elm_step_attempts', 'INSERT', 'failure archiving the attempt (lock already reserved)');
  await failAt('elm_lead_processes', 'UPDATE', 'failure updating the process');
  await failAt('elm_ops_audit_events', 'INSERT', 'failure writing the audit (last step)');
  const ok = await mretry(1470, 1);
  assert.strictEqual(ok.status, 'retried', 'after the failures the retry still works');
  assert.deepStrictEqual((await locks(1470)).map((l) => l.state), ['released', 'reserved']);
  assert.strictEqual((await archived(1470)).length, 1);
  assert.strictEqual((await audits(1470)).length, 1);
  pass('atomic: an injected failure after the reservation (archive), at the process update or at the audit rolls everything back (no new lock, no archived attempt, process unchanged); a later retry succeeds once');

  console.log('\n' + groups + ' groups passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
