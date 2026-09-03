'use strict';

/**
 * Offline unit checks for Rechazados V0 read assembly (no HTTP / no DB).
 * Run: node scripts/unit-rechazados-read.js
 */

const assert = require('assert');
const { OPS_STATUS } = require('../src/lib/rejectedOps');
const {
  SECTION_KEYS,
  resolveSectionForPath,
} = require('../src/middleware/dashboardSections');
const {
  parseStatusQuery,
  assembleRejectedList,
  assembleRejectedDetail,
  sortEncuestas,
  sortSnapshotsDesc,
  sortInstitutions,
  sortRejectionsDesc,
} = require('../src/lib/rejectedOpsRead');

function inst(category, extras) {
  return Object.assign(
    {
      id: extras && extras.id,
      snapshot_id: extras && extras.snapshot_id,
      institution_name: extras && extras.institution_name ? extras.institution_name : 'Banco',
      category: category,
      vigente_mn: 0,
      vigente_me: 0,
      moroso_mn: 0,
      moroso_me: 0,
      castigado_mn: 0,
      castigado_me: 0,
      contingencias_mn: 0,
      contingencias_me: 0,
      sort_order: extras && extras.sort_order != null ? extras.sort_order : 0,
      created_at: extras && extras.created_at,
    },
    extras || {},
  );
}

assert.ok(SECTION_KEYS.includes('rechazados'));
assert.strictEqual(resolveSectionForPath('/rechazados'), 'rechazados');
assert.strictEqual(resolveSectionForPath('/rechazados/45006120'), 'rechazados');

assert.deepStrictEqual(parseStatusQuery(undefined), { ok: true, status: null });
assert.deepStrictEqual(parseStatusQuery(''), { ok: true, status: null });
assert.deepStrictEqual(parseStatusQuery('bcu_pending'), {
  ok: true,
  status: 'bcu_pending',
});
assert.deepStrictEqual(parseStatusQuery('nope'), { ok: false });

const solA1 = {
  cz_id: 10,
  ci: 111,
  nombre: 'Ana',
  apellido: 'Perez',
  fecha_reg: '2026-01-01T00:00:00.000Z',
};
const solA2 = {
  cz_id: 11,
  ci: 111,
  nombre: 'Ana',
  apellido: 'Nueva',
  fecha_reg: '2026-06-01T00:00:00.000Z',
};
const solB = {
  cz_id: 20,
  ci: 222,
  nombre: 'Beto',
  apellido: 'Gomez',
  fecha_reg: '2026-02-01T00:00:00.000Z',
};
const solNoName = {
  cz_id: 30,
  ci: 333,
  nombre: null,
  apellido: null,
  fecha_reg: '2026-03-01T00:00:00.000Z',
};
const solFallbackName = {
  cz_id: 31,
  ci: 333,
  nombre: 'Carla',
  apellido: 'Luis',
  fecha_reg: '2026-04-01T00:00:00.000Z',
};

const estadoRows = [
  {
    cz_historico_id: 1,
    cz_solicitud_id: 10,
    solicitudes_estados_id: 3,
    estado: 'Autorización negada',
    fechahora_src: '2026-01-10T12:00:00.000Z',
  },
  {
    cz_historico_id: 2,
    cz_solicitud_id: 11,
    solicitudes_estados_id: 3,
    estado: 'Autorización negada',
    fechahora_src: '2026-07-01T12:00:00.000Z',
  },
  {
    cz_historico_id: 99,
    cz_solicitud_id: 10,
    solicitudes_estados_id: 5,
    estado: 'otro',
    fechahora_src: '2026-08-01T12:00:00.000Z',
  },
  {
    cz_historico_id: 3,
    cz_solicitud_id: 20,
    solicitudes_estados_id: 3,
    estado: 'Autorización negada',
    fechahora_src: '2026-05-01T12:00:00.000Z',
  },
  {
    cz_historico_id: 4,
    cz_solicitud_id: 30,
    solicitudes_estados_id: 3,
    estado: 'Autorización negada',
    fechahora_src: '2026-03-15T12:00:00.000Z',
  },
];

const solicitudRows = [solA1, solA2, solB, solNoName, solFallbackName];

