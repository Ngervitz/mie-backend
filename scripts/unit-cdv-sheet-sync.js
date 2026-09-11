'use strict';

/**
 * node scripts/unit-cdv-sheet-sync.js
 */

const assert = require('assert');

const {
  CDV_ESTADO_ID,
  SHEETS_SCOPE,
  readCdvSheetConfig,
  parseServiceAccountJson,
  formatFechaEnvioMontevideo,
  collectEstado8FromHistorico,
  ciMapFromSolicitudes,
  existingIdsFromColumnG,
  buildSheetRow,
  ensureCdvSheetRows,
  syncCdvSheetAfterHistoricoPersist,
} = require('../src/lib/cdvSheetSync');

assert.strictEqual(CDV_ESTADO_ID, 8);
assert.strictEqual(
  SHEETS_SCOPE,
  'https://www.googleapis.com/auth/spreadsheets',
);

const FAKE_SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'janus-cdv-sheet@example.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nMIIFAKE\n-----END PRIVATE KEY-----\n',
});

const ENABLED_ENV = {
  CDV_GOOGLE_SERVICE_ACCOUNT_JSON: FAKE_SA_JSON,
  CDV_GOOGLE_SHEET_ID: 'sheet-id-test',
  CDV_GOOGLE_SHEET_TAB: 'CDV',
};

function historicoRow(overrides) {
  return Object.assign(
    {
      cz_historico_id: 37,
      cz_solicitud_id: 1168,
      solicitudes_estados_id: 8,
      fechahora_src: '2026-09-01T21:33:40.000Z',
    },
    overrides || {},
  );
}

function fakeSheets(options) {
  const opts = options || {};
  const gValues = opts.gValues ? opts.gValues.slice() : [['CZ_SOLICITUD_ID']];
  const calls = { get: 0, append: [] };
  return {
    gValues: gValues,
    calls: calls,
    createSheetsClient: async function () {
      if (opts.createError) throw opts.createError;
      return {
        spreadsheets: {
          values: {
            get: async function () {
              calls.get += 1;
              if (opts.getError) throw opts.getError;
              return { data: { values: gValues } };
            },
            append: async function (req) {
              if (opts.appendError) throw opts.appendError;
              calls.append.push(req);
              const rows =
                req && req.requestBody && Array.isArray(req.requestBody.values)
                  ? req.requestBody.values
                  : [];
              rows.forEach(function (row) {
                gValues.push([row[6]]);
              });
              return { data: {} };
            },
          },
        },
      };
    },
  };
}

// --- helpers ---
assert.deepStrictEqual(readCdvSheetConfig({}).missing, [
  'CDV_GOOGLE_SERVICE_ACCOUNT_JSON',
  'CDV_GOOGLE_SHEET_ID',
  'CDV_GOOGLE_SHEET_TAB',
]);
assert.strictEqual(readCdvSheetConfig({}).enabled, false);
assert.strictEqual(readCdvSheetConfig(ENABLED_ENV).enabled, true);
assert.strictEqual(
  readCdvSheetConfig({
    GA4_SERVICE_ACCOUNT_JSON: FAKE_SA_JSON,
    GA4_PROPERTY_ID: '1',
  }).enabled,
  false,
);

const parsed = parseServiceAccountJson(FAKE_SA_JSON);
assert.strictEqual(
  parsed.client_email,
  'janus-cdv-sheet@example.iam.gserviceaccount.com',
);
assert.ok(parsed.private_key.indexOf('\n') !== -1);

let parseErr = null;
try {
  parseServiceAccountJson('{not-json');
} catch (err) {
  parseErr = err;
}
assert.ok(parseErr);
assert.match(String(parseErr.message), /not valid JSON/);
assert.ok(!String(parseErr.message).includes('BEGIN PRIVATE KEY'));

assert.strictEqual(
  formatFechaEnvioMontevideo('2026-09-01T21:33:40.000Z'),
  '01/09/2026 18:33:40',
);
assert.strictEqual(formatFechaEnvioMontevideo(null), '');
assert.strictEqual(formatFechaEnvioMontevideo('not-a-date'), '');

