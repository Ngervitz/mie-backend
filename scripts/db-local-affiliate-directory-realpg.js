'use strict';

/**
 * Local PostgreSQL check for the affiliate directory.
 * Throwaway cluster. Does not read SUPABASE_* and does not call the
 * attribution function.
 *
 * Run: node scripts/db-local-affiliate-directory-realpg.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

const { createAffiliate, listAffiliates, decorateCiRows } = require('../src/lib/affiliateDirectoryRead');

const BASE = path.join(os.tmpdir(), 'c1-realpg', 'node_modules');
const BIN = process.env.C1_REALPG_BIN || path.join(BASE, '@embedded-postgres', 'windows-x64', 'native', 'bin');
const PG_DRIVER = process.env.C1_REALPG_PG || path.join(BASE, 'pg');
const EXE = process.platform === 'win32' ? '.exe' : '';

const STUBS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`;

const FUNNEL = `
CREATE TABLE public.cz_funnel_solicitudes (
  cz_id bigint PRIMARY KEY,
  ci bigint,
  tracking_data_summary jsonb
);
`;

let groups = 0;
function pass(label) {
  groups += 1;
  console.log('ok - ' + label);
}

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

function ident(name) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('unexpected identifier');
  return '"' + name + '"';
}

function pgError(err) {
  return { code: err.code, message: err.message };
}

function pgApi(client) {
  return {
    from(table) {
      const state = {
        table: table,
        columns: '*',
        filters: [],
        order: null,
        row: null,
        writing: false,
      };
      const api = {
        select(columns) {
          state.columns = columns;
          return api;
        },
        insert(row) {
          state.writing = true;
          state.row = row;
          return api;
        },
        eq(field, value) {
          state.filters.push({ op: 'eq', field: field, value: value });
          return api;
        },
        in(field, values) {
          state.filters.push({ op: 'in', field: field, value: values });
          return api;
        },
        order(column, opts) {
          state.order = { column: column, asc: !(opts && opts.ascending === false) };
          return api;
        },
        limit(n) {
          return run(state, client, { limit: n });
        },
        range(from, to) {
          return run(state, client, { from: from, to: to });
        },
        single() {
          return run(state, client, { single: true });
        },
      };
      return api;
    },
  };
}

async function run(state, client, mode) {
  const table = ident(state.table);
  const cols = state.columns.split(',').map(function (part) {
    return ident(part.trim());
  }).join(', ');
  try {
    if (state.writing) {
      const keys = Object.keys(state.row);
      const names = keys.map(ident).join(', ');
      const params = keys.map(function (_key, index) {
        return '$' + (index + 1);
      });
      const values = keys.map(function (key) {
        return state.row[key];
      });
      const inserted = await client.query(
        'INSERT INTO ' + table + ' (' + names + ') VALUES (' + params.join(', ') + ') RETURNING ' + cols,
        values,
      );
      if (mode.single && inserted.rows.length !== 1) {
        return { data: null, error: { code: 'PGRST116', message: 'expected one row' } };
      }
      return { data: mode.single ? inserted.rows[0] : inserted.rows, error: null };
    }
    const values = [];
    const where = state.filters.map(function (filter) {
      values.push(filter.value);
      const field = ident(filter.field);
      if (filter.op === 'eq') return field + ' = $' + values.length;
      return field + ' = ANY($' + values.length + ')';
    });
    let sql = 'SELECT ' + cols + ' FROM ' + table;
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    if (state.order) {
      sql += ' ORDER BY ' + ident(state.order.column) + (state.order.asc ? ' ASC' : ' DESC');
    }
    if (mode.from != null) {
      values.push(mode.to - mode.from + 1);
      sql += ' LIMIT $' + values.length;
      values.push(mode.from);
      sql += ' OFFSET $' + values.length;
    } else if (mode.limit != null) {
      values.push(mode.limit);
      sql += ' LIMIT $' + values.length;
    }
    const selected = await client.query(sql, values);
    return { data: selected.rows, error: null };
  } catch (err) {
    return { data: null, error: pgError(err) };
  }
}

async function expectCode(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the statement to fail');
}

async function main() {
  const initdb = path.join(BIN, 'initdb' + EXE);
  const pgCtl = path.join(BIN, 'pg_ctl' + EXE);
  let pg;
  try {
    if (!fs.existsSync(initdb) || !fs.existsSync(pgCtl)) throw new Error('binaries not found');
    pg = require(PG_DRIVER);
  } catch (err) {
    console.error('BLOQUEANTE: PostgreSQL local no está disponible (' + err.message + ').');
    process.exit(2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-directory-pg-'));
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
    const client = new pg.Client({ host: '127.0.0.1', port: port, user: 'postgres', database: 'postgres' });
    await client.connect();
    if (role) await client.query('SET ROLE ' + role);
    clients.push(client);
    return client;
  }

  try {
    const admin = await connect(null);
    await admin.query(STUBS);
    await admin.query(FUNNEL);
    await admin.query('GRANT SELECT ON public.cz_funnel_solicitudes TO service_role');
    for (const name of [
      '20261020_affiliates_clicks.sql',
      '20261021_affiliate_attributions.sql',
      '20261022_affiliate_persist_plan.sql',
      '20261023_affiliates_identity_consent.sql',
    ]) {
      await admin.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', name), 'utf8'));
    }
    const version = (await admin.query('SHOW server_version')).rows[0].server_version;
    pass('PostgreSQL ' + version + ' on 127.0.0.1:' + port + '; migrations 20261020 through 20261023 applied locally');

    const service = await connect('service_role');
    const anon = await connect('anon');
    const api = pgApi(service);
    const acceptedAt = '2026-10-22T18:00:00.000Z';
    const acceptance = {
      acceptance_channel: 'dashboard',
      terms_version: '2026-10-22',
      acceptance_evidence: 'acta-mesa-14',
    };

    const missingPerson = await createAffiliate(api, Object.assign({ code: 'real01', ci: 12345678 }, acceptance), acceptedAt);
    assert.strictEqual(missingPerson.ok, false);
    assert.strictEqual(missingPerson.status, 400);
    assert.strictEqual(missingPerson.error, 'La CI no tiene solicitudes en JANUS');
    pass('a real alta without a funnel solicitud is rejected');

    await admin.query(
      'INSERT INTO public.cz_funnel_solicitudes (cz_id, ci) VALUES (10, 12345678), (30, 12345678), (40, 87654321)',
    );

    const noConsent = await createAffiliate(api, { code: 'real02', ci: 12345678 }, acceptedAt);
    assert.strictEqual(noConsent.ok, false);
    assert.strictEqual(noConsent.error, 'Falta la aceptación documentada');
    pass('a real alta without documented acceptance is rejected before insert');

    const rawBypass = await expectCode(function () {
      return service.query(
        "INSERT INTO public.affiliates (code, status, is_test, ci) VALUES ('rawreal', 'active', false, 12345678)",
      );
    });
    assert.strictEqual(rawBypass.code, '23514');
    pass('PostgreSQL rejects an active real affiliate written without acceptance');

    const created = await createAffiliate(api, Object.assign({ code: 'real01', ci: '12345678' }, acceptance), acceptedAt);
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.affiliate.status, 'active');
    assert.strictEqual(created.affiliate.is_test, false);
    assert.strictEqual(String(created.affiliate.ci), '12345678');
    assert.strictEqual(created.affiliate.terms_version, '2026-10-22');
    assert.strictEqual(created.affiliate.acceptance_channel, 'dashboard');
    assert.strictEqual(created.affiliate.acceptance_evidence, 'acta-mesa-14');
    assert.strictEqual(new Date(created.affiliate.accepted_at).toISOString(), acceptedAt);
    pass('a real alta stores the server time, channel, terms version, and evidence locator');

    const duplicate = await createAffiliate(api, Object.assign({ code: 'real99', ci: 12345678 }, acceptance), acceptedAt);
    assert.strictEqual(duplicate.ok, false);
    assert.strictEqual(duplicate.status, 409);
    pass('a second affiliate with the same CI is rejected');

    const tested = await createAffiliate(api, { code: 'test01', is_test: true }, acceptedAt);
    assert.strictEqual(tested.ok, true);
    assert.strictEqual(tested.affiliate.is_test, true);
    assert.strictEqual(tested.affiliate.ci, null);
    assert.strictEqual(tested.affiliate.accepted_at, null);
    pass('a test affiliate can be created without a CI or acceptance');

    await service.query(
      "INSERT INTO public.affiliates (code, status, is_test) VALUES ('ext001', 'inactive', false)",
    );
    const enableExternal = await expectCode(function () {
      return admin.query("UPDATE public.affiliates SET status = 'active' WHERE code = 'ext001'");
    });
    assert.strictEqual(enableExternal.code, '23514');
    pass('an external row without acceptance cannot be switched to active');

    const listed = await listAffiliates(api);
    assert.strictEqual(listed.length, 3);
    pass('the directory lists the real, test, and inactive external affiliates');

    const affiliateId = created.affiliate.id;
    await service.query(
      'INSERT INTO public.affiliate_clicks (click_id, affiliate_id, occurred_at) VALUES ($1, $2, $3)',
      ['22222222-2222-4222-8222-222222222222', affiliateId, acceptedAt],
    );
    await service.query(
      `INSERT INTO public.affiliate_attributions
        (cz_id, ci, outcome, click_id, affiliate_id, occurred_at, presentation_at, is_test, prize_eligible)
       VALUES
        (10, 12345678, 'attributed', '22222222-2222-4222-8222-222222222222', $1, $2, $2, false, false),
        (30, 12345678, 'excluded_prior_solicitud', NULL, NULL, NULL, $2, false, false)`,
      [affiliateId, acceptedAt],
    );
    await service.query(
      `INSERT INTO public.affiliate_originators
        (ci, affiliate_id, first_cz_id, first_presentation_at, is_test, prize_eligible)
       VALUES (12345678, $1, 10, $2, false, false)`,
      [affiliateId, acceptedAt],
    );

    const person = { ci: 12345678, solicitudes: [{ cz_solicitud_id: 10 }, { cz_solicitud_id: 30 }] };
    const other = { ci: 87654321, solicitudes: [{ cz_solicitud_id: 40 }] };
    const available = await decorateCiRows(api, [person, other], {
      ciOf: function (row) { return row.ci; },
      czIdsOf: function (row) {
        return row.solicitudes.map(function (item) { return item.cz_solicitud_id; });
      },
      stamp: function (row, czId, described) {
        const item = row.solicitudes.find(function (entry) { return entry.cz_solicitud_id === czId; });
        item.affiliate_ref = described;
      },
    });
    assert.strictEqual(available, true);
    assert.strictEqual(person.affiliate.is_affiliate, true);
    assert.strictEqual(person.affiliate.ref, 'REF');
    assert.deepStrictEqual(person.affiliate.attributed_cz_ids, [10]);
    assert.ok(person.affiliate.tooltip.indexOf('10') !== -1);
    assert.strictEqual(person.solicitudes[1].affiliate_ref.detail, 'REF · Excluido · Hay una solicitud anterior');
    assert.strictEqual(other.affiliate.is_affiliate, false);
    assert.strictEqual(other.affiliate.ref, null);
    assert.strictEqual(other.solicitudes[0].affiliate_ref.detail, 'Sin evaluar');
    pass('AF/REF counts only the attributed solicitud, and the exclusion stays on its own detail');

    const before = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM public.affiliate_attributions) AS attributions,
         (SELECT count(*)::int FROM public.affiliate_originators) AS originators,
         (SELECT count(*)::int FROM public.affiliate_clicks) AS clicks,
         (SELECT bool_or(prize_eligible) FROM public.affiliate_attributions) AS any_prize,
         (SELECT bool_or(prize_eligible) FROM public.affiliate_originators) AS any_origin_prize`,
    );
    const serviceUpdate = await expectCode(function () {
      return service.query("UPDATE public.affiliates SET status = 'inactive' WHERE id = $1", [affiliateId]);
    });
    assert.strictEqual(serviceUpdate.code, '42501');
    const serviceDelete = await expectCode(function () {
      return service.query('DELETE FROM public.affiliates WHERE id = $1', [affiliateId]);
    });
    assert.strictEqual(serviceDelete.code, '42501');
    await admin.query("UPDATE public.affiliates SET status = 'inactive' WHERE id = $1", [affiliateId]);
    const ownerDelete = await expectCode(function () {
      return admin.query('DELETE FROM public.affiliates WHERE id = $1', [affiliateId]);
    });
    assert.strictEqual(ownerDelete.code, '23503');
    const after = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM public.affiliate_attributions) AS attributions,
         (SELECT count(*)::int FROM public.affiliate_originators) AS originators,
         (SELECT count(*)::int FROM public.affiliate_clicks) AS clicks,
         (SELECT status FROM public.affiliates WHERE id = $1) AS status,
         (SELECT terms_version FROM public.affiliates WHERE id = $1) AS terms_version`,
      [affiliateId],
    );
    assert.strictEqual(after.rows[0].status, 'inactive');
    assert.strictEqual(after.rows[0].terms_version, '2026-10-22');
    assert.strictEqual(after.rows[0].attributions, before.rows[0].attributions);
    assert.strictEqual(after.rows[0].originators, before.rows[0].originators);
    assert.strictEqual(after.rows[0].clicks, before.rows[0].clicks);
    assert.strictEqual(before.rows[0].any_prize, false);
    assert.strictEqual(before.rows[0].any_origin_prize, false);
    const rewards = await admin.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name ILIKE '%prize%' OR table_name ILIKE '%reward%' OR table_name ILIKE '%commission%')`,
    );
    assert.strictEqual(rewards.rows.length, 0);
    pass('suspending keeps attributions, clicks, originators, and the acceptance; no reward table exists');

    const anonRead = await expectCode(function () {
      return anon.query('SELECT code FROM public.affiliates');
    });
    assert.strictEqual(anonRead.code, '42501');
    pass('anon cannot read affiliates');

    console.log('db-local-affiliate-directory-realpg: ' + groups + ' groups passed (LOCAL real PostgreSQL)');
  } finally {
    for (const client of clients) await client.end().catch(function () {});
    try {
      execFileSync(pgCtl, ['stop', '-D', data, '-m', 'fast', '-w'], { stdio: 'ignore' });
    } catch (_err) {
      /* already stopped */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
