'use strict';

/**
 * C1 follow-up merged into Rechazados display; surveys universe unchanged.
 * Run: node scripts/unit-rejected-c1-pending.js
 */

const assert = require('assert');
const { OPS_STATUS } = require('../src/lib/rejectedOps');
const {
  assembleRejectedList,
  rejectedUniverseByCi,
  listOpsForRejectedDisplay,
} = require('../src/lib/rejectedOpsRead');
const {
  REASONS,
  evaluateRejectedSurveyInviteEligibility,
} = require('../src/lib/rejectedSurveyInvite');
const {
  C1_DISPLAY_PROJECTED_ESTADOS,
  filterC1StatesExcludingElmGranted,
  mergeC1FollowupIntoRejectedRows,
  assembleC1FollowupDetail,
  appendC1FollowupToDetailRejections,
} = require('../src/lib/rejectedC1PendingRead');
const { readElmConfig } = require('../src/services/elm/config');
const { evaluateElmEligibility } = require('../src/services/elm/eligibility');
const { buildService1Payload } = require('../src/services/elm/payload');
const { classifyElmProcess } = require('../src/services/elm/classification');
const { computeElmCell } = require('../src/services/elm/listView');
const { resolveRejectedSend } = require('../src/lib/rejectedElmRead');
const { S1, S2 } = require('../src/services/elm/constants');
const { classifyService1Result } = require('../src/services/elm/client');
const { OUTCOME } = require('../src/services/elm/constants');
const { deriveFromProcess } = require('../src/services/providerFallback/outcome');
const {
  OUTCOME: FALLBACK_OUTCOME,
  REASONS: FALLBACK_REASONS,
} = require('../src/services/providerFallback/constants');

assert.deepStrictEqual(C1_DISPLAY_PROJECTED_ESTADOS, [12, 13, 14, 15]);

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

assert.strictEqual(rejectedUniverseByCi(historicoC1Path, [solPending]).has(ciElm), false);
assert.strictEqual(
  assembleRejectedList({
    estadoRows: historicoC1Path,
    solicitudRows: [solPending],
    encuestaRows: [],
    snapshotRows: [],
    institutionRows: [],
    status: null,
  }).length,
  0,
);

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

const opsNoSnap = listOpsForRejectedDisplay(ciElm, [], []);
assert.strictEqual(opsNoSnap.ops_status, null);
assert.strictEqual(opsNoSnap.has_rejected_bcu_snapshot, false);

const mergedAll = mergeC1FollowupIntoRejectedRows([], {
  states: [
    { cz_solicitud_id: czPending, ci: ciElm, projected_estado: 14, updated_at: '2026-07-01T11:00:00.000Z' },
    { cz_solicitud_id: 2001, ci: 88888888, projected_estado: 13, updated_at: '2026-07-01T12:00:00.000Z' },
  ],
  solicitudesByCz: new Map([
    [czPending, solPending],
    [2001, { cz_id: 2001, ci: 88888888, nombre: 'A', apellido: 'B', solicitudes_estados_id: 13 }],
  ]),
  snapshotRows: [],
  institutionRows: [],
  outreachRows: [],
  statusFilter: null,
});
assert.strictEqual(mergedAll.length, 2);
assert.strictEqual(mergedAll[0].ops_status, null);

const ciGranted = 43482685;
const czGranted = 1475;
const czOpen13 = 2001;
const mergedGrantedExcluded = mergeC1FollowupIntoRejectedRows([], {
  states: [
    { cz_solicitud_id: czGranted, ci: ciGranted, projected_estado: 13, updated_at: '2026-10-12T18:54:23Z' },
    { cz_solicitud_id: czOpen13, ci: 88888888, projected_estado: 13, updated_at: '2026-07-01T12:00:00.000Z' },
  ],
  grantedCzIds: new Set([czGranted]),
  solicitudesByCz: new Map([
    [czGranted, { cz_id: czGranted, ci: ciGranted, nombre: 'S', apellido: 'F', solicitudes_estados_id: 13 }],
    [czOpen13, { cz_id: czOpen13, ci: 88888888, nombre: 'A', apellido: 'B', solicitudes_estados_id: 13 }],
  ]),
  snapshotRows: [],
  institutionRows: [],
  outreachRows: [],
  statusFilter: null,
});
assert.strictEqual(
  mergedGrantedExcluded.some(function (r) {
    return Number(r.ci) === ciGranted;
  }),
  false,
  'ELM-granted C1 solicitud must not add a Rechazados row',
);
assert.strictEqual(mergedGrantedExcluded.length, 1);
assert.strictEqual(mergedGrantedExcluded[0].ci, 88888888);