const ciMap = ciMapFromSolicitudes([
  { cz_id: 1168, ci: 29108021 },
  { cz_id: 1171, ci: 32430417 },
]);
const collected = collectEstado8FromHistorico(
  [
    historicoRow({ solicitudes_estados_id: 7, cz_solicitud_id: 1168 }),
    historicoRow({
      solicitudes_estados_id: 8,
      cz_solicitud_id: 1168,
      fechahora_src: '2026-09-01T21:33:40.000Z',
    }),
    historicoRow({
      solicitudes_estados_id: 8,
      cz_solicitud_id: 1171,
      fechahora_src: '2026-09-02T15:13:13.000Z',
    }),
  ],
  ciMap,
);
assert.strictEqual(collected.size, 2);
assert.strictEqual(collected.get('1168').ci, 29108021);

const existing = existingIdsFromColumnG([
  ['CZ_SOLICITUD_ID'],
  ['1168'],
  [1171],
  [''],
]);
assert.ok(existing.has('1168'));
assert.ok(existing.has('1171'));
assert.strictEqual(existing.size, 2);

const built = buildSheetRow({
  cz_solicitud_id: '1168',
  ci: 29108021,
  fechahora_src: '2026-09-01T21:33:40.000Z',
});
assert.deepStrictEqual(built, [
  '29108021',
  '01/09/2026 18:33:40',
  '',
  '',
  '',
  '',
  '1168',
  '',
  '',
]);

