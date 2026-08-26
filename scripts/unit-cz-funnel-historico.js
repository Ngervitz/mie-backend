'use strict';

/**
 * node scripts/unit-cz-funnel-historico.js
 */

const assert = require('assert');

const FAKE_CI = 19999998;
const OBSERVACIONES = 'CV rechazó la proporcionar una oferta.';

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
  rpc: function () {
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
    rpc: function () {
      return supabaseImpl.rpc.apply(supabaseImpl, arguments);
    },
  },
};

const logger = require('../src/lib/logger');
const capturedLogs = [];
['info', 'warn', 'error'].forEach(function (level) {
  const orig = logger[level];
  logger[level] = function (message, meta) {
    capturedLogs.push({ level: level, message: message, meta: meta });
    return orig(message, meta);
  };
});

const {
  SOURCE_GRANTED,
  SOURCE_SOLICITUDES,
  SOURCE_SOLICITUD_ESTADOS,
  HISTORICO_UPSERT_CHUNK,
  parseCzDateTime,
  normalizeExtraData,
  mapHistoricoRows,
  upsertSolicitudes,
  upsertGrantedLoans,
} = require('../src/jobs/czFunnelSync');

assert.strictEqual(SOURCE_SOLICITUD_ESTADOS, 'cz_funnel_solicitud_estados');
assert.strictEqual(HISTORICO_UPSERT_CHUNK, 500);
assert.ok(parseCzDateTime('2026-08-20 11:48:25'));
assert.deepStrictEqual(normalizeExtraData({ a: 1 }), { a: 1 });
assert.deepStrictEqual(normalizeExtraData(null), {});
assert.deepStrictEqual(normalizeExtraData([]), {});
assert.deepStrictEqual(normalizeExtraData('{"a":1}'), {});
assert.deepStrictEqual(normalizeExtraData(1), {});

function realHistoricoShape() {
  return [
    {
      id: 4,
      solicitudes_id: 1153,
      fechahora: '2026-08-20 11:48:25',
      estado: '🔴 Autorización negada',
      solicitudes_estados_id: 3,
      estado_anterior: '⏺ Autorizando',
      solicitudes_estados_id_anterior: 1,
      extra_data: {
        newEstado: {
          solicitudes_estados_id: 3,
          nombre: '🔴 Autorización negada',
          observaciones: OBSERVACIONES,
        },
        oldEstado: {
          solicitudes_estados_id: 1,
          nombre: '⏺ Autorizando',
          observaciones:
            'El usuario completó el formulario y se está consultando a CV.',
        },
      },
    },
    {
      id: 3,
      solicitudes_id: 1153,
      fechahora: '2026-08-20 11:48:20',
      estado: '⏺ Autorizando',
      solicitudes_estados_id: 1,
      estado_anterior: '',
      solicitudes_estados_id_anterior: 0,
      extra_data: {
        newEstado: {
          solicitudes_estados_id: 1,
          nombre: '⏺ Autorizando',
          observaciones:
            'El usuario completó el formulario y se está consultando a CV.',
        },
      },
    },
  ];
}

function solicitudItem(overrides) {
  return Object.assign(
    {
      id: 1153,
      solicitudes_estados_id: 3,
      usuarios_id: 8,
      ci: FAKE_CI,
      fechaReg: '2026-08-20 11:48:20',
      updated: '2026-08-20 11:48:20',
      tracking_data: JSON.stringify({
        utm_source: 'sms',
        ip: '1.2.3.4',
        jt: 'should-not-be-persisted-here',
      }),
      historico: realHistoricoShape(),
    },
    overrides || {},
  );
}