const encuestaRows = [
  {
    cz_id: 100,
    ci: 111,
    score_v2: 10,
    completed_at: '2026-02-01T00:00:00.000Z',
    email: 'old@x.com',
  },
  {
    cz_id: 101,
    ci: 111,
    score_v2: 40,
    completed_at: '2026-08-01T00:00:00.000Z',
    email: 'new@x.com',
  },
  {
    cz_id: 102,
    ci: 111,
    score_v2: 99,
    completed_at: '2026-08-01T00:00:00.000Z',
    email: 'tie@x.com',
  },
];

const snapOld = {
  id: 'snap-old',
  ci: 111,
  period_label: 'ene',
  consulted_on: '2026-01-15',
  source: 'manual',
  storage_path: 'a',
  original_filename: 'a.pdf',
  content_type: 'application/pdf',
  file_size_bytes: 10,
  created_at: '2026-01-16T00:00:00.000Z',
};
const snapNewEarly = {
  id: 'snap-new-early',
  ci: 111,
  period_label: 'ago-early',
  consulted_on: '2026-08-10',
  source: 'manual',
  storage_path: null,
  original_filename: null,
  content_type: null,
  file_size_bytes: null,
  created_at: '2026-08-10T08:00:00.000Z',
};
const snapNewLate = {
  id: 'snap-new-late',
  ci: 111,
  period_label: 'ago-late',
  consulted_on: '2026-08-10',
  source: 'manual',
  storage_path: 'b',
  original_filename: 'b.pdf',
  content_type: 'application/pdf',
  file_size_bytes: 20,
  created_at: '2026-08-10T18:00:00.000Z',
};

const institutionRows = [
  inst('1C', {
    id: 'i1',
    snapshot_id: 'snap-old',
    sort_order: 0,
    created_at: '2026-01-16T00:00:01.000Z',
  }),
  inst('5', {
    id: 'i-late-2',
    snapshot_id: 'snap-new-late',
    institution_name: 'Zeta',
    sort_order: 1,
    created_at: '2026-08-10T18:00:02.000Z',
    moroso_mn: 100,
  }),
  inst('3', {
    id: 'i-late-1',
    snapshot_id: 'snap-new-late',
    institution_name: 'Alfa',
    sort_order: 0,
    created_at: '2026-08-10T18:00:03.000Z',
  }),
  inst('2A', {
    id: 'i-early',
    snapshot_id: 'snap-new-early',
    sort_order: 0,
    created_at: '2026-08-10T08:00:01.000Z',
  }),
];

const list = assembleRejectedList({
  estadoRows: estadoRows,
  solicitudRows: solicitudRows,
  encuestaRows: encuestaRows,
  snapshotRows: [snapOld, snapNewEarly, snapNewLate],
  institutionRows: institutionRows,
});

assert.strictEqual(list.length, 3);
assert.deepStrictEqual(
  list.map(function (r) {
    return r.ci;
  }),
  [111, 222, 333],
);
assert.strictEqual(list[0].rejected_at, '2026-07-01T12:00:00.000Z');
assert.strictEqual(list[1].rejected_at, '2026-05-01T12:00:00.000Z');
assert.strictEqual(list[2].rejected_at, '2026-03-15T12:00:00.000Z');

const row111 = list[0];
assert.strictEqual(row111.nombre, 'Ana');
assert.strictEqual(row111.apellido, 'Nueva');
assert.strictEqual(row111.score_v2, 99);
assert.strictEqual(row111.encuesta_completed_at, '2026-08-01T00:00:00.000Z');
assert.strictEqual(row111.worst_bcu, '5');
assert.strictEqual(row111.ops_status, OPS_STATUS.RECONSULTABLE);
assert.strictEqual(row111.next_review_on, '2026-09-05');

const row222 = list.find(function (r) {
  return r.ci === 222;
});
assert.strictEqual(row222.ops_status, OPS_STATUS.BCU_PENDING);
assert.strictEqual(row222.worst_bcu, null);
assert.strictEqual(row222.next_review_on, null);
assert.strictEqual(row222.score_v2, null);

const row333 = list.find(function (r) {
  return r.ci === 333;
});
assert.strictEqual(row333.nombre, 'Carla');
assert.strictEqual(row333.apellido, 'Luis');

const retryOnly = assembleRejectedList({
  estadoRows: estadoRows,
  solicitudRows: solicitudRows,
  encuestaRows: encuestaRows,
  snapshotRows: [snapOld],
  institutionRows: institutionRows,
  status: OPS_STATUS.RETRY_ELIGIBLE,
});
assert.strictEqual(retryOnly.length, 1);
assert.strictEqual(retryOnly[0].ci, 111);
assert.strictEqual(retryOnly[0].ops_status, OPS_STATUS.RETRY_ELIGIBLE);
assert.strictEqual(retryOnly[0].worst_bcu, '1C');