const ciMixed = 55555555;
const czMixedGranted = 3001;
const czMixedOpen = 3002;
const mergedMixedCi = mergeC1FollowupIntoRejectedRows([], {
  states: [
    { cz_solicitud_id: czMixedGranted, ci: ciMixed, projected_estado: 13, updated_at: '2026-10-01T00:00:00.000Z' },
    { cz_solicitud_id: czMixedOpen, ci: ciMixed, projected_estado: 14, updated_at: '2026-10-02T00:00:00.000Z' },
  ],
  grantedCzIds: new Set([czMixedGranted]),
  solicitudesByCz: new Map([
    [czMixedGranted, { cz_id: czMixedGranted, ci: ciMixed, nombre: 'G', apellido: '1', solicitudes_estados_id: 13 }],
    [czMixedOpen, { cz_id: czMixedOpen, ci: ciMixed, nombre: 'O', apellido: '2', solicitudes_estados_id: 14 }],
  ]),
  snapshotRows: [],
  institutionRows: [],
  outreachRows: [],
  statusFilter: null,
});
assert.strictEqual(mergedMixedCi.length, 1);
assert.strictEqual(mergedMixedCi[0].ci, ciMixed);
assert.deepStrictEqual(
  mergedMixedCi[0].rejected_solicitudes.map(function (r) {
    return r.cz_solicitud_id;
  }),
  [czMixedOpen],
);

assert.deepStrictEqual(
  filterC1StatesExcludingElmGranted(
    [
      { cz_solicitud_id: 12, projected_estado: 12 },
      { cz_solicitud_id: 13, projected_estado: 13 },
      { cz_solicitud_id: 14, projected_estado: 14 },
      { cz_solicitud_id: 15, projected_estado: 15 },
    ],
    new Set([13]),
  ).map(function (s) {
    return s.cz_solicitud_id;
  }),
  [12, 14, 15],
);

const sol1504 = {
  cz_id: 1504,
  ci: 42423903,
  nombre: 'Andrea',
  apellido: 'Villar',
  email: 'andrea.cantera25@gmail.com',
  celular: '59892973500',
  salario: '13000',
  fecha_nacimiento: '1977-10-18',
  relacion_laboral: 'OTR',
};
const cfg = readElmConfig({});
assert.strictEqual(cfg.activityTypeMap.OTR, 'Otro');
const elig1504 = evaluateElmEligibility({ czId: 1504, solicitud: sol1504, grantedRow: null, config: cfg });
assert.ok(
  !elig1504.blockers.some(function (b) {
    return b.code === 'elm_activity_type_mapping_missing';
  }),
  'OTR must map to Otro',
);
const payload1504 = buildService1Payload({ czId: 1504, solicitud: sol1504, config: cfg });
assert.strictEqual(payload1504.ok, false, 'other ELM format env still required for full S1 payload');
if (!payload1504.ok) {
  assert.notStrictEqual(payload1504.code, 'elm_activity_type_mapping_missing');
}

const mergedBcuFilter = mergeC1FollowupIntoRejectedRows([], {
  states: [{ cz_solicitud_id: czPending, ci: ciElm, projected_estado: 14, updated_at: '2026-07-01T11:00:00.000Z' }],
  solicitudesByCz: new Map([[czPending, solPending]]),
  snapshotRows: [],
  institutionRows: [],
  outreachRows: [],
  statusFilter: OPS_STATUS.BCU_PENDING,
});
assert.strictEqual(mergedBcuFilter.length, 0, 'C1 without BCU snapshot must not match bcu_pending filter');

const bundle = {
  ci: ciElm,
  solicitudRows: [solPending],
  encuestaRows: [],
  snapshotRows: [],
  institutionRows: [],
  outreachRows: [],
};
const c1States = [{ cz_solicitud_id: czPending, ci: ciElm, projected_estado: 14, updated_at: '2026-07-01T11:00:00.000Z' }];
const detail = assembleC1FollowupDetail(bundle, c1States);
assert.ok(detail);
assert.strictEqual(detail.c1_followup_only, true);
assert.strictEqual(detail.rejections.length, 1);
assert.strictEqual(detail.snapshots.length, 0);
assert.strictEqual(detail.encuestas.length, 0);

