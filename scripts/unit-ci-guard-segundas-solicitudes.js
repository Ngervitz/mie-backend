'use strict';

/**
 * evaluateCiGuard: second solicitudes of the same CI (prod regressions CZ 1987/1984/2024).
 * Run: node scripts/unit-ci-guard-segundas-solicitudes.js
 */

const assert = require('assert');
const { S1, S2 } = require('../src/services/elm/constants');
const { evaluateCiGuard, decideCiLock } = require('../src/services/providerFallback/outcome');
const { OUTCOME, REASONS, CZ_ESTADO } = require('../src/services/providerFallback/constants');

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

function proc(overrides) {
  return Object.assign(
    {
      cz_solicitud_id: 0,
      s1_status: S1.UNKNOWN,
      s2_status: S2.NOT_STARTED,
      s1_lease_expires_at: null,
      s2_lease_expires_at: null,
      s1_result_message: null,
      s2_result_message: null,
      cz_projected_estado: null,
      disbursed_at: null,
      ops_resolved_at: null,
      referred_at: null,
      provider_status: null,
    },
    overrides,
  );
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('CZ 1987 / CI 50966583: prior 1492 same month Repetido → not_eligible quota, not ci_prior_unknown', () => {
  const prior = proc({
    cz_solicitud_id: 1492,
    s1_status: S1.UNKNOWN,
    s1_result_message: 'Repetido. Rechazado',
    s1_completed_at: new Date(NOW).toISOString(),
    cz_projected_estado: CZ_ESTADO.REJECTED,
  });
  const g = evaluateCiGuard([prior], 1987, NOW);
  assert.strictEqual(g.kind, 'final');
  assert.strictEqual(g.outcome, OUTCOME.NOT_ELIGIBLE);
  assert.strictEqual(g.reasonCode, REASONS.CI_MONTHLY_QUOTA_USED);
  assert.strictEqual(g.relatedCzId, 1492);
  assert.notStrictEqual(g.reasonCode, REASONS.ELM_S1_REJECTED);
});

test('CZ 1984 / CI 26648230: prior 1847 same month Repetido → quota before phone correction', () => {
  const prior = proc({
    cz_solicitud_id: 1847,
    s1_status: S1.REJECTED,
    s1_result_message: 'Repetido. Rechazado',
    s1_completed_at: new Date(NOW).toISOString(),
    cz_projected_estado: CZ_ESTADO.REJECTED,
  });
  const g = evaluateCiGuard([prior], 1984, NOW);
  assert.strictEqual(g.kind, 'final');
  assert.strictEqual(g.outcome, OUTCOME.NOT_ELIGIBLE);
  assert.strictEqual(g.reasonCode, REASONS.CI_MONTHLY_QUOTA_USED);
  assert.strictEqual(g.relatedCzId, 1847);
});

test('CI 34552857: prior 2023 same month S1 rejected Repetido → ci_monthly_quota_used (not elm_s1_rejected)', () => {
  const prior = proc({
    cz_solicitud_id: 2023,
    s1_status: S1.REJECTED,
    s1_result_message: 'Repetido. Rechazado',
    s1_completed_at: new Date(NOW).toISOString(),
    cz_projected_estado: CZ_ESTADO.REJECTED,
  });
  const g = evaluateCiGuard([prior], 2024, NOW);
  assert.strictEqual(g.outcome, OUTCOME.NOT_ELIGIBLE);
  assert.strictEqual(g.reasonCode, REASONS.CI_MONTHLY_QUOTA_USED);
  assert.strictEqual(g.relatedCzId, 2023);
});

test('CZ 1984 cross-month: prior Repetido closed → guard proceed (no fake elm_s1_rejected)', () => {
  const prior = proc({
    cz_solicitud_id: 1847,
    s1_status: S1.REJECTED,
    s1_result_message: 'Repetido. Rechazado',
    s1_completed_at: '2026-08-15T15:00:00.000Z',
    cz_projected_estado: CZ_ESTADO.REJECTED,
  });
  const g = evaluateCiGuard([prior], 1984, NOW);
  assert.deepStrictEqual(g, { kind: 'proceed' });
});

test('regression CZ 1630: no other CI processes → proceed (resume S2 path unchanged)', () => {
  const self = proc({
    cz_solicitud_id: 1630,
    s1_status: S1.ELIGIBLE,
    s2_status: S2.NOT_STARTED,
    cz_projected_estado: 14,
  });
  const g = evaluateCiGuard([self], 1630, NOW);
  assert.deepStrictEqual(g, { kind: 'proceed' });
});

test('regression: prior still open in CZ with S1 unknown and no definitive text → ci_prior_unknown', () => {
  const prior = proc({
    cz_solicitud_id: 1900,
    s1_status: S1.UNKNOWN,
    s1_result_message: null,
    cz_projected_estado: 14,
  });
  const g = evaluateCiGuard([prior], 1912, NOW);
  assert.strictEqual(g.kind, 'final');
  assert.strictEqual(g.outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(g.reasonCode, REASONS.CI_PRIOR_UNKNOWN);
  assert.strictEqual(g.relatedCzId, 1900);
});

test('CI 35027627: unresolved 1498 Repetido closed in CZ is quota, not uncertain', () => {
  const now = Date.parse('2026-10-19T17:10:00.000Z');
  const prior = proc({
    cz_solicitud_id: 1498,
    s1_status: S1.UNKNOWN,
    s1_result_message: 'Repetido. Rechazado',
    s1_completed_at: '2026-10-14T21:12:14.000Z',
    cz_projected_estado: CZ_ESTADO.REJECTED,
  });
  const g = evaluateCiGuard([prior], 2149, now);
  assert.strictEqual(g.kind, 'final');
  assert.strictEqual(g.reasonCode, REASONS.CI_MONTHLY_QUOTA_USED);
  assert.notStrictEqual(g.reasonCode, REASONS.CI_PRIOR_UNKNOWN);
  assert.strictEqual(g.relatedCzId, 1498);
});

test('CI 35027627: after ops resolution of 1498 the guard no longer treats it as uncertain', () => {
  const now = Date.parse('2026-10-19T18:30:00.000Z');
  const prior = proc({
    cz_solicitud_id: 1498,
    s1_status: S1.UNKNOWN,
    s1_result_message: 'Repetido. Rechazado',
    s1_completed_at: '2026-10-14T21:12:14.000Z',
    cz_projected_estado: CZ_ESTADO.REJECTED,
    ops_resolved_at: '2026-10-19T18:00:00.000Z',
    ops_resolution_code: 'provider_confirmed_no_referral',
  });
  const g = evaluateCiGuard([prior], 2149, now);
  assert.deepStrictEqual(g, { kind: 'proceed' });
  const lock = decideCiLock({
    status: 'blocked',
    block: 'monthly_quota_used',
    related_cz_solicitud_id: 1498,
    month_key: '2026-10-01',
  });
  assert.strictEqual(lock.kind, 'final');
  assert.strictEqual(lock.reasonCode, REASONS.CI_MONTHLY_QUOTA_USED);
  assert.notStrictEqual(lock.reasonCode, REASONS.CI_PRIOR_UNKNOWN);
  assert.strictEqual(lock.relatedCzId, 1498);
});

test('closed prior S1 unknown without documented negative text does not auto-reject duplicate', () => {
  const prior = proc({
    cz_solicitud_id: 1500,
    s1_status: S1.UNKNOWN,
    s1_result_message: 'respuesta no documentada',
    cz_projected_estado: CZ_ESTADO.REJECTED,
  });
  const g = evaluateCiGuard([prior], 1501, NOW);
  assert.deepStrictEqual(g, { kind: 'proceed' });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('ok   ' + t.name);
    } catch (err) {
      failed += 1;
      console.log('FAIL ' + t.name);
      console.log(err && err.stack ? err.stack : err);
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
