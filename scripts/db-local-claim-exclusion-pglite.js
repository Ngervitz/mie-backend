'use strict';

/**
 * LOCAL: claim exclusion does not break one-job-per-CI; excluded rows never claim;
 * younger same-CI job claimable when older is excluded.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PGLITE_DIR =
  process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');
const MIG = (name) => path.join(__dirname, '..', 'migrations', name);
const EXCLUDED = [1490, 1491, 1948, 1962, 1966, 2424, 3115, 3532];
const STUBS = `
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
CREATE TABLE public.dashboard_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
`;
const HASH = crypto.createHash('sha256').update('snap').digest('hex');
const SNAP = JSON.stringify({ v: 1, applicant: { ci: '1' } });

async function main() {
  const { PGlite } = require(PGLITE_DIR);
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(fs.readFileSync(MIG('20261007_elm_lead_processes.sql'), 'utf8'));
  await db.exec(fs.readFileSync(MIG('20261007_elm_postback_events.sql'), 'utf8'));
  await db.exec(fs.readFileSync(MIG('20261008_provider_fallback_requests.sql'), 'utf8'));
  await db.exec(fs.readFileSync(MIG('20261120_provider_fallback_claim_excluded_cz.sql'), 'utf8'));

  async function enqueue(czId, ci) {
    await db.query('SELECT public.provider_fallback_enqueue($1, $2, $3::jsonb, $4)', [
      czId,
      ci,
      SNAP,
      HASH,
    ]);
  }
  async function claim(worker, limit, czId, excluded) {
    const r = await db.query(
      'SELECT cz_solicitud_id, exec_status FROM public.provider_fallback_claim($1, $2, $3, $4, $5)',
      [worker, 600, limit, czId, excluded || []],
    );
    return r.rows;
  }
  async function status(czId) {
    return (
      await db.query(
        'SELECT cz_solicitud_id, exec_status, claim_count FROM provider_fallback_requests WHERE cz_solicitud_id = $1',
        [czId],
      )
    ).rows[0];
  }

  const ci = 10768808;
  await enqueue(1490, ci);
  await enqueue(1491, ci);
  await enqueue(5001, ci);

  const excluded0 = await claim('w', 10, null, []);
  assert.deepStrictEqual(
    excluded0.map((r) => Number(r.cz_solicitud_id)),
    [1490],
    'without exclusion: oldest CI job claims first',
  );

  await db.query(
    "UPDATE provider_fallback_requests SET exec_status='queued', job_lease_owner=null, job_lease_expires_at=null WHERE cz_solicitud_id=1490",
  );

  const withEx = await claim('w2', 10, null, EXCLUDED);
  const claimed = withEx.map((r) => Number(r.cz_solicitud_id));
  assert.ok(!claimed.includes(1490) && !claimed.includes(1491), 'excluded never claimed');
  assert.deepStrictEqual(claimed, [5001], 'younger same-CI claimable when older excluded');

  assert.strictEqual((await status(1490)).claim_count, 1, '1490 claim_count unchanged after second pass');
  assert.strictEqual((await status(1490)).exec_status, 'queued', '1490 stays queued');

  const targeted = await claim('w3', 1, 1490, EXCLUDED);
  assert.strictEqual(targeted.length, 0, 'targeted claim cannot bypass exclusion list');

  const ci2 = 22222222;
  await enqueue(8001, ci2);
  await enqueue(8002, ci2);
  const pair = await claim('w4', 10, null, []);
  assert.deepStrictEqual(
    pair.map((r) => Number(r.cz_solicitud_id)),
    [8001],
    'concurrency: only one per CI per batch',
  );

  console.log('db-local-claim-exclusion-pglite: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});