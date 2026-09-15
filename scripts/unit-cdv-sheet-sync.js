'use strict';

/**
 * node scripts/unit-cdv-sheet-sync.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  CDV_ESTADO_ID,
  SHEETS_SCOPE,
  COL_CZ_SOLICITUD_ID,
  readCdvSheetConfig,
  parseServiceAccountJson,
  formatFechaEnvioMontevideo,
  collectEstado8FromHistorico,
  indexExistingSheetRows,
  existingIdsFromColumnH,
  buildSheetRow,
  resolveBasesForCandidates,
  ensureCdvSheetRows,
  syncCdvSheetAfterHistoricoPersist,
} = require('../src/lib/cdvSheetSync');

assert.strictEqual(CDV_ESTADO_ID, 8);
assert.strictEqual(
  SHEETS_SCOPE,
  'https://www.googleapis.com/auth/spreadsheets',
);
assert.strictEqual(COL_CZ_SOLICITUD_ID, 8);
assert.strictEqual(
  fs.readFileSync(path.join(__dirname, '../src/lib/cdvSheetSync.js'), 'utf8').indexOf('values.append'),
  -1,
  'CDV sheet sync must not call values.append',
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

function padRow(partial) {
  const row = new Array(11).fill('');
  Object.keys(partial).forEach(function (k) {
    row[Number(k)] = partial[k];
  });
  return row;
}

function fakeSheets(options) {
  const opts = options || {};
  const grid = opts.grid
    ? opts.grid.map(function (r) {
        return r.slice();
      })
    : [padRow({ 0: 'BASE', 8: 'CZ_SOLICITUD_ID' })];
  const sheetId = opts.sheetId != null ? opts.sheetId : 42;
  const validationByRow = opts.validationByRow || { 2: true };
  const calls = {
    get: 0,
    update: [],
    batchUpdate: [],
    append: [],
    spreadsheetGet: 0,
    spreadsheetBatchUpdate: [],
  };
  return {
    grid: grid,
    calls: calls,
    validationByRow: validationByRow,
    createSheetsClient: async function () {
      if (opts.createError) throw opts.createError;
      return {
        spreadsheets: {
          get: async function (req) {
            calls.spreadsheetGet += 1;
            if (opts.spreadsheetGetError) throw opts.spreadsheetGetError;
            assert.ok(req && req.spreadsheetId, 'spreadsheet get needs id');
            return {
              data: {
                sheets: [
                  {
                    properties: {
                      sheetId: sheetId,
                      title: opts.tabTitle || 'CDV',
                    },
                  },
                ],
              },
            };
          },
          batchUpdate: async function (req) {
            calls.spreadsheetBatchUpdate.push(req);
            if (opts.validationCopyError) throw opts.validationCopyError;
            const requests =
              req && req.requestBody && Array.isArray(req.requestBody.requests)
                ? req.requestBody.requests
                : [];
            assert.strictEqual(requests.length, 1, 'one copyPaste per call');
            const cp = requests[0] && requests[0].copyPaste;
            assert.ok(cp, 'must use copyPaste');
            assert.strictEqual(cp.pasteType, 'PASTE_DATA_VALIDATION');
            assert.strictEqual(cp.source.sheetId, sheetId);
            assert.strictEqual(cp.source.startRowIndex, 1);
            assert.strictEqual(cp.source.endRowIndex, 2);
            assert.strictEqual(cp.source.startColumnIndex, 4);
            assert.strictEqual(cp.source.endColumnIndex, 5);
            assert.strictEqual(cp.destination.sheetId, sheetId);
            assert.strictEqual(cp.destination.startColumnIndex, 4);
            assert.strictEqual(cp.destination.endColumnIndex, 5);
            const destRow = cp.destination.startRowIndex + 1;
            assert.strictEqual(
              cp.destination.endRowIndex,
              cp.destination.startRowIndex + 1,
            );
            // Paste validation only — never copy E2 value into destination.
            validationByRow[destRow] = true;
            if (grid[destRow - 1]) {
              // leave grid[destRow-1][4] as written by values.update
            }
            return { data: {} };
          },
          values: {
            get: async function (req) {
              calls.get += 1;
              if (opts.getError) throw opts.getError;
              assert.ok(
                String(req.range).indexOf('!A:K') !== -1,
                'must read A:K for id+base',
              );
              return { data: { values: grid.map(function (r) { return r.slice(); }) } };
            },
            append: async function () {
              calls.append.push('append');
              throw new Error('values.append must not be used');
            },
            update: async function (req) {
              if (opts.updateError) throw opts.updateError;
              calls.update.push(req);
              const m = String(req.range || '').match(/!A(\d+):K\1$/);
              assert.ok(m, 'new row must be values.update A{row}:K{row}');
              const rowNum = Number(m[1]);
              const written =
                req && req.requestBody && Array.isArray(req.requestBody.values)
                  ? req.requestBody.values[0]
                  : null;
              assert.ok(written && written.length === 11, 'row must be A:K');
              while (grid.length < rowNum) grid.push(new Array(11).fill(''));
              grid[rowNum - 1] = written.slice();
              return { data: {} };
            },
            batchUpdate: async function (req) {
              if (opts.batchError) throw opts.batchError;
              calls.batchUpdate.push(req);
              const data =
                req && req.requestBody && Array.isArray(req.requestBody.data)
                  ? req.requestBody.data
                  : [];
              data.forEach(function (item) {
                const m = String(item.range || '').match(/!A(\d+)$/);
                assert.ok(m, 'BASE update must target A{row} only');
                assert.strictEqual(
                  item.values[0].length,
                  1,
                  'BASE update must not touch other cells',
                );
                const rowNum = Number(m[1]);
                const val =
                  item.values && item.values[0] ? item.values[0][0] : '';
                while (grid.length < rowNum) grid.push(new Array(11).fill(''));
                const row = grid[rowNum - 1] || new Array(11).fill('');
                while (row.length < 11) row.push('');
                row[0] = val;
                grid[rowNum - 1] = row;
              });
              return { data: {} };
            },
          },
        },
      };
    },
  };
}

function fakeSupabaseForBases(scenario) {
  const s = scenario || {};
  return {
    from: function (table) {
      return {
        select: function () {
          return {
            in: async function (col, vals) {
              if (table === 'cz_funnel_solicitudes' && col === 'cz_id') {
                return {
                  data: (s.solicitudes || []).filter(function (r) {
                    return vals.map(Number).indexOf(Number(r.cz_id)) !== -1;
                  }),
                  error: null,
                };
              }
              if (table === 'marketing_impacts' && col === 'tracking_token') {
                return {
                  data: (s.impacts || []).filter(function (r) {
                    return vals.indexOf(r.tracking_token) !== -1;
                  }),
                  error: null,
                };
              }
              if (
                table === 'sms_messages' &&
                col === 'marketing_impact_id'
              ) {
                return {
                  data: (s.messages || []).filter(function (r) {
                    return vals.indexOf(r.marketing_impact_id) !== -1;
                  }),
                  error: null,
                };
              }
              if (table === 'sms_contacts' && col === 'id') {
                return {
                  data: (s.contacts || []).filter(function (r) {
                    return vals.indexOf(r.id) !== -1;
                  }),
                  error: null,
                };
              }
              return { data: [], error: null };
            },
            eq: async function () {
              return { data: [], error: null };
            },
          };
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
assert.strictEqual(readCdvSheetConfig(ENABLED_ENV).enabled, true);

const parsed = parseServiceAccountJson(FAKE_SA_JSON);
assert.strictEqual(
  parsed.client_email,
  'janus-cdv-sheet@example.iam.gserviceaccount.com',
);

assert.strictEqual(
  formatFechaEnvioMontevideo('2026-09-01T21:33:40.000Z'),
  '01/09/2026 18:33:40',
);

const built = buildSheetRow({
  cz_solicitud_id: '1168',
  ci: 29108021,
  fechahora_src: '2026-09-01T21:33:40.000Z',
  base: 'prestafacil',
});
assert.deepStrictEqual(built, [
  'prestafacil',
  '29108021',
  '',
  '01/09/2026 18:33:40',
  '',
  '',
  '',
  '',
  '1168',
  '',
  '',
]);
assert.strictEqual(built.length, 11);
assert.strictEqual(built[2], '');
assert.strictEqual(built[COL_CZ_SOLICITUD_ID], '1168');

const indexed = indexExistingSheetRows([
  padRow({ 0: 'BASE', 8: 'CZ_SOLICITUD_ID' }),
  padRow({ 0: '', 8: '1168' }),
  padRow({ 0: 'prestafacil', 8: 1171 }),
]);
assert.strictEqual(indexed.get('1168').base, '');
assert.strictEqual(indexed.get('1168').rowNumber, 2);
assert.strictEqual(indexed.get('1171').base, 'prestafacil');
assert.ok(existingIdsFromColumnH([['CZ_SOLICITUD_ID'], ['1168']]).has('1168'));
assert.strictEqual(
  indexExistingSheetRows([
    padRow({ 0: 'BASE', 8: 'CZ_SOLICITUD_ID' }),
    padRow({ 7: '1168' }),
  ]).has('1168'),
  false,
  'ID in H must not count as existing',
);

(async function main() {
  // 1. jt + sms_messages.source_system → snapshot
  const bases1 = await resolveBasesForCandidates(
    fakeSupabaseForBases({
      solicitudes: [
        {
          cz_id: 1168,
          tracking_data_summary: { jt: 'JT_TOKEN_AAAAAAAAAAAA' },
        },
      ],
      impacts: [
        {
          id: 'imp-1',
          tracking_token: 'JT_TOKEN_AAAAAAAAAAAA',
          contact_id: 'c-1',
        },
      ],
      messages: [
        { marketing_impact_id: 'imp-1', source_system: 'prestafacil' },
      ],
      contacts: [{ id: 'c-1', source_system: 'credizona2_datos' }],
    }),
    [{ cz_solicitud_id: '1168' }],
  );
  assert.strictEqual(bases1.get('1168'), 'prestafacil');

  // 2. jt sin snapshot + contact_id → sms_contacts
  const bases2 = await resolveBasesForCandidates(
    fakeSupabaseForBases({
      solicitudes: [
        {
          cz_id: 1171,
          tracking_data_summary: { jt: 'JT_TOKEN_BBBBBBBBBBBB' },
        },
      ],
      impacts: [
        {
          id: 'imp-2',
          tracking_token: 'JT_TOKEN_BBBBBBBBBBBB',
          contact_id: 'c-2',
        },
      ],
      messages: [{ marketing_impact_id: 'imp-2', source_system: null }],
      contacts: [{ id: 'c-2', source_system: 'crediflash' }],
    }),
    [{ cz_solicitud_id: '1171' }],
  );
  assert.strictEqual(bases2.get('1171'), 'crediflash');

  // 3. sin jt → BASE vacío
  const bases3 = await resolveBasesForCandidates(
    fakeSupabaseForBases({
      solicitudes: [{ cz_id: 1196, tracking_data_summary: {} }],
      impacts: [],
      messages: [],
      contacts: [{ id: 'c-x', source_system: 'prestafacil' }],
    }),
    [{ cz_solicitud_id: '1196' }],
  );
  assert.strictEqual(bases3.get('1196'), '');

  // 4. misma CI, distintas solicitudes → independientes
  const bases4 = await resolveBasesForCandidates(
    fakeSupabaseForBases({
      solicitudes: [
        {
          cz_id: 1171,
          tracking_data_summary: { jt: 'JT_A_111111111111111111' },
        },
        { cz_id: 1196, tracking_data_summary: {} },
      ],
      impacts: [
        {
          id: 'imp-a',
          tracking_token: 'JT_A_111111111111111111',
          contact_id: 'c-a',
        },
      ],
      messages: [
        { marketing_impact_id: 'imp-a', source_system: 'prestafacil' },
      ],
      contacts: [],
    }),
    [{ cz_solicitud_id: '1171' }, { cz_solicitud_id: '1196' }],
  );
  assert.strictEqual(bases4.get('1171'), 'prestafacil');
  assert.strictEqual(bases4.get('1196'), '');

  // 5. fila existente BASE vacío → completa solo BASE
  const sheets5 = fakeSheets({
    grid: [
      padRow({ 0: 'BASE', 8: 'CZ_SOLICITUD_ID' }),
      padRow({ 0: '', 1: '29108021', 4: 'RECHAZADO', 7: 'nota', 8: '1168' }),
    ],
  });
  const r5 = await ensureCdvSheetRows(
    {
      historicoRows: [historicoRow()],
      solicitudes: [{ cz_id: 1168, ci: 29108021 }],
      supabase: {},
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheets5.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map([['1168', 'prestafacil']]);
      },
    },
  );
  assert.strictEqual(r5.inserted, 0);
  assert.strictEqual(r5.base_updated, 1);
  assert.strictEqual(sheets5.calls.update.length, 0);
  assert.strictEqual(sheets5.calls.append.length, 0);
  assert.strictEqual(sheets5.calls.batchUpdate.length, 1);
  assert.strictEqual(sheets5.calls.batchUpdate[0].requestBody.data[0].range, "'CDV'!A2");
  assert.strictEqual(sheets5.grid[1][0], 'prestafacil');
  assert.strictEqual(sheets5.grid[1][1], '29108021');
  assert.strictEqual(sheets5.grid[1][4], 'RECHAZADO');
  assert.strictEqual(sheets5.grid[1][7], 'nota');
  assert.strictEqual(sheets5.grid[1][8], '1168');

  // 6. fila existente BASE ya cargada → no modifica
  const sheets6 = fakeSheets({
    grid: [
      padRow({ 0: 'BASE', 8: 'CZ_SOLICITUD_ID' }),
      padRow({ 0: 'prestafacil', 1: '29108021', 4: 'RECHAZADO', 7: 'nota', 8: '1168' }),
    ],
  });
  const r6 = await ensureCdvSheetRows(
    {
      historicoRows: [historicoRow()],
      solicitudes: [{ cz_id: 1168, ci: 29108021 }],
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheets6.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map([['1168', 'crediflash']]);
      },
    },
  );
  assert.strictEqual(r6.inserted, 0);
  assert.strictEqual(r6.base_updated, 0);
  assert.strictEqual(r6.skipped, 1);
  assert.strictEqual(sheets6.calls.batchUpdate.length, 0);
  assert.strictEqual(sheets6.calls.update.length, 0);
  assert.strictEqual(sheets6.grid[1][0], 'prestafacil');
  assert.strictEqual(sheets6.grid[1][4], 'RECHAZADO');
  assert.strictEqual(sheets6.grid[1][7], 'nota');

  // 7. idempotencia en I — insert explícito A{n}:K{n}, sin append;
  //    copia dataValidation E2→E{n} sin copiar valor de ESTADO
  const sheets7 = fakeSheets({
    grid: [
      padRow({ 0: 'BASE', 8: 'CZ_SOLICITUD_ID' }),
      padRow({
        0: 'prestafacil',
        1: '11111111',
        4: 'RECHAZADO',
        8: '1000',
      }),
    ],
  });
  const r7 = await ensureCdvSheetRows(
    {
      historicoRows: [historicoRow()],
      solicitudes: [
        {
          cz_id: 1168,
          ci: 29108021,
          tracking_data_summary: { jt: 'JT_X' },
        },
      ],
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheets7.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map([['1168', 'prestafacil']]);
      },
    },
  );
  assert.strictEqual(r7.inserted, 1);
  assert.strictEqual(sheets7.calls.append.length, 0);
  assert.strictEqual(sheets7.calls.update.length, 1);
  assert.strictEqual(sheets7.calls.update[0].range, "'CDV'!A3:K3");
  const written = sheets7.calls.update[0].requestBody.values[0];
  assert.strictEqual(written[0], 'prestafacil');
  assert.strictEqual(written[2], '');
  assert.strictEqual(written[3], '01/09/2026 18:33:40');
  assert.strictEqual(written[8], '1168');
  assert.strictEqual(written[4], '', 'ESTADO must stay empty on insert');
  assert.strictEqual(written[7], '');
  assert.strictEqual(sheets7.calls.spreadsheetGet, 1);
  assert.strictEqual(sheets7.calls.spreadsheetBatchUpdate.length, 1);
  assert.strictEqual(
    sheets7.calls.spreadsheetBatchUpdate[0].requestBody.requests[0].copyPaste
      .pasteType,
    'PASTE_DATA_VALIDATION',
  );
  assert.strictEqual(
    sheets7.calls.spreadsheetBatchUpdate[0].requestBody.requests[0].copyPaste
      .destination.startRowIndex,
    2,
  );
  assert.strictEqual(sheets7.validationByRow[3], true);
  assert.strictEqual(sheets7.grid[2][4], '', 'must not paste E2 value');
  assert.strictEqual(sheets7.grid[2][8], '1168');
  assert.strictEqual(sheets7.grid[1][4], 'RECHAZADO', 'template E2 unchanged');

  // second pass: same id → skip, no duplicate, no extra validation copy
  const r7b = await ensureCdvSheetRows(
    {
      historicoRows: [historicoRow()],
      solicitudes: [{ cz_id: 1168, ci: 29108021 }],
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheets7.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map([['1168', 'prestafacil']]);
      },
    },
  );
  assert.strictEqual(r7b.inserted, 0);
  assert.strictEqual(r7b.skipped, 1);
  assert.strictEqual(sheets7.calls.update.length, 1);
  assert.strictEqual(sheets7.calls.spreadsheetBatchUpdate.length, 1);
  assert.strictEqual(sheets7.calls.append.length, 0);

  // sin jt en insert → BASE vacío
  const sheetsEmptyBase = fakeSheets({
    grid: [
      padRow({ 0: 'BASE', 8: 'CZ_SOLICITUD_ID' }),
      padRow({ 0: 'x', 1: '1', 4: 'RECHAZADO', 8: '1' }),
    ],
  });
  const rEmpty = await ensureCdvSheetRows(
    {
      historicoRows: [
        historicoRow({ cz_solicitud_id: 1196, cz_historico_id: 102 }),
      ],
      solicitudes: [{ cz_id: 1196, ci: 32430417 }],
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheetsEmptyBase.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map([['1196', '']]);
      },
    },
  );
  assert.strictEqual(rEmpty.inserted, 1);
  assert.strictEqual(
    sheetsEmptyBase.calls.update[0].requestBody.values[0][0],
    '',
  );
  assert.strictEqual(sheetsEmptyBase.calls.update[0].requestBody.values[0][2], '');
  assert.strictEqual(sheetsEmptyBase.calls.update[0].requestBody.values[0][4], '');
  assert.strictEqual(sheetsEmptyBase.calls.spreadsheetBatchUpdate.length, 1);
  assert.strictEqual(sheetsEmptyBase.calls.append.length, 0);

  // mismo CI, distintos CZ_SOLICITUD_ID → dos filas + validation cada una
  const sheetsSameCi = fakeSheets({
    grid: [
      padRow({ 0: 'BASE', 8: 'CZ_SOLICITUD_ID' }),
      padRow({ 0: 'x', 1: '1', 4: 'RECHAZADO', 8: '1' }),
    ],
  });
  const rSameCi = await ensureCdvSheetRows(
    {
      historicoRows: [
        historicoRow({ cz_solicitud_id: 1171, cz_historico_id: 201 }),
        historicoRow({
          cz_solicitud_id: 1196,
          cz_historico_id: 202,
          fechahora_src: '2026-09-04T14:34:36.000Z',
        }),
      ],
      solicitudes: [
        { cz_id: 1171, ci: 32430417 },
        { cz_id: 1196, ci: 32430417 },
      ],
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheetsSameCi.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map([
          ['1171', ''],
          ['1196', ''],
        ]);
      },
    },
  );
  assert.strictEqual(rSameCi.inserted, 2);
  assert.strictEqual(sheetsSameCi.calls.update.length, 2);
  assert.strictEqual(sheetsSameCi.calls.update[0].range, "'CDV'!A3:K3");
  assert.strictEqual(sheetsSameCi.calls.update[1].range, "'CDV'!A4:K4");
  assert.strictEqual(sheetsSameCi.calls.update[0].requestBody.values[0][1], '32430417');
  assert.strictEqual(sheetsSameCi.calls.update[1].requestBody.values[0][1], '32430417');
  assert.strictEqual(sheetsSameCi.calls.update[0].requestBody.values[0][8], '1171');
  assert.strictEqual(sheetsSameCi.calls.update[1].requestBody.values[0][8], '1196');
  assert.strictEqual(sheetsSameCi.calls.spreadsheetGet, 1);
  assert.strictEqual(sheetsSameCi.calls.spreadsheetBatchUpdate.length, 2);
  assert.strictEqual(sheetsSameCi.validationByRow[3], true);
  assert.strictEqual(sheetsSameCi.validationByRow[4], true);
  assert.strictEqual(sheetsSameCi.grid[2][4], '');
  assert.strictEqual(sheetsSameCi.grid[3][4], '');
  assert.strictEqual(sheetsSameCi.calls.append.length, 0);

  // fallo al copiar validation → fila queda insertada; 2ª corrida no duplica
  const sheetsValFail = fakeSheets({
    grid: [
      padRow({ 0: 'BASE', 8: 'CZ_SOLICITUD_ID' }),
      padRow({ 0: 'x', 1: '1', 4: 'RECHAZADO', 8: '1' }),
    ],
    validationCopyError: new Error('copyPaste denied'),
  });
  const rValFail = await ensureCdvSheetRows(
    {
      historicoRows: [historicoRow()],
      solicitudes: [{ cz_id: 1168, ci: 29108021 }],
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheetsValFail.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map([['1168', 'prestafacil']]);
      },
    },
  );
  assert.strictEqual(rValFail.status, 'ok');
  assert.strictEqual(rValFail.inserted, 1);
  assert.strictEqual(sheetsValFail.calls.update.length, 1);
  assert.strictEqual(sheetsValFail.grid[2][8], '1168');
  assert.strictEqual(sheetsValFail.grid[2][4], '');
  assert.strictEqual(sheetsValFail.calls.spreadsheetBatchUpdate.length, 1);

  const rValFail2 = await ensureCdvSheetRows(
    {
      historicoRows: [historicoRow()],
      solicitudes: [{ cz_id: 1168, ci: 29108021 }],
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheetsValFail.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map([['1168', 'prestafacil']]);
      },
    },
  );
  assert.strictEqual(rValFail2.inserted, 0);
  assert.strictEqual(rValFail2.skipped, 1);
  assert.strictEqual(sheetsValFail.calls.update.length, 1);
  assert.strictEqual(sheetsValFail.calls.append.length, 0);

  // header I1 incorrecto → no escribe
  const sheetsBadHeader = fakeSheets({
    grid: [padRow({ 0: 'BASE', 7: 'OBSERVACIÓN', 8: 'NOT_THE_ID' })],
  });
  const rBadHeader = await ensureCdvSheetRows(
    {
      historicoRows: [historicoRow()],
      solicitudes: [{ cz_id: 1168, ci: 29108021 }],
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheetsBadHeader.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map([['1168', 'prestafacil']]);
      },
    },
  );
  assert.strictEqual(rBadHeader.status, 'header_mismatch');
  assert.strictEqual(rBadHeader.inserted, 0);
  assert.strictEqual(sheetsBadHeader.calls.update.length, 0);
  assert.strictEqual(sheetsBadHeader.calls.batchUpdate.length, 0);
  assert.strictEqual(sheetsBadHeader.calls.spreadsheetBatchUpdate.length, 0);
  assert.strictEqual(sheetsBadHeader.calls.append.length, 0);

  // 8. Google falla → fail-open
  const sheets8 = fakeSheets({
    updateError: new Error('Sheets API unavailable'),
  });
  let thrown = null;
  let r8 = null;
  try {
    r8 = await syncCdvSheetAfterHistoricoPersist(
      {
        historicoRows: [historicoRow()],
        solicitudes: [{ cz_id: 1168, ci: 1 }],
      },
      {
        env: ENABLED_ENV,
        createSheetsClient: sheets8.createSheetsClient,
        resolveBasesForCandidates: async function () {
          return new Map([['1168', 'prestafacil']]);
        },
      },
    );
  } catch (err) {
    thrown = err;
  }
  assert.strictEqual(thrown, null);
  assert.strictEqual(r8.status, 'error');

  // estado != 8 → no escribe
  const sheets9 = fakeSheets();
  const r9 = await ensureCdvSheetRows(
    {
      historicoRows: [
        historicoRow({ solicitudes_estados_id: 7, cz_solicitud_id: 99 }),
      ],
      solicitudes: [{ cz_id: 99, ci: 111 }],
    },
    {
      env: ENABLED_ENV,
      createSheetsClient: sheets9.createSheetsClient,
      resolveBasesForCandidates: async function () {
        return new Map();
      },
    },
  );
  assert.strictEqual(r9.inserted, 0);
  assert.strictEqual(sheets9.calls.get, 0);
  assert.strictEqual(sheets9.calls.update.length, 0);
  assert.strictEqual(sheets9.calls.append.length, 0);

  // collectEstado8 still works
  const collected = collectEstado8FromHistorico(
    [
      historicoRow({ solicitudes_estados_id: 7 }),
      historicoRow({ solicitudes_estados_id: 8 }),
    ],
    new Map([['1168', { ci: 29108021, jt: 'JT' }]]),
  );
  assert.strictEqual(collected.size, 1);
  assert.strictEqual(collected.get('1168').jt, 'JT');

  console.log('OK unit-cdv-sheet-sync');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
