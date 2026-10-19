'use strict';

/**
 * node scripts/unit-rejected-list-pagination.js
 */

const assert = require('assert');
const {
  parseListPagination,
  paginateAssembledList,
  applyEncuestasToListRows,
  assembleRejectedList,
  LIST_DEFAULT_LIMIT,
} = require('../src/lib/rejectedOpsRead');

assert.deepStrictEqual(parseListPagination(null, null), {
  ok: true,
  paginated: false,
  limit: null,
  offset: 0,
});

assert.deepStrictEqual(parseListPagination('', ''), {
  ok: true,
  paginated: false,
  limit: null,
  offset: 0,
});

assert.deepStrictEqual(parseListPagination('50', '0'), {
  ok: true,
  paginated: true,
  limit: 50,
  offset: 0,
});

assert.deepStrictEqual(parseListPagination(undefined, '100'), {
  ok: true,
  paginated: true,
  limit: LIST_DEFAULT_LIMIT,
  offset: 100,
});

assert.strictEqual(parseListPagination('0', '0').ok, false);
assert.strictEqual(parseListPagination('50', '-1').ok, false);

const rows = [{ ci: 1 }, { ci: 2 }, { ci: 3 }, { ci: 4 }, { ci: 5 }];
const all = paginateAssembledList(rows, {
  paginated: false,
  limit: null,
  offset: 0,
});
assert.strictEqual(all.total, 5);
assert.strictEqual(all.rows.length, 5);

const page = paginateAssembledList(rows, {
  paginated: true,
  limit: 2,
  offset: 2,
});
assert.deepStrictEqual(
  page.rows.map(function (r) {
    return r.ci;
  }),
  [3, 4],
);
assert.strictEqual(page.total, 5);
assert.strictEqual(page.offset, 2);

const withEnc = applyEncuestasToListRows(
  [{ ci: 10, nombre: 'A' }],
  [
    {
      ci: 10,
      cz_id: 1,
      score_v2: 18,
      completed_at: '2026-01-01T00:00:00Z',
      version_cuestionario: 2,
      segmentacion_base: 'A',
    },
    {
      ci: 10,
      cz_id: 2,
      score_v2: 5,
      completed_at: '2026-02-01T00:00:00Z',
      version_cuestionario: 2,
      segmentacion_base: 'B',
    },
  ],
);
assert.strictEqual(withEnc[0].score_v2, 5);
assert.strictEqual(withEnc[0].survey_version, 2);

const assembled = assembleRejectedList({
  estadoRows: [
    {
      cz_historico_id: 1,
      cz_solicitud_id: 100,
      solicitudes_estados_id: 3,
      fechahora_src: '2026-03-01T00:00:00Z',
    },
  ],
  solicitudRows: [
    {
      cz_id: 100,
      ci: 555,
      nombre: 'Ana',
      apellido: 'X',
      fecha_reg: '2026-02-01',
      solicitudes_estados_id: 3,
      email: 'a@b.com',
      lrw_id: 'LRW-1',
    },
  ],
  encuestaRows: [],
  snapshotRows: [],
  institutionRows: [],
  outreachRows: [],
  status: null,
});
assert.strictEqual(assembled.length, 1);
assert.strictEqual(assembled[0].score_v2, null);
const patched = applyEncuestasToListRows(assembled, [
  {
    ci: 555,
    cz_id: 9,
    score_v2: 12,
    completed_at: '2026-01-15T00:00:00Z',
    version_cuestionario: 1,
    segmentacion_base: null,
  },
]);
assert.strictEqual(patched[0].score_v2, 12);

console.log('unit-rejected-list-pagination: ok');
