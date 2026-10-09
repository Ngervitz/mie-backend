'use strict';

/**
 * REAL PostgreSQL concurrency test (several connections, truly concurrent transactions) of
 * migrations/20261011_elm_manual_pre_reception_retry.sql on top of 1A + 1B + 3A + 3B + C1.
 *
 * DB CLASSIFICATION: LOCAL. Same throwaway cluster setup as
 * scripts/db-local-provider-fallback-c1-realpg.js (initdb in a temp directory, 127.0.0.1 on a
 * random port, deleted at the end). Never reads SUPABASE_* env vars.
 * Binaries / driver: C1_REALPG_BIN, C1_REALPG_PG (see that file).
 *
 * Run: node scripts/db-local-elm-manual-retry-realpg.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

const BASE = path.join(os.tmpdir(), 'c1-realpg', 'node_modules');
const BIN = process.env.C1_REALPG_BIN || path.join(BASE, '@embedded-postgres', 'windows-x64', 'native', 'bin');
const PG_DRIVER = process.env.C1_REALPG_PG || path.join(BASE, 'pg');
const EXE = process.platform === 'win32' ? '.exe' : '';

const MIG = (name) => path.join(__dirname, '..', 'migrations', name);
const MIGRATIONS = [
  '20261007_elm_lead_processes.sql',
  '20261007_elm_postback_events.sql',
  '20261008_provider_fallback_requests.sql',
  '20261009_elm_phase3b_operations.sql',
  '20261010_provider_fallback_c1_events.sql',
  '20261011_elm_manual_pre_reception_retry.sql',
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

const REQ = JSON.stringify({ docNumber: '51001152', source: 'copanel' });
const N = 8;

let groups = 0;
function pass(label) {
  groups += 1;
  console.log('ok - ' + label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function main() {
  const initdb = path.join(BIN, 'initdb' + EXE);
  const pgCtl = path.join(BIN, 'pg_ctl' + EXE);
  let pg;
  try {
    if (!fs.existsSync(initdb) || !fs.existsSync(pgCtl)) throw new Error('binaries not found');
    pg = require(PG_DRIVER);
  } catch (e) {
    console.error('Local PostgreSQL binaries / pg driver not available (' + e.message + '). Set C1_REALPG_BIN / C1_REALPG_PG. SKIPPED.');
    process.exit(2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elm-retry-realpg-data-'));
  const data = path.join(dir, 'data');
  const port = await freePort();
  execFileSync(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C', '--lc-messages=C'], {
    stdio: 'ignore',
    env: Object.assign({}, process.env, { LANG: 'C', LC_ALL: 'C' }),
  });
  execFileSync(pgCtl, ['start', '-D', data, '-w', '-l', path.join(dir, 'pg.log'), '-o', '-p ' + port + ' -c listen_addresses=127.0.0.1'], {
    stdio: 'ignore',
  });

  const clients = [];
  const connect = async (role) => {
    const c = new pg.Client({ host: '127.0.0.1', port: port, user: 'postgres', database: 'postgres' });
    await c.connect();
    if (role) await c.query('SET ROLE ' + role);
    clients.push(c);
    return c;
  };

  try {
    const admin = await connect(null);
    await admin.query(STUBS);
    for (const m of MIGRATIONS) await admin.query(fs.readFileSync(MIG(m), 'utf8'));
    const ver = (await admin.query('SHOW server_version')).rows[0].server_version;
    const actor = (await admin.query('INSERT INTO public.dashboard_users DEFAULT VALUES RETURNING id')).rows[0].id;
    pass('real PostgreSQL ' + ver + ' on 127.0.0.1:' + port + ' (temp cluster); 1A+1B+3A+3B+C1+manual retry applied');

    const conns = [];
    for (let i = 0; i < N; i += 1) conns.push(await connect('service_role'));
    const [A, B] = conns;
    const val = async (c, sql, params) => (await c.query(sql, params || [])).rows[0].r;

    const claim = (c, czId, ci) =>
      val(c, 'SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) AS r', [
        czId, ci, 'copanel', 'janus_manual', actor, 12, 'LRW-' + czId, REQ, 300, null,
      ]);
    const auth403 = (c, id) =>
      c.query('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
        id, 'technical_error', '{"error":{"code":"INVALID_LOGIN_ATTEMPT"}}', 403, null, 487, 'elm_http_auth_rejected', null,
      ]);
    const mretry = (c, czId, expected) =>
      val(c, 'SELECT public.elm_manual_retry_s1($1, $2, $3, $4, $5) AS r', [czId, expected, 3, 300, actor]);
    const count = async (sql, params) => Number((await admin.query(sql, params)).rows[0].n);
    const liveLocks = (ci) => count("SELECT count(*)::int AS n FROM public.elm_ci_send_locks WHERE ci = $1 AND state <> 'released'", [ci]);
    const archived = (czId) => count('SELECT count(*)::int AS n FROM public.elm_step_attempts WHERE cz_solicitud_id = $1', [czId]);
    const audits = (czId) => count("SELECT count(*)::int AS n FROM public.elm_ops_audit_events WHERE cz_solicitud_id = $1 AND action = 'retried'", [czId]);
    const failedProcess = async (czId, ci) => {
      const p = (await claim(A, czId, ci)).process;
      await auth403(A, p.id);
      return p;
    };

    // 1) N admins press "Reintentar ELM" on 1430 at the same time.
    const CI1 = 51001152;
    const p1 = await failedProcess(1430, CI1);
    const burst = await Promise.all(conns.map((c) => mretry(c, 1430, 1)));
    const statuses = burst.map((r) => r.status).sort();
    assert.strictEqual(statuses.filter((s) => s === 'retried').length, 1, JSON.stringify(statuses));
    assert.ok(statuses.every((s) => s === 'retried' || s === 'stale'), JSON.stringify(statuses));
    const row1 = (await admin.query('SELECT id, s1_status, s1_attempts FROM public.elm_lead_processes WHERE cz_solicitud_id = 1430')).rows[0];
    assert.deepStrictEqual([row1.id, row1.s1_status, row1.s1_attempts], [p1.id, 'in_flight', 2]);
    assert.deepStrictEqual([await liveLocks(CI1), await archived(1430), await audits(1430)], [1, 1, 1]);
    pass(N + ' concurrent manual retries of 1430: exactly 1 retried, ' + (N - 1) + ' stale; same process, attempt 2, 1 reservation, 1 archived attempt, 1 audit');

    // 2) Manual retry racing first sends of other solicitudes of the same CI.
    const CI2 = 51002002;
    await failedProcess(2000, CI2);
    const race = await Promise.all(
      conns.map((c, i) =>
        i === 0
          ? mretry(c, 2000, 1).then((r) => r.status === 'retried')
          : claim(c, 2000 + i, CI2).then((r) => r.claimed === true),
      ),
    );
    assert.strictEqual(race.filter(Boolean).length, 1, 'one winner across the retry and the claims');
    assert.strictEqual(await liveLocks(CI2), 1);
    const procs2 = await count('SELECT count(*)::int AS n FROM public.elm_lead_processes WHERE ci = $1 AND s1_status = $2', [CI2, 'in_flight']);
    assert.strictEqual(procs2, 1, 'only one S1 in flight for the CI');
    pass('manual retry racing ' + (N - 1) + ' claims of other solicitudes of the same CI: exactly one reservation, one S1 in flight');

    // 3) Explicit overlap on the per-CI advisory lock, both directions.
    const CI3 = 51002003;
    await failedProcess(3000, CI3);
    await A.query('BEGIN');
    assert.strictEqual((await mretry(A, 3000, 1)).status, 'retried');
    let bDone = false;
    const bClaim = claim(B, 3001, CI3).then((r) => {
      bDone = true;
      return r;
    });
    await sleep(400);
    assert.strictEqual(bDone, false, 'claim waits while the retry transaction is open');
    await A.query('COMMIT');
    const b3 = await bClaim;
    assert.deepStrictEqual([b3.claimed, b3.blocked.block, Number(b3.blocked.related_cz_solicitud_id)], [false, 'send_in_progress', 3000]);

    const CI4 = 51002004;
    await failedProcess(4000, CI4);
    await A.query('BEGIN');
    assert.strictEqual((await claim(A, 4001, CI4)).claimed, true);
    let rDone = false;
    const bRetry = mretry(B, 4000, 1).then((r) => {
      rDone = true;
      return r;
    });
    await sleep(400);
    assert.strictEqual(rDone, false, 'retry waits while the claim transaction is open');
    await A.query('COMMIT');
    const r4 = await bRetry;
    assert.deepStrictEqual([r4.status, r4.lock.block], ['blocked', 'send_in_progress']);
    assert.deepStrictEqual([await liveLocks(CI4), await archived(4000), await audits(4000)], [1, 0, 0]);
    pass('advisory lock: an open retry makes a claim of the same CI wait and then refuse; an open claim makes the retry wait and then return blocked without writing');

    // 4) Rollback of the caller transaction and an injected failure leave nothing behind.
    const CI5 = 51002005;
    const p5 = await failedProcess(5000, CI5);
    await A.query('BEGIN');
    assert.strictEqual((await mretry(A, 5000, 1)).status, 'retried');
    await A.query('ROLLBACK');
    assert.deepStrictEqual([await liveLocks(CI5), await archived(5000), await audits(5000)], [0, 0, 0]);
    assert.strictEqual((await admin.query('SELECT s1_status FROM public.elm_lead_processes WHERE id = $1', [p5.id])).rows[0].s1_status, 'technical_error');

    await admin.query(`CREATE OR REPLACE FUNCTION public._test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test_injected_failure'; END; $$;`);
    await admin.query('CREATE TRIGGER _test_fail BEFORE INSERT ON public.elm_ops_audit_events FOR EACH ROW EXECUTE FUNCTION public._test_fail()');
    let failed = null;
    try {
      await mretry(A, 5000, 1);
    } catch (e) {
      failed = e;
    }
    await admin.query('DROP TRIGGER _test_fail ON public.elm_ops_audit_events');
    assert.ok(failed && /test_injected_failure/.test(failed.message), 'audit failure surfaces');
    assert.deepStrictEqual([await liveLocks(CI5), await archived(5000), await audits(5000)], [0, 0, 0]);
    const parallel = await Promise.all([mretry(A, 5000, 1), mretry(B, 5000, 1)]);
    assert.deepStrictEqual(parallel.map((r) => r.status).sort(), ['retried', 'stale'], 'advisory lock released by the rollback');
    assert.deepStrictEqual([await liveLocks(CI5), await archived(5000), await audits(5000)], [1, 1, 1]);
    pass('caller ROLLBACK and an injected audit failure leave no reservation, archive or audit; the CI is not left locked (next retry works once)');

    // 5) Automatic path unchanged: elm_retry_step cannot touch a pre-reception failure, even racing the manual retry.
    const CI6 = 51002006;
    await failedProcess(6000, CI6);
    const workerSql = 'SELECT id FROM public.elm_retry_step($1, $2, $3, $4, $5::text[], $6)';
    const mixed = await Promise.all(
      conns.map((c, i) =>
        i % 2 === 0
          ? c.query(workerSql, [6000, 's1', 1, 3, ['elm_http_auth_rejected'], 300]).then((r) => (r.rows.length ? 'worker' : 'worker_noop'))
          : mretry(c, 6000, 1).then((r) => r.status),
      ),
    );
    assert.strictEqual(mixed.filter((s) => s === 'worker').length, 0, 'worker never retries it (no live lock before the manual retry; stale after)');
    assert.strictEqual(mixed.filter((s) => s === 'retried').length, 1, JSON.stringify(mixed));
    assert.deepStrictEqual([await liveLocks(CI6), await archived(6000)], [1, 1]);
    pass('automatic elm_retry_step racing manual retries: the worker never resends a pre-reception failure; exactly one manual retry');

    console.log('db-local-elm-manual-retry-realpg: ' + groups + ' groups passed (LOCAL real PostgreSQL, ' + N + ' connections)');
  } finally {
    for (const c of clients) await c.end().catch(() => {});
    try {
      execFileSync(pgCtl, ['stop', '-D', data, '-m', 'fast', '-w'], { stdio: 'ignore' });
    } catch (_) {
      /* already stopped */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
