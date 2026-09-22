'use strict';

/**
 * Offline unit checks for Preaprobados V1 read assembly + permission mapping.
 * Run: node scripts/unit-preaprobados-read.js
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

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
  },
};

const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {},
};

const {
  SECTION_KEYS,
  resolveSectionForPath,
} = require('../src/middleware/dashboardSections');
const {
  requireDashboardPermission,
} = require('../src/middleware/requireDashboardPermission');
const {
  PREAPROBADOS_ESTADO_ID,
  RESULT_GRANTED,
  RESULT_SIN_RESULTADO,
  parseResultadoQuery,
  parseEstadoQuery,
  parsePagination,
  buildCohortByCzId,
  assemblePreaprobadosList,
  assemblePreaprobadosDetail,
} = require('../src/lib/preaprobadosRead');

assert.ok(SECTION_KEYS.includes('preaprobados'));
assert.strictEqual(resolveSectionForPath('/preaprobados'), 'preaprobados');
assert.strictEqual(
  resolveSectionForPath('/preaprobados/1168'),
  'preaprobados',
);

assert.deepStrictEqual(parseResultadoQuery(undefined), {
  ok: true,
  value: null,
});
assert.deepStrictEqual(parseResultadoQuery('granted'), {
  ok: true,
  value: RESULT_GRANTED,
});
assert.deepStrictEqual(parseResultadoQuery('sin_resultado'), {
  ok: true,
  value: RESULT_SIN_RESULTADO,
});
assert.deepStrictEqual(parseResultadoQuery('nope'), { ok: false });
assert.deepStrictEqual(parseEstadoQuery('8'), { ok: true, value: 8 });
assert.deepStrictEqual(parseEstadoQuery('99'), { ok: false });
assert.deepStrictEqual(parsePagination('100', '0'), {
  ok: true,
  limit: 100,
  offset: 0,
});
assert.deepStrictEqual(parsePagination('-1', '0'), { ok: false });

// --- fixtures ---
const solStill8 = {
  cz_id: 100,
  ci: 111,
  nombre: 'Ana',
  apellido: 'Perez',
  email: 'ana@x.com',
  lrw_id: 'LRW-100',
  fecha_reg: '2026-08-01T10:00:00.000Z',
  solicitudes_estados_id: 8,
  synced_at: '2026-09-01T00:00:00.000Z',
  updated_at_src: '2026-08-15T00:00:00.000Z',
};

const solLeft8 = {
  cz_id: 200,
  ci: 222,
  nombre: 'Beto',
  apellido: 'Gomez',
  email: 'beto@x.com',
  lrw_id: 'LRW-200',
  fecha_reg: '2026-07-01T10:00:00.000Z',
  solicitudes_estados_id: 7,
  synced_at: '2026-09-01T00:00:00.000Z',
  updated_at_src: '2026-08-20T00:00:00.000Z',
};

const solFallback8 = {
  cz_id: 300,
  ci: 333,
  nombre: 'Carla',
  apellido: 'Luis',
  email: null,
  lrw_id: 'LRW-300',
  fecha_reg: '2026-08-10T12:00:00.000Z',
  solicitudes_estados_id: 8,
  synced_at: '2026-09-01T00:00:00.000Z',
  updated_at_src: '2026-08-10T12:00:00.000Z',
};

const solLrwNever8 = {
  cz_id: 400,
  ci: 444,
  nombre: 'Diego',
  apellido: 'Nunca',
  email: 'd@x.com',
  lrw_id: 'LRW-HAS',
  fecha_reg: '2026-08-05T00:00:00.000Z',
  solicitudes_estados_id: 3,
  synced_at: '2026-09-01T00:00:00.000Z',
  updated_at_src: '2026-08-05T00:00:00.000Z',
};

const solSameCiA = {
  cz_id: 501,
  ci: 555,
  nombre: 'Eva',
  apellido: 'Dos',
  email: 'e1@x.com',
  lrw_id: 'LRW-501',
  fecha_reg: '2026-08-01T00:00:00.000Z',
  solicitudes_estados_id: 8,
  synced_at: '2026-09-01T00:00:00.000Z',
  updated_at_src: null,
};

const solSameCiB = {
  cz_id: 502,
  ci: 555,
  nombre: 'Eva',
  apellido: 'Dos',
  email: 'e2@x.com',
  lrw_id: 'LRW-502',
  fecha_reg: '2026-08-02T00:00:00.000Z',
  solicitudes_estados_id: 8,
  synced_at: '2026-09-01T00:00:00.000Z',
  updated_at_src: null,
};

const solGrantedLater = {
  cz_id: 600,
  ci: 666,
  nombre: 'Fran',
  apellido: 'Grant',
  email: 'f@x.com',
  lrw_id: 'LRW-600',
  fecha_reg: '2026-08-01T00:00:00.000Z',
  solicitudes_estados_id: 11,
  synced_at: '2026-09-20T00:00:00.000Z',
  updated_at_src: '2026-09-15T00:00:00.000Z',
};

const estado8Rows = [
  {
    cz_historico_id: 1,
    cz_solicitud_id: 100,
    solicitudes_estados_id: 8,
    estado: 'Enviado CDV',
    fechahora_src: '2026-08-05T15:00:00.000Z',
  },
  {
    cz_historico_id: 2,
    cz_solicitud_id: 200,
    solicitudes_estados_id: 8,
    estado: 'Enviado CDV',
    fechahora_src: '2026-08-08T10:00:00.000Z',
  },
  {
    cz_historico_id: 3,
    cz_solicitud_id: 501,
    solicitudes_estados_id: 8,
    estado: 'Enviado CDV',
    fechahora_src: '2026-08-03T00:00:00.000Z',
  },
  {
    cz_historico_id: 4,
    cz_solicitud_id: 502,
    solicitudes_estados_id: 8,
    estado: 'Enviado CDV',
    fechahora_src: '2026-08-04T00:00:00.000Z',
  },
  {
    cz_historico_id: 5,
    cz_solicitud_id: 600,
    solicitudes_estados_id: 8,
    estado: 'Enviado CDV',
    fechahora_src: '2026-08-12T00:00:00.000Z',
  },
];

const currentEstado8 = [solStill8, solFallback8, solSameCiA, solSameCiB];

const solicitudRows = [
  solStill8,
  solLeft8,
  solFallback8,
  solLrwNever8,
  solSameCiA,
  solSameCiB,
  solGrantedLater,
];

const grantedRows = [
  {
    cz_id: 600,
    ci: 666,
    monto_otorgado: 15000,
    updated_at_src: '2026-09-15T00:00:00.000Z',
    synced_at: '2026-09-20T00:00:00.000Z',
  },
];

const historicoRows = [
  ...estado8Rows,
  {
    cz_historico_id: 10,
    cz_solicitud_id: 200,
    solicitudes_estados_id: 7,
    estado: 'Otro estado',
    solicitudes_estados_id_anterior: 8,
    estado_anterior: 'Enviado CDV',
    fechahora_src: '2026-08-18T00:00:00.000Z',
  },
  {
    cz_historico_id: 11,
    cz_solicitud_id: 600,
    solicitudes_estados_id: 11,
    estado: 'Otorgado',
    fechahora_src: '2026-09-15T00:00:00.000Z',
  },
];

// 1) still in 8
{
  const cohort = buildCohortByCzId(estado8Rows, currentEstado8);
  assert.ok(cohort.has(100));
  assert.strictEqual(
    cohort.get(100).cohort_entered_at,
    '2026-08-05T15:00:00.000Z',
  );
}

// 2) left 8 — still in cohort
{
  const cohort = buildCohortByCzId(estado8Rows, currentEstado8);
  assert.ok(cohort.has(200));
  assert.strictEqual(cohort.get(200).from_historico, true);
}

// 3) current 8 without historico → fecha_reg fallback
{
  const cohort = buildCohortByCzId(estado8Rows, currentEstado8);
  assert.ok(cohort.has(300));
  assert.strictEqual(cohort.get(300).from_historico, false);
  assert.strictEqual(
    cohort.get(300).cohort_entered_at,
    '2026-08-10T12:00:00.000Z',
  );
}

// 4) lrw_id but never 8 → NOT in cohort
{
  const cohort = buildCohortByCzId(estado8Rows, currentEstado8);
  assert.ok(!cohort.has(400));
  assert.strictEqual(PREAPROBADOS_ESTADO_ID, 8);
}

// 5) same CI two cz_id → two rows
{
  const out = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
    limit: 100,
    offset: 0,
  });
  const sameCi = out.rows.filter(function (r) {
    return r.ci === 555;
  });
  assert.strictEqual(sameCi.length, 2);
  assert.ok(sameCi.some(function (r) {
    return r.cz_id === 501;
  }));
  assert.ok(sameCi.some(function (r) {
    return r.cz_id === 502;
  }));
}

// 6) granted via cz_funnel_granted_loans
{
  const out = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
    resultado: RESULT_GRANTED,
    limit: 100,
    offset: 0,
  });
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].cz_id, 600);
  assert.strictEqual(out.rows[0].resultado, RESULT_GRANTED);
  assert.strictEqual(out.rows[0].monto_otorgado, 15000);
}

// 7) Sin resultado even when estado actual != 8
{
  const out = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    q: '200',
    limit: 100,
    offset: 0,
  });
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].cz_id, 200);
  assert.strictEqual(out.rows[0].estado_id, 7);
  assert.strictEqual(out.rows[0].resultado, RESULT_SIN_RESULTADO);
}

// 8 + 9 identity + conversion
{
  const out = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
    limit: 100,
    offset: 0,
  });
  assert.strictEqual(
    out.kpis.preaprobados,
    out.kpis.granted + out.kpis.sin_resultado,
  );
  assert.strictEqual(
    out.kpis.conversion,
    out.kpis.granted / out.kpis.preaprobados,
  );
  assert.strictEqual(out.kpis.monto_otorgado, 15000);
  // 100,200,300,501,502,600 — not 400
  assert.strictEqual(out.kpis.preaprobados, 6);
  assert.strictEqual(out.kpis.granted, 1);
  assert.strictEqual(out.kpis.sin_resultado, 5);
}

// 10) cohort filter by cohort_entered_at (not fecha_reg / not granted date)
{
  // Narrow window that includes only 100 (entered Aug 5) not 600 (entered Aug 12)
  const out = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    from: '2026-08-05T00:00:00.000Z',
    to: '2026-08-06T00:00:00.000Z',
    limit: 100,
    offset: 0,
  });
  assert.strictEqual(out.kpis.preaprobados, 1);
  assert.strictEqual(out.rows[0].cz_id, 100);
}

// 11) GRANTED after period still counts in original cohort
{
  const out = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    from: '2026-08-12T00:00:00.000Z',
    to: '2026-08-12T23:59:59.999Z',
    limit: 100,
    offset: 0,
  });
  assert.strictEqual(out.kpis.preaprobados, 1);
  assert.strictEqual(out.kpis.granted, 1);
  assert.strictEqual(out.rows[0].cz_id, 600);
  assert.strictEqual(out.rows[0].resultado, RESULT_GRANTED);
}

// Detail + historico order
{
  const detail = assemblePreaprobadosDetail({
    czId: 200,
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitud: solLeft8,
    grantedRow: null,
    historicoRows: historicoRows.filter(function (h) {
      return Number(h.cz_solicitud_id) === 200;
    }),
  });
  assert.ok(detail);
  assert.strictEqual(detail.resultado, RESULT_SIN_RESULTADO);
  assert.strictEqual(detail.estado_id, 7);
  assert.strictEqual(detail.historico.length, 2);
  assert.ok(
    Date.parse(detail.historico[0].fechahora_src) <
      Date.parse(detail.historico[1].fechahora_src),
  );
}

// Not in cohort detail
{
  const detail = assemblePreaprobadosDetail({
    czId: 400,
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitud: solLrwNever8,
    grantedRow: null,
    historicoRows: [],
  });
  assert.strictEqual(detail, null);
}

// Pagination
{
  const out = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
    limit: 2,
    offset: 0,
  });
  assert.strictEqual(out.rows.length, 2);
  assert.strictEqual(out.total, 6);
  assert.strictEqual(out.kpis.preaprobados, 6);
  const page2 = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
    limit: 2,
    offset: 2,
  });
  assert.strictEqual(page2.rows.length, 2);
  assert.notStrictEqual(page2.rows[0].cz_id, out.rows[0].cz_id);
}

// Search by lrw / name
{
  const byLrw = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    q: 'LRW-100',
    limit: 100,
    offset: 0,
  });
  assert.strictEqual(byLrw.rows.length, 1);
  assert.strictEqual(byLrw.rows[0].cz_id, 100);

  const byName = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    q: 'ana',
    limit: 100,
    offset: 0,
  });
  assert.ok(byName.rows.some(function (r) {
    return r.cz_id === 100;
  }));
}

// Filter estado actual
{
  const out = assemblePreaprobadosList({
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
    estado: 7,
    limit: 100,
    offset: 0,
  });
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].cz_id, 200);
}

// Permission middleware
(async function permissionTests() {
  await new Promise(function (resolve, reject) {
    const mw = requireDashboardPermission('preaprobados');
    const req = { dashboardUserId: null, dashboardAuthViaCron: false };
    const res = {
      statusCode: null,
      body: null,
      status: function (code) {
        this.statusCode = code;
        return this;
      },
      json: function (body) {
        this.body = body;
        try {
          assert.strictEqual(this.statusCode, 401);
          resolve();
        } catch (e) {
          reject(e);
        }
        return this;
      },
    };
    mw(req, res, function () {
      reject(new Error('expected 401'));
    });
  });

  await new Promise(function (resolve, reject) {
    const mw = requireDashboardPermission('preaprobados');
    mw(
      { dashboardUserId: null, dashboardAuthViaCron: true },
      {
        status: function () {
          reject(new Error('no status'));
          return this;
        },
        json: function () {
          reject(new Error('no json'));
          return this;
        },
      },
      function () {
        resolve();
      },
    );
  });

  // HTTP smoke with mocked empty supabase bundle
  function emptyClient() {
    return {
      from: function () {
        return {
          select: function () {
            const q = {
              eq: function () {
                return q;
              },
              in: function () {
                return q;
              },
              range: async function () {
                return { data: [], error: null };
              },
              maybeSingle: async function () {
                return { data: null, error: null };
              },
            };
            return q;
          },
        };
      },
    };
  }

  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: emptyClient(),
  };
  const routePath = require.resolve('../src/routes/preaprobados');
  delete require.cache[routePath];
  const router = require('../src/routes/preaprobados');

  const app = express();
  app.use('/preaprobados', router);
  const server = http.createServer(app);
  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const res = await fetch(base + '/preaprobados?limit=10&offset=0');
  const json = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.data.kpis.preaprobados, 0);
  assert.strictEqual(
    json.data.kpis.preaprobados,
    json.data.kpis.granted + json.data.kpis.sin_resultado,
  );
  server.close();

  console.log('unit-preaprobados-read: OK');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
