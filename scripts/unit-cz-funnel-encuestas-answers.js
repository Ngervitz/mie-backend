'use strict';

/**
 * node scripts/unit-cz-funnel-encuestas-answers.js
 *
 * Covers expanded /encuestas mapping (p1–p10 + analytic fields).
 * Does not touch eligibility / Rechazados completion logic.
 */

const assert = require('assert');

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
    czTrackingHmacSecret: null,
  },
};

const supabasePath = require.resolve('../src/clients/supabase');
let supabaseImpl = {
  from: function () {
    throw new Error('supabase mock not installed');
  },
};
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from: function () {
      return supabaseImpl.from.apply(supabaseImpl, arguments);
    },
  },
};

const {
  SOURCE_ENCUESTAS,
  mapEncuestaRow,
  upsertEncuestas,
  parseCzDateTime,
} = require('../src/jobs/czFunnelSync');

function fullItem(overrides) {
  return Object.assign(
    {
      id: 65,
      ci: 57000086,
      email: 'user@example.com',
      tipo: 'prestamo-rechazado',
      estado: 'completada',
      p1: 'B',
      p2: 'A',
      p3: 'B',
      p4: 'A',
      p5: 'B',
      p6: 'C',
      p7: 'A',
      p8: 'A',
      p9: 'B',
      p10: 'A',
      bloque_1_score_v2: 8,
      bloque_2_score_v2: 7,
      bloque_3_score_v2: 4,
      bloque_4_score_v2: 5,
      segmentacion_base: 'A',
      b_plus: 0,
      version_cuestionario: 1,
      canal_origen: 'web',
      score_v2: 24,
      completed_at: '2026-09-22 14:24:11',
    },
    overrides || {},
  );
}

function createStore() {
  const byId = new Map();
  const upserts = [];
  supabaseImpl = {
    from: function (table) {
      return {
        upsert: function (rows, spec) {
          upserts.push({
            table: table,
            rows: rows,
            onConflict: spec && spec.onConflict,
          });
          if (table === SOURCE_ENCUESTAS) {
            (rows || []).forEach(function (row) {
              byId.set(row.cz_id, Object.assign({}, row));
            });
          }
          return Promise.resolve({ data: rows, error: null });
        },
      };
    },
  };
  return { byId: byId, upserts: upserts };
}

