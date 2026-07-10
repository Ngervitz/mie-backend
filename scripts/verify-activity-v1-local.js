#!/usr/bin/env node
/**
 * Local pure-logic checks for Activity V1 (no DB).
 * Run: node scripts/verify-activity-v1-local.js
 */

const {
  CONFIDENCE_NONE_MAX_DAYS,
  MIN_ABSOLUTE_DELTA,
  VALID_SNAPSHOT_STATUSES,
  RULESET_VERSION,
} = require('../src/activity/constants');
const { shiftDateUtc, daysBetween } = require('../src/activity/dates');
const {
  buildCurrentWindow,
  isBlockCoverageValid,
  indexSnapshotsByDate,
} = require('../src/activity/coverage');
const {
  confidenceLevelFromDays,
  evaluateChange,
  computeBaseline,
} = require('../src/activity/metrics');
const { resolveAntiFlapping, yesterdayExecutionDate } = require('../src/activity/antiflap');

function assert(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) process.exitCode = 1;
}

console.log('=== Activity V1 local verification ===\n');
console.log(`RULESET_VERSION=${RULESET_VERSION}\n`);

const exec = '2026-07-10';
const { currentWindowStart, currentWindowEnd } = buildCurrentWindow(exec);
assert('window is 7 days half-open ending next day', currentWindowStart === '2026-07-04' && currentWindowEnd === '2026-07-11');
assert('yesterdayExecutionDate = execution_date - 1', yesterdayExecutionDate(exec) === '2026-07-09');

assert('empty is NOT valid coverage status', !VALID_SNAPSHOT_STATUSES.has('empty'));
assert('empty_unconfirmed is NOT valid', !VALID_SNAPSHOT_STATUSES.has('empty_unconfirmed'));
assert('success is valid', VALID_SNAPSHOT_STATUSES.has('success'));
assert('empty_confirmed is valid', VALID_SNAPSHOT_STATUSES.has('empty_confirmed'));

const snaps = indexSnapshotsByDate([
  { snapshot_date: '2026-07-04', status: 'success', created_at: '2026-07-04T10:00:00Z' },
  { snapshot_date: '2026-07-04', status: 'empty', created_at: '2026-07-04T12:00:00Z' },
  { snapshot_date: '2026-07-05', status: 'empty_confirmed', created_at: '2026-07-05T10:00:00Z' },
  { snapshot_date: '2026-07-06', status: 'success', created_at: '2026-07-06T10:00:00Z' },
  { snapshot_date: '2026-07-07', status: 'success', created_at: '2026-07-07T10:00:00Z' },
  { snapshot_date: '2026-07-08', status: 'success', created_at: '2026-07-08T10:00:00Z' },
  { snapshot_date: '2026-07-09', status: 'success', created_at: '2026-07-09T10:00:00Z' },
  { snapshot_date: '2026-07-10', status: 'success', created_at: '2026-07-10T10:00:00Z' },
]);

assert(
  'latest snapshot of day uses created_at DESC (empty overrides success → invalid day)',
  isBlockCoverageValid(snaps, '2026-07-04', '2026-07-05') === false,
);

const goodSnaps = indexSnapshotsByDate([
  { snapshot_date: '2026-07-04', status: 'success', created_at: '2026-07-04T10:00:00Z' },
  { snapshot_date: '2026-07-05', status: 'empty_confirmed', created_at: '2026-07-05T10:00:00Z' },
  { snapshot_date: '2026-07-06', status: 'success', created_at: '2026-07-06T10:00:00Z' },
  { snapshot_date: '2026-07-07', status: 'success', created_at: '2026-07-07T10:00:00Z' },
  { snapshot_date: '2026-07-08', status: 'success', created_at: '2026-07-08T10:00:00Z' },
  { snapshot_date: '2026-07-09', status: 'success', created_at: '2026-07-09T10:00:00Z' },
  { snapshot_date: '2026-07-10', status: 'success', created_at: '2026-07-10T10:00:00Z' },
]);
assert('full valid week passes coverage', isBlockCoverageValid(goodSnaps, currentWindowStart, currentWindowEnd));

assert('confidence none for 0–13 days', confidenceLevelFromDays(13) === 'none');
assert('confidence low for 14', confidenceLevelFromDays(14) === 'low');
assert('confidence medium for 35', confidenceLevelFromDays(35) === 'medium');
assert('confidence high for 56', confidenceLevelFromDays(56) === 'high');

const blocked = evaluateChange({
  observedValue: 20,
  baselineMean: 5,
  baselineStd: 1,
  confidenceLevel: 'none',
  coverageValid: true,
});
assert('confidence=none blocks change_relevant', blocked.changeRelevant === false);
assert('delta_value still persisted when none', blocked.deltaValue === 15);

const changed = evaluateChange({
  observedValue: 20,
  baselineMean: 5,
  baselineStd: null,
  confidenceLevel: 'low',
  coverageValid: true,
});
assert('low confidence can declare change with cond 1+2', changed.changeRelevant === true);
assert('direction increased', changed.changeDirection === 'increased');

const baseline = computeBaseline([1, 2, 3, 4]);
assert('std requires 4 blocks', baseline.baselineStd !== null);
assert('mean with 1 block', computeBaseline([10]).baselineMean === 10);
assert('std null with <4 blocks', computeBaseline([1, 2, 3]).baselineStd === null);

const flapNew = resolveAntiFlapping({
  executionDate: exec,
  changeRelevantToday: true,
  changeDirectionToday: 'increased',
  deltaValueToday: 10,
  yesterdayRow: null,
  recentAlertsSameDirection: [],
});
assert('no yesterday → can emit alert', flapNew.alertEmitted === true);
assert('consecutive starts at 1', flapNew.consecutiveChangeDays === 1);

const flapRepeat = resolveAntiFlapping({
  executionDate: exec,
  changeRelevantToday: true,
  changeDirectionToday: 'increased',
  deltaValueToday: 10,
  yesterdayRow: { change_relevant: true, consecutive_change_days: 2 },
  recentAlertsSameDirection: [],
});
assert('yesterday already change → no new alert', flapRepeat.alertEmitted === false);
assert('consecutive increments vs execution_date-1', flapRepeat.consecutiveChangeDays === 3);

const flapSuppress = resolveAntiFlapping({
  executionDate: exec,
  changeRelevantToday: true,
  changeDirectionToday: 'increased',
  deltaValueToday: 10,
  yesterdayRow: null,
  recentAlertsSameDirection: [{
    execution_date: shiftDateUtc(exec, -2),
    delta_value: 10,
    alert_emitted: true,
    change_direction: 'increased',
  }],
});
assert('suppression blocks same-direction alert within 7d', flapSuppress.alertEmitted === false);

const flapEscalate = resolveAntiFlapping({
  executionDate: exec,
  changeRelevantToday: true,
  changeDirectionToday: 'increased',
  deltaValueToday: 20,
  yesterdayRow: null,
  recentAlertsSameDirection: [{
    execution_date: shiftDateUtc(exec, -2),
    delta_value: 10,
    alert_emitted: true,
    change_direction: 'increased',
  }],
});
assert('escalation 1.75x uses persisted delta', flapEscalate.alertEmitted === true);

assert('daysBetween calendar', daysBetween('2026-01-01', '2026-01-15') === 14);
assert('CONFIDENCE_NONE_MAX_DAYS is 13', CONFIDENCE_NONE_MAX_DAYS === 13);
assert('MIN_ABSOLUTE_DELTA is 3', MIN_ABSOLUTE_DELTA === 3);

console.log('\nDB E2E (Pronto+/Anda): No demostrado — requiere migración + SUPABASE_URL.');
