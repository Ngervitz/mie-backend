'use strict';

/**
 * Integrated LOCAL test: CDV estado 8 claim (real SQL) + orchestrator + mocked ELM HTTP.
 * Applies ELM/C1 migrations, send_origin parity bootstrap, cdv estado-8 queue + fix migration.
 *
 * Run: node scripts/db-local-cdv-estado8-elm-integrated-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PGLITE_DIR =
  process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
    apifyToken: 'test',
    apifyActorId: 'test',
    sessionSecret: 'test-session',
    cronSecret: null,
  },
};

const { createElmOrchestrator } = require('../src/services/elm/orchestrator');
const { createElmRepository } = require('../src/services/elm/repository');
const { processCdvEstado8ElmQueue } = require('../src/lib/cdvEstado8ElmAutomation');
const { readCdvEstado8ElmConfig } = require('../src/lib/cdvEstado8ElmConfig');

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

const SEND_ORIGIN_BOOTSTRAP = `
ALTER TABLE public.elm_lead_processes
  ADD COLUMN IF NOT EXISTS send_origin text,
  ADD COLUMN IF NOT EXISTS send_origin_source text;
UPDATE public.elm_lead_processes SET
  send_origin = CASE trigger_origin
    WHEN 'cz_automatic' THEN 'cz_automatic'
    WHEN 'janus_batch' THEN 'janus_batch'
    WHEN 'janus_manual' THEN 'rechazados_manual'
    WHEN 'cdv_estado_8' THEN 'cdv_estado_8'
    ELSE 'cz_automatic'
  END,
  send_origin_source = COALESCE(send_origin_source, 'legacy_default')
WHERE send_origin IS NULL OR send_origin_source IS NULL;
ALTER TABLE public.elm_lead_processes
  ALTER COLUMN send_origin SET NOT NULL,
  ALTER COLUMN send_origin_source SET NOT NULL;
CREATE OR REPLACE FUNCTION public.elm_lead_processes_send_origin_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.send_origin_source NOT IN ('explicit', 'legacy_default', 'backfill') THEN
      RAISE EXCEPTION 'elm_send_origin_source_invalid_on_insert';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.send_origin IS DISTINCT FROM OLD.send_origin
     OR NEW.send_origin_source IS DISTINCT FROM OLD.send_origin_source THEN
    RAISE EXCEPTION 'elm_lead_processes.send_origin is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_elm_lead_processes_send_origin_guard ON public.elm_lead_processes;
CREATE TRIGGER trg_elm_lead_processes_send_origin_guard
  BEFORE INSERT OR UPDATE OF send_origin, send_origin_source ON public.elm_lead_processes
  FOR EACH ROW EXECUTE FUNCTION public.elm_lead_processes_send_origin_guard();
`;

const FUNNEL_STUB = `
CREATE TABLE IF NOT EXISTS public.cz_funnel_solicitudes (
  cz_id bigint PRIMARY KEY,
  ci bigint NOT NULL,
  nombre text,
  apellido text,
  email text,
  celular text,
  salario numeric,
  fecha_nacimiento text,
  relacion_laboral text,
  lrw_id text,
  solicitudes_estados_id integer,
  fecha_reg timestamptz,
  updated_at_src timestamptz,
  synced_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.cz_funnel_solicitud_estados (
  cz_historico_id bigint PRIMARY KEY,
  cz_solicitud_id bigint NOT NULL,
  solicitudes_estados_id integer,
  fechahora_src timestamptz
);
CREATE TABLE IF NOT EXISTS public.cz_funnel_granted_loans (
  cz_id bigint PRIMARY KEY,
  ci bigint,
  monto_otorgado numeric,
  updated_at_src timestamptz,
  synced_at timestamptz
);
`;

const CZ_CLAIM = 99001;
const CZ = 99002;
const CZ_QUEUE = 99003;
const CI_CLAIM = 50099001;
const CI = 50099002;
const REQ = JSON.stringify({
  docNumber: String(CI_CLAIM),
  source: 'copanel',
  firstName: 'Test',
  lastName: 'User',
  salary: '50000',
  dateOfBirth: '1/1/1990',
  activityType: 'Empleado',
});

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

function firstRow(data) {
  if (data == null) return null;
  if (Array.isArray(data)) return data[0] || null;
  return data;
}

function createPgliteSupabase(db, svc) {
  return {
    rpc: async function (name, args) {
      if (name === 'cdv_estado8_elm_try_enqueue') {
        const { error } = await svc(
          `INSERT INTO public.cdv_estado8_elm_queue (cz_solicitud_id, fechahora_estado8, status)
           VALUES ($1, $2, 'pending') ON CONFLICT (cz_solicitud_id) DO NOTHING`,
          [args.p_cz_solicitud_id, args.p_fechahora_estado8],
        );
        return { data: !error, error: error };
      }
      if (name === 'elm_claim_process') {
        const { data, error } = await svc(
          `SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11) AS r`,
          [
            args.p_cz_solicitud_id,
            args.p_ci,
            args.p_source_brand,
            args.p_trigger_origin,
            args.p_triggered_by_user_id || null,
            args.p_cz_estado_id_at_start,
            args.p_lrw_id_at_start,
            JSON.stringify(args.p_s1_request),
            args.p_lease_seconds,
            args.p_commercial_origin || null,
            args.p_send_origin || null,
          ],
        );
        if (error) return { data: null, error: error };
        const row = data.rows[0];
        return { data: row && row.r, error: null };
      }
      if (name === 'elm_finish_s1') {
        const { data, error } = await svc(
          `SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
          [
            args.p_process_id,
            args.p_status,
            JSON.stringify(args.p_response || {}),
            args.p_http_status,
            args.p_result_message,
            args.p_latency_ms,
            args.p_error_code,
            args.p_error_detail,
          ],
        );
        if (error) return { data: null, error };
        return { data: data.rows, error: null };
      }
      if (name === 'elm_begin_s2') {
        const { data, error } = await svc(
          `SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)`,
          [args.p_cz_solicitud_id, JSON.stringify(args.p_s2_request), args.p_lease_seconds],
        );
        if (error) return { data: null, error };
        return { data: data.rows, error: null };
      }
      if (name === 'elm_finish_s2') {
        const { data, error } = await svc(
          `SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
          [
            args.p_process_id,
            args.p_status,
            JSON.stringify(args.p_response || {}),
            args.p_http_status,
            args.p_result_message,
            args.p_latency_ms,
            args.p_error_code,
            args.p_error_detail,
          ],
        );
        if (error) return { data: null, error };
        return { data: data.rows, error: null };
      }
      return { data: null, error: { message: 'rpc not stubbed: ' + name } };
    },
    from: function (table) {
      function buildFilterSql(filters, params) {
        let where = '';
        for (const f of filters) {
          if (f.op === 'eq') {
            params.push(f.val);
            where += (where ? ' AND ' : ' WHERE ') + f.col + ' = $' + params.length;
          } else if (f.op === 'in') {
            params.push(f.vals);
            where += (where ? ' AND ' : ' WHERE ') + f.col + ' = ANY($' + params.length + ')';
          } else if (f.op === 'lt') {
            params.push(f.val);
            where += (where ? ' AND ' : ' WHERE ') + f.col + ' < $' + params.length;
          } else if (f.op === 'is_null') {
            where += (where ? ' AND ' : ' WHERE ') + f.col + ' IS NULL';
          }
        }
        return where;
      }
      function chain(filters) {
        const state = { filters: filters || [] };
        const api = {
          select: function () {
            return chain(state.filters);
          },
          eq: function (col, val) {
            return chain(state.filters.concat([{ col, val, op: 'eq' }]));
          },
          in: function (col, vals) {
            return chain(state.filters.concat([{ col, vals, op: 'in' }]));
          },
          lt: function (col, val) {
            return chain(state.filters.concat([{ col, val, op: 'lt' }]));
          },
          is: function (col, val) {
            if (val !== null) {
              return chain(state.filters.concat([{ col, val, op: 'eq' }]));
            }
            return chain(state.filters.concat([{ col, val: null, op: 'is_null' }]));
          },
          order: function (col, opts) {
            state.order = { col, asc: !(opts && opts.ascending === false) };
            return api;
          },
          limit: function (n) {
            state.limit = n;
            return api._runSelect(api._cols || '*', false);
          },
          maybeSingle: function () {
            return api._runSelect(api._cols || '*', true);
          },
          update: function (patch) {
            const filters = state.filters.slice();
            const runUpdate = async function () {
              const sets = Object.keys(patch)
                .map(function (k, i) {
                  return k + ' = $' + (i + 1);
                })
                .join(', ');
              const vals = Object.values(patch);
              const params = vals.slice();
              const where = buildFilterSql(filters, params);
              const sql = 'UPDATE public.' + table + ' SET ' + sets + where;
              await svc(sql, params);
              return { error: null };
            };
            const upd = {
              eq: function (col, val) {
                filters.push({ col, val, op: 'eq' });
                return upd;
              },
              in: function (col, vals) {
                filters.push({ col, vals, op: 'in' });
                return runUpdate();
              },
              lt: function (col, val) {
                filters.push({ col, val, op: 'lt' });
                return runUpdate();
              },
              then: function (onFulfilled, onRejected) {
                return runUpdate().then(onFulfilled, onRejected);
              },
            };
            return upd;
          },
          _runSelect: async function (cols, one) {
            const params = [];
            let sql = 'SELECT ' + cols + ' FROM public.' + table;
            sql += buildFilterSql(state.filters, params);
            if (state.order) {
              sql += ' ORDER BY ' + state.order.col + (state.order.asc ? ' ASC' : ' DESC');
            }
            if (state.limit != null) sql += ' LIMIT ' + Number(state.limit);
            const { data, error } = await svc(sql, params);
            if (error) return { data: null, error };
            if (one) return { data: (data.rows && data.rows[0]) || null, error: null };
            return { data: data.rows, error: null };
          },
        };
        api.select = function (cols) {
          api._cols = cols || '*';
          return api;
        };
        const origMaybe = api.maybeSingle;
        api.maybeSingle = function () {
          return api._runSelect(api._cols || '*', true);
        };
        api.in = api.in;
        return api;
      }
      const root = chain([]);
      root.select = function (cols) {
        const c = chain([]);
        c._cols = cols;
        const base = chain([]);
        base._cols = cols;
        base.select = function () {
          return base;
        };
        base.eq = function (col, val) {
          return chain([{ col, val, op: 'eq' }]).select(cols);
        };
        base.in = function (col, vals) {
          return chain([{ col, vals, op: 'in' }]).select(cols);
        };
        base.lt = function (col, val) {
          return chain([{ col, val, op: 'lt' }]).select(cols);
        };
        base.is = function (col, val) {
          const op = val === null ? 'is_null' : 'eq';
          return chain([{ col, val, op: op }]).select(cols);
        };
        base.order = function (col, opts) {
          const ch = chain([]);
          ch._cols = cols;
          ch.order = { col, asc: !(opts && opts.ascending === false) };
          return ch;
        };
        base.limit = function (n) {
          base._limit = n;
          return base._runSelect(base._cols || cols, false);
        };
        base.maybeSingle = function () {
          return base._runSelect(cols, true);
        };
        base.update = function (patch) {
          return chain([]).update(patch);
        };
        base._runSelect = chain([])._runSelect;
        return base;
      };
      return root;
    },
  };
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
  const svc = async (sql, params) => {
    const data = await db.query(sql, params || []);
    return { data, error: null };
  };

  await db.exec(STUBS);
  for (const name of [
    '20261007_elm_lead_processes.sql',
    '20261007_elm_postback_events.sql',
    '20261008_provider_fallback_requests.sql',
    '20261009_elm_phase3b_operations.sql',
    '20261010_provider_fallback_c1_events.sql',
    '20261119_elm_ci_lock_closed_cz_uncertain.sql',
  ]) {
    await db.exec(fs.readFileSync(MIG(name), 'utf8'));
  }
  await db.exec(SEND_ORIGIN_BOOTSTRAP);
  await db.exec(FUNNEL_STUB);
  await db.exec(fs.readFileSync(MIG('20261120_cdv_estado8_elm_automation.sql'), 'utf8'));
  await db.exec(fs.readFileSync(MIG('20261124_cdv_estado8_elm_send_origin.sql'), 'utf8'));
  pass('migrations + send_origin bootstrap + cdv_estado8 fix');

  await expectSqlError(
    () =>
      svc(
        `SELECT public.elm_claim_process($1, $2, 'copanel', 'cdv_estado_8', null, 8, 'LRW', $3::jsonb, 60, null, 'rechazados_manual') AS r`,
        [CZ_CLAIM, CI_CLAIM, REQ],
      ),
    /elm_invalid_send_origin/,
    'wrong send_origin pairing rejected',
  );

  const claimed = await svc(
    `SELECT public.elm_claim_process($1, $2, 'copanel', 'cdv_estado_8', null, 8, 'LRW', $3::jsonb, 60, null, null) AS r`,
    [CZ_CLAIM, CI_CLAIM, REQ],
  );
  assert.equal(claimed.data.rows[0].r.claimed, true);
  const proc = claimed.data.rows[0].r.process;
  assert.equal(proc.trigger_origin, 'cdv_estado_8');
  assert.equal(proc.send_origin, 'cdv_estado_8');
  assert.equal(proc.send_origin_source, 'legacy_default');
  pass('elm_claim_process accepts cdv_estado_8 / cdv_estado_8');

  await svc(
    `INSERT INTO public.cz_funnel_solicitudes (cz_id, ci, nombre, apellido, email, celular, salario, fecha_nacimiento, relacion_laboral, solicitudes_estados_id)
     VALUES ($1, $2, 'Ana', 'Test', 'a@test.com', '59891234567', 50000, '1990-01-01', 'EPR', 8)`,
    [CZ, CI],
  );

  let s1Calls = 0;
  const mockClient = {
    enabled: true,
    service1: async function () {
      s1Calls += 1;
      return {
        sent: true,
        outcome: 'negative',
        httpStatus: 200,
        responseBody: { success: false, result: 'SCORE BAJO. Rechazado' },
      };
    },
    service2: async function () {
      throw new Error('s2 must not run on negative s1');
    },
  };

  const sb = createPgliteSupabase(db, svc);
  const repo = createElmRepository(sb);
  const orch = createElmOrchestrator({
    repository: repo,
    client: mockClient,
    enabledTriggerOrigins: ['cdv_estado_8', 'janus_manual'],
    config: {
      inFlightLeaseSeconds: 120,
      activityTypeMap: { EPR: 'Empleado' },
      dateOfBirthFormat: 'D/M/YYYY',
      mobilePhoneFormat: 'uy_local_0',
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const send = await orch.sendElm(CZ, { triggerOrigin: 'cdv_estado_8' });
  assert.equal(send.ok, true, JSON.stringify(send));
  assert.equal(send.stage, 's1');
  assert.equal(s1Calls, 1);
  const after = (
    await svc('SELECT trigger_origin, send_origin, s1_status FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [
      CZ,
    ])
  ).data.rows[0];
  assert.equal(after.trigger_origin, 'cdv_estado_8');
  assert.equal(after.send_origin, 'cdv_estado_8');
  assert.equal(after.s1_status, 'rejected');
  pass('orchestrator sendElm with cdv_estado_8 persists process via real claim RPC');

  await svc(
    `INSERT INTO public.cz_funnel_solicitudes (cz_id, ci, nombre, apellido, email, celular, salario, fecha_nacimiento, relacion_laboral, solicitudes_estados_id)
     VALUES ($1, $2, 'Bob', 'Queue', 'b@test.com', '59891234568', 50000, '1990-01-01', 'EPR', 8)`,
    [CZ_QUEUE, CI + 1],
  );
  await svc(
    `INSERT INTO public.cdv_estado8_elm_queue (cz_solicitud_id, fechahora_estado8, status, attempts)
     VALUES ($1, now(), 'pending', 0)`,
    [CZ_QUEUE],
  );

  const drain = await processCdvEstado8ElmQueue({
    supabase: sb,
    config: readCdvEstado8ElmConfig({ CDV_ESTADO8_ELM_AUTOMATION_ENABLED: 'true' }),
    orchestrator: orch,
    nowMs: Date.now(),
  });
  assert.equal(drain.ok, true);
  assert.equal(drain.processed.length, 1);
  assert.equal(drain.processed[0].status, 'completed');

  const qrow = (
    await svc('SELECT status, last_error, elm_process_id FROM public.cdv_estado8_elm_queue WHERE cz_solicitud_id = $1', [
      CZ_QUEUE,
    ])
  ).data.rows[0];
  assert.equal(qrow.status, 'completed');
  assert.ok(qrow.elm_process_id);
  pass('processCdvEstado8ElmQueue drains queue with orchestrator + SQL');

  const c1Claim = await svc(
    `SELECT public.provider_fallback_enqueue($1, $2, '{"v":1,"cz_estado_id":12}'::jsonb, $3) AS r`,
    [
      CZ_QUEUE + 10,
      CI + 10,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ],
  );
  assert.ok(c1Claim.data.rows[0].r);
  pass('C1 enqueue still callable after elm_claim_process change');

  console.log('db-local-cdv-estado8-elm-integrated-pglite: ' + groups + ' checks passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});