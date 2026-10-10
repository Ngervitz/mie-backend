'use strict';

/**
 * LOCAL database test: "Resolver ELM" from the solicitud detail goes through the existing
 * elm_resolve_process RPC; the CI lock is recalculated only by the existing settle trigger.
 * Migrations 1A + 1B + 3A + 3B + C1 + 20261011 + 20261012 (production state, step B not applied).
 *
 * DB CLASSIFICATION: LOCAL. In-process, in-memory PGlite. Never reads SUPABASE_* env vars and
 * never opens a network connection. PGLITE_DIR as in db-local-provider-fallback-c1-pglite.js.
 *
 * Covers the production shapes: Aceptado ELM (S2 { success: true, result: null }), S1 unknown
 * ("Repetido. Aprobado" / "Mocasist" stored as elm_response_undocumented) and S1 favorable with
 * S2 never started (solicitud 1106: S2 blocked before starting by an invalid mobile number).
 *
 * Run: node scripts/db-local-elm-resolve-detail-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openProcessView } = require('../src/services/elmOps/service');

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
  '20261012_elm_send_origin.sql',
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
CREATE TABLE public.cz_funnel_solicitud_estados (cz_solicitud_id bigint, solicitudes_estados_id integer);
CREATE TABLE public.cz_funnel_solicitudes (cz_id bigint PRIMARY KEY, solicitudes_estados_id integer);
`;

/** Same filter as GET /preaprobados/elm-ops/processes (elmOps repository listOpenProcesses). */
const OPEN_FILTER = "(s2_status IN ('referred', 'unknown') OR s1_status = 'unknown') AND ops_resolved_at IS NULL";
const S1_OK = 'Listo para recibir datos en servicio 2';
const NOTE = 'Confirmado con ELM por correo del 10/10.';

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
  await db.exec(STUBS);
  for (const m of MIGRATIONS) await db.exec(fs.readFileSync(MIG(m), 'utf8'));

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

  const claim = async (czId, ci) =>
    (await svc('SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11) AS r', [
      czId, ci, 'copanel', 'janus_manual', actor, 3, 'LRW-' + czId,
      JSON.stringify({ docNumber: String(ci), TrackingId: String(czId) }), 300, null, 'rechazados_manual',
    ])).rows[0].r;
  const finishS1 = (id, status, message, errorCode) =>
    svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, status, JSON.stringify({ result: message }), 200, message, 5, errorCode, null,
    ]);
  const beginS2 = (czId, ci) =>
    svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [
      czId, JSON.stringify({ docNumber: String(ci), TrackingId: String(czId) }), 300,
    ]);
  const finishS2Accepted = (id, ci) =>
    svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, 'unknown', JSON.stringify({ result: null, success: true, docNumber: String(ci) }), 200, null, 5,
      'elm_response_undocumented', null,
    ]);
  const settle = (czId) => svc('SELECT public.elm_ci_lock_settle($1) AS r', [czId]);
  const row = async (czId) =>
    (await su('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId]))[0];
  const lockOf = async (czId) =>
    (await su(
      "SELECT state, blocks_future, block_reason FROM public.elm_ci_send_locks WHERE cz_solicitud_id = $1 AND state <> 'released'",
      [czId],
    ))[0] || null;
  const tryOther = async (ci, czId) =>
    (await svc('SELECT public.elm_ci_lock_try($1, $2, NULL, $3, NULL) AS r', [ci, czId, 'janus_manual'])).rows[0].r;
  const resolve = async (czId, code, czOutcome) => {
    const p = await row(czId);
    return (await svc('SELECT public.elm_resolve_process($1, $2, $3, $4, $5, $6) AS r', [
      p.id, p.updated_at, code, NOTE, actor, czOutcome || 'none',
    ])).rows[0].r;
  };
  const view = async (czId) => openProcessView(await row(czId), { nowMs: Date.now() });
  const isListed = async (czId) =>
    (await su('SELECT count(*)::int AS n FROM public.elm_lead_processes WHERE cz_solicitud_id = $1 AND ' + OPEN_FILTER, [czId]))[0].n === 1;

  // Aceptado ELM (one of the 7)
  const ACC = [1333, 32392154];
  let c = await claim(ACC[0], ACC[1]);
  await finishS1(c.process.id, 'eligible', S1_OK, null);
  await beginS2(ACC[0], ACC[1]);
  await finishS2Accepted(c.process.id, ACC[1]);
  await settle(ACC[0]);

  // S1 unknown (the 4): resolved "not received" and "no referral"
  const S1A = [1341, 41960071];
  const S1B = [1421, 46816299];
  for (const [czId, ci, msg] of [[S1A[0], S1A[1], 'Repetido. Aprobado'], [S1B[0], S1B[1], 'Mocasist']]) {
    c = await claim(czId, ci);
    await finishS1(c.process.id, 'unknown', msg, 'elm_response_undocumented');
    await settle(czId);
  }

  // 1106: S1 favorable, S2 never started (blocked before beginS2)
  const NOS2 = [1106, 18827733];
  c = await claim(NOS2[0], NOS2[1]);
  await finishS1(c.process.id, 'eligible', S1_OK, null);
  await settle(NOS2[0]);

  // ------------------------------------------------------------------ what the detail offers
  assert.ok(await isListed(ACC[0]) && await isListed(S1A[0]) && await isListed(S1B[0]));
  assert.strictEqual(await isListed(NOS2[0]), false, '1106-like process is not in GET /processes');
  const vAcc = await view(ACC[0]);
  assert.deepStrictEqual([vAcc.kind, vAcc.s2_accepted, vAcc.allowed_resolutions, vAcc.correction_resolutions],
    ['s2_unknown', true, ['provider_closed_no_loan', 'provider_loan_disbursed', 'other'], ['provider_confirmed_not_received']]);
  const vS1 = await view(S1A[0]);
  assert.deepStrictEqual([vS1.kind, vS1.allowed_resolutions],
    ['s1_unknown', ['provider_confirmed_not_received', 'provider_confirmed_no_referral', 'other']]);
  assert.deepStrictEqual((await view(NOS2[0])).allowed_resolutions, [], '1106-like: no resolution offered');
  pass('the open-process view offers Aceptado / S1-unknown resolutions from the real rows; 1106-like gets none');

  // ------------------------------------------------------------------ CI locks before resolving
  assert.deepStrictEqual(await lockOf(ACC[0]), { state: 'consumed', blocks_future: true, block_reason: 'uncertain_referral' });
  assert.deepStrictEqual(await lockOf(S1A[0]), { state: 'reserved', blocks_future: false, block_reason: null });
  assert.deepStrictEqual(await lockOf(NOS2[0]), { state: 'reserved', blocks_future: false, block_reason: null });
  assert.strictEqual((await tryOther(ACC[1], 7001)).block, 'uncertain');
  assert.strictEqual((await tryOther(S1A[1], 7002)).block, 'uncertain');
  assert.strictEqual((await tryOther(NOS2[1], 7003)).block, 'send_in_progress', '1106-like keeps the CI as send in progress');
  pass('before: Aceptado and S1 unknown block their CI as uncertain; 1106-like as send in progress');

  // ------------------------------------------------------------------ Aceptado
  const noEvidence = await resolve(ACC[0], 'provider_loan_disbursed');
  assert.strictEqual(noEvidence.status, 'evidence_required');
  assert.strictEqual((await row(ACC[0])).ops_resolved_at, null);
  assert.strictEqual((await tryOther(ACC[1], 7001)).block, 'uncertain', 'nothing changed');
  const closed = await resolve(ACC[0], 'provider_closed_no_loan');
  assert.deepStrictEqual([closed.status, closed.kind], ['resolved', 's2_unknown']);
  assert.deepStrictEqual(await lockOf(ACC[0]), { state: 'consumed', blocks_future: false, block_reason: null });
  const accAfter = await tryOther(ACC[1], 7001);
  assert.deepStrictEqual([accAfter.status, accAfter.block], ['blocked', 'monthly_quota_used'], 'quota of the month stays used');
  assert.strictEqual(await isListed(ACC[0]), false, 'leaves the open list');
  const accAudit = await su("SELECT actor_user_id, detail FROM public.elm_ops_audit_events WHERE entity_id = $1 AND action = 'resolved'", [(await row(ACC[0])).id]);
  assert.deepStrictEqual([accAudit.length, accAudit[0].actor_user_id, accAudit[0].detail.resolution_code, accAudit[0].detail.note],
    [1, actor, 'provider_closed_no_loan', NOTE]);
  pass('Aceptado: "loan disbursed" without Convertido → evidence_required (no change); "closed no loan" → audited, stops blocking as uncertain, monthly quota still used');

  // ------------------------------------------------------------------ S1 unknown
  const notReceived = await resolve(S1A[0], 'provider_confirmed_not_received');
  assert.deepStrictEqual([notReceived.status, notReceived.kind], ['resolved', 's1_unknown']);
  assert.strictEqual(await lockOf(S1A[0]), null, 'not received → lock released');
  assert.strictEqual((await tryOther(S1A[1], 7002)).status, 'acquired', 'CI free again');

  const noReferral = await resolve(S1B[0], 'provider_confirmed_no_referral');
  assert.strictEqual(noReferral.status, 'resolved');
  assert.deepStrictEqual(await lockOf(S1B[0]), { state: 'consumed', blocks_future: false, block_reason: null });
  assert.strictEqual((await tryOther(S1B[1], 7004)).block, 'monthly_quota_used', 'received → quota used this month');
  assert.deepStrictEqual(
    (await su("SELECT detail->>'kind' AS kind, detail->>'resolution_code' AS code FROM public.elm_ops_audit_events WHERE cz_solicitud_id IN ($1, $2) AND action = 'resolved' ORDER BY cz_solicitud_id", [S1A[0], S1B[0]])),
    [{ kind: 's1_unknown', code: 'provider_confirmed_not_received' }, { kind: 's1_unknown', code: 'provider_confirmed_no_referral' }],
  );
  pass('S1 unknown: "not received" releases the lock (CI free); "no referral" keeps the month quota used; both audited');

  // ------------------------------------------------------------------ 1106-like and replays
  assert.strictEqual((await resolve(NOS2[0], 'other')).status, 'not_resolvable');
  assert.deepStrictEqual(await lockOf(NOS2[0]), { state: 'reserved', blocks_future: false, block_reason: null });
  assert.strictEqual((await resolve(S1A[0], 'other')).status, 'already_resolved');
  assert.strictEqual((await resolve(ACC[0], 'other')).status, 'already_resolved');
  pass('1106-like answers not_resolvable and keeps its lock; a resolved process cannot be resolved again');

  console.log('\ndb-local-elm-resolve-detail-pglite: ' + groups + ' groups passed (LOCAL PGlite, no network)');
  await db.close();
}

main().catch((err) => {
  console.error('FAIL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
