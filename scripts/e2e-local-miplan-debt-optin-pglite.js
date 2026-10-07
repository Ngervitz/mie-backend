'use strict';

/**
 * Mi Deuda Stage 2 — LOCAL end-to-end: Mi Plan pending export → HTTP → JANUS job (ingest → ACK →
 * CI reconciliation) → JANUS DB → read model.
 *
 * DB CLASSIFICATION: LOCAL. Two in-process, in-memory PGlite databases; loopback HTTP only.
 * Never reads SUPABASE_* env vars, never opens a non-loopback connection. No sleeps: the
 * reconciliation clock is injected (job `now`), derived from the stored first_unresolved_at.
 *
 *   Mi Plan: stubs of the tables the export reads + real 20261006120000 migration (export + ACK),
 *            real repository/service/route (createApp) on 127.0.0.1, DB role anon.
 *   JANUS:   real migrations (handoff tokens, Stage 1 catalog, Stage 2) over Supabase stubs,
 *            real job + real HTTP client + real read model through a supabase-js subset adapter
 *            (PostgREST-like JSON via to_jsonb), DB role service_role.
 *
 * Env: PGLITE_DIR (default %TEMP%/stage2-pglite/node_modules/@electric-sql/pglite),
 *      MIPLAN_REPO (default ../../../CZReset/CZMiplan). Exit 2 = SKIPPED.
 * Run: node scripts/e2e-local-miplan-debt-optin-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: { port: 3000, nodeEnv: 'test', supabaseUrl: 'https://example.invalid', supabaseServiceRoleKey: 'x', apifyToken: 'x', apifyActorId: 'x' },
};
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const { createMiplanDebtOptinSync, ALERT } = require('../src/jobs/miplanDebtOptinSync');
const { createMiplanExportClient, MiplanUnavailableError } = require('../src/lib/miplanExportClient');
const { loadCreditorCatalog } = require('../src/lib/creditorCatalogRead');
const { declaredDebtId } = require('../src/lib/miplanDebtOptinContract');
const {
  attachMiDeudaOptinToListRows,
  loadMiDeudaOptinDetail,
} = require('../src/lib/miplanDebtOptinRead');
const { loadMiDeudaBagsWithDeclared } = require('../src/lib/miDeudaBagsRead');
const { buildQueueReport } = require('./report-miplan-declared-unknown-queue-ro');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');
const MIPLAN_REPO = process.env.MIPLAN_REPO || path.join(__dirname, '..', '..', '..', 'CZReset', 'CZMiplan');
const MIGRATIONS = path.join(__dirname, '..', 'migrations');

const EXPORT_SECRET = 'e2e-local-export-secret-0123456789abcdefXYZ';
const B2 = 'e2e-local-b2-secret';
const CI = 41234567;
const CI3 = 51111111;
const CI4 = 52222222;
const CI_LATE = 53333333;
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);
const H4 = '4'.repeat(64);
const H6 = '6'.repeat(64);
const T1 = '7a000000-0000-4000-8000-0000000000a1';
const T2 = '7a000000-0000-4000-8000-0000000000a2';
const T3 = '7a000000-0000-4000-8000-0000000000a3';
const T4 = '7a000000-0000-4000-8000-0000000000a4';

let groups = 0;

function u(p, n) {
  return p + '-0000-4000-8000-' + String(n).padStart(12, '0');
}

const JANUS_STUBS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
CREATE TABLE public.dashboard_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE TABLE public.cz_funnel_sync_cursors (
  source_name text PRIMARY KEY, last_since text, last_synced_at timestamptz,
  last_sync_status text CHECK (last_sync_status IN ('success','error') OR last_sync_status IS NULL),
  last_sync_error text, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cz_funnel_sync_cursors_source_name_check CHECK (source_name IN
    ('cz_funnel_granted_loans','cz_funnel_solicitudes','cz_funnel_encuestas')));
CREATE TABLE public.job_locks (job_name text PRIMARY KEY, locked_by text NOT NULL, expires_at timestamptz NOT NULL);
CREATE FUNCTION public.acquire_job_lock(p_job_name text, p_locked_by text, p_ttl_seconds integer) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.job_locks WHERE job_name = p_job_name AND expires_at < now();
  INSERT INTO public.job_locks VALUES (p_job_name, p_locked_by, now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (job_name) DO NOTHING;
  RETURN EXISTS (SELECT 1 FROM public.job_locks WHERE job_name = p_job_name AND locked_by = p_locked_by);
END; $$;
CREATE FUNCTION public.release_job_lock(p_job_name text, p_locked_by text) RETURNS void
LANGUAGE sql AS $$ DELETE FROM public.job_locks WHERE job_name = p_job_name AND locked_by = p_locked_by; $$;
CREATE TABLE public.rejected_bcu_snapshots (id text PRIMARY KEY, ci bigint, period_label text, consulted_on date, created_at timestamptz, source text);
CREATE TABLE public.rejected_bcu_institutions (id text PRIMARY KEY, snapshot_id text, institution_name text, category text,
  moroso_mn numeric, moroso_me numeric, castigado_mn numeric, castigado_me numeric, colocacion_vencida_mn numeric,
  colocacion_vencida_me numeric, creditos_reestructurados_mn numeric, creditos_reestructurados_me numeric, sort_order int, created_at timestamptz);
`;

const MIPLAN_STUBS = [
  "SET TimeZone = 'UTC';",
  'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;',
  'GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;',
  'CREATE SCHEMA miplan_private;',
  'CREATE TABLE miplan_private.backend_secrets (name text PRIMARY KEY, secret text NOT NULL);',
  "INSERT INTO miplan_private.backend_secrets VALUES ('b2_persist', '" + B2 + "');",
  'CREATE TABLE public.journeys (journey_id uuid PRIMARY KEY, anonymous_id text NOT NULL, entry_type text NOT NULL, bootstrap_key text UNIQUE);',
  'CREATE TABLE public.diagnoses (diagnosis_id uuid PRIMARY KEY, anonymous_id text NOT NULL, journey_id uuid, created_at timestamptz NOT NULL DEFAULT now(), input_snapshot jsonb NOT NULL);',
  'CREATE TABLE public.financial_strategy_evaluations (evaluation_id uuid PRIMARY KEY, journey_id uuid NOT NULL, anonymous_id text NOT NULL, origin_diagnosis_id uuid NOT NULL REFERENCES public.diagnoses);',
  'CREATE TABLE public.debt_management_opt_in_events (event_id uuid PRIMARY KEY, journey_id uuid NOT NULL REFERENCES public.journeys, anonymous_id text NOT NULL,',
  '  scope text NOT NULL CHECK (scope = \'debt_management_interest\'), state text NOT NULL CHECK (state IN (\'opted_in\',\'withdrawn\')),',
  '  contract_version text NOT NULL CHECK (contract_version = \'debt_management_opt_in_v1\'), source text NOT NULL CHECK (source = \'miplan_v2\'),',
  '  consent_text_version text NULL, origin_evaluation_id uuid NOT NULL REFERENCES public.financial_strategy_evaluations,',
  '  origin_diagnosis_id uuid NULL REFERENCES public.diagnoses, seq integer NOT NULL, created_at timestamptz NOT NULL, UNIQUE (journey_id, scope, seq));',
  'REVOKE ALL ON TABLE public.debt_management_opt_in_events FROM PUBLIC, anon, authenticated;',
].join('\n');

/** supabase-js subset over PGlite; rows shaped like PostgREST JSON (to_jsonb). */
function pgliteSupabase(db) {
  function toParam(v) {
    return v != null && typeof v === 'object' ? JSON.stringify(v) : v;
  }
  function builder(table) {
    let cols = '*';
    const where = [];
    const params = [];
    function add(sqlFn, value) {
      params.push(value);
      where.push(sqlFn('$' + params.length));
    }
    function sql(extra) {
      return 'SELECT to_jsonb(t) AS r FROM (SELECT ' + cols + ' FROM public.' + table +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') + (extra || '') + ') t';
    }
    async function run(extra) {
      try {
        const res = await db.query(sql(extra), params);
        return { data: res.rows.map(function (x) { return x.r; }), error: null };
      } catch (e) {
        return { data: null, error: { message: String(e.message), code: e.code || null } };
      }
    }
    const b = {
      select: function (c) {
        cols = c || '*';
        return b;
      },
      eq: function (col, val) {
        add(function (p) { return col + '::text = ' + p + '::text'; }, String(val));
        return b;
      },
      neq: function (col, val) {
        add(function (p) { return col + '::text IS DISTINCT FROM ' + p + '::text'; }, String(val));
        return b;
      },
      in: function (col, vals) {
        add(function (p) { return col + '::text = ANY(' + p + '::text[])'; }, vals.map(String));
        return b;
      },
      range: function (from, to) {
        return run(' OFFSET ' + Number(from) + ' LIMIT ' + (Number(to) - Number(from) + 1));
      },
      maybeSingle: async function () {
        const r = await run(' LIMIT 2');
        if (r.error) return r;
        if (r.data.length > 1) return { data: null, error: { message: 'multiple rows' } };
        return { data: r.data[0] || null, error: null };
      },
      then: function (resolve, reject) {
        return run('').then(resolve, reject);
      },
    };
    return b;
  }
  return {
    from: builder,
    rpc: async function (name, args) {
      const keys = Object.keys(args || {});
      const parts = keys.map(function (k, i) {
        const v = args[k];
        return k + ' => $' + (i + 1) + (v != null && typeof v === 'object' ? '::jsonb' : '');
      });
      try {
        const res = await db.query('SELECT to_jsonb(public.' + name + '(' + parts.join(', ') + ')) AS r',
          keys.map(function (k) { return toParam(args[k]); }));
        return { data: res.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: String(e.message), code: e.code || null } };
      }
    },
  };
}

