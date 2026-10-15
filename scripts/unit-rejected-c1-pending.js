'use strict';

/**
 * Regression: C1 pending (12/14/15) must not enter rejected universe or survey path.
 * Run: node scripts/unit-rejected-c1-pending.js
 */

const assert = require('assert');
const { OUTCOME } = require('../src/services/providerFallback/constants');
const {
  assembleRejectedList,
  rejectedUniverseByCi,
} = require('../src/lib/rejectedOpsRead');
const {
  REASONS,
  evaluateRejectedSurveyInviteEligibility,
} = require('../src/lib/rejectedSurveyInvite');
const {
  C1_PENDING_LIST_STATUS,
  C1_PENDING_PROJECTED_ESTADOS,
  isC1PendingListStatus,
  assembleC1PendingRows,
} = require('../src/lib/rejectedC1PendingRead');

assert.strictEqual(C1_PENDING_LIST_STATUS, 'c1_pending_elm');
assert.strictEqual(isC1PendingListStatus('c1_pending_elm'), true);
assert.strictEqual(isC1PendingListStatus('bcu_pending'), false);
assert.deepStrictEqual(C1_PENDING_PROJECTED_ESTADOS, [12, 14, 15]);
assert.ok(!C1_PENDING_PROJECTED_ESTADOS.includes(13), 'estado 13 (derivación activa) excluded');

const excluded13 = assembleC1PendingRows({
  states: [
    { cz_solicitud_id: 2000, ci: 999, projected_estado: 13, updated_at: '2026-01-01T00:00:00.000Z' },
  ],
  solicitudesByCz: new Map(),
  fallbacksByCz: new Map(),
  reviewByCz: new Map(),
  elmCells: new Map(),
});
assert.strictEqual(excluded13.length, 0);

const ciElm = 40129799;
const czPending = 1508;

const historicoC1Path = [
  {
    cz_historico_id: 100,
    cz_solicitud_id: czPending,
    solicitudes_estados_id: 1,
    fechahora_src: '2026-07-01T10:00:00.000Z',
  },
  {
    cz_historico_id: 101,
    cz_solicitud_id: czPending,
    solicitudes_estados_id: 12,
    fechahora_src: '2026-07-01T10:05:00.000Z',
  },
  {
    cz_historico_id: 102,
    cz_solicitud_id: czPending,
    solicitudes_estados_id: 14,
    fechahora_src: '2026-07-01T11:00:00.000Z',
  },
];

const solPending = {
  cz_id: czPending,
  ci: ciElm,
  nombre: 'Test',
  apellido: 'C1',
  fecha_reg: '2026-07-01T09:00:00.000Z',
  solicitudes_estados_id: 14,
  email: 'test@example.com',
  lrw_id: 'lrw-1',
};

const uni = rejectedUniverseByCi(historicoC1Path, [solPending]);
assert.strictEqual(uni.has(ciElm), false, 'C1 path 1→12→14 must not enter rejected universe');

const rejectedList = assembleRejectedList({
  estadoRows: historicoC1Path,
  solicitudRows: [solPending],
  encuestaRows: [],
  snapshotRows: [],
  institutionRows: [],
  status: null,
});
assert.strictEqual(rejectedList.length, 0, 'assembleRejectedList must ignore C1-only CIs');

const survey = evaluateRejectedSurveyInviteEligibility({
  ci: ciElm,
  campaignId: 'camp-1',
  publicBaseUrlConfigured: true,
  lastRejection: null,
  solicitud: solPending,
  hasEncuesta: false,
  isSuppressed: false,
  elmBlocked: false,
});
assert.strictEqual(survey.eligible, false);
assert.strictEqual(survey.reason, REASONS.NO_CURRENT_REJECTION);

const c1Rows = assembleC1PendingRows({
  states: [
    {
      cz_solicitud_id: czPending,
      ci: ciElm,
      projected_estado: 14,
      updated_at: '2026-07-01T11:00:00.000Z',
    },
  ],
  solicitudesByCz: new Map([[czPending, solPending]]),
  fallbacksByCz: new Map([
    [
      czPending,
      {
        cz_solicitud_id: czPending,
        outcome: OUTCOME.MANUAL_REVIEW,
        reason_code: 'elm_s1_unknown',
        finalized_at: '2026-07-01T11:00:00.000Z',
      },
    ],
  ]),
  reviewByCz: new Map([
    [
      czPending,
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        cz_solicitud_id: czPending,
        reason_code: 'elm_s1_unknown',
        status: 'open',
      },
    ],
  ]),
  elmCells: new Map([
    [
      czPending,
      {
        kind: 'process',
        state: 's1_unknown',
        label: 'S1 incierto',
        detail: 'Esperando revisión',
      },
    ],
  ]),
});

assert.strictEqual(c1Rows.length, 1);
assert.strictEqual(c1Rows[0].ci, ciElm);
assert.strictEqual(c1Rows[0].cz_solicitud_id, czPending);
assert.strictEqual(c1Rows[0].projected_estado, 14);
assert.ok(c1Rows[0].action);
assert.strictEqual(c1Rows[0].action.kind, 'open_elm_ops');
assert.strictEqual(
  c1Rows[0].action.review_case_id,
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
);

const noAction = assembleC1PendingRows({
  states: [
    { cz_solicitud_id: 99, ci: 111, projected_estado: 12, updated_at: '2026-01-01T00:00:00.000Z' },
  ],
  solicitudesByCz: new Map(),
  fallbacksByCz: new Map([
    [99, { outcome: OUTCOME.REJECTED, reason_code: 'x', finalized_at: '2026-01-01T00:00:00.000Z' }],
  ]),
  reviewByCz: new Map(),
  elmCells: new Map(),
});
assert.strictEqual(noAction[0].action, null);

console.log('OK unit-rejected-c1-pending');