// --- A. Full payload mapping ---
(async function run() {
  {
    const now = '2026-09-22T19:00:00.000Z';
    const row = mapEncuestaRow(fullItem(), now);
    assert.ok(row);
    assert.strictEqual(row.cz_id, 65);
    assert.strictEqual(row.ci, 57000086);
    assert.strictEqual(row.email, 'user@example.com');
    assert.strictEqual(row.tipo, 'prestamo-rechazado');
    assert.strictEqual(row.estado, 'completada');
    assert.strictEqual(row.p1, 'B');
    assert.strictEqual(row.p2, 'A');
    assert.strictEqual(row.p3, 'B');
    assert.strictEqual(row.p4, 'A');
    assert.strictEqual(row.p5, 'B');
    assert.strictEqual(row.p6, 'C');
    assert.strictEqual(row.p7, 'A');
    assert.strictEqual(row.p8, 'A');
    assert.strictEqual(row.p9, 'B');
    assert.strictEqual(row.p10, 'A');
    assert.strictEqual(row.bloque_1_score_v2, 8);
    assert.strictEqual(row.bloque_2_score_v2, 7);
    assert.strictEqual(row.bloque_3_score_v2, 4);
    assert.strictEqual(row.bloque_4_score_v2, 5);
    assert.strictEqual(row.segmentacion_base, 'A');
    assert.strictEqual(row.b_plus, 0);
    assert.strictEqual(row.version_cuestionario, 1);
    assert.strictEqual(row.canal_origen, 'web');
    assert.strictEqual(row.score_v2, 24);
    assert.strictEqual(
      row.completed_at,
      parseCzDateTime('2026-09-22 14:24:11'),
    );
    assert.strictEqual(row.synced_at, now);
  }

  // --- B. Missing / null / blank new fields do not break ---
  {
    const row = mapEncuestaRow(
      {
        id: 66,
        ci: 11111111,
        email: null,
        score_v2: 10,
        completed_at: '2026-09-01 10:00:00',
        // all new fields absent
      },
      '2026-09-22T19:00:00.000Z',
    );
    assert.ok(row);
    assert.strictEqual(row.cz_id, 66);
    assert.strictEqual(row.tipo, null);
    assert.strictEqual(row.estado, null);
    assert.strictEqual(row.p1, null);
    assert.strictEqual(row.p10, null);
    assert.strictEqual(row.bloque_1_score_v2, null);
    assert.strictEqual(row.bloque_4_score_v2, null);
    assert.strictEqual(row.segmentacion_base, null);
    assert.strictEqual(row.b_plus, null);
    assert.strictEqual(row.version_cuestionario, null);
    assert.strictEqual(row.canal_origen, null);
    assert.strictEqual(row.score_v2, 10);

    const blank = mapEncuestaRow(
      fullItem({
        id: 67,
        p1: '  ',
        p2: '',
        tipo: '   ',
        b_plus: '',
        bloque_1_score_v2: '',
        version_cuestionario: null,
      }),
      '2026-09-22T19:00:00.000Z',
    );
    assert.strictEqual(blank.p1, null);
    assert.strictEqual(blank.p2, null);
    assert.strictEqual(blank.tipo, null);
    assert.strictEqual(blank.b_plus, null);
    assert.strictEqual(blank.bloque_1_score_v2, null);
    assert.strictEqual(blank.version_cuestionario, null);
  }

  // skip items without id
  assert.strictEqual(mapEncuestaRow({ ci: 1 }, 'x'), null);
  assert.strictEqual(mapEncuestaRow(null, 'x'), null);

  // --- C. Upsert by encuesta id (cz_id); second write updates, no duplicate ---
  {
    const store = createStore();
    const n1 = await upsertEncuestas([
      fullItem({ id: 65, p1: 'B', score_v2: 24 }),
    ]);
    assert.strictEqual(n1, 1);
    assert.strictEqual(store.upserts.length, 1);
    assert.strictEqual(store.upserts[0].table, SOURCE_ENCUESTAS);
    assert.strictEqual(store.upserts[0].onConflict, 'cz_id');
    assert.strictEqual(store.byId.size, 1);
    assert.strictEqual(store.byId.get(65).p1, 'B');
    assert.strictEqual(store.byId.get(65).score_v2, 24);

    const n2 = await upsertEncuestas([
      fullItem({
        id: 65,
        p1: 'C',
        p10: 'D',
        score_v2: 18,
        b_plus: 1,
        bloque_2_score_v2: 9,
      }),
    ]);
    assert.strictEqual(n2, 1);
    assert.strictEqual(store.byId.size, 1);
    assert.strictEqual(store.byId.get(65).p1, 'C');
    assert.strictEqual(store.byId.get(65).p10, 'D');
    assert.strictEqual(store.byId.get(65).score_v2, 18);
    assert.strictEqual(store.byId.get(65).b_plus, 1);
    assert.strictEqual(store.byId.get(65).bloque_2_score_v2, 9);
  }

  // empty batch
  {
    createStore();
    const n = await upsertEncuestas([]);
    assert.strictEqual(n, 0);
    const n2 = await upsertEncuestas([{ ci: 1 }, { id: 'nope' }]);
    // Number('nope') is NaN → skipped
    assert.strictEqual(n2, 0);
  }

  // --- D. Regression: completion remains "any row for CI" (mirror of eligibility) ---
  {
    const store = createStore();
    await upsertEncuestas([
      fullItem({ id: 100, ci: 45006120, p1: 'A' }),
      fullItem({ id: 101, ci: 45006120, p1: 'B' }),
      fullItem({ id: 102, ci: 99999999, p1: 'C' }),
    ]);
    const forCi = [...store.byId.values()].filter(function (r) {
      return Number(r.ci) === 45006120;
    });
    // Same rule as rejectedSurveyInviteEligibility: count > 0 by ci
    const hasEncuesta = forCi.length > 0;
    assert.strictEqual(hasEncuesta, true);
    assert.strictEqual(forCi.length, 2);
    // New columns present but do not affect the presence check
    assert.strictEqual(forCi[0].p1 != null || forCi[1].p1 != null, true);
  }

  console.log('unit-cz-funnel-encuestas-answers: ok');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
