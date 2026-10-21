'use strict';

/**
 * Real PostgreSQL test for persist_affiliate_plan.
 *
 * LOCAL only. Creates a throwaway cluster on 127.0.0.1, applies the affiliate
 * migrations, and deletes the cluster at the end. Does not read SUPABASE_*.
 *
 * Binaries, same layout as the other local real-Postgres harnesses:
 *   C1_REALPG_BIN  default %TEMP%/c1-realpg/node_modules/@embedded-postgres/windows-x64/native/bin
 *   C1_REALPG_PG   default %TEMP%/c1-realpg/node_modules/pg
 *
 * Run: node scripts/db-local-affiliate-persist-realpg.js
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

const AFF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AFF_TEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLICK = '22222222-2222-4222-8222-222222222222';
const CLICK_TEST = '33333333-3333-4333-8333-333333333333';
const BAD_CLICK = '99999999-9999-4999-8999-999999999999';
const T0 = '2026-09-21T14:21:00.000Z';
const T1 = '2026-10-21T14:21:00.000Z';
const T_EARLY = '2026-10-20T14:21:00.000Z';
const T_EVAL = '2026-10-21T18:00:00.000Z';
const T_LATER = '2026-10-21T19:00:00.000Z';
const T_OLD = '2026-10-21T17:00:00.000Z';

const STUBS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`;

let groups = 0;
function pass(label) {
  groups += 1;
  console.log('ok - ' + label);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function ids(list) {
  return '{' + list.join(',') + '}';
}

function row(fields) {
  return Object.assign({
    click_id: null,
    affiliate_id: null,
    occurred_at: null,
    presentation_at: null,
    presentation_text: null,
    is_test: false,
    prize_eligible: false,
  }, fields);
}

function origin(fields) {
  return Object.assign({
    is_test: false,
    prize_eligible: false,
  }, fields);
}

async function plan(client, evaluatedAt, scope, attributions, originators) {
  const result = await client.query(
    'SELECT public.persist_affiliate_plan($1::timestamptz, $2::bigint[], $3::jsonb, $4::jsonb) AS r',
    [evaluatedAt, ids(scope), JSON.stringify(attributions), JSON.stringify(originators)],
  );
  return result.rows[0].r;
}

async function fails(client, evaluatedAt, scope, attributions, originators) {
  try {
    await plan(client, evaluatedAt, scope, attributions, originators);
  } catch (err) {
    return err;
  }
  throw new Error('expected persist_affiliate_plan to fail');
}

async function main() {
  const initdb = path.join(BIN, 'initdb' + EXE);
  const pgCtl = path.join(BIN, 'pg_ctl' + EXE);
  let pg;
  try {
    if (!fs.existsSync(initdb) || !fs.existsSync(pgCtl)) {
      throw new Error('binaries not found');
    }
    pg = require(PG_DRIVER);
  } catch (err) {
    console.error('BLOQUEANTE para deploy: PostgreSQL local no está disponible (' + err.message + ').');
    console.error('El harness quedó en scripts/db-local-affiliate-persist-realpg.js y no se ejecutó.');
    process.exit(2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-persist-pg-'));
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
  async function connect(role) {
    const client = new pg.Client({
      host: '127.0.0.1',
      port: port,
      user: 'postgres',
      database: 'postgres',
    });
    await client.connect();
    if (role) await client.query('SET ROLE ' + role);
    clients.push(client);
    return client;
  }

  try {
    const admin = await connect(null);
    await admin.query(STUBS);
    for (const name of [
      '20261020_affiliates_clicks.sql',
      '20261021_affiliate_attributions.sql',
      '20261022_affiliate_persist_plan.sql',
    ]) {
      await admin.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', name), 'utf8'));
    }
    const version = (await admin.query('SHOW server_version')).rows[0].server_version;
    const ciType = (await admin.query(
      "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'affiliate_attributions' AND column_name = 'ci'",
    )).rows[0].data_type;
    const scopeType = (await admin.query(
      "SELECT format_type(proargtypes[1], NULL) AS t FROM pg_proc WHERE proname = 'persist_affiliate_plan'",
    )).rows[0].t;
    assert.strictEqual(ciType, 'bigint');
    assert.strictEqual(scopeType, 'bigint[]');
    const definer = (await admin.query(
      "SELECT prosecdef FROM pg_proc WHERE proname = 'persist_affiliate_plan'",
    )).rows[0].prosecdef;
    assert.strictEqual(definer, false);
    assert.strictEqual(await admin.query(
      "SELECT has_function_privilege('anon', 'public.persist_affiliate_plan(timestamptz, bigint[], jsonb, jsonb)', 'EXECUTE') AS ok",
    ).then((r) => r.rows[0].ok), false);
    assert.strictEqual(await admin.query(
      "SELECT has_function_privilege('service_role', 'public.persist_affiliate_plan(timestamptz, bigint[], jsonb, jsonb)', 'EXECUTE') AS ok",
    ).then((r) => r.rows[0].ok), true);
    pass('PostgreSQL ' + version + ' on 127.0.0.1:' + port + '; ci bigint; invoker; execute only for service_role');

    await admin.query(
      "INSERT INTO public.affiliates (id, code, status, is_test) VALUES ($1, 'testcode', 'active', false), ($2, 'testonly', 'active', true)",
      [AFF, AFF_TEST],
    );
    await admin.query(
      'INSERT INTO public.affiliate_clicks (click_id, affiliate_id, occurred_at) VALUES ($1, $2, $3), ($4, $5, $3)',
      [CLICK, AFF, T0, CLICK_TEST, AFF_TEST],
    );

    const db = await connect('service_role');
    const anon = await connect('anon');
    const other = await connect('service_role');

    const denied = await fails(anon, T_EVAL, [600], [
      row({ cz_id: 1, ci: 600, outcome: 'no_click' }),
    ], []);
    assert.strictEqual(denied.code, '42501');
    pass('anon cannot execute persist_affiliate_plan');

    const first = await plan(db, T_EVAL, [600], [
      row({
        cz_id: 20,
        ci: 600,
        outcome: 'attributed',
        click_id: CLICK,
        affiliate_id: AFF,
        occurred_at: T0,
        presentation_at: T1,
        presentation_text: T1,
      }),
    ], [
      origin({
        ci: 600,
        affiliate_id: AFF,
        first_cz_id: 20,
        first_presentation_at: T1,
      }),
    ]);
    assert.deepStrictEqual(first.applied_ci.map(Number), [600]);
    assert.deepStrictEqual(first.skipped_ci, []);
    const linked = await db.query(
      'SELECT o.first_cz_id, a.cz_id IS NOT NULL AS fk_ok, a.prize_eligible, o.prize_eligible AS origin_prize FROM public.affiliate_originators o JOIN public.affiliate_attributions a ON a.cz_id = o.first_cz_id WHERE o.ci = 600',
    );
    assert.strictEqual(linked.rows.length, 1);
    assert.strictEqual(Number(linked.rows[0].first_cz_id), 20);
    assert.strictEqual(linked.rows[0].fk_ok, true);
    assert.strictEqual(linked.rows[0].prize_eligible, false);
    assert.strictEqual(linked.rows[0].origin_prize, false);
    pass('initial insert writes the attribution before the originator and the foreign key holds');

    const again = await plan(db, T_EVAL, [600], [
      row({
        cz_id: 20,
        ci: 600,
        outcome: 'attributed',
        click_id: CLICK,
        affiliate_id: AFF,
        occurred_at: T0,
        presentation_at: T1,
        presentation_text: T1,
      }),
    ], [
      origin({
        ci: 600,
        affiliate_id: AFF,
        first_cz_id: 20,
        first_presentation_at: T1,
      }),
    ]);
    assert.deepStrictEqual(again.idempotent_ci.map(Number), [600]);
    assert.strictEqual(again.attribution_count, 0);
    const stamp = (await db.query(
      'SELECT updated_at FROM public.affiliate_originators WHERE ci = 600',
    )).rows[0].updated_at.toISOString();
    assert.strictEqual(stamp, T_EVAL);
    pass('replaying the same plan at the same timestamp does not rewrite the originator');

    const tie = await plan(db, T_EVAL, [600], [
      row({
        cz_id: 20,
        ci: 600,
        outcome: 'no_click',
        presentation_at: T1,
        presentation_text: T1,
      }),
    ], []);
    assert.deepStrictEqual(tie.skipped_ci.map(Number), [600]);
    const still = (await db.query(
      "SELECT outcome FROM public.affiliate_attributions WHERE cz_id = 20",
    )).rows[0].outcome;
    assert.strictEqual(still, 'attributed');
    pass('an equal timestamp with a different plan is skipped and does not overwrite');

    const recalc = await plan(db, T_LATER, [600], [
      row({
        cz_id: 10,
        ci: 600,
        outcome: 'attributed',
        click_id: CLICK,
        affiliate_id: AFF,
        occurred_at: T0,
        presentation_at: T_EARLY,
        presentation_text: T_EARLY,
      }),
      row({
        cz_id: 20,
        ci: 600,
        outcome: 'attributed',
        click_id: CLICK,
        affiliate_id: AFF,
        occurred_at: T0,
        presentation_at: T1,
        presentation_text: T1,
      }),
    ], [
      origin({
        ci: 600,
        affiliate_id: AFF,
        first_cz_id: 10,
        first_presentation_at: T_EARLY,
      }),
    ]);
    assert.deepStrictEqual(recalc.applied_ci.map(Number), [600]);
    const moved = (await db.query(
      'SELECT first_cz_id FROM public.affiliate_originators WHERE ci = 600',
    )).rows[0];
    assert.strictEqual(Number(moved.first_cz_id), 10);
    pass('a later plan recalculates the provisional originator in the same transaction');

    const bare = await plan(db, T_EVAL, [800], [
      row({ cz_id: 80, ci: 800, outcome: 'no_click', presentation_text: null }),
    ], []);
    assert.deepStrictEqual(bare.applied_ci.map(Number), [800]);
    assert.strictEqual(bare.originator_count, 0);
    const kept = (await db.query(
      'SELECT last_evaluated_at FROM public.affiliate_ci_evaluations WHERE ci = 800',
    )).rows[0].last_evaluated_at.toISOString();
    assert.strictEqual(kept, T_EVAL);
    assert.strictEqual(Number((await db.query(
      'SELECT count(*)::int AS n FROM public.affiliate_originators WHERE ci = 800',
    )).rows[0].n), 0);
    const staleBare = await plan(db, T_OLD, [800], [
      row({
        cz_id: 80,
        ci: 800,
        outcome: 'attributed',
        click_id: CLICK,
        affiliate_id: AFF,
        occurred_at: T0,
        presentation_at: T1,
        presentation_text: T1,
      }),
    ], [
      origin({ ci: 800, affiliate_id: AFF, first_cz_id: 80, first_presentation_at: T1 }),
    ]);
    assert.deepStrictEqual(staleBare.skipped_ci.map(Number), [800]);
    assert.strictEqual(Number((await db.query(
      'SELECT count(*)::int AS n FROM public.affiliate_originators WHERE ci = 800',
    )).rows[0].n), 0);
    assert.strictEqual((await db.query(
      'SELECT last_evaluated_at FROM public.affiliate_ci_evaluations WHERE ci = 800',
    )).rows[0].last_evaluated_at.toISOString(), T_EVAL);
    pass('a cédula without an originator keeps last_evaluated_at and rejects an older plan');

    const tested = await plan(db, T_EVAL, [700], [
      row({
        cz_id: 70,
        ci: 700,
        outcome: 'attributed',
        click_id: CLICK_TEST,
        affiliate_id: AFF_TEST,
        occurred_at: T0,
        presentation_at: T1,
        presentation_text: T1,
        is_test: true,
      }),
    ], [
      origin({
        ci: 700,
        affiliate_id: AFF_TEST,
        first_cz_id: 70,
        first_presentation_at: T1,
        is_test: true,
      }),
    ]);
    assert.deepStrictEqual(tested.applied_ci.map(Number), [700]);
    const testRow = (await db.query(
      'SELECT is_test, prize_eligible FROM public.affiliate_attributions WHERE cz_id = 70',
    )).rows[0];
    assert.strictEqual(testRow.is_test, true);
    assert.strictEqual(testRow.prize_eligible, false);
    const prize = await fails(db, T_LATER, [700], [
      row({
        cz_id: 70,
        ci: 700,
        outcome: 'attributed',
        click_id: CLICK_TEST,
        affiliate_id: AFF_TEST,
        occurred_at: T0,
        presentation_at: T1,
        presentation_text: T1,
        is_test: true,
        prize_eligible: true,
      }),
    ], []);
    assert.ok(prize);
    const afterPrize = (await db.query(
      'SELECT outcome, prize_eligible, evaluated_at FROM public.affiliate_attributions WHERE cz_id = 70',
    )).rows[0];
    assert.strictEqual(afterPrize.prize_eligible, false);
    assert.strictEqual(afterPrize.evaluated_at.toISOString(), T_EVAL);
    pass('a test affiliate can be attributed and prize_eligible=true rolls back without changing the row');

    await plan(db, T_EVAL, [900], [
      row({ cz_id: 90, ci: 900, outcome: 'no_click' }),
    ], []);
    const broken = await fails(db, T_LATER, [901, 902], [
      row({ cz_id: 91, ci: 901, outcome: 'no_click' }),
      row({
        cz_id: 92,
        ci: 902,
        outcome: 'attributed',
        click_id: BAD_CLICK,
        affiliate_id: AFF,
        occurred_at: T0,
        presentation_at: T1,
        presentation_text: T1,
      }),
    ], [
      origin({ ci: 902, affiliate_id: AFF, first_cz_id: 92, first_presentation_at: T1 }),
    ]);
    assert.strictEqual(broken.code, '23503');
    assert.strictEqual(Number((await db.query(
      'SELECT count(*)::int AS n FROM public.affiliate_attributions WHERE ci IN (901, 902)',
    )).rows[0].n), 0);
    assert.strictEqual(Number((await db.query(
      'SELECT count(*)::int AS n FROM public.affiliate_originators WHERE ci IN (901, 902)',
    )).rows[0].n), 0);
    assert.strictEqual((await db.query(
      'SELECT outcome FROM public.affiliate_attributions WHERE cz_id = 90',
    )).rows[0].outcome, 'no_click');
    pass('a foreign-key failure after the first cédula rolls the whole call back and keeps earlier commits');

    await other.query('BEGIN');
    await plan(other, T_LATER, [610], [
      row({
        cz_id: 61,
        ci: 610,
        outcome: 'attributed',
        click_id: CLICK,
        affiliate_id: AFF,
        occurred_at: T0,
        presentation_at: T1,
        presentation_text: T1,
      }),
    ], [
      origin({ ci: 610, affiliate_id: AFF, first_cz_id: 61, first_presentation_at: T1 }),
    ]);
    let secondFinished = false;
    const waiting = plan(db, T_OLD, [610], [
      row({ cz_id: 61, ci: 610, outcome: 'no_click' }),
    ], []).then((value) => {
      secondFinished = true;
      return value;
    });
    await sleep(400);
    assert.strictEqual(secondFinished, false);
    await other.query('COMMIT');
    const lost = await waiting;
    assert.deepStrictEqual(lost.skipped_ci.map(Number), [610]);
    assert.strictEqual((await db.query(
      'SELECT outcome FROM public.affiliate_attributions WHERE cz_id = 61',
    )).rows[0].outcome, 'attributed');
    pass('a concurrent older plan waits on the cédula lock and is skipped after the newer plan commits');

    console.log('db-local-affiliate-persist-realpg: ' + groups + ' groups passed (LOCAL real PostgreSQL)');
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    try {
      execFileSync(pgCtl, ['stop', '-D', data, '-m', 'fast', '-w'], { stdio: 'ignore' });
    } catch (_err) {
      /* already stopped */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
