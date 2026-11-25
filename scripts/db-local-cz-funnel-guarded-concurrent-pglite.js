'use strict';

/**
 * PGlite: real SQL guarded upsert + concurrent writers.
 * node scripts/db-local-cz-funnel-guarded-concurrent-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PGLITE_DIR =
  process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIG = (name) => path.join(__dirname, '..', 'migrations', name);

const STUB = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE public.cz_funnel_solicitudes (
  cz_id bigint PRIMARY KEY,
  solicitudes_estados_id integer,
  usuarios_id integer,
  ci bigint,
  nombre text,
  apellido text,
  email text,
  lrw_id text,
  celular text,
  salario numeric,
  fecha_nacimiento date,
  fecha_nacimiento_status text,
  relacion_laboral text,
  fecha_reg timestamptz,
  updated_at_src timestamptz,
  updated_raw text,
  tracking_data_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.cz_funnel_solicitud_estados (
  cz_historico_id bigint PRIMARY KEY,
  cz_solicitud_id bigint NOT NULL,
  solicitudes_estados_id integer,
  solicitudes_estados_id_anterior integer,
  estado text,
  estado_anterior text,
  fechahora_src timestamptz,
  fechahora_raw text,
  extra_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now()
);
`;

const CZ = 88001;

function rowPayload(estado, updated, hist) {
  return {
    cz_id: CZ,
    solicitudes_estados_id: estado,
    ci: 51088001,
    updated_at_src: updated,
    updated_raw: String(updated),
    tracking_data_summary: {},
    synced_at: new Date().toISOString(),
    incoming_hist_max: hist.max,
    incoming_hist_estado_id: hist.estado,
  };
}

async function main() {
  const { PGlite } = require(PGLITE_DIR);
  const db = new PGlite();
  await db.exec(STUB);
  await db.exec(fs.readFileSync(MIG('20261125_cz_funnel_solicitudes_guarded_upsert.sql'), 'utf8'));

  await db.exec(
    `INSERT INTO public.cz_funnel_solicitudes (cz_id, solicitudes_estados_id, updated_at_src, updated_raw, tracking_data_summary)
     VALUES (${CZ}, 8, '2026-11-25T14:00:00Z', '2026-11-25T14:00:00Z', '{}')`,
  );
  await db.exec(
    `INSERT INTO public.cz_funnel_solicitud_estados (cz_historico_id, cz_solicitud_id, solicitudes_estados_id, fechahora_src)
     VALUES (1, ${CZ}, 8, '2026-11-25T14:00:05Z')`,
  );

  async function callRpc(payloadRows) {
    const res = await db.query(
      `SELECT public.cz_funnel_upsert_solicitudes_guarded($1::jsonb) AS r`,
      [JSON.stringify(payloadRows)],
    );
    return res.rows[0].r;
  }

  const [staleRes, freshRes] = await Promise.all([
    callRpc([
      rowPayload(4, '2026-11-25T13:00:00Z', { max: null, estado: null }),
    ]),
    callRpc([
      rowPayload(8, '2026-11-25T14:00:00Z', {
        max: '2026-11-25T14:00:10Z',
        estado: 8,
      }),
    ]),
  ]);

  assert.strictEqual(Number(staleRes.skipped), 1);
  assert.strictEqual(Number(freshRes.applied), 1);

  const snap = await db.query(
    `SELECT solicitudes_estados_id, updated_at_src::text FROM public.cz_funnel_solicitudes WHERE cz_id = $1`,
    [CZ],
  );
  assert.strictEqual(snap.rows[0].solicitudes_estados_id, 8);

  await db.exec(
    `INSERT INTO public.cz_funnel_solicitud_estados (cz_historico_id, cz_solicitud_id, solicitudes_estados_id, fechahora_src)
     VALUES (2, ${CZ}, 8, '2026-11-25T14:00:10Z')`,
  );

  const regress = await callRpc([
    rowPayload(5, '2026-11-25T14:00:00Z', {
      max: '2026-11-25T14:00:08Z',
      estado: 5,
    }),
  ]);
  assert.strictEqual(Number(regress.skipped), 1);

  const NEW_CZ = 88002;
  const baseRow = rowPayload(8, '2026-11-25T15:00:00Z', {
    max: '2026-11-25T15:00:01Z',
    estado: 8,
  });
  baseRow.cz_id = NEW_CZ;
  baseRow.ci = 51088002;

  const [insA, insB] = await Promise.all([
    callRpc([Object.assign({}, baseRow)]),
    callRpc([Object.assign({}, baseRow, { nombre: 'Concurrent' })]),
  ]);
  assert.ok(Number(insA.applied) + Number(insB.applied) >= 1);

  const one = await db.query(
    `SELECT count(*)::int AS n FROM public.cz_funnel_solicitudes WHERE cz_id = $1`,
    [NEW_CZ],
  );
  assert.strictEqual(one.rows[0].n, 1);

  const row = await db.query(
    `SELECT nombre FROM public.cz_funnel_solicitudes WHERE cz_id = $1`,
    [NEW_CZ],
  );
  assert.ok(row.rows[0].nombre);

  console.log('db-local-cz-funnel-guarded-concurrent-pglite: OK');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});