function captureLogger() {
  const lines = [];
  const records = [];
  function rec(level) {
    return function (msg, meta) {
      lines.push(level + ' ' + msg + ' ' + JSON.stringify(meta || {}));
      records.push({ level: level, msg: msg, meta: meta || {} });
    };
  }
  return { lines: lines, records: records, info: rec('info'), error: rec('error'), warn: rec('warn') };
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

async function expectFail(promise, code, stage) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected failure ' + code);
  assert.strictEqual(err.code, code, 'code ' + (err && err.code));
  if (stage) assert.strictEqual(err.stage, stage, 'stage ' + (err && err.stage));
}

async function main() {
  let PGlite;
  let uuidOssp;
  try {
    PGlite = require(PGLITE_DIR).PGlite;
    uuidOssp = require(path.join(PGLITE_DIR, 'dist', 'contrib', 'uuid_ossp.cjs')).uuid_ossp;
  } catch (_e) {
    console.error('PGlite not available at ' + PGLITE_DIR + ' (set PGLITE_DIR). SKIPPED.');
    process.exit(2);
  }
  const miplanServer = path.join(MIPLAN_REPO, 'server');
  if (!fs.existsSync(path.join(miplanServer, 'app.js'))) {
    console.error('Mi Plan repo not found at ' + MIPLAN_REPO + ' (set MIPLAN_REPO). SKIPPED.');
    process.exit(2);
  }
  const { createApp } = require(path.join(miplanServer, 'app'));
  const { loadConfig } = require(path.join(miplanServer, 'config'));
  const { createJanusExportService } = require(path.join(miplanServer, 'modules', 'janusExport', 'service'));
  const { createJanusExportRepository } = require(path.join(miplanServer, 'modules', 'janusExport', 'repository'));

  // ---------- Mi Plan DB (LOCAL) ----------
  const mp = new PGlite();
  await mp.exec(MIPLAN_STUBS);
  await mp.exec(fs.readFileSync(path.join(miplanServer, 'migrations', '20261006120000_miplan_janus_debt_optin_export.sql'), 'utf8'));
  const J1 = u('a1000000', 1);
  const J2 = u('a1000000', 2);
  const JV = u('a1000000', 3);
  const J3 = u('a1000000', 4);
  const J4 = u('a1000000', 5);
  const J6 = u('a1000000', 6);
  const D1 = u('d1000000', 1);
  const D1B = u('d1000000', 2);
  const D2 = u('d1000000', 3);
  const DV = u('d1000000', 4);
  const D3 = u('d1000000', 5);
  const D4 = u('d1000000', 6);
  const EV1 = u('e1000000', 1);
  const EV1B = u('e1000000', 2);
  const EV2 = u('e1000000', 3);
  const EVV = u('e1000000', 4);
  const EVW = u('e1000000', 9);
  const F1 = u('e1000000', 31);
  const F2 = u('e1000000', 32);
  const G1 = u('e1000000', 41);
  const G2 = u('e1000000', 42);
  const L1 = u('e1000000', 61);
  const D1_DEBTS = [
    { id: 'a', tipo: 'tarjeta', acreedor_raw: 'Tarjeta OCA', acreedor: 'oca', monto: '15000', pago: 1200, situacion_ui: 'atrasada' },
    { id: 'b', tipo: 'prestamo', acreedor_raw: 'OCA', acreedor: 'oca', monto: 15000, situacion_ui: 'al_dia' },
    { id: 'c', tipo: 'prestamo', acreedor_raw: 'Tía Marta', acreedor: 'tia marta', monto: '15.000', situacion_ui: 'reclamo_disputa' },
    { id: 'd', tipo: 'servicio', acreedor_raw: 'UTE', acreedor: 'ute', monto: 3000 },
    { id: 'e', acreedor: 'brou', monto: 1, situacion_ui: 'pagada' },
    { id: 'f', acreedor: 'anda', monto: 1, cancelada: true },
    { id: 'g', acreedor: 'creditel', monto: 1, _is_draft_add: true },
    { id: 'h', tipo: 'prestamo', acreedor_raw: 'Fucac', acreedor: 'fucac', monto: 9000 },
  ];
  await mp.query("INSERT INTO journeys VALUES ($1,'anon-1','janus_handoff','handoff:'||$7), ($2,'anon-2','janus_handoff','handoff:'||$8), ($3,'anon-3','virgin_miplan',NULL), " +
    "($4,'anon-4','janus_handoff','handoff:'||$9), ($5,'anon-5','janus_handoff','handoff:'||$10), ($6,'anon-6','janus_handoff','handoff:'||$11)",
  [J1, J2, JV, J3, J4, J6, H1, H2, H3, H4, H6]);
  await mp.query("INSERT INTO diagnoses (diagnosis_id, anonymous_id, journey_id, input_snapshot) VALUES " +
    "($1,'anon-1',$5,$6::jsonb), ($2,'anon-1',$5,$7::jsonb), ($3,'anon-2',$8,$9::jsonb), ($4,'anon-3',$10,$9::jsonb)",
  [D1, D1B, D2, DV, J1, JSON.stringify({ deudas: D1_DEBTS, ingreso: 99999 }),
    JSON.stringify({ deudas: [{ id: 'z', tipo: 'servicio', acreedor_raw: 'Antel', acreedor: 'antel', monto: 700 }] }),
    J2, JSON.stringify({ deudas: [{ id: 'y', acreedor_raw: 'UTE', acreedor: 'ute', monto: 100 }] }), JV]);
  await mp.query("INSERT INTO diagnoses (diagnosis_id, anonymous_id, journey_id, input_snapshot) VALUES ($1,'anon-4',$2,$3::jsonb), ($4,'anon-5',$5,$6::jsonb)",
    [D3, J3, JSON.stringify({ deudas: [{ id: 'o', acreedor_raw: 'OSE', acreedor: 'ose', monto: 400 }] }),
      D4, J4, JSON.stringify({ deudas: [{ id: 'k', acreedor_raw: 'Claro', acreedor: 'claro', monto: 800 }] })]);
  await mp.query("INSERT INTO financial_strategy_evaluations VALUES ($1,$4,'anon-1',$5), ($2,$6,'anon-2',$7), ($3,$8,'anon-3',$9)",
    [u('f1000000', 1), u('f1000000', 2), u('f1000000', 3), J1, D1, J2, D2, JV, DV]);
  await mp.query("INSERT INTO financial_strategy_evaluations VALUES ($1,$2,'anon-1',$3), ($4,$5,'anon-4',$6), ($7,$8,'anon-5',$9), ($10,$11,'anon-6',$12)",
    [u('f1000000', 4), J1, D1B, u('f1000000', 5), J3, D3, u('f1000000', 6), J4, D4, u('f1000000', 7), J6, D2]);
  const INS = "INSERT INTO debt_management_opt_in_events (event_id, journey_id, anonymous_id, scope, state, contract_version, source, " +
    "consent_text_version, origin_evaluation_id, origin_diagnosis_id, seq, created_at) VALUES " +
    "($1,$2,'anon','debt_management_interest',$3,'debt_management_opt_in_v1','miplan_v2','dm-optin-v1',$4,$5,$6,$7::timestamptz)";
  async function ago(interval) {
    return (await mp.query('SELECT (now() - $1::interval)::text AS t', [interval])).rows[0].t;
  }
  async function mpAdmin(fn) {
    await mp.exec('RESET ROLE');
    try {
      return await fn();
    } finally {
      await mp.exec('SET ROLE anon');
    }
  }
  const tie = await ago('9 min');
  await mp.query(INS, [EV1, J1, 'opted_in', u('f1000000', 1), D1, 1, await ago('10 min')]);
  await mp.query(INS, [EV2, J2, 'opted_in', u('f1000000', 2), D2, 1, tie]);
  await mp.query(INS, [EVW, J1, 'withdrawn', u('f1000000', 1), D1, 2, tie]);
  await mp.query(INS, [EVV, JV, 'opted_in', u('f1000000', 3), DV, 1, await ago('8 min')]);
  await mp.query(INS, [EV1B, J1, 'opted_in', u('f1000000', 4), D1B, 3, await ago('0 seconds')]);
  await mp.exec('SET ROLE anon');
  const mpClient = {
    rpc: function (name, params) {
      const q = name === 'miplan_ack_debt_optin_events'
        ? mp.query('SELECT public.miplan_ack_debt_optin_events($1,$2::jsonb) AS r', [params.p_secret, JSON.stringify(params.p_acks)])
        : mp.query('SELECT public.miplan_export_debt_optin_events($1,$2) AS r', [params.p_secret, params.p_limit]);
      return q.then(function (res) { return { data: res.rows[0].r, error: null }; }, function (e) { return { data: null, error: { message: String(e.message) } }; });
    },
  };
  const mpConfig = loadConfig({
    NODE_ENV: 'test', PORT: '0', CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:5500', SUPABASE_URL: '', SUPABASE_ANON_KEY: '',
    MIPLAN_BACKEND_SECRET: '', JANUS_HANDOFF_BASE_URL: 'https://janus.invalid', MIPLAN_HANDOFF_REDEEM_SECRET: 'redeem-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    MIPLAN_JANUS_EXPORT_SECRET: EXPORT_SECRET,
  });
  function miplanApp() {
    return createApp(mpConfig, {
      janusExportService: createJanusExportService({ repository: createJanusExportRepository({ client: mpClient, backendSecret: B2 }) }),
    });
  }
  async function mpAcks() {
    return mpAdmin(async function () {
      return (await mp.query('SELECT event_id, janus_ingest_status, acked_at FROM janus_debt_optin_delivery_acks ORDER BY acked_at, event_id')).rows;
    });
  }
  async function mpPending() {
    return mpAdmin(async function () {
      return (await mp.query("SELECT o.event_id FROM debt_management_opt_in_events o JOIN journeys j USING (journey_id) WHERE j.bootstrap_key LIKE 'handoff:%' AND NOT EXISTS (SELECT 1 FROM janus_debt_optin_delivery_acks a WHERE a.event_id = o.event_id) ORDER BY o.created_at, o.event_id")).rows.map(function (r) { return r.event_id; });
    });
  }
  let mpSrv = await listen(miplanApp());

  // ---------- JANUS DB (LOCAL) ----------
  const jdb = new PGlite({ extensions: { uuid_ossp: uuidOssp } });
  await jdb.exec(JANUS_STUBS);
  await jdb.exec(fs.readFileSync(path.join(MIGRATIONS, '20260925_miplan_handoff_tokens.sql'), 'utf8'));
  await jdb.exec(fs.readFileSync(path.join(MIGRATIONS, '20261006_mi_deuda_creditor_catalog.sql'), 'utf8'));
  await jdb.exec(fs.readFileSync(path.join(MIGRATIONS, '20261006_mi_deuda_miplan_declared_debts.sql'), 'utf8'));
  await jdb.query(
    "INSERT INTO public.miplan_handoff_tokens (id, token_hash, purpose, external_ref, ci, status, expires_at) VALUES " +
    "($1,$2,'miplan_handoff','LRW-E2E-1',$5,'consumed',now()), ($3,$4,'miplan_handoff','LRW-E2E-2',NULL,'issued',now() + interval '1 day'), " +
    "($6,$7,'miplan_handoff','LRW-E2E-3',$8,'consumed',now()), ($9,$10,'miplan_handoff','LRW-E2E-4',$11,'consumed',now())",
    [T1, H1, T2, H2, CI, T3, H3, CI3, T4, H4, CI4],
  );
  await jdb.query("INSERT INTO rejected_bcu_snapshots VALUES ('s1', $1, NULL, '2026-09-01', '2026-09-01T00:00:00Z', 'html_import')", [CI]);
  await jdb.query("INSERT INTO rejected_bcu_institutions (id, snapshot_id, institution_name, category, moroso_mn) VALUES ('i1','s1','OCA S.A.','5',500)");
  await jdb.exec('SET ROLE service_role');
  const sb = pgliteSupabase(jdb);

  function syncJob(base, secret, log, extra) {
    return createMiplanDebtOptinSync(Object.assign({
      supabase: sb,
      client: createMiplanExportClient({ baseUrl: base, secret: secret, timeoutMs: 3000 }),
      loadCatalog: loadCreditorCatalog,
      logger: log,
      pageLimit: 1,
    }, extra || {}));
  }
  async function count(sql, params) {
    return Number((await jdb.query(sql, params || [])).rows[0].n);
  }
  async function recon(eventId) {
    return (await jdb.query('SELECT * FROM miplan_optin_ci_reconciliation WHERE event_id = $1', [eventId])).rows[0] || null;
  }
  async function asSuper(fn) {
    await jdb.exec('RESET ROLE');
    try {
      return await fn();
    } finally {
      await jdb.exec('SET ROLE service_role');
    }
  }
  const allLogs = [];

  // 1. [B][J] First run: every pending handoff event (no time lag), one per page, each acked after
  //    durable ingest — including the event whose CI cannot be resolved yet.
  {
    const log = captureLogger();
    const r = await syncJob(mpSrv.base, EXPORT_SECRET, log).run();
    allLogs.push.apply(allLogs, log.lines);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.events_inserted, 4, 'EV1, EV2, the tied withdrawal and EV1B (created now)');
    assert.strictEqual(r.events_acked, 4);
    assert.strictEqual(r.ci_unresolvable, 1, 'J2 token issued → unresolvable, persisted');
    assert.strictEqual(await count("SELECT count(*) n FROM miplan_debt_optin_events WHERE event_id = '" + EVV + "'"), 0, 'virgin journey never exported');
    const acks = await mpAcks();
    assert.deepStrictEqual(acks.map(function (a) { return a.event_id; }).sort(), [EV1, EV1B, EV2, EVW].sort(), 'Mi Plan recorded exactly the persisted events');
    assert.ok(acks.every(function (a) { return a.janus_ingest_status === 'inserted'; }));
    assert.deepStrictEqual(await mpPending(), [], 'nothing pending in Mi Plan');
    assert.ok(acks.some(function (a) { return a.event_id === EV2; }), '[J] unresolved-CI event acked after durable ingest');
    const r2 = await recon(EV2);
    assert.deepStrictEqual([r2.status, r2.last_unresolved_reason], ['PENDING', 'TOKEN_NOT_CONSUMED'], '[J] reconciliation pending');
    assert.ok(log.records.some(function (x) { return x.level === 'warn' && x.meta.alert === ALERT.CI_UNRESOLVED && x.meta.event_id === EV2; }), '[J] WARN alert at first appearance');
    assert.strictEqual(r.reconciliation.pending_total, 1);
    const evRow = (await jdb.query('SELECT ci, ci_resolution, handoff_token_id, excluded_count, snapshot_diagnosis_id FROM miplan_debt_optin_events WHERE event_id = $1', [EV1])).rows[0];
    assert.strictEqual(Number(evRow.ci), CI);
    assert.strictEqual(evRow.handoff_token_id, T1);
    assert.strictEqual(evRow.excluded_count, 3, 'pagada + cancelada + draft');
    assert.strictEqual(evRow.snapshot_diagnosis_id, D1);
    const debts = (await jdb.query('SELECT declared_debt_id, position, ingestion_resolution, ingestion_creditor_id, monto, monto_raw, situacion_ui FROM miplan_declared_debts WHERE optin_event_id = $1 ORDER BY position', [EV1])).rows;
    assert.deepStrictEqual(debts.map(function (d) { return d.position; }), [0, 1, 2, 3, 7], 'positions = ordinality in D');
    debts.forEach(function (d) {
      assert.strictEqual(d.declared_debt_id, declaredDebtId(EV1, d.position), 'deterministic declared_debt_id');
    });
    assert.deepStrictEqual(debts.map(function (d) { return d.ingestion_resolution; }), ['RESOLVED', 'RESOLVED', 'UNKNOWN', 'RESOLVED', 'UNKNOWN']);
    assert.strictEqual(debts[2].monto_raw, '15.000', 'invalid numeric preserves raw');
    assert.strictEqual(await count("SELECT count(*) n FROM cz_funnel_sync_cursors"), 0, 'no cursor row written');
    groups += 1;
  }

  // 2. [A][C][D] Replays: nothing pending → nothing fetched; ACK lost after ingest → re-export,
  //    replay detected (no duplicate), acked later as already_ingested; repeated ACK is a no-op.
  {
    let r = await syncJob(mpSrv.base, EXPORT_SECRET, captureLogger()).run();
    assert.strictEqual(r.events_seen, 0);
    await mpAdmin(async function () {
      await mp.query(INS, [u('e1000000', 21), J2, 'withdrawn', u('f1000000', 2), D2, 2, await ago('0 seconds')]);
    });
    const real = createMiplanExportClient({ baseUrl: mpSrv.base, secret: EXPORT_SECRET, timeoutMs: 3000 });
    let lastBody = null;
    const lossy = {
      fetchPage: async function (a) {
        lastBody = await real.fetchPage(a);
        return lastBody;
      },
      ackEvents: async function () { throw new MiplanUnavailableError('miplan ack network error'); },
    };
    await expectFail(syncJob(mpSrv.base, EXPORT_SECRET, captureLogger(), { client: lossy }).run(), 'MIPLAN_UNAVAILABLE', 'ack');
    assert.strictEqual(await count("SELECT count(*) n FROM miplan_debt_optin_events WHERE event_id = '" + u('e1000000', 21) + "'"), 1, 'durably ingested');
    assert.deepStrictEqual(await mpPending(), [u('e1000000', 21)], '[C] still pending in Mi Plan (no ACK)');
    r = await syncJob(mpSrv.base, EXPORT_SECRET, captureLogger()).run();
    assert.strictEqual(r.events_inserted, 0);
    assert.strictEqual(r.events_already_ingested, 1, '[C] replay detected');
    assert.strictEqual(r.events_acked, 1);
    assert.strictEqual(await count("SELECT count(*) n FROM miplan_debt_optin_events WHERE event_id = '" + u('e1000000', 21) + "'"), 1, 'no duplicate');
    assert.deepStrictEqual(await mpPending(), []);
    const ackRow = (await mpAcks()).filter(function (a) { return a.event_id === u('e1000000', 21); })[0];
    assert.strictEqual(ackRow.janus_ingest_status, 'already_ingested');
    // [D] duplicate delivery of an already-acked event (stale page replayed) → already_acked.
    const stale = { fetchPage: async function () { return JSON.parse(JSON.stringify(lastBody)); }, ackEvents: real.ackEvents };
    r = await syncJob(mpSrv.base, EXPORT_SECRET, captureLogger(), { client: stale, maxPages: 1 }).run();
    assert.strictEqual(r.events_already_ingested, 1);
    assert.strictEqual(r.events_already_acked, 1, '[D] repeated ACK is a safe no-op');
    assert.deepStrictEqual((await mpAcks()).filter(function (a) { return a.event_id === u('e1000000', 21); }), [ackRow], 'first ACK row unchanged');
    groups += 1;
  }

  // 3. [A] Mi Plan down / wrong secret → FAIL, nothing acked; lock released.
  {
    const acksBefore = (await mpAcks()).length;
    await mpAdmin(async function () {
      await mp.query(INS, [u('e1000000', 22), J2, 'opted_in', u('f1000000', 2), D2, 3, await ago('0 seconds')]);
    });
    const log = captureLogger();
    await expectFail(syncJob(mpSrv.base, 'wrong-secret-wrong-secret-wrong-secret-x', log).run(), 'MIPLAN_UNAVAILABLE', 'fetch');
    await new Promise(function (resolve) { mpSrv.server.close(resolve); });
    await expectFail(syncJob(mpSrv.base, EXPORT_SECRET, log).run(), 'MIPLAN_UNAVAILABLE', 'fetch');
    allLogs.push.apply(allLogs, log.lines);
    assert.strictEqual((await mpAcks()).length, acksBefore, 'no ACK without ingest');
    assert.deepStrictEqual(await mpPending(), [u('e1000000', 22)]);
    assert.strictEqual(await count('SELECT count(*) n FROM job_locks'), 0, 'lock released');
    mpSrv = await listen(miplanApp());
    const r = await syncJob(mpSrv.base, EXPORT_SECRET, captureLogger()).run();
    assert.strictEqual(r.events_inserted, 1, 'delivered once Mi Plan is back');
    assert.deepStrictEqual(await mpPending(), []);
    groups += 1;
  }

  // 4. [F][G][I] Out-of-order delivery across two real databases. seq2 is committed (and
  //    delivered) first; seq1 commits later with an OLDER created_at (late commit) and arrives
  //    later (inverted received_at). It is still delivered (no cursor to skip it) and never
  //    overrides seq2.
  {
    await mpAdmin(async function () {
      await mp.query(INS, [F2, J3, 'withdrawn', u('f1000000', 5), D3, 2, await ago('5 min')]);
      await mp.query(INS, [G2, J4, 'opted_in', u('f1000000', 6), D4, 2, await ago('4 min')]);
    });
    let r = await syncJob(mpSrv.base, EXPORT_SECRET, captureLogger()).run();
    assert.strictEqual(r.events_inserted, 2);
    await mpAdmin(async function () {
      await mp.query(INS, [F1, J3, 'opted_in', u('f1000000', 5), D3, 1, await ago('6 min')]);
      await mp.query(INS, [G1, J4, 'withdrawn', u('f1000000', 6), D4, 1, await ago('5 min 30 seconds')]);
    });
    r = await syncJob(mpSrv.base, EXPORT_SECRET, captureLogger()).run();
    assert.strictEqual(r.events_inserted, 2, 'late seq1 events delivered despite older created_at');
    assert.deepStrictEqual(await mpPending(), []);
    const recv = (await jdb.query('SELECT event_id, received_at FROM miplan_debt_optin_events WHERE event_id = ANY($1::uuid[])', [[F1, F2]])).rows;
    const at = new Map(recv.map(function (x) { return [x.event_id, x.received_at.getTime()]; }));
    assert.ok(at.get(F1) > at.get(F2), '[I] seq1 received after seq2 (inverted arrival)');

    const list = await attachMiDeudaOptinToListRows(sb, [{ ci: CI3 }, { ci: CI4 }]);
    const by = new Map(list.rows.map(function (x) { return [x.ci, x]; }));
    assert.strictEqual(by.get(CI3).mi_deuda_optin.state, 'withdrawn', '[F] seq2 withdrawn wins over late seq1 opted_in');
    assert.strictEqual(by.get(CI3).mi_deuda_optin.event_id, F2);
    assert.strictEqual(by.get(CI4).mi_deuda_optin.state, 'opted_in', '[G] seq2 opted_in wins over late seq1 withdrawn');
    assert.strictEqual(by.get(CI4).mi_deuda_optin.event_id, G2);
    const detF = await loadMiDeudaOptinDetail(sb, CI3, { loadCatalog: loadCreditorCatalog });
    assert.strictEqual(detF.snapshot.event_id, F1, '[F] late seq1 kept historically');
    assert.strictEqual(detF.snapshot.feeds_bags, false, '[F] late seq1 does not feed bags');
    assert.strictEqual(detF.snapshot.debts[0].effective_creditor_name, 'OSE');
    assert.deepStrictEqual(detF.history.map(function (h) { return h.seq; }), [2, 1]);
    groups += 1;
  }

  // 5. Read model on the JANUS copy: Rechazados list/detail, bags DECLARED + BCU, unknown queue.
  {
    const list = await attachMiDeudaOptinToListRows(sb, [{ ci: CI, mi_deuda_status: 'not_invited' }, { ci: 999 }]);
    assert.strictEqual(list.available, true);
    assert.strictEqual(list.rows[0].mi_deuda_optin.state, 'opted_in', 'accept → withdraw → accept');
    assert.strictEqual(list.rows[0].mi_deuda_optin.event_id, EV1B);
    assert.strictEqual(list.rows[0].mi_deuda_optin.third_party_sharing_authorized, false);
    assert.strictEqual(list.rows[0].mi_deuda_status, 'not_invited');
    assert.strictEqual(list.rows[1].mi_deuda_optin, null);

    const det = await loadMiDeudaOptinDetail(sb, CI, { loadCatalog: loadCreditorCatalog });
    assert.strictEqual(det.snapshot.event_id, EV1B);
    assert.strictEqual(det.snapshot.feeds_bags, true);
    assert.strictEqual(det.snapshot.debts[0].effective_creditor_name, 'ANTEL');
    assert.deepStrictEqual(det.history.map(function (h) { return h.state; }), ['opted_in', 'withdrawn', 'opted_in']);

    const bags = await loadMiDeudaBagsWithDeclared(sb);
    assert.strictEqual(bags.declared_layer.available, true);
    const oca = bags.bags.find(function (x) { return x.institution_canonical && /OCA/i.test(x.institution_canonical); });
    assert.ok(oca, 'BCU OCA bag present');
    assert.strictEqual(oca.people_count, 1);
    assert.strictEqual(oca.people_declared, 0, 'old D1 snapshot (OCA) no longer feeds bags after re-accept with D1B');
    const decl = bags.declared_layer.bags;
    assert.deepStrictEqual(decl.map(function (b) { return b.display_name; }).sort(), ['ANTEL', 'Claro'], '[F] no OSE bag; [G] Claro bag');
    const claro = decl.find(function (b) { return b.display_name === 'Claro'; });
    assert.deepStrictEqual(claro.members.map(function (m) { return m.ci; }), [CI4]);
    assert.ok(decl.every(function (b) { return b.members.every(function (m) { return m.ci !== CI3; }); }), '[F] CI3 never bagged');
    assert.deepStrictEqual(bags.declared_layer.ci_reconciliation, { pending: 3, resolved: 0, terminal_unresolvable: 0 }, 'J2 seq1..3');
    assert.ok(decl.every(function (b) { return b.display_name !== 'UTE'; }), '[J] unresolved J2 (UTE) not bagged');

    const queue = await buildQueueReport(sb, { loadCatalog: loadCreditorCatalog });
    assert.deepStrictEqual(queue.map(function (g) { return g.normalized_key; }).sort(), ['fucac', 'tia marta']);
    assert.ok(!JSON.stringify(queue).includes(String(CI)), 'queue exposes counts, never CIs');
    groups += 1;
  }

  // 6. [K][N] The CI appears later (token redeemed with a CI) → next reconciliation resolves it and
  //    the opt-in enters derived state and bags. Clock injected from first_unresolved_at.
  {
    await asSuper(async function () {
      await jdb.query("UPDATE miplan_handoff_tokens SET status = 'consumed', ci = $1, redeemed_at = now() WHERE id = $2", [CI_LATE, T2]);
    });
    const first = (await recon(EV2)).first_unresolved_at;
    const clock = new Date(first.getTime() + 24 * 3600 * 1000);
    const log = captureLogger();
    const r = await syncJob(mpSrv.base, EXPORT_SECRET, log, { now: function () { return clock; } }).run();
    allLogs.push.apply(allLogs, log.lines);
    assert.strictEqual(r.reconciliation.resolved, 3, 'J2 seq1..3 share the token');
    const rr = await recon(EV2);
    assert.deepStrictEqual([rr.status, Number(rr.resolved_ci), rr.resolved_handoff_token_id], ['RESOLVED', CI_LATE, T2]);
    assert.strictEqual(rr.resolved_at.getTime(), clock.getTime(), 'resolution time = injected clock');
    const ev = (await jdb.query('SELECT ci FROM miplan_debt_optin_events WHERE event_id = $1', [EV2])).rows[0];
    assert.strictEqual(ev.ci, null, 'immutable event untouched');
    const list = await attachMiDeudaOptinToListRows(sb, [{ ci: CI_LATE }]);
    assert.strictEqual(list.rows[0].mi_deuda_optin.state, 'opted_in', 'J2 head (seq3 opted_in) under the reconciled CI');
    const bags = await loadMiDeudaBagsWithDeclared(sb);
    const ute = bags.declared_layer.bags.find(function (b) { return b.display_name === 'UTE'; });
    assert.ok(ute && ute.members.some(function (m) { return m.ci === CI_LATE; }), '[K] reconciled CI enters the bag');
    assert.deepStrictEqual(bags.declared_layer.ci_reconciliation, { pending: 0, resolved: 3, terminal_unresolvable: 0 }, 'J2 seq1..3 all resolved via the same token');
    groups += 1;
  }

  // 7. [L][M] The CI never appears: retries, horizon reached → TERMINAL_UNRESOLVABLE (ERROR alert),
  //    visible, never bagged; a replay after terminal neither duplicates nor resets the horizon.
  {
    await mpAdmin(async function () {
      await mp.query(INS, [L1, J6, 'opted_in', u('f1000000', 7), D2, 1, await ago('0 seconds')]);
    });
    const real = createMiplanExportClient({ baseUrl: mpSrv.base, secret: EXPORT_SECRET, timeoutMs: 3000 });
    let lBody = null;
    const recorder = { fetchPage: async function (a) { const b = await real.fetchPage(a); if (b.events.length) lBody = b; return b; }, ackEvents: real.ackEvents };
    let r = await syncJob(mpSrv.base, EXPORT_SECRET, captureLogger(), { client: recorder }).run();
    assert.strictEqual(r.events_inserted, 1);
    assert.deepStrictEqual(await mpPending(), [], '[J] unresolved event acked');
    const first = (await recon(L1)).first_unresolved_at;
    const dayMs = 24 * 3600 * 1000;
    r = await syncJob(mpSrv.base, EXPORT_SECRET, captureLogger(), { now: function () { return new Date(first.getTime() + 3 * dayMs); } }).run();
    assert.strictEqual((await recon(L1)).status, 'PENDING', 'retry before the horizon');
    const log = captureLogger();
    r = await syncJob(mpSrv.base, EXPORT_SECRET, log, { now: function () { return new Date(first.getTime() + 7 * dayMs); } }).run();
    allLogs.push.apply(allLogs, log.lines);
    const term = await recon(L1);
    assert.deepStrictEqual([term.status, term.terminal_reason, term.last_unresolved_reason, term.resolution_attempt_count],
      ['TERMINAL_UNRESOLVABLE', 'HORIZON_EXCEEDED', 'TOKEN_NOT_FOUND', 4]);
    assert.ok(log.records.some(function (x) { return x.level === 'error' && x.meta.alert === ALERT.CI_TERMINAL && x.meta.event_id === L1; }), '[L] ERROR alert on terminal');
    const bags = await loadMiDeudaBagsWithDeclared(sb);
    assert.deepStrictEqual(bags.declared_layer.ci_reconciliation, { pending: 0, resolved: 3, terminal_unresolvable: 1 }, '[L] terminal stays visible');
    const ute = bags.declared_layer.bags.find(function (b) { return b.display_name === 'UTE'; });
    assert.deepStrictEqual(ute.members.map(function (m) { return m.ci; }), [CI_LATE], '[L] terminal event never bagged');

    const stale = { fetchPage: async function () { return JSON.parse(JSON.stringify(lBody)); }, ackEvents: real.ackEvents };
    r = await syncJob(mpSrv.base, EXPORT_SECRET, captureLogger(), { client: stale, maxPages: 1, now: function () { return new Date(first.getTime() + 30 * dayMs); } }).run();
    assert.strictEqual(r.events_already_ingested, 1, '[M] replay detected');
    assert.strictEqual(r.events_already_acked, 1);
    assert.strictEqual(await count('SELECT count(*) n FROM miplan_debt_optin_events WHERE event_id = $1', [L1]), 1, '[M] no duplicate');
    assert.deepStrictEqual(await recon(L1), term, '[M] horizon / status / attempts not reset');
    groups += 1;
  }

  // 8. Immutability, role isolation and log hygiene end to end.
  {
    let err = null;
    try {
      await jdb.query('UPDATE miplan_declared_debts SET monto = 1 WHERE optin_event_id = $1', [EV1]);
    } catch (e) {
      err = e;
    }
    assert.ok(err && /immutable|55000|not allowed|forbid/i.test(String(err.message) + String(err.code)), 'service_role cannot rewrite the snapshot');
    err = null;
    try {
      await jdb.query('DELETE FROM miplan_optin_ci_reconciliation');
    } catch (e) {
      err = e;
    }
    assert.ok(err && /never deleted/.test(String(err.message)), 'reconciliation rows never deleted');
    await jdb.exec('RESET ROLE');
    await jdb.exec('SET ROLE anon');
    err = null;
    try {
      await jdb.query('SELECT count(*) FROM miplan_debt_optin_events');
    } catch (e) {
      err = e;
    }
    assert.ok(err && /permission denied/.test(String(err.message)), 'anon cannot read the JANUS copy');
    await jdb.exec('RESET ROLE');
    err = null;
    try {
      await mp.query('UPDATE janus_debt_optin_delivery_acks SET janus_ingest_status = $1', ['inserted']);
    } catch (e) {
      err = e;
    }
    assert.ok(err && /APPEND_ONLY|permission denied/.test(String(err.message)), 'Mi Plan ACK log cannot be rewritten');
    const all = allLogs.join('\n');
    [EXPORT_SECRET, H1, H2, H6, String(CI), String(CI_LATE), T1, T2, 'Tía Marta', 'Fucac'].forEach(function (needle) {
      assert.ok(all.indexOf(needle) === -1, 'sensitive value in job logs: ' + needle.slice(0, 5));
    });
    groups += 1;
  }

  await new Promise(function (resolve) { mpSrv.server.close(resolve); });
  await mp.close();
  await jdb.close();
  console.log('e2e-local-miplan-debt-optin-pglite [LOCAL]: ' + groups + ' groups OK');
}

main().catch(function (err) {
  console.error('e2e-local-miplan-debt-optin-pglite: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
