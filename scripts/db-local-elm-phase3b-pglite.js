'use strict';

/**
 * Fase 3B — LOCAL database test of migrations/20261009_elm_phase3b_operations.sql
 * (applied on top of 1A + 1B + 3A).
 *
 * DB CLASSIFICATION: LOCAL. In-process, in-memory PGlite. Never reads SUPABASE_* env vars and
 * never opens a network connection. PGLITE_DIR as in db-local-elm-lead-processes-pglite.js.
 *
 * NOT covered here: truly concurrent transactions (PGlite is a single connection). Row locks
 * (FOR UPDATE) and optimistic versions are executed sequentially; concurrent retry/resolution
 * safety rests on those locks + the conditional checks exercised below.
 *
 * Run: node scripts/db-local-elm-phase3b-pglite.js
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
const MIG_3B = MIG('20261009_elm_phase3b_operations.sql');

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

const HASH = crypto.createHash('sha256').update('a').digest('hex');
const SNAP = JSON.stringify({ v: 1, applicant: { ci: '1' } });
const REQ = JSON.stringify({ docNumber: '12345678', source: 'copanel', testInternalId: '1' });
const NOTE = 'ELM confirmó por mail el cierre del caso';
const BCU = 'elm_provider_bcu_error';

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

  async function claimProc(czId, ci, lease, origin) {
    const r = await one(
      'SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) AS r',
      [czId, ci, 'copanel', 'cz_automatic', null, 6, 'LRW-' + czId, REQ, lease || 300, origin == null ? null : origin],
    );
    return r.r;
  }
  const finishS1 = (id, status, code) =>
    svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [id, status, '{"r":1}', 200, 'msg', 5, code || null, null]);
  const finishS2 = (id, status, code) =>
    svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [id, status, '{"r":2}', 200, 'msg', 5, code || null, null]);
  const beginS2 = (czId) => svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [czId, '{"docNumber":"1","source":"copanel"}', 300]);
  const retry = (czId, step, expected, max, safe) =>
    svc('SELECT * FROM public.elm_retry_step($1, $2, $3, $4, $5::text[], $6)', [czId, step, expected, max, safe, 300]);
  const proc = (czId) => one('SELECT *, updated_at::text AS version FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId]);
  const resolve = async (id, version, code, note, actor) =>
    (await one('SELECT public.elm_resolve_process($1, $2::timestamptz, $3, $4, $5) AS r', [id, version, code, note, actor])).r;

  await db.exec(STUBS);
  await db.exec(fs.readFileSync(MIG_1A, 'utf8'));
  await db.exec(fs.readFileSync(MIG_1B, 'utf8'));
  await db.exec(fs.readFileSync(MIG_3A, 'utf8'));

  // A process created before 3B (9-arg claim of 1A), to check the backfill.
  const pre = await one(
    'SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) AS r',
    [1, 11111111, 'TestBrand', 'cz_automatic', null, 6, 'LRW-1', REQ, 300],
  );
  await finishS1(pre.r.process.id, 'eligible');
  await beginS2(1);

  const sql3b = fs.readFileSync(MIG_3B, 'utf8');
  await db.exec(sql3b);
  await db.exec(sql3b);
  const p1 = await proc(1);
  assert.strictEqual(p1.s1_attempts, 1);
  assert.strictEqual(p1.s2_attempts, 1);
  assert.strictEqual(p1.commercial_origin, null);
  pass('3B migration applies twice (idempotent) on 1A+1B+3A; pre-existing steps backfilled to 1 attempt');

  const claimSigs = await db.query("SELECT pronargs FROM pg_proc WHERE proname = 'elm_claim_process'");
  assert.deepStrictEqual(claimSigs.rows.map((r) => r.pronargs), [10]);
  const finSigs = await db.query("SELECT pronargs FROM pg_proc WHERE proname = 'provider_fallback_finalize'");
  assert.deepStrictEqual(finSigs.rows.map((r) => r.pronargs), [9]);
  pass('old overloads dropped: elm_claim_process(10 args), provider_fallback_finalize(9 args) only');

  // Access
  for (const t of ['elm_step_attempts', 'elm_ops_audit_events', 'provider_review_cases']) {
    const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || $1)::regclass", [t]);
    assert.strictEqual(rls.rows[0].relrowsecurity, true, t + ' rls');
    const pol = await db.query('SELECT count(*)::int AS n FROM pg_policies WHERE tablename = $1', [t]);
    assert.strictEqual(pol.rows[0].n, 0, t + ' policies');
    for (const role of ['anon', 'authenticated']) {
      await expectSqlError(() => asRole(role, () => db.query('SELECT * FROM public.' + t)), /permission denied/, role + ' ' + t);
    }
  }
  for (const role of ['anon', 'authenticated']) {
    await expectSqlError(() => asRole(role, () => db.query("SELECT * FROM public.elm_retry_step(1, 's1', 1, 3, '{}', 60)")), /permission denied/, role + ' retry');
    await expectSqlError(
      () => asRole(role, () => db.query("SELECT public.elm_resolve_process(gen_random_uuid(), now(), 'other', 'xxxxxxxxxxxx', gen_random_uuid())")),
      /permission denied/,
      role + ' resolve',
    );
    await expectSqlError(() => asRole(role, () => db.query('SELECT public.provider_review_assign(gen_random_uuid(), 1, null, gen_random_uuid())')), /permission denied/, role + ' assign');
  }
  await expectSqlError(() => svc('UPDATE public.elm_ops_audit_events SET action = action'), /permission denied/, 'svc audit update');
  await expectSqlError(() => svc('DELETE FROM public.elm_step_attempts'), /permission denied/, 'svc attempts delete');
  await expectSqlError(() => svc('DELETE FROM public.provider_review_cases'), /permission denied/, 'svc cases delete');
  pass('access: RLS on, 0 policies, anon/authenticated denied; service_role cannot UPDATE/DELETE audit or attempts, nor DELETE cases');

  // commercial_origin: tracking only, immutable
  const pc = await claimProc(5, 55555555, 300, '  BASE SMS 1 ');
  assert.strictEqual(pc.process.commercial_origin, 'BASE SMS 1');
  assert.strictEqual(pc.process.source_brand, 'copanel');
  assert.strictEqual(pc.process.s1_attempts, 1);
  assert.strictEqual((await claimProc(6, 66666666)).process.commercial_origin, null, 'organic: NULL, not blocked');
  await expectSqlError(() => db.query("UPDATE public.elm_lead_processes SET commercial_origin = 'X' WHERE cz_solicitud_id = 5"), /immutable/, 'origin immutable');
  pass('claim: source copanel + separate commercial_origin (organic NULL), immutable, attempt 1');

  // Retry S1 technical_error
  const p10 = (await claimProc(10, 10101010)).process;
  await finishS1(p10.id, 'technical_error', BCU);
  assert.strictEqual((await retry(10, 's1', 1, 3, [])).rows.length, 0, 'empty safe list → never');
  assert.strictEqual((await retry(10, 's1', 1, 3, ['other_code'])).rows.length, 0, 'code not proven safe');
  assert.strictEqual((await retry(10, 's1', 0, 3, [BCU])).rows.length, 0, 'stale expected attempts');
  assert.strictEqual((await retry(10, 's1', 1, 1, [BCU])).rows.length, 0, 'limit reached');
  const r10 = (await retry(10, 's1', 1, 3, [BCU])).rows;
  assert.strictEqual(r10.length, 1);
  assert.strictEqual(r10[0].s1_status, 'in_flight');
  assert.strictEqual(r10[0].s1_attempts, 2);
  assert.strictEqual(r10[0].s1_error_code, null);
  assert.strictEqual(r10[0].s1_response, null);
  assert.deepStrictEqual(r10[0].s1_request, JSON.parse(REQ), 'same frozen request');
  assert.strictEqual((await retry(10, 's1', 1, 3, [BCU])).rows.length, 0, 'concurrent/duplicate retry is a no-op');
  const arch = await db.query('SELECT * FROM public.elm_step_attempts WHERE cz_solicitud_id = 10');
  assert.strictEqual(arch.rows.length, 1);
  assert.strictEqual(arch.rows[0].attempt_no, 1);
  assert.strictEqual(arch.rows[0].error_code, BCU);
  await finishS1(p10.id, 'technical_error', BCU);
  await finishS1(p10.id, 'technical_error', BCU);
  assert.strictEqual((await retry(10, 's1', 2, 3, [BCU])).rows[0].s1_attempts, 3);
  await finishS1(p10.id, 'technical_error', BCU);
  assert.strictEqual((await retry(10, 's1', 3, 3, [BCU])).rows.length, 0, 'exhausted at max');
  await expectSqlError(() => db.query('UPDATE public.elm_step_attempts SET error_code = null'), /append-only/, 'attempts append-only');
  pass('retry S1: only proven-safe code, expected attempts, below max; same request; attempt archived; duplicate no-op');

  // unknown never retried; guard enforces attempts
  const p11 = (await claimProc(11, 11111112)).process;
  await finishS1(p11.id, 'unknown', BCU);
  assert.strictEqual((await retry(11, 's1', 1, 3, [BCU, 'elm_in_flight_lease_expired'])).rows.length, 0, 'unknown never retried');
  await expectSqlError(
    () => db.query("UPDATE public.elm_lead_processes SET s1_status = 'in_flight', s1_attempts = 2, s1_lease_expires_at = now() + interval '1 minute' WHERE cz_solicitud_id = 11"),
    /elm_illegal_s1_transition/,
    'unknown → in_flight forbidden',
  );
  await expectSqlError(
    () => db.query("UPDATE public.elm_lead_processes SET s1_status = 'in_flight', s1_lease_expires_at = now() + interval '1 minute', s1_error_code = null WHERE cz_solicitud_id = 10"),
    /attempt_must_increment|result is frozen|illegal/,
    'retry without increment',
  );
  await expectSqlError(() => db.query('UPDATE public.elm_lead_processes SET s1_attempts = 9 WHERE cz_solicitud_id = 11'), /attempts_only_change_on_start/, 'attempts immutable');
  pass('unknown is never retried (RPC + guard); attempts only change by +1 on entering in_flight');

  // Retry S2
  const p12 = (await claimProc(12, 12121212)).process;
  await finishS1(p12.id, 'eligible');
  const b12 = (await beginS2(12)).rows[0];
  assert.strictEqual(b12.s2_attempts, 1);
  await finishS2(p12.id, 'technical_error', BCU);
  const r12 = (await retry(12, 's2', 1, 3, [BCU])).rows[0];
  assert.strictEqual(r12.s2_status, 'in_flight');
  assert.strictEqual(r12.s2_attempts, 2);
  assert.deepStrictEqual(r12.s2_request, b12.s2_request);
  await finishS2(p12.id, 'referred');
  assert.ok((await proc(12)).referred_at);
  pass('retry S2: same frozen request, attempts 2, then referred');

  // Manual resolution of an active referral
  const users = await db.query('INSERT INTO public.dashboard_users (id) SELECT gen_random_uuid() FROM generate_series(1, 3) RETURNING id');
  const [U1, U2, U3] = users.rows.map((r) => r.id);
  const v12 = (await proc(12)).version;
  assert.strictEqual((await resolve(p12.id, '2020-01-01T00:00:00Z', 'provider_closed_no_loan', NOTE, U1)).status, 'stale');
  assert.strictEqual((await resolve(p12.id, v12, 'provider_closed_no_loan', 'corta', U1)).status, 'note_required');
  assert.strictEqual((await resolve(p12.id, v12, 'provider_confirmed_no_referral', NOTE, U1)).status, 'invalid_resolution');
  assert.strictEqual((await resolve(p12.id, v12, 'provider_loan_disbursed', NOTE, U1)).status, 'evidence_required', 'no GRANTED without postback evidence');
  assert.strictEqual((await resolve(crypto.randomUUID(), v12, 'other', NOTE, U1)).status, 'not_found');
  await expectSqlError(() => resolve(p12.id, v12, 'other', NOTE, null), /elm_ops_actor_required/, 'actor required');
  // A postback after the operator loaded the row makes the action stale.
  await db.query("UPDATE public.elm_lead_processes SET provider_status = 'Latente', provider_status_at = now() WHERE cz_solicitud_id = 12");
  assert.strictEqual((await resolve(p12.id, v12, 'provider_closed_no_loan', NOTE, U1)).status, 'stale', 'race with postback → stale');
  const before12 = await proc(12);
  const res12 = await resolve(p12.id, before12.version, 'provider_closed_no_loan', NOTE, U1);
  assert.strictEqual(res12.status, 'resolved');
  assert.strictEqual(res12.kind, 'referral');
  const after12 = await proc(12);
  assert.strictEqual(after12.ops_resolution_code, 'provider_closed_no_loan');
  assert.strictEqual(after12.ops_resolved_by, U1);
  assert.strictEqual(after12.s2_status, 'referred', 'ELM state untouched');
  assert.strictEqual(after12.disbursed_at, null, 'never GRANTED by resolution');
  assert.strictEqual(after12.provider_status, 'Latente');
  assert.strictEqual((await resolve(p12.id, after12.version, 'other', NOTE, U1)).status, 'already_resolved');
  const audit = await db.query("SELECT * FROM public.elm_ops_audit_events WHERE entity_type = 'elm_process' AND entity_id = $1", [p12.id]);
  assert.strictEqual(audit.rows.length, 1);
  assert.strictEqual(audit.rows[0].actor_user_id, U1);
  assert.strictEqual(audit.rows[0].detail.resolution_code, 'provider_closed_no_loan');
  assert.strictEqual(audit.rows[0].detail.note, NOTE);
  await expectSqlError(() => db.query("UPDATE public.elm_lead_processes SET ops_resolution_code = 'other' WHERE cz_solicitud_id = 12"), /elm_ops_resolution_immutable/, 'resolution immutable');
  await db.query("UPDATE public.elm_lead_processes SET provider_status = 'Rechazado', provider_status_at = now() WHERE cz_solicitud_id = 12");
  assert.strictEqual((await proc(12)).ops_resolution_code, 'provider_closed_no_loan', 'later postbacks still recorded; resolution kept');
  await expectSqlError(() => db.query('DELETE FROM public.elm_ops_audit_events'), /append-only/, 'audit append-only');
  pass('resolve referral: note, code by state, evidence for disbursed, stale on concurrent postback, audited, once, state untouched');

  // Direct writes cannot bypass the rules
  await expectSqlError(
    () => db.query("UPDATE public.elm_lead_processes SET ops_resolution_code = 'other', ops_resolution_note = $1, ops_resolved_at = now() WHERE cz_solicitud_id = 10", [NOTE]),
    /elm_ops_resolution_not_applicable/,
    'not applicable on technical_error/in_flight',
  );
  await finishS1(p10.id, 'technical_error', BCU);
  await expectSqlError(
    () => db.query("UPDATE public.elm_lead_processes SET ops_resolution_code = 'other', ops_resolution_note = $1, ops_resolved_at = now(), provider_status = 'Convertido' WHERE cz_solicitud_id = 12", [NOTE]),
    /elm_ops_resolution_immutable/,
    'already resolved',
  );
  const p13 = (await claimProc(13, 13131313)).process;
  await finishS1(p13.id, 'eligible');
  await beginS2(13);
  await finishS2(p13.id, 'referred');
  await expectSqlError(
    () => db.query("UPDATE public.elm_lead_processes SET ops_resolution_code = 'other', ops_resolution_note = $1, ops_resolved_at = now(), disbursed_at = now() WHERE cz_solicitud_id = 13", [NOTE]),
    /elm_ops_resolution_must_not_change_state|granted/,
    'resolution cannot set GRANTED',
  );
  await expectSqlError(
    () => db.query("UPDATE public.elm_lead_processes SET ops_resolution_code = 'other', ops_resolution_note = 'corta', ops_resolved_at = now() WHERE cz_solicitud_id = 13"),
    /ops_resolution_check/,
    'note length enforced by constraint',
  );
  pass('guard: resolution only for referral/unknown, never with state/GRANTED changes, note ≥ 10 chars');

  // s1 unknown resolution + in_flight refused + expired in_flight path
  const v11 = (await proc(11)).version;
  assert.strictEqual((await resolve(p11.id, v11, 'provider_loan_disbursed', NOTE, U2)).status, 'invalid_resolution');
  assert.strictEqual((await resolve(p11.id, v11, 'provider_confirmed_not_received', NOTE, U2)).status, 'resolved');
  const p14 = (await claimProc(14, 14141414, 1)).process;
  const v14 = (await proc(14)).version;
  assert.strictEqual((await resolve(p14.id, v14, 'other', NOTE, U2)).status, 'in_flight', 'live or expired-not-persisted in_flight refused');
  await sleep(1100);
  await svc('SELECT * FROM public.elm_expire_stale_in_flight($1)', [14]);
  const e14 = await proc(14);
  assert.strictEqual(e14.s1_status, 'unknown');
  assert.strictEqual((await resolve(p14.id, v14, 'other', NOTE, U2)).status, 'stale', 'expiry bumps the version');
  assert.strictEqual((await resolve(p14.id, e14.version, 'provider_confirmed_no_referral', NOTE, U2)).status, 'resolved');
  pass('resolve unknown: codes by step, in_flight refused, expired lease → unknown first (new version) → resolved');

  const p15 = (await claimProc(15, 15151515)).process;
  await finishS1(p15.id, 'eligible');
  assert.strictEqual((await resolve(p15.id, (await proc(15)).version, 'other', NOTE, U3)).status, 'not_resolvable');
  await finishS1(p10.id, 'technical_error', BCU);
  assert.strictEqual((await resolve(p10.id, (await proc(10)).version, 'other', NOTE, U3)).status, 'not_resolvable', 'technical_error goes through retry/review, not resolution');
  pass('not resolvable: S1 eligible without S2, technical_error');

  // Finalize creates the review case atomically
  const enqueue = async (czId, ci) =>
    (await one('SELECT public.provider_fallback_enqueue($1, $2, $3::jsonb, $4) AS r', [czId, ci, SNAP, HASH])).r;
  const claimJob = async (czId) =>
    (await svc('SELECT * FROM public.provider_fallback_claim($1, $2, $3, $4)', ['w', 600, 10, czId])).rows[0];
  const finalize = (id, outcome, reason, prio, due, processId) =>
    svc('SELECT * FROM public.provider_fallback_finalize($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)', [
      id, 'w', outcome, reason, null, processId || null, null, prio == null ? null : prio, due == null ? null : due,
    ]);
  await enqueue(700, 70000000);
  const j700 = await claimJob(700);
  await expectSqlError(() => finalize(j700.id, 'manual_review', 'elm_s1_unknown'), /provider_fallback_review_sla_required/, 'SLA required');
  await expectSqlError(() => finalize(j700.id, 'manual_review', 'elm_s1_unknown', 'nope', 3600), /sla_required/, 'priority validated');
  await expectSqlError(() => finalize(j700.id, 'rejected', 'elm_s1_rejected', 'high', 3600), /sla_only_for_manual_review/, 'SLA only for manual_review');
  assert.strictEqual((await db.query('SELECT outcome FROM public.provider_fallback_requests WHERE cz_solicitud_id = 700')).rows[0].outcome, 'pending', 'nothing finalized on error');
  const f700 = (await finalize(j700.id, 'manual_review', 'elm_s1_unknown', 'high', 7200, p11.id)).rows;
  assert.strictEqual(f700[0].outcome, 'manual_review');
  const cases = await db.query('SELECT *, (due_at - created_at) AS sla FROM public.provider_review_cases WHERE cz_solicitud_id = 700');
  assert.strictEqual(cases.rows.length, 1);
  const c700 = cases.rows[0];
  assert.strictEqual(c700.priority, 'high');
  assert.strictEqual(c700.status, 'open');
  assert.strictEqual(c700.version, 1);
  assert.strictEqual(c700.elm_process_id, p11.id);
  assert.strictEqual(c700.reason_code, 'elm_s1_unknown');
  assert.strictEqual((await finalize(j700.id, 'manual_review', 'elm_s1_unknown', 'high', 7200)).rows.length, 0);
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM public.provider_review_cases')).rows[0].n, 1);
  const created = await db.query("SELECT * FROM public.elm_ops_audit_events WHERE entity_type = 'review_case' AND action = 'created'");
  assert.strictEqual(created.rows.length, 1);
  await enqueue(701, 70100000);
  const j701 = await claimJob(701);
  await finalize(j701.id, 'already_referred', 'ci_active_referral');
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM public.provider_review_cases')).rows[0].n, 1, 'no case for non-review outcomes');
  pass('finalize manual_review: SLA required, case + audit in the same transaction, once; other outcomes never create cases');

  // Review case actions
  const assign = async (id, v, who, actor) => (await one('SELECT public.provider_review_assign($1, $2, $3, $4) AS r', [id, v, who, actor])).r;
  const triage = async (id, v, prio, due, actor) =>
    (await one('SELECT public.provider_review_triage($1, $2, $3, $4::timestamptz, $5) AS r', [id, v, prio, due, actor])).r;
  const resolveCase = async (id, v, code, note, actor) =>
    (await one('SELECT public.provider_review_resolve($1, $2, $3, $4, $5) AS r', [id, v, code, note, actor])).r;
  assert.strictEqual((await assign(c700.id, 9, U2, U1)).status, 'stale');
  assert.deepStrictEqual(await assign(c700.id, 1, U2, U1), { status: 'assigned', version: 2 });
  assert.strictEqual((await assign(c700.id, 1, U3, U1)).status, 'stale', 'second operator with old version');
  assert.deepStrictEqual(await triage(c700.id, 2, 'urgent', '2030-01-01T00:00:00Z', U1), { status: 'triaged', version: 3 });
  assert.strictEqual((await triage(c700.id, 3, 'nope', '2030-01-01T00:00:00Z', U1)).status, 'invalid_triage');
  assert.strictEqual((await resolveCase(c700.id, 3, 'other', 'corta', U2)).status, 'note_required');
  assert.strictEqual((await resolveCase(c700.id, 3, 'approve', NOTE, U2)).status, 'invalid_resolution');
  assert.deepStrictEqual(await resolveCase(c700.id, 3, 'resolved_with_provider', NOTE, U2), { status: 'resolved', version: 4 });
  assert.strictEqual((await resolveCase(c700.id, 4, 'other', NOTE, U2)).status, 'already_resolved');
  assert.strictEqual((await assign(c700.id, 4, U3, U1)).status, 'resolved');
  await expectSqlError(() => one('SELECT public.provider_review_assign($1, 4, null, null) AS r', [c700.id]), /actor_required/, 'actor required');
  const caseAudit = await db.query("SELECT action, actor_user_id FROM public.elm_ops_audit_events WHERE entity_id = $1 ORDER BY created_at, action", [c700.id]);
  assert.deepStrictEqual(caseAudit.rows.map((r) => r.action).sort(), ['assigned', 'created', 'resolved', 'triaged']);
  pass('review case RPCs: optimistic version, stale for concurrent operators, validated, audited, resolved frozen');

  // Guard on review cases
  await expectSqlError(() => db.query("UPDATE public.provider_review_cases SET priority = 'low' WHERE id = $1", [c700.id]), /version must increment/, 'no silent change');
  await expectSqlError(() => db.query("UPDATE public.provider_review_cases SET priority = 'low', version = version + 1 WHERE id = $1", [c700.id]), /frozen/, 'resolved frozen');
  await expectSqlError(() => db.query('DELETE FROM public.provider_review_cases'), /cannot be deleted/, 'no delete');
  await expectSqlError(() => db.query("UPDATE public.provider_review_cases SET reason_code = 'x', version = version + 1 WHERE id = $1", [c700.id]), /immutable/, 'identity immutable');
  await expectSqlError(
    () => db.query("INSERT INTO public.provider_review_cases (fallback_request_id, cz_solicitud_id, ci, reason_code, priority, due_at, status, resolution_code, resolution_note, resolved_at) VALUES ($1, 1, 1, 'x', 'low', now(), 'resolved', 'other', $2, now())", [j701.id, NOTE]),
    /must be open/,
    'insert must be open',
  );
  // ON DELETE SET NULL of a dashboard user keeps working (version unchanged).
  await db.query('DELETE FROM public.dashboard_users WHERE id = $1', [U2]);
  const afterDel = (await db.query('SELECT assigned_to, resolved_by, version FROM public.provider_review_cases WHERE id = $1', [c700.id])).rows[0];
  assert.deepStrictEqual(afterDel, { assigned_to: null, resolved_by: null, version: 4 });
  assert.strictEqual((await proc(11)).ops_resolved_by, null, 'process resolver also SET NULL; resolution kept');
  assert.strictEqual((await proc(11)).ops_resolution_code, 'provider_confirmed_not_received');
  const keptActor = await db.query("SELECT count(*)::int AS n FROM public.elm_ops_audit_events WHERE actor_user_id = $1", [U2]);
  assert.ok(keptActor.rows[0].n >= 2, 'audit keeps the historical actor id after user deletion');
  pass('review case guard: version bump, resolved frozen, no delete, identity immutable, user deletion SET NULL');

  console.log('db-local-elm-phase3b-pglite: ' + groups + ' groups passed (LOCAL PGlite; real concurrency NOT executed)');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
