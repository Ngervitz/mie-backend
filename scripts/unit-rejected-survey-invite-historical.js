'use strict';

/**
 * node scripts/unit-rejected-survey-invite-historical.js
 */

const assert = require('assert');

const {
  HISTORICAL_PILOT_CZ_IDS,
  HISTORICAL_PILOT_STEP_CAMPAIGN_IDS,
  HISTORICAL_RESULTS,
  STEP2_OFFSET_MS,
  STEP3_OFFSET_MS,
  resolveHistoricalTHist,
  historicalStep2DueAt,
  historicalStep3DueAt,
  decideHistoricalSurveyInviteAction,
  isAuthorizedPilotCzId,
  MS_HOUR,
} = require('../src/lib/rejectedSurveyInviteHistorical');

assert.strictEqual(HISTORICAL_PILOT_CZ_IDS.length, 10);
assert.deepStrictEqual(
  HISTORICAL_PILOT_STEP_CAMPAIGN_IDS,
  { 1: 6, 2: 7, 3: 8 },
);

assert.strictEqual(isAuthorizedPilotCzId(1153), true);
assert.strictEqual(isAuthorizedPilotCzId(9999), false);

assert.strictEqual(resolveHistoricalTHist(null), null);
assert.strictEqual(resolveHistoricalTHist({ status: 'queued' }), null);
assert.strictEqual(resolveHistoricalTHist({ created_at: '2026-01-01T00:00:00Z' }), null);
assert.strictEqual(
  resolveHistoricalTHist({ sent_at: '2026-09-01T12:00:00.000Z' }),
  '2026-09-01T12:00:00.000Z',
);

const tHist = '2026-09-01T12:00:00.000Z';
const t0Ms = Date.parse(tHist);
assert.strictEqual(
  historicalStep2DueAt(tHist),
  new Date(t0Ms + STEP2_OFFSET_MS).toISOString(),
);
assert.strictEqual(
  historicalStep3DueAt(tHist),
  new Date(t0Ms + STEP3_OFFSET_MS).toISOString(),
);
assert.strictEqual(STEP3_OFFSET_MS, 72 * MS_HOUR);
assert.strictEqual(STEP2_OFFSET_MS, 24 * MS_HOUR);
// STEP3 is +72h from T_HIST, not +48h from STEP2 due.
assert.strictEqual(STEP3_OFFSET_MS - STEP2_OFFSET_MS, 48 * MS_HOUR);

// STEP1 first
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date('2026-09-01T12:00:00Z'),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: { 1: null, 2: null, 3: null },
  });
  assert.strictEqual(d.action, 'materialize');
  assert.strictEqual(d.due_step, 1);
  assert.strictEqual(d.campaign_id, 6);
}

// Waiting for send — created_at must NOT unlock clock
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date('2026-09-10T12:00:00Z'),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'queued', created_at: '2026-09-01T12:00:00Z' },
      2: null,
      3: null,
    },
  });
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.result, HISTORICAL_RESULTS.WAITING_STEP1_SEND);
  assert.strictEqual(d.t_hist, null);
}

// Before +24h → not due
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(t0Ms + 23 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
  });
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.result, HISTORICAL_RESULTS.NOT_DUE);
  assert.strictEqual(d.due_step, null);
}

// At +24h → STEP2
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(t0Ms + 24 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
  });
  assert.strictEqual(d.action, 'materialize');
  assert.strictEqual(d.due_step, 2);
  assert.strictEqual(d.campaign_id, 7);
}

// Past +72h but STEP2 missing → still STEP2 (never skip)
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(t0Ms + 80 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
  });
  assert.strictEqual(d.due_step, 2);
  assert.strictEqual(d.campaign_id, 7);
}

// STEP2 present, +72h → STEP3 from T_HIST not STEP2
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(t0Ms + 72 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: { status: 'sent', sent_at: new Date(t0Ms + 24 * MS_HOUR).toISOString() },
      3: null,
    },
  });
  assert.strictEqual(d.due_step, 3);
  assert.strictEqual(d.campaign_id, 8);
  assert.strictEqual(d.step3_due_at, historicalStep3DueAt(tHist));
}

// Survey stop
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(t0Ms + 80 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: true,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.SEQUENCE_STOPPED_SURVEY);
  assert.strictEqual(d.action, 'skip');
}

// Suppression stop
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(t0Ms + 80 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: true,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.SEQUENCE_STOPPED_SUPPRESSION);
}

// Does not use rejection T0 — old T0 irrelevant when sent_at drives clock
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(t0Ms + 10 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.NOT_DUE);
}

console.log('OK unit-rejected-survey-invite-historical');
