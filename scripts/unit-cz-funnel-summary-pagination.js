'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CZ_FUNNEL_SUMMARY_PAGE_SIZE,
  fetchAllPaginated,
  loadCzFunnelSummarySources,
} = require('../src/lib/czFunnelSummaryRead');
const { surveyConversionByCi } = require('../src/lib/czSurveyConversionByCi');

function monthKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
  return ymd && ymd.length >= 7 ? ymd.slice(0, 7) : null;
}

function makeRows(prefix, count, rowFn) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push(rowFn(i));
  }
  return rows;
}

function mockTable(rows, pk) {
  let calls = 0;
  return {
    calls: function () {
      return calls;
    },
    from: function () {
      return {
        select: function () {
          const chain = {
            order: function () {
              return chain;
            },
            eq: function () {
              return chain;
            },
            range: async function (from, to) {
              calls += 1;
              return {
                data: rows.slice(from, to + 1),
                error: null,
              };
            },
          };
          return chain;
        },
      };
    },
    pk: pk,
  };
}

function mockSupabase(tables) {
  return {
    from: function (name) {
      const table = tables[name];
      assert.ok(table, 'unexpected table ' + name);
      return table.from();
    },
  };
}

async function run() {
// --- fetchAllPaginated: >1000 and >2000 without gaps or duplicates ---
{
  const rows = makeRows('sol', 1500, function (i) {
    return { id: i };
  });
  const ranges = [];
  const out = await fetchAllPaginated(async function (from, to) {
    ranges.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  });
  assert.strictEqual(out.length, 1500);
  assert.strictEqual(ranges.length, 2);
  assert.strictEqual(ranges[0][1] - ranges[0][0] + 1, CZ_FUNNEL_SUMMARY_PAGE_SIZE);
  const ids = new Set(out.map((r) => r.id));
  assert.strictEqual(ids.size, 1500);
}

{
  const rows = makeRows('sol', 2501, function (i) {
    return { id: i };
  });
  const out = await fetchAllPaginated(async function (from, to) {
    return { data: rows.slice(from, to + 1), error: null };
  });
  assert.strictEqual(out.length, 2501);
  assert.strictEqual(new Set(out.map((r) => r.id)).size, 2501);
}

// --- intermediate page failure must throw (no silent partial) ---
{
  let page = 0;
  await assert.rejects(
    async function () {
      await fetchAllPaginated(async function (from, to) {
        page += 1;
        if (page === 2) {
          return { data: null, error: { message: 'timeout on page 2' } };
        }
        const rows = makeRows('x', 2500, function (i) {
          return { id: i };
        });
        return { data: rows.slice(from, to + 1), error: null };
      });
    },
    function (err) {
      return /timeout on page 2/.test(err.message);
    },
  );
}

// --- loadCzFunnelSummarySources paginates all four tables ---
{
  const solicitudes = makeRows('sol', 1200, function (i) {
    return { cz_id: i, ci: 100000 + i, fecha_reg: '2026-06-01T12:00:00.000Z' };
  });
  const encuestas = makeRows('enc', 1100, function (i) {
    return {
      cz_id: i,
      ci: 200000 + i,
      score_v2: 20,
      version_cuestionario: 2,
      completed_at: '2026-06-10T12:00:00.000Z',
    };
  });
  const estados = makeRows('est', 1050, function (i) {
    return {
      cz_historico_id: i,
      cz_solicitud_id: i,
      solicitudes_estados_id: 3,
      fechahora_src: '2026-06-05T12:00:00.000Z',
    };
  });
  const loans = [{ cz_id: 1, monto_otorgado: 100, updated_at_src: '2026-06-01T12:00:00.000Z' }];

  const tables = {
    cz_funnel_granted_loans: mockTable(loans, 'cz_id'),
    cz_funnel_solicitudes: mockTable(solicitudes, 'cz_id'),
    cz_funnel_encuestas: mockTable(encuestas, 'cz_id'),
    cz_funnel_solicitud_estados: mockTable(estados, 'cz_historico_id'),
  };

  const sb = mockSupabase(tables);
  const loaded = await loadCzFunnelSummarySources(sb);
  assert.strictEqual(loaded.solicitudes.length, 1200);
  assert.strictEqual(loaded.encuestas.length, 1100);
  assert.strictEqual(loaded.estadoRows.length, 1050);
  assert.strictEqual(loaded.grantedLoans.length, 1);
  assert.ok(tables.cz_funnel_solicitudes.calls() >= 2);
  assert.ok(tables.cz_funnel_encuestas.calls() >= 2);
  assert.ok(tables.cz_funnel_solicitud_estados.calls() >= 2);
}

// --- conversion on full synthetic universe (not truncated) ---
{
  const novIso = '2026-11-10T15:00:00.000Z';
  const sol = [];
  const est = [];
  const enc = [];
  for (let i = 0; i < 12; i += 1) {
    const czId = 5000 + i;
    const ci = 600000 + i;
    sol.push({ cz_id: czId, ci: ci, fecha_reg: novIso });
    est.push({
      cz_historico_id: 8000 + i,
      cz_solicitud_id: czId,
      solicitudes_estados_id: 3,
      fechahora_src: novIso,
    });
    if (i < 7) {
      enc.push({
        cz_id: 9000 + i,
        ci: ci,
        score_v2: 18,
        version_cuestionario: 2,
        completed_at: '2026-11-12T15:00:00.000Z',
      });
    }
  }
  const conv = surveyConversionByCi(
    { solicitudRows: sol, surveyRows: enc },
    {
      monthKey,
      nowMs: Date.parse('2026-11-23T18:00:00.000Z'),
      currentMonthKey: '2026-11',
    },
  );
  const nov = conv.surveyConversionByMonth.find(function (r) {
    return r.month === '2026-11';
  });
  assert.strictEqual(nov.denominator, 12);
  assert.strictEqual(nov.numerator, 7);
  assert.strictEqual(nov.rate, Math.round((7 / 12) * 1000) / 10);

  const padSol = makeRows('pad-sol', 1500, function (i) {
    return { cz_id: i, ci: 700000 + i, fecha_reg: '2025-01-01T12:00:00.000Z' };
  });
  const fullSol = padSol.concat(sol);
  const fullConv = surveyConversionByCi(
    { solicitudRows: fullSol, surveyRows: enc },
    {
      monthKey,
      nowMs: Date.parse('2026-11-23T18:00:00.000Z'),
      currentMonthKey: '2026-11',
    },
  );
  const fullNov = fullConv.surveyConversionByMonth.find(function (r) {
    return r.month === '2026-11';
  });
  assert.deepStrictEqual(fullNov, nov, 'cohort stable when solicitudes > 1000');
}

{
  const route = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'reports.js'),
    'utf8',
  );
  const block = route.slice(
    route.indexOf("router.get('/cz-funnel-summary'"),
    route.indexOf("router.get('/cz-funnel-channel-utility'"),
  );
  assert.ok(block.includes('loadCzFunnelSummarySources'));
  assert.ok(!block.includes(".from('cz_funnel_solicitudes')"));
}

console.log('unit-cz-funnel-summary-pagination: ok');
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});