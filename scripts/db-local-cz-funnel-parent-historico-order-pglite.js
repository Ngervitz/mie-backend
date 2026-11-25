'use strict';

/**
 * PGlite + FK: parent-before-historico persist order (regression for prod FK failure).
 * node scripts/db-local-cz-funnel-parent-historico-order-pglite.js
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
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cz_funnel_solicitud_estados_cz_solicitud_id_fkey
    FOREIGN KEY (cz_solicitud_id)
    REFERENCES public.cz_funnel_solicitudes (cz_id)
    ON DELETE CASCADE
);
`;

function parentPayload(czId, estado, updated, hist) {
  return {
    cz_id: czId,
    solicitudes_estados_id: estado,
    ci: 51000000 + czId,
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
  await db.exec(
    fs.readFileSync(MIG('20261125_cz_funnel_solicitudes_guarded_upsert.sql'), 'utf8'),
  );

  async function callRpc(payloadRows) {
    const res = await db.query(
      `SELECT public.cz_funnel_upsert_solicitudes_guarded($1::jsonb) AS r`,
      [JSON.stringify(payloadRows)],
    );
    return res.rows[0].r;
  }

  async function upsertHistorico(rows) {
    if (!rows.length) return;
    const values = rows
      .map(function (r, i) {
        const p = i * 4;
        return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}::timestamptz)`;
      })
      .join(', ');
    const params = [];
    rows.forEach(function (r) {
      params.push(r.cz_historico_id, r.cz_solicitud_id, r.solicitudes_estados_id, r.fechahora_src);
    });
    await db.query(
      `INSERT INTO public.cz_funnel_solicitud_estados
        (cz_historico_id, cz_solicitud_id, solicitudes_estados_id, fechahora_src)
       VALUES ${values}
       ON CONFLICT (cz_historico_id) DO UPDATE SET
        solicitudes_estados_id = EXCLUDED.solicitudes_estados_id,
        fechahora_src = EXCLUDED.fechahora_src`,
      params,
    );
  }

  const NEW = 99001;

  // Wrong order (historico before parent) must fail on FK — documents prod regression.
  let fkErr = null;
  try {
    await upsertHistorico([
      {
        cz_historico_id: 1,
        cz_solicitud_id: NEW,
        solicitudes_estados_id: 8,
        fechahora_src: '2026-11-25T15:00:01Z',
      },
    ]);
  } catch (err) {
    fkErr = err;
  }
  assert.ok(fkErr, 'historico before parent must violate FK');

  // Correct order: new solicitud + historico
  const ins = await callRpc([
    parentPayload(NEW, 8, '2026-11-25T15:00:00Z', {
      max: '2026-11-25T15:00:01Z',
      estado: 8,
    }),
  ]);
  assert.strictEqual(Number(ins.applied), 1);
  await upsertHistorico([
    {
      cz_historico_id: 1,
      cz_solicitud_id: NEW,
      solicitudes_estados_id: 8,
      fechahora_src: '2026-11-25T15:00:01Z',
    },
  ]);
  const newSnap = await db.query(
    `SELECT count(*)::int AS n FROM public.cz_funnel_solicitud_estados WHERE cz_solicitud_id = $1`,
    [NEW],
  );
  assert.strictEqual(newSnap.rows[0].n, 1);

  // Existing parent + new historico row
  await upsertHistorico([
    {
      cz_historico_id: 2,
      cz_solicitud_id: NEW,
      solicitudes_estados_id: 9,
      fechahora_src: '2026-11-25T15:05:00Z',
    },
  ]);
  const twoHist = await db.query(
    `SELECT count(*)::int AS n FROM public.cz_funnel_solicitud_estados WHERE cz_solicitud_id = $1`,
    [NEW],
  );
  assert.strictEqual(twoHist.rows[0].n, 2);

  // Stale parent snapshot + fresher historico on existing row
  const EX = 99002;
  await callRpc([
    parentPayload(EX, 8, '2026-11-25T14:00:00Z', {
      max: '2026-11-25T14:00:05Z',
      estado: 8,
    }),
  ]);
  const stale = await callRpc([
    parentPayload(EX, 4, '2026-11-25T13:00:00Z', {
      max: '2026-11-25T14:30:00Z',
      estado: 4,
    }),
  ]);
  assert.strictEqual(Number(stale.skipped), 1);
  await upsertHistorico([
    {
      cz_historico_id: 3,
      cz_solicitud_id: EX,
      solicitudes_estados_id: 8,
      fechahora_src: '2026-11-25T14:30:00Z',
    },
  ]);
  const exHist = await db.query(
    `SELECT count(*)::int AS n FROM public.cz_funnel_solicitud_estados WHERE cz_solicitud_id = $1`,
    [EX],
  );
  assert.strictEqual(exHist.rows[0].n, 1);

  // Concurrent guarded insert same new id
  const CON = 99003;
  const row = parentPayload(CON, 8, '2026-11-25T16:00:00Z', {
    max: '2026-11-25T16:00:01Z',
    estado: 8,
  });
  await Promise.all([callRpc([row]), callRpc([Object.assign({}, row, { nombre: 'A' })])]);
  await upsertHistorico([
    {
      cz_historico_id: 4,
      cz_solicitud_id: CON,
      solicitudes_estados_id: 8,
      fechahora_src: '2026-11-25T16:00:01Z',
    },
  ]);
  const one = await db.query(
    `SELECT count(*)::int AS n FROM public.cz_funnel_solicitudes WHERE cz_id = $1`,
    [CON],
  );
  assert.strictEqual(one.rows[0].n, 1);

  console.log('db-local-cz-funnel-parent-historico-order-pglite: OK');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});