assert.strictEqual(classifyService1Result('Repetido. Rechazado'), OUTCOME.NEGATIVE);
const classified1508 = classifyElmProcess(
  {
    s1_status: S1.UNKNOWN,
    s2_status: S2.NOT_STARTED,
    s1_result_message: 'Repetido. Rechazado',
    s1_error_code: 'elm_response_undocumented',
    trigger_origin: 'cz_automatic',
    id: 'proc-1508',
    cz_solicitud_id: 1508,
  },
  { projectedEstado: 14, nowMs: Date.now() },
);
assert.strictEqual(classified1508.state, 'rejected');
assert.strictEqual(classified1508.detail, 's1_negative');

const fallbackNowMs = Date.parse('2026-10-14T12:00:00.000Z');
const proc1508 = {
  s1_status: S1.UNKNOWN,
  s2_status: S2.NOT_STARTED,
  s1_result_message: 'Repetido. Rechazado',
  s1_error_code: 'elm_response_undocumented',
};
const derived1508 = deriveFromProcess(proc1508, fallbackNowMs, null);
assert.strictEqual(derived1508.kind, 'final');
assert.strictEqual(derived1508.outcome, FALLBACK_OUTCOME.REJECTED);
assert.strictEqual(derived1508.reasonCode, FALLBACK_REASONS.ELM_S1_REJECTED);
assert.strictEqual(derived1508.detail.result_message, 'Repetido. Rechazado');

const derivedUncertain = deriveFromProcess(
  {
    s1_status: S1.UNKNOWN,
    s2_status: S2.NOT_STARTED,
    s1_result_message: null,
    s1_error_code: 'HTTP_TIMEOUT',
  },
  fallbackNowMs,
  null,
);
assert.strictEqual(derivedUncertain.outcome, FALLBACK_OUTCOME.MANUAL_REVIEW);
assert.strictEqual(derivedUncertain.reasonCode, FALLBACK_REASONS.ELM_S1_UNKNOWN);

const derived1341 = deriveFromProcess(
  {
    s1_status: S1.UNKNOWN,
    s2_status: S2.NOT_STARTED,
    s1_result_message: 'Repetido. Aprobado',
    s1_error_code: 'elm_response_undocumented',
  },
  fallbackNowMs,
  null,
);
assert.strictEqual(derived1341.reasonCode, FALLBACK_REASONS.ELM_S1_UNKNOWN);

const cell1508 = computeElmCell({
  process: {
    id: 'proc-1508',
    cz_solicitud_id: 1508,
    s1_status: S1.UNKNOWN,
    s2_status: S2.NOT_STARTED,
    s1_result_message: 'Repetido. Rechazado',
    s1_error_code: 'elm_response_undocumented',
    trigger_origin: 'cz_automatic',
  },
  allowSend: true,
  sendReadiness: { ready: true, reasons: [] },
  nowMs: Date.now(),
  projectedEstado: 14,
});
assert.strictEqual(cell1508.state, 'rejected');
assert.strictEqual(cell1508.action.show, false, 'existing process: no send button');

const cells = new Map([
  [
    9101,
    {
      kind: 'not_sent',
      action: { show: true, enabled: true, reasons: [] },
    },
  ],
  [
    9102,
    {
      kind: 'not_sent',
      action: { show: true, enabled: true, reasons: [] },
    },
  ],
]);
const resolved = resolveRejectedSend({
  rejected: [
    { cz_solicitud_id: 9102, rejected_at: '2026-10-05T10:00:00.000Z' },
    { cz_solicitud_id: 9101, rejected_at: '2026-08-20T10:00:00.000Z' },
  ],
  cells: cells,
  hold: null,
});
assert.strictEqual(resolved.send.needs_selection, true);
assert.strictEqual(resolved.send.target_cz_id, null);
assert.deepStrictEqual(resolved.send.selectable_cz_ids, [9102, 9101]);
assert.strictEqual(resolved.solicitudes.length, 2);
assert.strictEqual(resolved.solicitudes[0].cz_solicitud_id, 9102);
assert.strictEqual(resolved.solicitudes[0].cell.action.enabled, true);
assert.strictEqual(resolved.solicitudes[1].cz_solicitud_id, 9101);

const mixedDetail = {
  ci: ciElm,
  rejections: [{ cz_historico_id: 1, cz_solicitud_id: 900, solicitudes_estados_id: 3, fechahora_src: '2026-06-01T00:00:00.000Z' }],
};
appendC1FollowupToDetailRejections(mixedDetail, c1States, bundle);
assert.strictEqual(mixedDetail.rejections.length, 2);

console.log('OK unit-rejected-c1-pending');