function createStore(options) {
  const opts = options || {};
  const solicitudes = new Map();
  const estados = new Map();
  const granted = new Map();
  const calls = {
    upserts: [],
    deletes: [],
    rpcs: [],
    tables: [],
    selects: [],
    ins: [],
  };

  function install() {
    supabaseImpl = {
      rpc: function (name, args) {
        calls.rpcs.push({ name: name, args: args });
        if (opts.rpcError) {
          return Promise.resolve({ data: null, error: opts.rpcError });
        }
        return Promise.resolve({ data: true, error: null });
      },
      from: function (table) {
        calls.tables.push(table);
        return {
          select: function (cols) {
            calls.selects.push({ table: table, cols: cols });
            return {
              in: function (column, ids) {
                calls.ins.push({
                  table: table,
                  column: column,
                  ids: ids,
                });
                if (opts.failSelect && table === SOURCE_SOLICITUDES) {
                  return Promise.resolve({
                    data: null,
                    error: { message: 'forced lookup failure' },
                  });
                }
                const data = [];
                if (table === SOURCE_SOLICITUDES) {
                  (ids || []).forEach(function (id) {
                    const row =
                      solicitudes.get(Number(id)) || solicitudes.get(id);
                    if (row) {
                      data.push({
                        cz_id: row.cz_id,
                        tracking_data_summary: row.tracking_data_summary,
                      });
                    }
                  });
                }
                return Promise.resolve({ data: data, error: null });
              },
            };
          },
          upsert: function (rows, spec) {
            calls.upserts.push({
              table: table,
              rows: rows,
              onConflict: spec && spec.onConflict,
            });
            if (opts.failTable === table) {
              return Promise.resolve({
                error: { message: 'forced failure' },
              });
            }
            if (table === SOURCE_SOLICITUDES) {
              (rows || []).forEach(function (row) {
                solicitudes.set(row.cz_id, Object.assign({}, row));
              });
            } else if (table === SOURCE_SOLICITUD_ESTADOS) {
              (rows || []).forEach(function (row) {
                estados.set(
                  row.cz_historico_id,
                  Object.assign({}, row, {
                    extra_data: Object.assign({}, row.extra_data),
                  }),
                );
              });
            } else if (table === SOURCE_GRANTED) {
              (rows || []).forEach(function (row) {
                granted.set(row.cz_id, Object.assign({}, row));
              });
            }
            return Promise.resolve({ error: null });
          },
          delete: function () {
            calls.deletes.push({ table: table });
            throw new Error('delete must not be called');
          },
        };
      },
    };
  }

  install();
  return {
    calls: calls,
    solicitudes: solicitudes,
    estados: estados,
    granted: granted,
    seedEstado: function (row) {
      estados.set(row.cz_historico_id, Object.assign({}, row));
    },
  };
}

function assertNoForbiddenLogs() {
  const blob = JSON.stringify(capturedLogs);
  assert.ok(!blob.includes(String(FAKE_CI)), 'logs must not contain CI');
  assert.ok(!blob.includes('1.2.3.4'), 'logs must not contain tracking_data PII');
  assert.ok(!blob.includes(OBSERVACIONES), 'logs must not contain extra_data');
  assert.ok(!blob.includes('tracking_data'), 'logs must not contain tracking_data');
}

function resetLogs() {
  capturedLogs.length = 0;
}