const pendingOnly = assembleRejectedList({
  estadoRows: estadoRows,
  solicitudRows: solicitudRows,
  encuestaRows: [],
  snapshotRows: [],
  institutionRows: [],
  status: OPS_STATUS.BCU_PENDING,
});
assert.strictEqual(pendingOnly.length, 3);

const none = assembleRejectedList({
  estadoRows: estadoRows,
  solicitudRows: solicitudRows,
  encuestaRows: [],
  snapshotRows: [],
  institutionRows: [],
  status: OPS_STATUS.NO_AUTO_RECONSULT,
});
assert.strictEqual(none.length, 0);

const missing = assembleRejectedDetail({
  ci: 999,
  estadoRows: estadoRows,
  solicitudRows: solicitudRows,
  encuestaRows: [],
  snapshotRows: [],
  institutionRows: [],
});
assert.strictEqual(missing, null);

const detail = assembleRejectedDetail({
  ci: 111,
  estadoRows: estadoRows,
  solicitudRows: solicitudRows,
  encuestaRows: encuestaRows,
  snapshotRows: [snapOld, snapNewEarly, snapNewLate],
  institutionRows: institutionRows,
});
assert.ok(detail);
assert.strictEqual(detail.ci, 111);
assert.strictEqual(detail.ops_status, OPS_STATUS.RECONSULTABLE);
assert.strictEqual(detail.worst_bcu, '5');
assert.strictEqual(detail.snapshots[0].id, 'snap-new-late');
assert.strictEqual(detail.snapshots[1].id, 'snap-new-early');
assert.strictEqual(detail.snapshots[2].id, 'snap-old');
assert.deepStrictEqual(
  detail.snapshots[0].institutions.map(function (i) {
    return i.id;
  }),
  ['i-late-1', 'i-late-2'],
);
assert.strictEqual(detail.snapshots[1].ops_status, OPS_STATUS.RETRY_ELIGIBLE);
assert.strictEqual(detail.ops_status, detail.snapshots[0].ops_status);
assert.notStrictEqual(detail.ops_status, detail.snapshots[1].ops_status);
assert.deepStrictEqual(
  detail.rejections.map(function (r) {
    return r.cz_historico_id;
  }),
  [2, 1],
);
assert.deepStrictEqual(
  detail.encuestas.map(function (e) {
    return e.cz_id;
  }),
  [102, 101, 100],
);

const sortedEnc = sortEncuestas([
  { cz_id: 1, completed_at: null },
  { cz_id: 2, completed_at: '2026-01-01T00:00:00.000Z' },
  { cz_id: 3, completed_at: null },
]);
assert.deepStrictEqual(
  sortedEnc.map(function (e) {
    return e.cz_id;
  }),
  [2, 3, 1],
);

const sortedSnaps = sortSnapshotsDesc([
  { id: 'a', consulted_on: '2026-01-01', created_at: '2026-01-02T00:00:00.000Z' },
  { id: 'b', consulted_on: '2026-02-01', created_at: '2026-02-01T00:00:00.000Z' },
]);
assert.strictEqual(sortedSnaps[0].id, 'b');

const sortedInst = sortInstitutions([
  { id: 'z', sort_order: 2, created_at: '2026-01-01T00:00:00.000Z' },
  { id: 'a', sort_order: 0, created_at: '2026-01-03T00:00:00.000Z' },
  { id: 'b', sort_order: 0, created_at: '2026-01-02T00:00:00.000Z' },
]);
assert.deepStrictEqual(
  sortedInst.map(function (i) {
    return i.id;
  }),
  ['b', 'a', 'z'],
);

const sortedRej = sortRejectionsDesc([
  { cz_historico_id: 1, fechahora_src: '2026-01-01T00:00:00.000Z' },
  { cz_historico_id: 9, fechahora_src: '2026-01-01T00:00:00.000Z' },
  { cz_historico_id: 2, fechahora_src: null },
]);
assert.deepStrictEqual(
  sortedRej.map(function (r) {
    return r.cz_historico_id;
  }),
  [9, 1, 2],
);

console.log('OK unit-rechazados-read');
