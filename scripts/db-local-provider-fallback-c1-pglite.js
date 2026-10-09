'use strict';

/**
 * C1 — LOCAL database test of migrations/20261010_provider_fallback_c1_events.sql
 * (applied on top of 1A + 1B + 3A + 3B).
 *
 * DB CLASSIFICATION: LOCAL. In-process, in-memory PGlite. Never reads SUPABASE_* env vars and
 * never opens a network connection. PGLITE_DIR as in db-local-elm-lead-processes-pglite.js.
 *
 * NOT covered here: truly concurrent transactions (PGlite is a single connection). Same-CI
 * concurrency rests on pg_advisory_xact_lock per CI inside acquire/settle plus the unique partial
 * indexes; this file proves the indexes reject every duplicate a race could produce and that a
 * second acquire for the same CI is refused while the first reservation is open. Real
 * multi-connection races: scripts/db-local-provider-fallback-c1-realpg.js.
 *
 * Run: node scripts/db-local-provider-fallback-c1-pglite.js
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
];
const MIG_C1 = MIG('20261010_provider_fallback_c1_events.sql');

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

const HASH = crypto.createHash('sha256').update('c1').digest('hex');
const SNAP = JSON.stringify({ v: 1, cz_estado_id: 12, applicant: { ci: '1' } });
const REQ = JSON.stringify({ docNumber: '1', source: 'copanel' });
const NOTE = 'Operaciones verificó el caso con ELM por mail';

// Instants around Uruguay month boundaries (UTC-3, no DST).
const OCT = '2026-10-15T12:00:00-03:00';
const NOV = '2026-11-15T12:00:00-03:00';
const DEC = '2026-12-15T12:00:00-03:00';

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

  await db.exec(STUBS);
  for (const m of MIGRATIONS) await db.exec(fs.readFileSync(MIG(m), 'utf8'));
  const c1 = fs.readFileSync(MIG_C1, 'utf8');
  await db.exec(c1);
  await db.exec(c1);
  const actor = (await db.query('INSERT INTO public.dashboard_users DEFAULT VALUES RETURNING id')).rows[0].id;

  const finSigs = await db.query("SELECT pronargs FROM pg_proc WHERE proname = 'provider_fallback_finalize'");
  assert.deepStrictEqual(finSigs.rows.map((r) => r.pronargs), [9]);
  const resSigs = await db.query("SELECT pronargs FROM pg_proc WHERE proname = 'provider_review_resolve'");
  assert.deepStrictEqual(resSigs.rows.map((r) => r.pronargs), [6]);
  const sigs = async (name) => (await db.query('SELECT pronargs FROM pg_proc WHERE proname = $1', [name])).rows.map((r) => r.pronargs);
  assert.deepStrictEqual(await sigs('elm_resolve_process'), [6]);
  assert.deepStrictEqual(await sigs('elm_claim_process'), [10]);
  assert.deepStrictEqual(await sigs('elm_retry_step'), [6]);
  pass('C1 migration applies twice (idempotent) on 1A+1B+3A+3B; finalize 9 args; review_resolve / elm_resolve_process only 6 args; claim / retry keep their signature');

  // ------------------------------------------------------------------ helpers
  const enqueue = async (czId, ci) =>
    (await val('SELECT public.provider_fallback_enqueue($1, $2, $3::jsonb, $4) AS r', [czId, ci, SNAP, HASH])).request;
  const claim = async (czId) =>
    (await svc('SELECT * FROM public.provider_fallback_claim($1, $2, $3, $4)', ['w', 600, 10, czId])).rows[0];
  const finalize = async (reqId, outcome, reason, processId, related) => {
    const manual = outcome === 'manual_review';
    return (await svc('SELECT * FROM public.provider_fallback_finalize($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)', [
      reqId, 'w', outcome, reason, null, processId || null, related || null,
      manual ? 'normal' : null, manual ? 3600 : null,
    ])).rows[0];
  };
  const job = async (czId, ci) => {
    const r = await enqueue(czId, ci);
    const c = await claim(czId);
    assert.ok(c, 'claimed ' + czId);
    return r;
  };
  const claimRaw = (czId, ci, lease, origin, user) =>
    val('SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) AS r', [
      czId, ci, 'copanel', origin || 'cz_automatic', user || null, 12, 'LRW-' + czId, REQ, lease || 300, null,
    ]);
  const claimProc = async (czId, ci, lease, origin) => (await claimRaw(czId, ci, lease, origin)).process;
  const finishS1 = (id, status, code) =>
    svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [id, status, '{"r":1}', 200, 'm', 5, code || null, null]);
  const beginS2 = (czId, lease) =>
    svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [czId, REQ, lease || 300]);
  const finishS2 = (id, status) =>
    svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [id, status, '{"r":2}', 200, 'm', 5, null, null]);
  const expire = (czId) => svc('SELECT * FROM public.elm_expire_stale_in_flight($1)', [czId]);
  const referredProc = async (czId, ci, origin) => {
    const p = await claimProc(czId, ci, 300, origin);
    await finishS1(p.id, 'eligible');
    await beginS2(czId);
    await finishS2(p.id, 'referred');
    return p;
  };
  const acquire = (ci, czId, reqId, at) =>
    val('SELECT public.elm_ci_lock_acquire($1, $2, $3, $4::timestamptz) AS r', [ci, czId, reqId, at || null]);
  const releaseUnstarted = (czId) => val('SELECT public.elm_ci_lock_release_unstarted($1) AS r', [czId]);
  const locks = async (czId) =>
    (await svc('SELECT state, blocks_future, block_reason, settle_reason, month_key::text AS month FROM public.elm_ci_send_locks WHERE cz_solicitud_id = $1 ORDER BY reserved_at', [czId])).rows;
  const liveLock = async (czId) => (await locks(czId)).find((l) => l.state !== 'released') || null;
  const state = (czId) => one('SELECT * FROM public.provider_cz_state WHERE cz_solicitud_id = $1', [czId]);
  const events = async (czId) =>
    (await svc('SELECT * FROM public.provider_cz_events WHERE cz_solicitud_id = $1 ORDER BY seq', [czId])).rows;
  const conflicts = async (czId) =>
    (await svc('SELECT * FROM public.provider_cz_conflicts WHERE cz_solicitud_id = $1 ORDER BY created_at', [czId])).rows;
  const pending = async (limit) => (await svc('SELECT * FROM public.provider_cz_events_pending($1)', [limit || 200])).rows;
  const ack = (id, result) => val('SELECT public.provider_cz_event_ack($1, $2) AS r', [id, result]);
  const SOURCE_KIND = { 'review.resolved': 'review_case', outcome: 'fallback_outcome', 'referral.resolved': 'elm_process' };
  const emit = (czId, type, target, dedupe) =>
    val('SELECT public.provider_cz_emit($1, $2, $3, $4, null, $5, null, null, null, null, null) AS r', [
      czId, type, target, SOURCE_KIND[type] || 'provider_status', dedupe,
    ]);
  const resolveProc = async (czId, code, czOutcome) => {
    const p = await one('SELECT id, updated_at FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId]);
    return val('SELECT public.elm_resolve_process($1, $2::timestamptz, $3, $4, $5, $6) AS r', [p.id, p.updated_at, code, NOTE, actor, czOutcome]);
  };
  // Superuser-only test helper: move a process clock back (the 1A/3B guards freeze timestamps).
  const backdate = async (czId, col, interval) => {
    await db.exec('ALTER TABLE public.elm_lead_processes DISABLE TRIGGER USER');
    try {
      await db.query('UPDATE public.elm_lead_processes SET ' + col + ' = ' + col + ' - $2::interval WHERE cz_solicitud_id = $1', [czId, interval]);
    } finally {
      await db.exec('ALTER TABLE public.elm_lead_processes ENABLE TRIGGER USER');
    }
  };
  const retry = (czId, step, expected, max, codes) =>
    svc('SELECT * FROM public.elm_retry_step($1, $2, $3, $4, $5::text[], $6)', [czId, step, expected, max || 1, codes || [], 300]);
  const lateReconcile = (statuses) =>
    val('SELECT public.provider_cz_reconcile_late($1::text[], $2) AS r', [statuses || [], 100]);
  const lockReconcile = () => val('SELECT public.elm_ci_lock_reconcile($1) AS r', [100]);
  const postback = async (czId, ci, raw, normalized, processId, eventAt) => {
    const ev = (await svc('SELECT * FROM public.elm_postback_record_event($1, $2, $3, $4, $5, $6, $7::jsonb)', [
      raw, normalized, ci, null, czId, eventAt || null, '{}',
    ])).rows[0];
    return (await svc('SELECT * FROM public.elm_postback_resolve_event($1, $2, $3, $4, $5)', [
      ev.id, processId, 'cz_solicitud_id', null, null,
    ])).rows[0];
  };
  const reviewCase = (czId) => one('SELECT * FROM public.provider_review_cases WHERE cz_solicitud_id = $1', [czId]);
  const resolveCase = (czId, c, outcome) =>
    val('SELECT public.provider_review_resolve($1, $2, $3, $4, $5, $6) AS r', [c.id, c.version, 'resolved_with_provider', NOTE, actor, outcome]);

  // ------------------------------------------------------------------ access
  const tables = ['provider_cz_state', 'provider_cz_events', 'provider_cz_conflicts', 'elm_ci_send_locks'];
  for (const t of tables) {
    const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || $1)::regclass", [t]);
    assert.strictEqual(rls.rows[0].relrowsecurity, true, t + ' rls');
    const pol = await db.query('SELECT count(*)::int AS n FROM pg_policies WHERE tablename = $1', [t]);
    assert.strictEqual(pol.rows[0].n, 0, t + ' policies');
    for (const role of ['anon', 'authenticated']) {
      await expectSqlError(() => asRole(role, () => db.query('SELECT * FROM public.' + t)), /permission denied/, role + ' ' + t);
    }
    await expectSqlError(() => svc('DELETE FROM public.' + t), /permission denied/, 'svc delete ' + t);
    await expectSqlError(() => svc('TRUNCATE public.' + t), /permission denied/, 'svc truncate ' + t);
  }
  const fns = [
    "SELECT * FROM public.provider_cz_events_pending(1)",
    "SELECT public.provider_cz_event_ack(gen_random_uuid(), 'applied')",
    "SELECT public.elm_ci_lock_acquire(1, 1, gen_random_uuid(), null)",
    "SELECT public.elm_ci_lock_reconcile(1)",
    "SELECT public.provider_cz_reconcile_late('{}'::text[], 1)",
    "SELECT * FROM public.provider_c1_active_referrals(72, 10)",
    "SELECT public.provider_cz_conflict_resolve(gen_random_uuid(), 'xxxxxxxxxxxx', gen_random_uuid())",
    "SELECT public.provider_review_resolve(gen_random_uuid(), 1, 'other', 'xxxxxxxxxxxx', gen_random_uuid(), 'none')",
    "SELECT public.elm_ci_lock_try(1, 1, null, 'janus_batch', null)",
    "SELECT public.elm_resolve_process(gen_random_uuid(), now(), 'other', 'xxxxxxxxxxxx', gen_random_uuid(), 'none')",
    "SELECT public.elm_claim_process(1, 1, 'copanel', 'janus_batch', null, 12, 'x', '{}'::jsonb, 60, null)",
  ];
  for (const role of ['anon', 'authenticated']) {
    for (const q of fns) await expectSqlError(() => asRole(role, () => db.query(q)), /permission denied/, role + ' ' + q);
  }
  pass('access: RLS on, 0 policies, anon/authenticated denied on tables + RPCs; service_role cannot DELETE/TRUNCATE');

  // ------------------------------------------------------------------ calendar month (America/Montevideo)
  const mk = (at) => val('SELECT public.elm_month_key($1::timestamptz)::text AS r', [at]);
  assert.strictEqual(await mk('2026-10-31T23:59:59-03:00'), '2026-10-01');
  assert.strictEqual(await mk('2026-11-01T00:00:00-03:00'), '2026-11-01');
  assert.strictEqual(await mk('2026-11-01T02:59:59Z'), '2026-10-01', 'UTC already November, Uruguay still October');
  assert.strictEqual(await mk('2026-11-01T03:00:00Z'), '2026-11-01');
  assert.strictEqual(await mk('2026-12-31T23:59:59-03:00'), '2026-12-01');
  assert.strictEqual(await mk('2027-01-01T03:00:00Z'), '2027-01-01', 'year boundary');
  assert.strictEqual(await mk('2028-02-29T12:00:00-03:00'), '2028-02-01', 'leap day');
  pass('month key uses America/Montevideo: 31-oct 23:59:59 UY = octubre; 02:59:59Z del 1-nov = octubre; cambio de año');

  // ------------------------------------------------------------------ happy path + active referral blocks
  const CI_A = 10000001;
  const rA = await job(101, CI_A);
  const a1 = await acquire(CI_A, 101, rA.id, OCT);
  assert.strictEqual(a1.status, 'acquired');
  assert.strictEqual(a1.month_key, '2026-10-01');
  const a2 = await acquire(CI_A, 101, rA.id, NOV);
  assert.strictEqual(a2.status, 'held', 'idempotent for the same solicitud (retries / S2)');
  const pA = await referredProc(101, CI_A);
  await finalize(rA.id, 'referred', 'elm_s2_referred', pA.id);
  const sA = await state(101);
  assert.strictEqual(sA.projected_estado, 13);
  assert.strictEqual(sA.last_seq, 1);
  const evA = await events(101);
  assert.strictEqual(evA.length, 1);
  assert.deepStrictEqual(
    [evA[0].seq, evA[0].event_type, evA[0].from_estado, evA[0].target_estado, evA[0].outcome, evA[0].delivery_status],
    [1, 'outcome', 12, 13, 'referred', 'pending'],
  );
  assert.deepStrictEqual(await liveLock(101), {
    state: 'consumed', blocks_future: true, block_reason: 'active_referral', settle_reason: 'received', month: '2026-10-01',
  });
  const again = await finalize(rA.id, 'referred', 'elm_s2_referred', pA.id);
  assert.strictEqual(again, undefined, 'second finalize is a no-op');
  assert.strictEqual((await events(101)).length, 1, 'no duplicated outcome event');
  assert.strictEqual((await emit(101, 'outcome', 13, 'outcome:' + rA.id)).status, 'duplicate');

  const rB = await job(102, CI_A);
  const bOct = await acquire(CI_A, 102, rB.id, OCT);
  assert.deepStrictEqual([bOct.status, bOct.block, bOct.related_cz_solicitud_id], ['blocked', 'active_referral', 101]);
  const bDec = await acquire(CI_A, 102, rB.id, DEC);
  assert.strictEqual(bDec.block, 'active_referral', 'active referral keeps blocking later months');
  assert.deepStrictEqual(await locks(102), [], 'a blocked acquire writes nothing');
  pass('referred: finalize → state 13 + event seq1 (12→13) + lock consumed/active_referral in one tx; same CI blocked this and later months; finalize/emit idempotent');

  // ------------------------------------------------------------------ PULL: order, ack, out-of-order, late.granted
  await postback(101, CI_A, 'Convertido', 'convertido', pA.id);
  const lg = await lateReconcile([]);
  assert.strictEqual(lg.granted_emitted, 1);
  const evA2 = await events(101);
  assert.deepStrictEqual([evA2[1].seq, evA2[1].event_type, evA2[1].from_estado, evA2[1].target_estado], [2, 'late.granted', 13, 16]);
  assert.strictEqual(evA2[1].provider_status, 'Convertido');
  assert.strictEqual((await state(101)).projected_estado, 16);
  const l101 = await liveLock(101);
  assert.deepStrictEqual([l101.state, l101.blocks_future, l101.block_reason, l101.settle_reason], ['consumed', false, null, 'granted_elm'],
    'GRANTED closes that solicitud only: no future block');
  assert.deepStrictEqual(await lateReconcile([]), {}, 'late reconcile is idempotent');

  let pend = await pending();
  assert.deepStrictEqual(pend.filter((e) => e.cz_solicitud_id === '101' || e.cz_solicitud_id === 101).map((e) => e.seq), [1], 'only the head is delivered');
  assert.strictEqual((await ack(evA2[1].id, 'applied')).status, 'out_of_order');
  assert.strictEqual((await ack(evA2[0].id, 'bogus')).status, 'invalid_result');
  assert.strictEqual((await ack(crypto.randomUUID(), 'applied')).status, 'not_found');
  const k1 = await ack(evA2[0].id, 'applied');
  assert.deepStrictEqual([k1.status, k1.result, k1.seq], ['acked', 'applied', 1]);
  const k1b = await ack(evA2[0].id, 'not_applied');
  assert.deepStrictEqual([k1b.status, k1b.result], ['already_acked', 'applied'], 'repeated ack keeps the first result');
  pend = await pending();
  const head = pend.find((e) => Number(e.cz_solicitud_id) === 101);
  assert.strictEqual(head.seq, 2);
  assert.strictEqual(head.delivery_attempts, 1);
  pend = await pending();
  assert.strictEqual(pend.find((e) => Number(e.cz_solicitud_id) === 101).delivery_attempts, 2, 'retries are counted, event kept');
  assert.strictEqual((await ack(head.id, 'not_applied')).status, 'acked');
  assert.strictEqual(pend.length >= 1, true);
  assert.ok(!(await pending()).some((e) => Number(e.cz_solicitud_id) === 101), 'nothing pending after both acks');
  assert.strictEqual((await events(101)).length, 2, 'acked events are never deleted');
  await expectSqlError(() => svc("UPDATE public.provider_cz_events SET target_estado = 3 WHERE cz_solicitud_id = 101 AND seq = 2"), /immutable|shape/, 'content immutable');
  await expectSqlError(() => svc("UPDATE public.provider_cz_events SET delivery_attempts = 0 WHERE cz_solicitud_id = 101 AND seq = 2"), /frozen/, 'acked frozen');
  const gOct = await acquire(CI_A, 102, rB.id, OCT);
  assert.deepStrictEqual([gOct.block, gOct.related_cz_solicitud_id], ['monthly_quota_used', 101], 'same month: still the monthly quota');
  const gDec = await acquire(CI_A, 102, rB.id, DEC);
  assert.strictEqual(gDec.status, 'acquired', 'another month after a GRANTED loan: not blocked by that GRANTED alone');
  assert.strictEqual((await releaseUnstarted(102)).status, 'released');
  pass('PULL: seq n only after n-1 acked; ack idempotent / out_of_order / invalid / not_found; attempts counted; Convertido → late.granted 13→16; GRANTED does not block later months');

  // ------------------------------------------------------------------ transition matrix
  let fixtureId = 2000;
  async function stateAt(estado) {
    fixtureId += 1;
    const czId = fixtureId;
    const r = await job(czId, 20000000 + czId);
    if (estado === 12) {
      await svc('INSERT INTO public.provider_cz_state (cz_solicitud_id, fallback_request_id, ci) VALUES ($1, $2, $3)', [czId, r.id, 20000000 + czId]);
      return czId;
    }
    const outcome = { 13: 'referred', 16: 'referred', 14: 'manual_review', 3: 'rejected', 15: 'already_referred' }[estado];
    await finalize(r.id, outcome, outcome === 'rejected' ? 'elm_s1_rejected' : 'test_' + outcome, null, estado === 15 ? 1 : null);
    if (estado === 16) assert.strictEqual((await emit(czId, 'late.granted', 16, 'm16:' + czId)).status, 'emitted');
    assert.strictEqual((await state(czId)).projected_estado, estado);
    return czId;
  }
  const LEGAL = new Set([
    'outcome:12>13', 'outcome:12>14', 'outcome:12>3', 'outcome:12>15',
    'late.rejected:13>3', 'late.granted:13>16',
    'review.resolved:14>13', 'review.resolved:14>3', 'review.resolved:14>16',
    'late.rejected:14>3', 'late.granted:14>16',
    'referral.resolved:13>3', 'referral.resolved:13>16',
  ]);
  const ESTADOS = [12, 13, 14, 3, 15, 16];
  const TYPES = ['outcome', 'late.rejected', 'late.granted', 'review.resolved', 'referral.resolved'];
  const shared = {};
  for (const e of ESTADOS) shared[e] = await stateAt(e);
  let n = 0;
  let emitted = 0;
  for (const from of ESTADOS) {
    assert.strictEqual((await emit(shared[from], 'review.resolved', from, 'noop:' + from)).status, 'noop');
    for (const to of ESTADOS) {
      if (to === from) continue;
      for (const type of TYPES) {
        n += 1;
        const key = type + ':' + from + '>' + to;
        const czId = LEGAL.has(key) ? await stateAt(from) : shared[from];
        const before = await state(czId);
        const r = await emit(czId, type, to, 'mx:' + key);
        const after = await state(czId);
        if (LEGAL.has(key)) {
          emitted += 1;
          assert.strictEqual(r.status, 'emitted', key);
          assert.deepStrictEqual([after.projected_estado, after.last_seq], [to, before.last_seq + 1], key);
        } else {
          assert.strictEqual(r.status, 'conflict', key + ' must be a conflict');
          assert.deepStrictEqual([after.projected_estado, after.last_seq], [before.projected_estado, before.last_seq], key);
        }
      }
    }
  }
  assert.strictEqual(emitted, LEGAL.size);
  const at = shared;
  const cx = await conflicts(at[3]);
  assert.ok(cx.length > 0 && cx.every((c) => c.conflict_code === 'transition_not_allowed' && c.status === 'open'));
  assert.strictEqual((await emit(at[3], 'late.granted', 16, 'mx:late.granted:3>16')).status, 'duplicate', 'repeated contradictory event → same conflict');
  await expectSqlError(() => svc('UPDATE public.provider_cz_state SET projected_estado = 13, last_seq = last_seq + 1 WHERE cz_solicitud_id = $1', [at[3]]), /illegal_transition/, 'no 3→13 even by direct update');
  await expectSqlError(() => svc('UPDATE public.provider_cz_state SET projected_estado = 12, last_seq = last_seq + 1 WHERE cz_solicitud_id = $1', [at[13]]), /illegal_transition/, 'never back to 12');
  await expectSqlError(() => svc('UPDATE public.provider_cz_state SET last_seq = last_seq + 5 WHERE cz_solicitud_id = $1', [at[13]]), /seq only advances/, 'seq');
  pass('matrix: only 12→13/14/3/15, 13→3/16 (late / referral.resolved), 14→13/3/16 are emitted (' + n + ' type/transition combinations checked); 3, 15, 16 terminal; contradictions → open conflict, state untouched');

  // ------------------------------------------------------------------ review resolution with CZ outcome
  const CI_R = 30000001;
  const rR = await job(301, CI_R);
  await finalize(rR.id, 'manual_review', 'elm_s1_unknown', null);
  assert.strictEqual((await state(301)).projected_estado, 14);
  let cR = await reviewCase(301);
  assert.strictEqual((await resolveCase(301, cR, 'none')).status, 'cz_outcome_required');
  assert.strictEqual((await resolveCase(301, cR, 'granted')).status, 'evidence_required');
  assert.strictEqual((await resolveCase(301, cR, 'maybe')).status, 'invalid_cz_outcome');
  const res = await resolveCase(301, cR, 'referred');
  assert.strictEqual(res.status, 'resolved');
  assert.deepStrictEqual([res.cz_event.status, res.cz_event.from_estado, res.cz_event.target_estado], ['emitted', 14, 13]);
  cR = await reviewCase(301);
  assert.strictEqual((await resolveCase(301, cR, 'referred')).status, 'already_resolved');
  const audit = await one("SELECT detail FROM public.elm_ops_audit_events WHERE entity_type = 'review_case' AND entity_id = $1 AND action = 'resolved'", [cR.id]);
  assert.strictEqual(audit.detail.cz_outcome, 'referred');

  const rR2 = await job(302, 30000002);
  await finalize(rR2.id, 'manual_review', 'elm_s2_unknown', null);
  assert.strictEqual((await emit(302, 'late.rejected', 3, 'test-late-302')).status, 'emitted');
  const cR2 = await reviewCase(302);
  const na = await resolveCase(302, cR2, 'rejected');
  assert.deepStrictEqual([na.status, na.projected_estado], ['cz_outcome_not_applicable', 3]);
  assert.strictEqual((await resolveCase(302, cR2, 'none')).status, 'resolved');
  assert.strictEqual((await events(302)).length, 2, 'review with none emits nothing');
  pass('review.resolved: cz_outcome required while 14, granted needs Convertido, refused once the solicitud left 14; emits 14→13 once; audited');

  // ------------------------------------------------------------------ late.rejected (configurable list) + quota + conflicts
  const CI_L = 40000001;
  const rL = await job(401, CI_L);
  await acquire(CI_L, 401, rL.id, null);
  const pL = await referredProc(401, CI_L);
  await finalize(rL.id, 'referred', 'elm_s2_referred', pL.id);
  const pbRej = await postback(401, CI_L, 'Rechazado', 'rechazado', pL.id);
  assert.strictEqual(pbRej.processing_status, 'applied');
  assert.deepStrictEqual(await lateReconcile([]), {}, 'empty list → no late.rejected');
  assert.strictEqual((await state(401)).projected_estado, 13);
  const lr = await lateReconcile(['rechazado', 'convertido']);
  assert.strictEqual(lr.rejected_emitted, 1);
  const evL = await events(401);
  assert.deepStrictEqual([evL[1].event_type, evL[1].from_estado, evL[1].target_estado, evL[1].provider_status], ['late.rejected', 13, 3, 'Rechazado']);
  assert.deepStrictEqual(await liveLock(401), {
    state: 'consumed', blocks_future: false, block_reason: null, settle_reason: 'received', month: (await liveLock(401)).month,
  }, 'post-referral rejection closes the referral block but the month stays used');
  assert.deepStrictEqual(await lateReconcile(['rechazado']), {}, 'idempotent');

  const rL2 = await job(402, CI_L);
  const q = await acquire(CI_L, 402, rL2.id, null);
  assert.deepStrictEqual([q.status, q.block, q.related_cz_solicitud_id], ['blocked', 'monthly_quota_used', 401], 'same CI, same month, closed evaluation → no resend');
  const nextMonth = await val("SELECT (date_trunc('month', now() AT TIME ZONE 'America/Montevideo') + interval '1 month 1 day')::timestamp AT TIME ZONE 'America/Montevideo' AS r");
  const qn = await acquire(CI_L, 402, rL2.id, nextMonth);
  assert.strictEqual(qn.status, 'acquired', 'next calendar month is allowed');
  assert.strictEqual((await releaseUnstarted(402)).status, 'released');
  assert.strictEqual((await liveLock(402)), null);

  await sleep(5);
  await postback(401, CI_L, 'Aprobado', 'aprobado', pL.id);
  const sar = await lateReconcile(['rechazado']);
  assert.strictEqual(sar.status_after_rejection, 1);
  assert.strictEqual((await state(401)).projected_estado, 3, 'never 3→13 automatically');
  assert.deepStrictEqual(await lateReconcile(['rechazado']), {}, 'conflict recorded once');
  await postback(401, CI_L, 'Convertido', 'convertido', pL.id);
  const g3 = await lateReconcile(['rechazado']);
  assert.strictEqual(g3.granted_conflict, 1, 'Convertido after an applied rejection → conflict (no 3→16)');
  assert.strictEqual((await state(401)).projected_estado, 3);
  const codes = (await conflicts(401)).map((c) => c.conflict_code).sort();
  assert.deepStrictEqual(codes, ['status_after_rejection', 'transition_not_allowed']);
  await lockReconcile();
  assert.strictEqual((await liveLock(401)).block_reason, null, 'a GRANTED loan never becomes a CI-wide block');
  assert.strictEqual((await acquire(CI_L, 402, rL2.id, nextMonth)).status, 'acquired', 'next month still allowed after GRANTED');
  assert.strictEqual((await releaseUnstarted(402)).status, 'released');
  pass('late.rejected only with the configured list (13→3), unblocks referral but keeps month quota; same month → monthly_quota_used, next month allowed (also after GRANTED); later status / Convertido after rejection → conflicts');

  // ------------------------------------------------------------------ technical failures and uncertain results
  const CI_T = 50000001;
  const rT1 = await job(501, CI_T);
  assert.strictEqual((await acquire(CI_T, 501, rT1.id, null)).status, 'acquired');
  const pT1 = await claimProc(501, CI_T);
  await finishS1(pT1.id, 'technical_error', 'elm_http_auth_rejected');
  await finalize(rT1.id, 'manual_review', 'elm_s1_technical_error_retry_unsafe', pT1.id);
  assert.deepStrictEqual([(await locks(501))[0].state, (await locks(501))[0].settle_reason], ['released', 'not_received'], 'error before reception does not use the month');

  const rT2 = await job(502, CI_T);
  assert.strictEqual((await acquire(CI_T, 502, rT2.id, null)).status, 'acquired', 'quota still free after a pre-reception error');
  const pT2 = await claimProc(502, CI_T);
  await finishS1(pT2.id, 'technical_error', 'elm_provider_bcu_error');
  await finalize(rT2.id, 'manual_review', 'elm_s1_technical_error_retry_unsafe', pT2.id);
  assert.deepStrictEqual(await liveLock(502), {
    state: 'consumed', blocks_future: false, block_reason: null, settle_reason: 'received', month: (await liveLock(502)).month,
  }, 'technical error after reception uses the month');
  const rT3 = await job(503, CI_T);
  assert.strictEqual((await acquire(CI_T, 503, rT3.id, null)).block, 'monthly_quota_used');

  const CI_U = 50000002;
  const rU = await job(511, CI_U);
  await acquire(CI_U, 511, rU.id, null);
  const pU = await claimProc(511, CI_U, 1);
  await sleep(1200);
  await expire(511);
  await finalize(rU.id, 'manual_review', 'elm_s1_unknown', pU.id);
  assert.strictEqual((await liveLock(511)).state, 'reserved', 'uncertain result keeps the reservation');
  const rU2 = await job(512, CI_U);
  const u2 = await acquire(CI_U, 512, rU2.id, nextMonth);
  assert.deepStrictEqual([u2.block, u2.related_cz_solicitud_id], ['uncertain', 511], 'blocks new sends (any month) until reconciled');
  const pUrow = await one('SELECT updated_at FROM public.elm_lead_processes WHERE cz_solicitud_id = 511');
  const resU = await val('SELECT public.elm_resolve_process($1, $2::timestamptz, $3, $4, $5) AS r', [pU.id, pUrow.updated_at, 'provider_confirmed_not_received', NOTE, actor]);
  assert.strictEqual(resU.status, 'resolved');
  assert.strictEqual((await locks(511))[0].state, 'released', 'settled by the process trigger in the same transaction');
  await lockReconcile();
  assert.strictEqual((await locks(511))[0].state, 'released');
  assert.strictEqual((await acquire(CI_U, 512, rU2.id, null)).status, 'acquired', 'after reconciliation the CI can be evaluated');

  const CI_S = 50000003;
  const rS = await job(521, CI_S);
  await acquire(CI_S, 521, rS.id, null);
  const pS = await claimProc(521, CI_S);
  await finishS1(pS.id, 'eligible');
  await beginS2(521, 1);
  await sleep(1200);
  await expire(521);
  await finalize(rS.id, 'manual_review', 'elm_s2_unknown', pS.id);
  assert.strictEqual((await liveLock(521)).block_reason, 'uncertain_referral');
  const rS2 = await job(522, CI_S);
  assert.strictEqual((await acquire(CI_S, 522, rS2.id, nextMonth)).block, 'uncertain');
  const cS = await reviewCase(521);
  assert.strictEqual((await resolveCase(521, cS, 'rejected')).cz_event.target_estado, 3);
  assert.strictEqual((await liveLock(521)).blocks_future, false, 'review rejected (14→3) closes the uncertain referral');
  assert.strictEqual((await acquire(CI_S, 522, rS2.id, null)).block, 'monthly_quota_used', 'but the month stays used');
  assert.strictEqual((await acquire(CI_S, 522, rS2.id, nextMonth)).status, 'acquired');
  pass('technical failures: pre-reception error releases; error after reception consumes; S1 unknown keeps reservation until elm_resolve_process; S2 unknown blocks as uncertain_referral until reviewed');

  // ------------------------------------------------------------------ not started, other origins, concurrency backstops
  const CI_N = 60000001;
  const rN = await job(601, CI_N);
  await acquire(CI_N, 601, rN.id, null);
  assert.strictEqual((await releaseUnstarted(601)).status, 'released');
  assert.strictEqual((await releaseUnstarted(601)).status, 'no_lock');
  await acquire(CI_N, 601, rN.id, null);
  await claimProc(601, CI_N);
  assert.strictEqual((await releaseUnstarted(601)).status, 'process_exists', 'never released once a call may have started');

  const CI_O = 60000002;
  const pO = await claimProc(611, CI_O, 300, 'janus_batch');
  await finishS1(pO.id, 'rejected');
  const rO = await job(612, CI_O);
  assert.strictEqual((await acquire(CI_O, 612, rO.id, null)).block, 'monthly_quota_used', 'a send from another origin uses the month too');
  assert.strictEqual((await acquire(CI_O, 612, rO.id, nextMonth)).status, 'acquired');
  await releaseUnstarted(612);
  const b613 = await claimRaw(613, CI_O, 300, 'janus_batch');
  assert.deepStrictEqual([b613.claimed, b613.process, b613.blocked.block, b613.blocked.related_cz_solicitud_id],
    [false, null, 'monthly_quota_used', 611], 'a batch send of the same CI and month is refused by the claim itself');
  const CI_O2 = 60000004;
  await referredProc(614, CI_O2, 'janus_batch');
  const rO2 = await job(615, CI_O2);
  assert.strictEqual((await acquire(CI_O2, 615, rO2.id, nextMonth)).block, 'active_referral', 'referral from another origin blocks');

  const CI_C = 60000003;
  const rC1 = await job(621, CI_C);
  const rC2 = await enqueue(622, CI_C);
  assert.strictEqual((await acquire(CI_C, 621, rC1.id, null)).status, 'acquired');
  const c2 = await acquire(CI_C, 622, rC2.id, null);
  assert.deepStrictEqual([c2.block, c2.related_cz_solicitud_id], ['send_in_progress', 621], 'second solicitud of the CI waits');
  const month = (await liveLock(621)).month;
  const ins = (cz, req, mon, st) => svc(
    "INSERT INTO public.elm_ci_send_locks (ci, month_key, cz_solicitud_id, fallback_request_id, state, trigger_origin) VALUES ($1, $2::date, $3, $4, $5, 'cz_automatic')",
    [CI_C, mon, cz, req, st || 'reserved'],
  );
  await expectSqlError(() => ins(622, rC2.id, month), /duplicate key|unique/, 'two reservations same CI same month');
  await expectSqlError(() => ins(622, rC2.id, '2030-01-01'), /duplicate key|unique/, 'two open reservations same CI (other month)');
  await expectSqlError(() => ins(621, rC1.id, '2030-02-01'), /duplicate key|unique/, 'two live locks same solicitud');
  await expectSqlError(() => ins(622, rC2.id, '2030-03-01', 'consumed'), /must be reserved/, 'insert must be reserved');
  await expectSqlError(() => svc("UPDATE public.elm_ci_send_locks SET month_key = '2030-04-01' WHERE cz_solicitud_id = 621"), /immutable/, 'identity');
  await expectSqlError(() => svc("UPDATE public.elm_ci_send_locks SET state = 'released', released_at = now() WHERE cz_solicitud_id = 502"), /illegal_transition/, 'consumed never released');
  await expectSqlError(() => svc("UPDATE public.elm_ci_send_locks SET settle_reason = 'x' WHERE cz_solicitud_id = 501"), /frozen/, 'released frozen');
  await expectSqlError(() => svc("UPDATE public.elm_ci_send_locks SET blocks_future = true WHERE cz_solicitud_id = 621"), /check/, 'reserved cannot carry a block');
  pass('not-started release only without process; other origins count for quota and referral; unique indexes reject every duplicate a race could produce');

  // ------------------------------------------------------------------ one claim for every origin
  const CI_M = 70000001;
  const rM = await job(701, CI_M);
  assert.strictEqual((await acquire(CI_M, 701, rM.id, null)).status, 'acquired');
  const pM = await claimProc(701, CI_M);
  assert.ok(pM && pM.id, 'automatic claim reuses the reservation (held)');
  const manualWhileOpen = await claimRaw(702, CI_M, 300, 'janus_manual', actor);
  assert.deepStrictEqual([manualWhileOpen.claimed, manualWhileOpen.blocked.block, manualWhileOpen.blocked.related_cz_solicitud_id],
    [false, 'send_in_progress', 701], 'manual send while the automatic one is open → refused');
  await finishS1(pM.id, 'rejected');
  await finalize(rM.id, 'rejected', 'elm_s1_rejected', pM.id);
  for (const [cz, origin, user] of [[702, 'janus_manual', actor], [703, 'janus_batch', null]]) {
    const b = await claimRaw(cz, CI_M, 300, origin, user);
    assert.deepStrictEqual([b.claimed, b.process, b.blocked.block, b.blocked.related_cz_solicitud_id],
      [false, null, 'monthly_quota_used', 701], origin + ': same CI, same month → refused');
    assert.deepStrictEqual(await locks(cz), [], origin + ': a refused claim writes no lock');
    assert.strictEqual(await one('SELECT id FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [cz]), undefined);
  }
  const CI_M2 = 70000002;
  const m1 = await claimRaw(711, CI_M2, 300, 'janus_batch');
  const m2 = await claimRaw(712, CI_M2, 300, 'janus_manual', actor);
  assert.strictEqual(m1.claimed, true);
  assert.deepStrictEqual([m2.claimed, m2.blocked.block], [false, 'send_in_progress'], 'second claim of the CI waits for the first');
  const l711 = await liveLock(711);
  assert.deepStrictEqual([l711.state, l711.month], ['reserved', await mk(new Date().toISOString())]);
  const origin711 = await one('SELECT trigger_origin, fallback_request_id FROM public.elm_ci_send_locks WHERE cz_solicitud_id = 711');
  assert.deepStrictEqual([origin711.trigger_origin, origin711.fallback_request_id], ['janus_batch', null]);
  await finishS1(m1.process.id, 'eligible');
  assert.strictEqual((await liveLock(711)).state, 'reserved', 'S1 eligible waiting for S2 keeps the reservation');
  await beginS2(711);
  await finishS2(m1.process.id, 'referred');
  assert.deepStrictEqual([(await liveLock(711)).state, (await liveLock(711)).block_reason], ['consumed', 'active_referral'],
    'the settle trigger keeps the lock of a non-fallback send in step with its process');

  await expectSqlError(() => svc(
    "INSERT INTO public.elm_lead_processes (cz_solicitud_id, ci, source_brand, trigger_origin, s1_status, s1_attempts, s1_request, s1_started_at, s1_lease_expires_at) VALUES (721, 70000003, 'copanel', 'janus_batch', 'in_flight', 1, '{}'::jsonb, now(), now() + interval '1 minute')",
  ), /elm_ci_lock_required/, 'direct insert without the claim');
  assert.deepStrictEqual(await retry(501, 's1', 1, 3, ['elm_http_auth_rejected']).then((r) => r.rows), [], 'retry without a live lock is refused');
  await expectSqlError(() => svc(
    "UPDATE public.elm_lead_processes SET s1_status = 'in_flight', s1_attempts = 2, s1_lease_expires_at = now() + interval '1 minute' WHERE cz_solicitud_id = 501",
  ), /elm_ci_lock_required|transition|guard|frozen/, 'direct retry without a live lock');
  pass('unified claim: automatic, manual and batch all take the CI lock inside elm_claim_process; refused claims write nothing; no process insert / retry without a live lock');

  // ------------------------------------------------------------------ ELM "BCU error": one retry 24 h later
  const CI_B = 80000001;
  const rBcu = await job(801, CI_B);
  await acquire(CI_B, 801, rBcu.id, null);
  const pB = await claimProc(801, CI_B);
  const reqBefore = (await one('SELECT s1_request FROM public.elm_lead_processes WHERE id = $1', [pB.id])).s1_request;
  await finishS1(pB.id, 'technical_error', 'elm_provider_bcu_error');
  const lockB = await liveLock(801);
  assert.deepStrictEqual([lockB.state, lockB.blocks_future], ['reserved', false], 'pending request: reservation kept, no quota release');
  assert.strictEqual(await state(801), undefined, 'no CZ event while waiting: CZ stays 12');
  assert.deepStrictEqual((await retry(801, 's1', 1)).rows, [], 'not before 24 h');
  await backdate(801, 's1_completed_at', '23 hours 59 minutes');
  assert.deepStrictEqual((await retry(801, 's1', 1)).rows, [], 'not at 23:59');
  const rB2 = await enqueue(802, CI_B);
  assert.strictEqual((await acquire(CI_B, 802, rB2.id, null)).block, 'send_in_progress', 'another solicitud of the CI cannot skip the wait');
  assert.strictEqual((await claimRaw(803, CI_B, 300, 'janus_batch')).blocked.block, 'send_in_progress');
  await backdate(801, 's1_completed_at', '1 minute');
  const again1 = (await retry(801, 's1', 1)).rows;
  assert.strictEqual(again1.length, 1, 'exactly 24 h after the error');
  assert.deepStrictEqual([again1[0].s1_status, again1[0].s1_attempts, Number(again1[0].cz_solicitud_id)], ['in_flight', 2, 801]);
  assert.deepStrictEqual(again1[0].s1_request, reqBefore, 'same frozen request (same solicitud / TrackingId)');
  assert.deepStrictEqual((await retry(801, 's1', 1)).rows, [], 'a concurrent second retry is a no-op');
  const att = await one("SELECT attempt_no, error_code, status FROM public.elm_step_attempts WHERE cz_solicitud_id = 801 AND step = 's1'");
  assert.deepStrictEqual([att.attempt_no, att.error_code, att.status], [1, 'elm_provider_bcu_error', 'technical_error'], 'first attempt and its answer are archived');
  assert.strictEqual((await locks(801)).length, 1, 'same lock: no new monthly quota');
  assert.strictEqual((await liveLock(801)).state, 'reserved');
  await finishS1(pB.id, 'technical_error', 'elm_provider_bcu_error');
  await backdate(801, 's1_completed_at', '48 hours');
  assert.deepStrictEqual((await retry(801, 's1', 2, 20, ['elm_provider_bcu_error'])).rows, [], 'never a third attempt, whatever the config');
  await finalize(rBcu.id, 'manual_review', 'elm_s1_bcu_error_repeated', pB.id);
  const evB = await events(801);
  assert.deepStrictEqual(evB.map((e) => [e.event_type, e.from_estado, e.target_estado]), [['outcome', 12, 14]], 'manual review (14), never a rejection');
  assert.strictEqual((await liveLock(801)).state, 'consumed');
  pass('BCU error: no retry before 24 h; exactly one retry with the same request and lock; archived attempt; concurrent retry no-op; second BCU → 14 (no third attempt)');

  // ------------------------------------------------------------------ no default rejection
  const rD = await job(811, 80000002);
  for (const [outcome, reason] of [['rejected', 'elm_s1_unknown'], ['rejected', 'elm_http_timeout'], ['not_eligible', 'unexpected_state'], ['rejected', 'elm_response_undocumented'], ['not_eligible', 'elm_cdv_granted']]) {
    await expectSqlError(() => finalize(rD.id, outcome, reason, null), /provider_fallback_rejection_not_definitive/, outcome + '/' + reason);
  }
  assert.strictEqual((await one('SELECT outcome FROM public.provider_fallback_requests WHERE id = $1', [rD.id])).outcome, 'pending');
  assert.strictEqual(await state(811), undefined, 'no CZ state / event');
  await finalize(rD.id, 'manual_review', 'elm_s1_unknown', null);
  assert.strictEqual((await state(811)).projected_estado, 14);
  pass('finalize refuses rejected / not_eligible without a definitive reason (technical, unknown, timeout, unmapped) → no estado 3');

  // ------------------------------------------------------------------ manual resolution of an active referral (13)
  const CI_Q = 90000001;
  const rQ = await job(901, CI_Q);
  await acquire(CI_Q, 901, rQ.id, null);
  const pQ = await referredProc(901, CI_Q);
  await finalize(rQ.id, 'referred', 'elm_s2_referred', pQ.id);
  assert.strictEqual((await state(901)).projected_estado, 13);
  assert.deepStrictEqual([(await resolveProc(901, 'provider_closed_no_loan', 'none')).status], ['cz_outcome_required'], 'no definitive evidence → stays pending');
  assert.strictEqual((await resolveProc(901, 'provider_closed_no_loan', null)).status, 'cz_outcome_required');
  assert.strictEqual((await resolveProc(901, 'customer_withdrew', 'rejected')).status, 'cz_outcome_mismatch');
  assert.strictEqual((await resolveProc(901, 'provider_loan_disbursed', 'granted')).status, 'evidence_required', 'granted needs Convertido');
  assert.strictEqual((await resolveProc(901, 'provider_closed_no_loan', 'maybe')).status, 'invalid_cz_outcome');
  assert.strictEqual((await one('SELECT ops_resolved_at FROM public.elm_lead_processes WHERE cz_solicitud_id = 901')).ops_resolved_at, null);
  const resQ = await resolveProc(901, 'provider_closed_no_loan', 'rejected');
  assert.strictEqual(resQ.status, 'resolved');
  assert.deepStrictEqual([resQ.cz_event.status, resQ.cz_event.from_estado, resQ.cz_event.target_estado], ['emitted', 13, 3]);
  const evQ = (await events(901)).find((e) => e.event_type === 'referral.resolved');
  assert.deepStrictEqual([evQ.seq, evQ.source_kind, evQ.outcome, evQ.reason_code, evQ.delivery_status], [2, 'elm_process', 'rejected', 'provider_closed_no_loan', 'pending']);
  const auQ = await one("SELECT actor_user_id, created_at, detail FROM public.elm_ops_audit_events WHERE entity_type = 'elm_process' AND entity_id = $1 AND action = 'resolved'", [pQ.id]);
  assert.strictEqual(auQ.actor_user_id, actor);
  assert.ok(auQ.created_at);
  assert.deepStrictEqual([auQ.detail.cz_outcome, auQ.detail.cz_from_estado, auQ.detail.cz_to_estado, auQ.detail.note, auQ.detail.cz_event_status],
    ['rejected', 13, 3, NOTE, 'emitted']);
  assert.ok('evidence' in auQ.detail && 'provider_status' in auQ.detail.evidence && 'disbursed_at' in auQ.detail.evidence);
  const lQ = await liveLock(901);
  assert.deepStrictEqual([lQ.state, lQ.blocks_future], ['consumed', false], 'referral closed: no longer blocks the CI');
  const headQ = (await pending()).find((e) => Number(e.cz_solicitud_id) === 901);
  assert.strictEqual(headQ.seq, 1);
  await ack(headQ.id, 'applied');
  const nextQ = (await pending()).find((e) => Number(e.cz_solicitud_id) === 901);
  assert.deepStrictEqual([nextQ.seq, nextQ.event_type, nextQ.target_estado], [2, 'referral.resolved', 3], 'delivered to CZ through PULL after the previous ACK');
  assert.strictEqual((await ack(nextQ.id, 'applied')).status, 'acked');

  const CI_Q2 = 90000002;
  const rQ2 = await job(902, CI_Q2);
  await acquire(CI_Q2, 902, rQ2.id, null);
  const pQ2 = await referredProc(902, CI_Q2);
  await finalize(rQ2.id, 'referred', 'elm_s2_referred', pQ2.id);
  await postback(902, CI_Q2, 'Convertido', 'convertido', pQ2.id);
  const resQ2 = await resolveProc(902, 'provider_loan_disbursed', 'granted');
  assert.deepStrictEqual([resQ2.status, resQ2.cz_event.target_estado], ['resolved', 16]);
  assert.strictEqual((await events(902)).filter((e) => e.target_estado === 16).length, 1);
  await lateReconcile([]);
  assert.strictEqual((await events(902)).length, 2, 'late reconcile adds no second 16');

  const pN = await claimProc(911, 90000003, 1, 'janus_batch');
  await sleep(1200);
  await expire(911);
  assert.strictEqual((await resolveProc(911, 'provider_confirmed_not_received', 'rejected')).status, 'cz_outcome_not_applicable', 'no C1 state: no CZ change');
  assert.strictEqual((await resolveProc(911, 'provider_confirmed_not_received', null)).status, 'resolved', 'default none keeps the 3B behaviour');
  assert.strictEqual((await liveLock(911)), null, 'confirmed not received → lock released by the settle trigger');
  assert.ok(pN.id);
  pass('referral 13: rejected (13→3) only with provider_closed_no_loan, granted (13→16) only with Convertido, otherwise stays pending; audited (actor, time, note, evidence, estado); event via PULL+ACK');

  // ------------------------------------------------------------------ ops tracking + conflicts
  const rows = (await svc('SELECT * FROM public.provider_c1_active_referrals($1, $2)', [72, 1000])).rows;
  const byCz = new Map(rows.map((r) => [Number(r.cz_solicitud_id), r]));
  assert.ok(rows.every((r) => [13, 14].includes(r.projected_estado)));
  assert.ok(!byCz.has(101) && !byCz.has(401), '16 and 3 are not active');
  const t301 = byCz.get(301);
  assert.strictEqual(t301.projected_estado, 13);
  assert.strictEqual(t301.last_event_type, 'review.resolved');
  assert.strictEqual(t301.unacked_events, 2);
  assert.strictEqual(t301.stale, false);
  assert.ok(Number(t301.age_hours) >= 0);
  const t201 = byCz.get(201) || rows.find((r) => r.projected_estado === 13 && r.fallback_outcome === 'referred');
  assert.ok(t201 && 'provider_status' in t201 && 'last_postback_at' in t201 && 'lock_state' in t201);
  const t511 = byCz.get(511);
  assert.strictEqual(t511.projected_estado, 14);
  await expectSqlError(() => svc('SELECT * FROM public.provider_c1_active_referrals(0, 10)'), /invalid_stale_hours/, 'stale hours');

  const cf = (await conflicts(401))[0];
  assert.strictEqual((await val('SELECT public.provider_cz_conflict_resolve($1, $2, $3) AS r', [cf.id, 'corta', actor])).status, 'note_required');
  assert.strictEqual((await val('SELECT public.provider_cz_conflict_resolve($1, $2, $3) AS r', [cf.id, NOTE, actor])).status, 'resolved');
  assert.strictEqual((await val('SELECT public.provider_cz_conflict_resolve($1, $2, $3) AS r', [cf.id, NOTE, actor])).status, 'already_resolved');
  const ca = await one("SELECT action FROM public.elm_ops_audit_events WHERE entity_type = 'cz_conflict' AND entity_id = $1", [cf.id]);
  assert.strictEqual(ca.action, 'resolved');
  assert.strictEqual((await state(401)).projected_estado, 3, 'resolving a conflict never changes CZ state');
  pass('ops: active referrals (13/14) with start, age, last ELM status, last event + unacked, conflicts, lock; conflict resolution audited, no state change');

  console.log('db-local-provider-fallback-c1-pglite: ' + groups + ' groups passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