(async function run() {
  resetLogs();

  // Shape real → mapped rows
  const now = '2026-08-25T23:00:00.000Z';
  const mapped = mapHistoricoRows([solicitudItem()], now);
  assert.strictEqual(mapped.received, 2);
  assert.strictEqual(mapped.skippedNoId, 0);
  assert.strictEqual(mapped.rows.length, 2);
  const byHist = new Map(
    mapped.rows.map(function (r) {
      return [r.cz_historico_id, r];
    }),
  );
  const row4 = byHist.get(4);
  assert.ok(row4);
  assert.strictEqual(row4.cz_solicitud_id, 1153);
  assert.strictEqual(row4.solicitudes_estados_id, 3);
  assert.strictEqual(row4.solicitudes_estados_id_anterior, 1);
  assert.strictEqual(row4.estado, '🔴 Autorización negada');
  assert.strictEqual(row4.estado_anterior, '⏺ Autorizando');
  assert.strictEqual(row4.fechahora_raw, '2026-08-20 11:48:25');
  assert.strictEqual(row4.fechahora_src, parseCzDateTime('2026-08-20 11:48:25'));
  assert.strictEqual(row4.extra_data.newEstado.solicitudes_estados_id, 3);
  assert.strictEqual(row4.synced_at, now);
  const row3 = byHist.get(3);
  assert.strictEqual(row3.solicitudes_estados_id, 1);
  assert.strictEqual(row3.solicitudes_estados_id_anterior, 0);
  assert.strictEqual(row3.estado_anterior, '');

  // Missing / invalid historico.id
  const skipped = mapHistoricoRows(
    [
      solicitudItem({
        historico: [
          { solicitudes_estados_id: 3, fechahora: '2026-08-20 11:48:25' },
          { id: 'nope', solicitudes_estados_id: 7 },
          { id: 11, solicitudes_estados_id: 11, fechahora: '2026-08-20 12:00:00' },
        ],
      }),
    ],
    now,
  );
  assert.strictEqual(skipped.received, 3);
  assert.strictEqual(skipped.skippedNoId, 2);
  assert.strictEqual(skipped.rows.length, 1);
  assert.strictEqual(skipped.rows[0].cz_historico_id, 11);
  assert.strictEqual(skipped.rows[0].solicitudes_estados_id, 11);

  // extra_data inválido
  const badExtra = mapHistoricoRows(
    [
      solicitudItem({
        historico: [
          { id: 99, extra_data: ['x'] },
          { id: 100, extra_data: 'nope' },
          { id: 101, extra_data: null },
        ],
      }),
    ],
    now,
  );
  assert.strictEqual(badExtra.rows.length, 3);
  badExtra.rows.forEach(function (r) {
    assert.deepStrictEqual(r.extra_data, {});
  });

  // Array vacío / ausente
  const emptyMapped = mapHistoricoRows(
    [solicitudItem({ historico: [] }), solicitudItem({ id: 1085, historico: undefined })],
    now,
  );
  assert.strictEqual(emptyMapped.received, 0);
  assert.strictEqual(emptyMapped.rows.length, 0);

  // Array invertido
  const inverted = mapHistoricoRows(
    [
      solicitudItem({
        historico: realHistoricoShape().slice().reverse(),
      }),
    ],
    now,
  );
  assert.strictEqual(inverted.rows.length, 2);
  assert.strictEqual(
    new Set(inverted.rows.map(function (r) { return r.cz_historico_id; })).size,
    2,
  );

  // Mismo estado, distintos historico.id
  const sameEstado = mapHistoricoRows(
    [
      solicitudItem({
        historico: [
          { id: 20, solicitudes_id: 1153, solicitudes_estados_id: 3, fechahora: '2026-08-20 11:00:00' },
          { id: 21, solicitudes_id: 1153, solicitudes_estados_id: 3, fechahora: '2026-08-21 11:00:00' },
        ],
      }),
    ],
    now,
  );
  assert.strictEqual(sameEstado.rows.length, 2);
  assert.deepStrictEqual(
    sameEstado.rows.map(function (r) { return r.cz_historico_id; }).sort(),
    [20, 21],
  );

  // Persistencia con mock
  const store = createStore();
  const parentCount = await upsertSolicitudes([solicitudItem()]);
  assert.strictEqual(parentCount, 1);
  assert.strictEqual(store.solicitudes.size, 1);
  assert.ok(store.solicitudes.get(1153));
  assert.strictEqual(store.solicitudes.get(1153).ci, FAKE_CI);
  assert.strictEqual(store.estados.size, 2);
  assert.strictEqual(store.estados.get(4).solicitudes_estados_id, 3);
  assert.strictEqual(store.estados.get(3).solicitudes_estados_id, 1);
  assert.strictEqual(store.granted.size, 0);
  assert.strictEqual(store.calls.deletes.length, 0);
  store.calls.upserts.forEach(function (u) {
    if (u.table === SOURCE_SOLICITUD_ESTADOS) {
      assert.strictEqual(u.onConflict, 'cz_historico_id');
    }
    if (u.table === SOURCE_SOLICITUDES) {
      assert.strictEqual(u.onConflict, 'cz_id');
    }
  });
  assert.ok(
    store.calls.tables.every(function (t) {
      return (
        t === SOURCE_SOLICITUDES ||
        t === SOURCE_SOLICITUD_ESTADOS
      );
    }),
  );
  assert.ok(
    !store.calls.tables.includes('marketing_impacts') &&
      !store.calls.tables.includes('marketing_impact_events') &&
      !store.calls.tables.includes(SOURCE_GRANTED),
  );
  assert.ok(
    store.calls.rpcs.some(function (r) {
      return r.name === 'sms_contacts_exclude_old_base_by_ci';
    }),
  );

  // Replay 20 veces
  for (let i = 0; i < 19; i += 1) {
    await upsertSolicitudes([solicitudItem()]);
  }
  assert.strictEqual(store.estados.size, 2);
  assert.strictEqual(store.solicitudes.size, 1);

  // historico=[] no borra
  const histUpsertsBeforeEmpty = store.calls.upserts.filter(function (u) {
    return u.table === SOURCE_SOLICITUD_ESTADOS;
  }).length;
  const emptyCount = await upsertSolicitudes([solicitudItem({ historico: [] })]);
  assert.strictEqual(emptyCount, 1);
  assert.strictEqual(store.estados.size, 2);
  assert.ok(store.estados.get(4));
  assert.ok(store.estados.get(3));
  const histUpsertsAfterEmpty = store.calls.upserts.filter(function (u) {
    return u.table === SOURCE_SOLICITUD_ESTADOS;
  }).length;
  assert.strictEqual(histUpsertsAfterEmpty, histUpsertsBeforeEmpty);
  assert.strictEqual(store.calls.deletes.length, 0);

  // Update mismo historico.id
  await upsertSolicitudes([
    solicitudItem({
      historico: [
        {
          id: 4,
          solicitudes_id: 1153,
          fechahora: '2026-08-22 10:00:00',
          estado: 'updated-label',
          solicitudes_estados_id: 3,
          extra_data: { note: 'corrected' },
        },
      ],
    }),
  ]);
  assert.strictEqual(store.estados.size, 2);
  assert.strictEqual(store.estados.get(4).estado, 'updated-label');
  assert.strictEqual(store.estados.get(4).fechahora_raw, '2026-08-22 10:00:00');
  assert.deepStrictEqual(store.estados.get(4).extra_data, { note: 'corrected' });
  assert.strictEqual(store.estados.get(3).solicitudes_estados_id, 1);

  // Varios estados misma solicitud
  await upsertSolicitudes([
    solicitudItem({
      historico: [
        { id: 4, solicitudes_estados_id: 3 },
        { id: 3, solicitudes_estados_id: 1 },
        { id: 30, solicitudes_estados_id: 7 },
        { id: 31, solicitudes_estados_id: 11 },
      ],
    }),
  ]);
  assert.strictEqual(store.estados.size, 4);
  assert.strictEqual(store.estados.get(30).solicitudes_estados_id, 7);
  assert.strictEqual(store.estados.get(31).solicitudes_estados_id, 11);

  // Padre falla → no hijos de ese batch
  const failParent = createStore({ failTable: SOURCE_SOLICITUDES });
  failParent.seedEstado({
    cz_historico_id: 999,
    cz_solicitud_id: 1,
    solicitudes_estados_id: 3,
  });
  let parentErr = null;
  try {
    await upsertSolicitudes([solicitudItem({ id: 2000, historico: [{ id: 50 }] })]);
  } catch (err) {
    parentErr = err;
  }
  assert.ok(parentErr);
  assert.match(String(parentErr.message), /cz_funnel_solicitudes upsert failed/);
  assert.strictEqual(failParent.estados.size, 1);
  assert.ok(failParent.estados.get(999));
  assert.ok(!failParent.estados.has(50));
  assert.ok(
    !failParent.calls.upserts.some(function (u) {
      return u.table === SOURCE_SOLICITUD_ESTADOS;
    }),
  );

  // Hijo falla → padre ya persistido, sin delete
  const failChild = createStore({ failTable: SOURCE_SOLICITUD_ESTADOS });
  let childErr = null;
  try {
    await upsertSolicitudes([solicitudItem()]);
  } catch (err) {
    childErr = err;
  }
  assert.ok(childErr);
  assert.match(String(childErr.message), /cz_funnel_solicitud_estados upsert failed/);
  assert.strictEqual(failChild.solicitudes.size, 1);
  assert.ok(failChild.solicitudes.get(1153));
  assert.strictEqual(failChild.estados.size, 0);
  assert.strictEqual(failChild.calls.deletes.length, 0);

  // Granted intacto si se llama por su propio upsert, y solicitudes no lo toca
  const grantedStore = createStore();
  await upsertGrantedLoans([
    { id: 1093, ci: FAKE_CI, monto_otorgado: 100000, updated: '2026-05-08 10:27:38' },
  ]);
  assert.strictEqual(grantedStore.granted.size, 1);
  await upsertSolicitudes([solicitudItem()]);
  assert.strictEqual(grantedStore.granted.size, 1);
  assert.strictEqual(grantedStore.granted.get(1093).monto_otorgado, 100000);
  assert.ok(
    !grantedStore.calls.upserts.some(function (u) {
      return (
        u.table === SOURCE_GRANTED &&
        u.rows &&
        u.rows[0] &&
        u.rows[0].cz_id === 1153
      );
    }),
  );

  // Chunking: 501 filas → 2 round-trips
  const chunkStore = createStore();
  const manyHist = [];
  for (let i = 1; i <= 501; i += 1) {
    manyHist.push({
      id: i,
      solicitudes_estados_id: i % 2 === 0 ? 3 : 1,
      fechahora: '2026-08-20 11:48:20',
    });
  }
  await upsertSolicitudes([solicitudItem({ historico: manyHist })]);
  const histUpserts = chunkStore.calls.upserts.filter(function (u) {
    return u.table === SOURCE_SOLICITUD_ESTADOS;
  });
  assert.strictEqual(histUpserts.length, 2);
  assert.strictEqual(histUpserts[0].rows.length, 500);
  assert.strictEqual(histUpserts[1].rows.length, 1);
  assert.strictEqual(chunkStore.estados.size, 501);

  assertNoForbiddenLogs();

  console.log('OK unit-cz-funnel-historico');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