(async function main() {
  // 1. estado != 8 → no escribe
  const sheets1 = fakeSheets();
  const r1 = await ensureCdvSheetRows(
    {
      historicoRows: [
        historicoRow({ solicitudes_estados_id: 7, cz_solicitud_id: 99 }),
      ],
      solicitudes: [{ cz_id: 99, ci: 111 }],
    },
    { env: ENABLED_ENV, createSheetsClient: sheets1.createSheetsClient },
  );
  assert.strictEqual(r1.status, 'ok');
  assert.strictEqual(r1.inserted, 0);
  assert.strictEqual(sheets1.calls.append.length, 0);
  assert.strictEqual(sheets1.calls.get, 0);

  // 2. estado 8 nuevo → inserta; ESTADO vacío; fecha del evento
  const sheets2 = fakeSheets();
  const r2 = await ensureCdvSheetRows(
    {
      historicoRows: [historicoRow()],
      solicitudes: [{ cz_id: 1168, ci: 29108021 }],
    },
    { env: ENABLED_ENV, createSheetsClient: sheets2.createSheetsClient },
  );
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(r2.inserted, 1);
  assert.strictEqual(sheets2.calls.append.length, 1);
  const appended = sheets2.calls.append[0].requestBody.values[0];
  assert.strictEqual(appended[0], '29108021');
  assert.strictEqual(appended[1], '01/09/2026 18:33:40');
  assert.strictEqual(appended[2], '');
  assert.strictEqual(appended[3], '');
  assert.strictEqual(appended[4], '');
  assert.strictEqual(appended[5], '');
  assert.strictEqual(appended[6], '1168');
  assert.strictEqual(appended[7], '');
  assert.strictEqual(appended[8], '');
  assert.ok(sheets2.calls.append[0].range.indexOf("'CDV'!A:I") !== -1);

  // 3. estado 8 ya existente → no duplica
  const sheets3 = fakeSheets({ gValues: [['CZ_SOLICITUD_ID'], ['1168']] });
  const r3 = await ensureCdvSheetRows(
    {
      historicoRows: [historicoRow()],
      solicitudes: [{ cz_id: 1168, ci: 29108021 }],
    },
    { env: ENABLED_ENV, createSheetsClient: sheets3.createSheetsClient },
  );
  assert.strictEqual(r3.inserted, 0);
  assert.strictEqual(r3.skipped, 1);
  assert.strictEqual(sheets3.calls.append.length, 0);

  // 4. Google falla → wrapper no tira
  const sheets4 = fakeSheets({
    appendError: new Error('Sheets API unavailable'),
  });
  let thrown4 = null;
  let r4 = null;
  try {
    r4 = await syncCdvSheetAfterHistoricoPersist(
      {
        historicoRows: [historicoRow()],
        solicitudes: [{ cz_id: 1168, ci: 29108021 }],
      },
      { env: ENABLED_ENV, createSheetsClient: sheets4.createSheetsClient },
    );
  } catch (err) {
    thrown4 = err;
  }
  assert.strictEqual(thrown4, null);
  assert.strictEqual(r4.status, 'error');
  assert.match(String(r4.error), /Sheets API unavailable/);

  // 5. misma CI + distinto CZ_SOLICITUD_ID → dos filas
  const sheets5 = fakeSheets();
  const r5 = await ensureCdvSheetRows(
    {
      historicoRows: [
        historicoRow({
          cz_solicitud_id: 1171,
          cz_historico_id: 46,
          fechahora_src: '2026-09-02T15:13:13.000Z',
        }),
        historicoRow({
          cz_solicitud_id: 1196,
          cz_historico_id: 102,
          fechahora_src: '2026-09-04T14:34:36.000Z',
        }),
      ],
      solicitudes: [
        { cz_id: 1171, ci: 32430417 },
        { cz_id: 1196, ci: 32430417 },
      ],
    },
    { env: ENABLED_ENV, createSheetsClient: sheets5.createSheetsClient },
  );
  assert.strictEqual(r5.inserted, 2);
  const ids5 = sheets5.calls.append[0].requestBody.values.map(function (row) {
    return row[6];
  });
  assert.ok(ids5.indexOf('1171') !== -1);
  assert.ok(ids5.indexOf('1196') !== -1);
  assert.strictEqual(
    sheets5.calls.append[0].requestBody.values[0][0],
    '32430417',
  );
  assert.strictEqual(
    sheets5.calls.append[0].requestBody.values[1][0],
    '32430417',
  );

  // 6. config faltante → no rompe, no llama Google
  let factoryCalls = 0;
  const r6 = await syncCdvSheetAfterHistoricoPersist(
    {
      historicoRows: [historicoRow()],
      solicitudes: [{ cz_id: 1168, ci: 29108021 }],
    },
    {
      env: {},
      createSheetsClient: async function () {
        factoryCalls += 1;
        throw new Error('should not be called');
      },
    },
  );
  assert.strictEqual(r6.status, 'disabled');
  assert.strictEqual(factoryCalls, 0);

  // Reintento: persistido en Janus y ausente en Sheet → inserta
  const sheetsRetry = fakeSheets();
  const fakeSupabase = {
    from: function (table) {
      return {
        select: function () {
          return {
            eq: async function () {
              if (table !== 'cz_funnel_solicitud_estados') {
                return { data: [], error: null };
              }
              return {
                data: [
                  {
                    cz_solicitud_id: 2001,
                    fechahora_src: '2026-09-10T12:00:00.000Z',
                  },
                ],
                error: null,
              };
            },
            in: async function () {
              if (table !== 'cz_funnel_solicitudes') {
                return { data: [], error: null };
              }
              return { data: [{ cz_id: 2001, ci: 555 }], error: null };
            },
          };
        },
      };
    },
  };
  const rRetry = await ensureCdvSheetRows(
    {
      historicoRows: [],
      solicitudes: [],
      supabase: fakeSupabase,
    },
    { env: ENABLED_ENV, createSheetsClient: sheetsRetry.createSheetsClient },
  );
  assert.strictEqual(rRetry.inserted, 1);
  assert.strictEqual(
    sheetsRetry.calls.append[0].requestBody.values[0][6],
    '2001',
  );
  assert.strictEqual(
    sheetsRetry.calls.append[0].requestBody.values[0][0],
    '555',
  );

  console.log('OK unit-cdv-sheet-sync');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
