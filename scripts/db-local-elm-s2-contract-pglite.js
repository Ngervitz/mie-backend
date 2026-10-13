'use strict';

/**
 * LOCAL database test of migrations/20261013_elm_s2_success_true_referred.sql
 * on top of 1A + 1B + 3A + 3B.
 *
 * In-process PGlite. No network, no SUPABASE_* reads, no ELM call.
 * Run: node scripts/db-local-elm-s2-contract-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIG = (name) => path.join(__dirname, '..', 'migrations', name);

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

const REQ = JSON.stringify({ docNumber: '12345678', source: 'copanel', testInternalId: '1' });
const CONTRACT = JSON.stringify({ docNumber: '1', result: null, success: true });

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
  const one = async (sql, params) => (await svc(sql, params)).rows[0];

  async function seedUnknown(czId, ci, body, errorCode) {
    const claimed = await one(
      'SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) AS r',
      [czId, ci, 'copanel', 'cz_automatic', null, 6, 'LRW-' + czId, REQ, 300, null],
    );
    const id = claimed.r.process.id;
    await svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, 'eligible', '{"result":"Listo para recibir datos en servicio 2"}', 200,
      'Listo para recibir datos en servicio 2', 5, null, null,
    ]);
    await svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [czId, REQ, 300]);
    await svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, 'unknown', body, 200, null, 5, errorCode, null,
    ]);
    return one('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId]);
  }

  await db.exec(STUBS);
  for (const name of [
    '20261007_elm_lead_processes.sql',
    '20261007_elm_postback_events.sql',
    '20261008_provider_fallback_requests.sql',
    '20261009_elm_phase3b_operations.sql',
    '20261013_elm_s2_success_true_referred.sql',
  ]) {
    await db.exec(fs.readFileSync(MIG(name), 'utf8'));
  }
  await db.exec(fs.readFileSync(MIG('20261013_elm_s2_success_true_referred.sql'), 'utf8'));
  pass('migration applies twice on 1A+1B+3A+3B');

  const match = await seedUnknown(1195, 11111111, CONTRACT, 'elm_response_undocumented');
  const other = await seedUnknown(1488, 22222222, JSON.stringify({ result: 'Algo nuevo' }), 'elm_response_undocumented');
  const absent = await seedUnknown(1500, 33333333, JSON.stringify({ success: true, docNumber: '1' }), 'elm_response_undocumented');
  const stringTrue = await seedUnknown(1501, 44444444, JSON.stringify({ success: 'true', result: null }), 'elm_response_undocumented');
  assert.strictEqual(match.s2_status, 'unknown');
  assert.strictEqual(match.referred_at, null);
  const completedAt = match.s2_completed_at;
  const responseBefore = JSON.stringify(match.s2_response);

  const n1 = await one('SELECT public.elm_reconcile_s2_success_true() AS n');
  assert.strictEqual(n1.n, 1);
  const after = await one('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [1195]);
  assert.strictEqual(after.s2_status, 'referred');
  assert.strictEqual(new Date(after.referred_at).toISOString(), new Date(completedAt).toISOString());
  assert.strictEqual(new Date(after.s2_completed_at).toISOString(), new Date(completedAt).toISOString());
  assert.strictEqual(JSON.stringify(after.s2_response), responseBefore);
  assert.strictEqual(after.s2_http_status, 200);
  assert.strictEqual(after.s2_error_code, 'elm_response_undocumented');
  assert.strictEqual(after.s2_result_message, null);
  const audit = await one('SELECT count(*)::int AS n FROM public.elm_s2_contract_reconcile');
  assert.strictEqual(audit.n, 1);
  const auditRow = await one(
    'SELECT rule, cz_solicitud_id FROM public.elm_s2_contract_reconcile WHERE elm_process_id = $1',
    [match.id],
  );
  assert.strictEqual(auditRow.rule, 's2_success_true_result_null');
  assert.strictEqual(Number(auditRow.cz_solicitud_id), 1195);
  pass('matching row becomes referred with the original s2_completed_at and one audit row');

  const n2 = await one('SELECT public.elm_reconcile_s2_success_true() AS n');
  assert.strictEqual(n2.n, 0);
  const audit2 = await one('SELECT count(*)::int AS n FROM public.elm_s2_contract_reconcile');
  assert.strictEqual(audit2.n, 1);
  const after2 = await one('SELECT s2_status, referred_at FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [1195]);
  assert.strictEqual(after2.s2_status, 'referred');
  assert.strictEqual(new Date(after2.referred_at).toISOString(), new Date(completedAt).toISOString());
  pass('second call updates 0 rows and does not duplicate the audit');

  for (const czId of [1488, 1500, 1501]) {
    const row = await one('SELECT s2_status, referred_at FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId]);
    assert.strictEqual(row.s2_status, 'unknown', String(czId));
    assert.strictEqual(row.referred_at, null, String(czId));
  }
  pass('other unknown bodies, absent result, and string success stay unknown');

  await expectSqlError(
    () => svc(
      "UPDATE public.elm_lead_processes SET s2_status = 'referred', referred_at = s2_completed_at WHERE cz_solicitud_id = $1",
      [other.cz_solicitud_id],
    ),
    /elm_illegal_s2_transition/,
    'unknown without the contract',
  );
  await expectSqlError(
    () => svc(
      "UPDATE public.elm_lead_processes SET s2_status = 'referred', referred_at = s2_completed_at + interval '1 second' WHERE cz_solicitud_id = $1",
      [absent.cz_solicitud_id],
    ),
    /elm_illegal_s2_transition/,
    'referred_at other than s2_completed_at',
  );
  await expectSqlError(
    () => svc(
      "UPDATE public.elm_lead_processes SET s2_status = 'referred', referred_at = now() WHERE id = $1",
      [stringTrue.id],
    ),
    /elm_illegal_s2_transition/,
    'string success is not the contract',
  );
  pass('unknown -> referred outside the predicate is still rejected');

  const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.elm_s2_contract_reconcile'::regclass");
  assert.strictEqual(rls.rows[0].relrowsecurity, true);
  const pol = await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'elm_s2_contract_reconcile'");
  assert.strictEqual(pol.rows[0].n, 0);
  await expectSqlError(
    () => asRole('anon', () => db.query('SELECT public.elm_reconcile_s2_success_true()')),
    /permission denied/,
    'anon reconcile',
  );
  await expectSqlError(
    () => asRole('authenticated', () => db.query('SELECT * FROM public.elm_s2_contract_reconcile')),
    /permission denied/,
    'authenticated audit',
  );
  await expectSqlError(
    () => svc('UPDATE public.elm_s2_contract_reconcile SET rule = rule'),
    /permission denied|append-only/,
    'service_role cannot update the audit',
  );
  pass('audit table is RLS-on, append-only, and not executable by anon');

  console.log('\n' + groups + ' groups passed');
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
