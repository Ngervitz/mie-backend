'use strict';

/**
 * LOCAL PGlite smoke test: 20261016 + 20261017 (admin provider resend).
 * Run: node scripts/db-local-elm-admin-provider-resend-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PGLITE_DIR =
  process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIG = (name) => path.join(__dirname, '..', 'migrations', name);
const BASE = [
  '20261007_elm_lead_processes.sql',
  '20261007_elm_postback_events.sql',
  '20261008_provider_fallback_requests.sql',
  '20261009_elm_phase3b_operations.sql',
  '20261010_provider_fallback_c1_events.sql',
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

const S1 = JSON.stringify({ docNumber: '52764618', source: 'copanel' });

async function main() {
  let PGlite;
  try {
    PGlite = require(PGLITE_DIR).PGlite;
  } catch (e) {
    console.log('SKIPPED: PGlite not at ' + PGLITE_DIR);
    return;
  }
  const db = new PGlite();
  await db.exec(STUBS);
  for (const f of BASE) await db.exec(fs.readFileSync(MIG(f), 'utf8'));
  await db.exec(fs.readFileSync(MIG('20261016_elm_gestion_send_audit.sql'), 'utf8'));
  await db.exec(fs.readFileSync(MIG('20261017_elm_admin_provider_resend.sql'), 'utf8'));

  const actor = (
    await db.query('INSERT INTO public.dashboard_users DEFAULT VALUES RETURNING id')
  ).rows[0].id;

  const claimOut = (
    await db.query(
      `SELECT public.elm_claim_process($1::bigint, $2::bigint, 'copanel', 'janus_manual', $3::uuid, 12, 'LRW-1912', $4::jsonb, 300, NULL) AS r`,
      [1912, 52764618, actor, S1],
    )
  ).rows[0].r;
  assert.strictEqual(claimOut.claimed, true);
  await db.query(
    `SELECT * FROM public.elm_finish_s1($1::uuid, 'rejected', '{"r":1}'::jsonb, 400, 'SCORE BAJO', 100, NULL, NULL)`,
    [claimOut.process.id],
  );

  const upd = (await db.query('SELECT updated_at FROM elm_lead_processes WHERE cz_solicitud_id = 1912'))
    .rows[0].updated_at;

  const snapRejected = (
    await db.query('SELECT s1_status, s1_result_message FROM elm_lead_processes WHERE cz_solicitud_id = 1912')
  ).rows[0];

  await db.query(
    `INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
     VALUES ('elm_process', $1::uuid, 1912, 'gestion_send', $2::uuid, $3::jsonb)`,
    [claimOut.process.id, actor, JSON.stringify({ provider_reference: 'REF-EARLIER' })],
  );
  const dupEarly = await db.query(
    `SELECT (public.elm_admin_provider_resend($1::bigint, $2::timestamptz, 'REF-EARLIER', $3::jsonb, 300, $4::uuid) ->> 'reason') AS reason`,
    [1912, upd, S1, actor],
  );
  assert.strictEqual(dupEarly.rows[0].reason, 'duplicate_provider_reference');
  assert.deepStrictEqual(
    (await db.query('SELECT s1_status, s1_result_message FROM elm_lead_processes WHERE cz_solicitud_id = 1912')).rows[0],
    snapRejected,
  );
  console.log('ok - duplicate provider_reference refused with no process write');

  const ready = await db.query(
    `SELECT public.elm_admin_provider_resend($1::bigint, $2::timestamptz, $3::text, $4::jsonb, 300, $5::uuid) AS out`,
    [1912, upd, 'REF-OK-1', S1, actor],
  );
  assert.strictEqual(ready.rows[0].out.status, 'ready');
  assert.strictEqual(
    (await db.query('SELECT s1_status FROM elm_lead_processes WHERE cz_solicitud_id = 1912')).rows[0]
      .s1_status,
    'in_flight',
  );
  assert.strictEqual(
    Number((await db.query('SELECT count(*)::int AS c FROM elm_step_attempts WHERE cz_solicitud_id = 1912')).rows[0].c),
    0,
    'rejected S1 is not elm_step_attempts row; cycle lives in audit',
  );
  const audRow = (
    await db.query(
      "SELECT detail FROM elm_ops_audit_events WHERE action = 'gestion_send' AND cz_solicitud_id = 1912 ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  assert.strictEqual(audRow.detail.archived_cycle.s1.status, 'rejected');
  assert.strictEqual(audRow.detail.kind, 'provider_admin_resend');
  console.log('ok - rejected S1: archived_cycle in audit, ready + in_flight, no step_attempts violation');

  const updBeforeBlock = (
    await db.query('SELECT updated_at, s1_status FROM elm_lead_processes WHERE cz_solicitud_id = 1912')
  ).rows[0];
  assert.strictEqual(updBeforeBlock.s1_status, 'in_flight');

  const inFlight = await db.query(
    `SELECT (public.elm_admin_provider_resend($1::bigint, $2::timestamptz, 'REF-OK-2', $3::jsonb, 300, $4::uuid) ->> 'reason') AS reason`,
    [1912, updBeforeBlock.updated_at, S1, actor],
  );
  assert.strictEqual(inFlight.rows[0].reason, 'in_flight');
  console.log('ok - second admin resend refused while s1 in_flight');

  const stale = await db.query(
    `SELECT (public.elm_admin_provider_resend($1::bigint, $2::timestamptz, 'REF-OK-2', $3::jsonb, 300, $4::uuid) ->> 'status') AS status`,
    [1912, upd, S1, actor],
  );
  assert.strictEqual(stale.rows[0].status, 'stale');
  console.log('ok - stale expected_updated_at (operator saw old version)');

  console.log('db-local-elm-admin-provider-resend-pglite: passed');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
