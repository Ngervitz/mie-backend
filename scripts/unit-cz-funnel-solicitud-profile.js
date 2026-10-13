'use strict';

/**
 * node scripts/unit-cz-funnel-solicitud-profile.js
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

const {
  SOURCE_SOLICITUDES,
  upsertSolicitudes,
  mapEncuestaRow,
  nullableCelular,
  nullableSalario,
  parseCzDateOnly,
  mapSolicitudProfileFields,
  resolveLatestCelularByCi,
} = require('../src/jobs/czFunnelSync');

assert.strictEqual(nullableCelular(59899970709), '59899970709');
assert.strictEqual(nullableCelular('099 970 709'), '099970709');
assert.strictEqual(nullableCelular(null), null);
assert.strictEqual(nullableCelular(''), null);
assert.strictEqual(nullableCelular('abc'), null);

assert.strictEqual(nullableSalario(80000), 80000);
assert.strictEqual(nullableSalario('90000.5'), 90000.5);
assert.strictEqual(nullableSalario(null), null);
assert.strictEqual(nullableSalario(''), null);
assert.strictEqual(nullableSalario('nope'), null);

assert.strictEqual(parseCzDateOnly('1990-05-08'), '1990-05-08');
assert.strictEqual(parseCzDateOnly('1990-05-08 10:27:38'), '1990-05-08');
assert.strictEqual(parseCzDateOnly('1990-13-01'), null);
assert.strictEqual(parseCzDateOnly('not-a-date'), null);
assert.strictEqual(parseCzDateOnly(null), null);

// Date of birth validation (calendar + age 18-100): CZ years 0001/0080/0088/0174 never pass.
const {
  normalizeBirthDate,
  isValidBirthDate,
  parseCalendarDate,
} = require('../src/lib/birthDate');
const DOB_NOW = new Date('2026-10-10T12:00:00Z');
for (const bad of [
  '0001-03-31',
  '0001-09-28',
  '0080-01-30',
  '0088-04-08',
  '0099-12-31',
  '0174-12-16',
  '1899-12-31',
  '1925-10-10',
  '2008-10-11',
  '2026-02-30',
  '1990-02-29',
  '0000-00-00',
  '',
  '31/03/1951',
]) {
  assert.strictEqual(parseCzDateOnly(bad, DOB_NOW), null, 'parser rejects ' + bad);
  assert.strictEqual(isValidBirthDate(bad, DOB_NOW), false, 'invalid ' + bad);
}
assert.strictEqual(parseCzDateOnly('1926-10-10', DOB_NOW), '1926-10-10');
assert.strictEqual(parseCzDateOnly('2008-10-10', DOB_NOW), '2008-10-10');
assert.strictEqual(parseCzDateOnly('1988-04-08 00:00:00', DOB_NOW), '1988-04-08');
assert.strictEqual(parseCzDateOnly('2000-02-29', DOB_NOW), '2000-02-29');
assert.strictEqual(normalizeBirthDate('1951-03-31', DOB_NOW), '1951-03-31');
assert.deepStrictEqual(parseCalendarDate('0001-03-31'), { y: 1, mo: 3, d: 31 });
assert.strictEqual(parseCalendarDate('0001-02-29'), null);
assert.strictEqual(mapSolicitudProfileFields({ fecha_nacimiento: '0174-12-16' }).fecha_nacimiento, null);
assert.strictEqual(mapSolicitudProfileFields({ fecha_nacimiento: '0088-04-08' }).fecha_nacimiento, null);

// fecha_nacimiento_status keeps why a date was stored as null (a minor is never "impossible").
const { classifyBirthDate } = require('../src/lib/birthDate');
for (const [raw, status] of [
  ['1990-05-08', 'valid'],
  ['2008-10-10', 'valid'],
  ['1926-10-10', 'valid'],
  [null, 'absent'],
  ['', 'absent'],
  ['   ', 'absent'],
  ['2026-02-30', 'impossible'],
  ['31/03/1951', 'impossible'],
  ['0000-00-00', 'impossible'],
  ['0001-03-31', 'over_max_age'],
  ['0088-04-08', 'over_max_age'],
  ['1925-10-09', 'over_max_age'],
  ['2008-10-11', 'underage'],
  ['2015-01-01', 'underage'],
  ['2026-10-10', 'underage'],
  ['2026-10-11', 'future'],
  ['2031-01-01', 'future'],
]) {
  assert.strictEqual(classifyBirthDate(raw, DOB_NOW), status, 'status of ' + raw);
  const m = mapSolicitudProfileFields({ fecha_nacimiento: raw }, DOB_NOW);
  assert.strictEqual(m.fecha_nacimiento_status, status, 'mapped status of ' + raw);
  assert.strictEqual(m.fecha_nacimiento != null, status === 'valid', 'stored date only when valid: ' + raw);
}
assert.strictEqual(
  mapSolicitudProfileFields({ celular: 59899111222 }, DOB_NOW).fecha_nacimiento_status,
  null,
  'field missing from the API item → not classified (never "absent")',
);

const mapped = mapSolicitudProfileFields({
  celular: 59899111222,
  salario: 70000,
  fecha_nacimiento: '1988-01-15',
  relacion_laboral: 'dependiente',
});
assert.strictEqual(mapped.celular, '59899111222');
assert.strictEqual(mapped.salario, 70000);
assert.strictEqual(mapped.fecha_nacimiento, '1988-01-15');
assert.strictEqual(mapped.relacion_laboral, 'dependiente');

function item(overrides) {
  return Object.assign(
    {
      id: 1153,
      solicitudes_estados_id: 3,
      usuarios_id: 8,
      ci: 45006120,
      email: 'user@example.com',
      lrw_id: 'LRW-111-222-333',
      celular: 59899970709,
      salario: 80000,
      fecha_nacimiento: '1990-05-08',
      relacion_laboral: 'independiente',
      nombre: 'Ana',
      apellido: 'Test',
      fechaReg: '2026-08-20 11:48:20',
      updated: '2026-08-20 11:48:20',
      tracking_data: JSON.stringify({ utm_source: 'sms', jt: 'abcdefghijABCDEFGHIJ12' }),
      historico: [],
      p1: 'A',
      p2: 'B',
    },
    overrides || {},
  );
}

function createStore() {
  const solicitudes = new Map();
  const upserts = [];
  supabaseImpl = {
    rpc: function () {
      return Promise.resolve({ data: true, error: null });
    },
    from: function (table) {
      return {
        select: function () {
          return {
            in: function () {
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
        upsert: function (rows, spec) {
          upserts.push({
            table: table,
            rows: rows,
            onConflict: spec && spec.onConflict,
          });
          if (table === SOURCE_SOLICITUDES) {
            (rows || []).forEach(function (row) {
              solicitudes.set(row.cz_id, Object.assign({}, row));
            });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { solicitudes: solicitudes, upserts: upserts };
}

(async function run() {
  const store = createStore();
  await upsertSolicitudes([item()]);
  const row = store.solicitudes.get(1153);
  assert.strictEqual(row.celular, '59899970709');
  assert.strictEqual(row.salario, 80000);
  assert.strictEqual(row.fecha_nacimiento, '1990-05-08');
  assert.strictEqual(row.fecha_nacimiento_status, 'valid');

  const storeMinor = createStore();
  await upsertSolicitudes([item({ fecha_nacimiento: '2015-06-01' }), item({ id: 1154, fecha_nacimiento: '0088-04-08' })]);
  assert.strictEqual(storeMinor.solicitudes.get(1153).fecha_nacimiento, null);
  assert.strictEqual(storeMinor.solicitudes.get(1153).fecha_nacimiento_status, 'underage');
  assert.strictEqual(storeMinor.solicitudes.get(1154).fecha_nacimiento, null);
  assert.strictEqual(storeMinor.solicitudes.get(1154).fecha_nacimiento_status, 'over_max_age');
  assert.strictEqual(row.relacion_laboral, 'independiente');
  assert.strictEqual(row.email, 'user@example.com');
  assert.strictEqual(row.lrw_id, 'LRW-111-222-333');
  assert.strictEqual(row.nombre, 'Ana');
  assert.strictEqual(row.tracking_data_summary.jt, 'abcdefghijABCDEFGHIJ12');

  // Null / empty profile fields
  const storeNull = createStore();
  await upsertSolicitudes([
    item({
      celular: null,
      salario: '',
      fecha_nacimiento: 'bad',
      relacion_laboral: '   ',
    }),
  ]);
  const nulled = storeNull.solicitudes.get(1153);
  assert.strictEqual(nulled.celular, null);
  assert.strictEqual(nulled.salario, null);
  assert.strictEqual(nulled.fecha_nacimiento, null);
  assert.strictEqual(nulled.fecha_nacimiento_status, 'impossible');
  assert.strictEqual(nulled.relacion_laboral, null);

  // Same CI, two LRW episodes — distinct salario preserved
  const storeMulti = createStore();
  await upsertSolicitudes([
    item({
      id: 10,
      ci: 111,
      lrw_id: 'LRW-A',
      salario: 70000,
      celular: 59811111111,
      updated: '2026-01-01 10:00:00',
    }),
    item({
      id: 11,
      ci: 111,
      lrw_id: 'LRW-B',
      salario: 90000,
      celular: 59822222222,
      updated: '2026-06-01 10:00:00',
    }),
  ]);
  assert.strictEqual(storeMulti.solicitudes.get(10).salario, 70000);
  assert.strictEqual(storeMulti.solicitudes.get(10).lrw_id, 'LRW-A');
  assert.strictEqual(storeMulti.solicitudes.get(11).salario, 90000);
  assert.strictEqual(storeMulti.solicitudes.get(11).lrw_id, 'LRW-B');

  const latestPhone = resolveLatestCelularByCi(
    [
      storeMulti.solicitudes.get(10),
      storeMulti.solicitudes.get(11),
    ],
    111,
  );
  assert.strictEqual(latestPhone, '59822222222');

  // P1–P10 mapping untouched
  const encuesta = mapEncuestaRow(
    {
      id: 99,
      ci: 111,
      p1: 'A',
      p2: 'B',
      p3: 'C',
      p4: 'A',
      p5: 'B',
      p6: 'C',
      p7: 'A',
      p8: 'B',
      p9: 'C',
      p10: 'A',
      score_v2: 12,
      completed_at: '2026-08-01 12:00:00',
    },
    '2026-09-24T00:00:00.000Z',
  );
  assert.strictEqual(encuesta.p1, 'A');
  assert.strictEqual(encuesta.p10, 'A');
  assert.strictEqual(encuesta.score_v2, 12);

  // monto_solicitado must NOT be invented on upsert rows
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'monto_solicitado'));

  console.log('OK unit-cz-funnel-solicitud-profile');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
