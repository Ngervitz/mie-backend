'use strict';
/**
 * Pre-cutoff catch-up cohort (112) — unit tests.
 * node scripts/unit-rejected-survey-invite-pre-cutoff-catchup.js
 */

const assert = require('assert');

const {
  buildSurveyInviteIdempotencyKey,
} = require('../src/lib/rejectedSurveyInvite');
const {
  HISTORICAL_RESULTS,
  HISTORICAL_PILOT_STEP_CAMPAIGN_IDS,
  decideHistoricalSurveyInviteAction,
  isAuthorizedPilotCzId,
  putPreferredAttempt,
  buildHistoricalPilotAttemptsByStep,
  resolveHistoricalTHist,
  historicalStep2DueAt,
  historicalStep3DueAt,
  MS_HOUR,
  STEP3_OFFSET_MS,
} = require('../src/lib/rejectedSurveyInviteHistorical');
const {
  PRE_CUTOFF_CATCHUP_CZ_IDS,
  isAuthorizedPreCutoffCatchupCzId,
} = require('../src/lib/rejectedSurveyInvitePreCutoffCatchupIds');

const CATCHUP_CZ = 1365;
const CI_CATCHUP = 42424242;
const tHist = '2026-09-22T01:00:00.000Z';

assert.strictEqual(PRE_CUTOFF_CATCHUP_CZ_IDS.length, 112);
assert.strictEqual(isAuthorizedPreCutoffCatchupCzId(1357), false);
assert.strictEqual(isAuthorizedPreCutoffCatchupCzId(CATCHUP_CZ), true);
assert.strictEqual(isAuthorizedPreCutoffCatchupCzId(1153), false);
assert.strictEqual(isAuthorizedPilotCzId(1153), true);

// 1 — no S1, catch-up runner → S1_NOT_STARTED (not incorrect S2)
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: { 1: null, 2: null, 3: null },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.S1_NOT_STARTED);
  assert.strictEqual(d.due_step, null);
}

// 2 — S1 queued, sent_at NULL → WAITING_STEP1_SEND
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date('2026-09-25T00:00:00Z'),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: {
        status: 'queued',
        sent_at: null,
        created_at: '2026-09-22T00:00:00Z',
      },
      2: null,
      3: null,
    },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.WAITING_STEP1_SEND);
}

// 3 — S1 sent <24h → no S2
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist) + 23 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.NOT_DUE);
}

// 4 — S1 sent >=24h → due STEP2
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist) + 24 * MS_HOUR + 1),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.action, 'materialize');
  assert.strictEqual(d.due_step, 2);
  assert.strictEqual(d.campaign_id, HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[2]);
  assert.strictEqual(d.t_hist, tHist);
}

// 5 — completion blocks S2
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist) + 30 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: true,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.SEQUENCE_STOPPED_SURVEY);
}

// 6 — suppression blocks S2
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist) + 30 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: true,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: null,
      3: null,
    },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.SEQUENCE_STOPPED_SUPPRESSION);
}

// 7 — S1+S2 sent, T_HIST <72h → no S3
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist) + 71 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: { status: 'sent', sent_at: historicalStep2DueAt(tHist) },
      3: null,
    },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.NOT_DUE);
}

// 8 — S1+S2 sent, T_HIST >=72h → due STEP3
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist) + 72 * MS_HOUR + 1),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: { status: 'sent', sent_at: historicalStep2DueAt(tHist) },
      3: null,
    },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.action, 'materialize');
  assert.strictEqual(d.due_step, 3);
  assert.strictEqual(d.campaign_id, HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[3]);
}

// 9 — S3 due from T_HIST+72h, not S2.sent_at+48h
{
  const s2SentLate = '2026-09-25T12:00:00.000Z';
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist) + 73 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: { status: 'sent', sent_at: s2SentLate },
      3: null,
    },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.step3_due_at, historicalStep3DueAt(tHist));
  assert.notStrictEqual(
    d.step3_due_at,
    new Date(Date.parse(s2SentLate) + 48 * MS_HOUR).toISOString(),
  );
  assert.strictEqual(d.action, 'materialize');
  assert.strictEqual(d.due_step, 3);
}

// 10 — idempotency keys unique per cz
{
  const k1 = buildSurveyInviteIdempotencyKey(6, CATCHUP_CZ);
  const k2 = buildSurveyInviteIdempotencyKey(6, CATCHUP_CZ + 1);
  assert.notStrictEqual(k1, k2);
  assert.strictEqual(
    k1,
    'rechazados_survey_invite:campaign:6:cz:' + CATCHUP_CZ,
  );
}

// 11 — idempotent decision when S3 already present
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist) + 80 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: {
      1: { status: 'sent', sent_at: tHist },
      2: { status: 'sent', sent_at: historicalStep2DueAt(tHist) },
      3: { status: 'queued', sent_at: null },
    },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.SEQUENCE_COMPLETE);
}

// 12 — cz1357 not in cohort (already above)

// 13 — pilot default still materializes STEP1
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: { 1: null, 2: null, 3: null },
  });
  assert.strictEqual(d.due_step, 1);
  assert.strictEqual(d.action, 'materialize');
}

// 14 — legacy NULL bridge NOT applied to catch-up cz
{
  const legacyMap = new Map();
  putPreferredAttempt(legacyMap, '6:' + CI_CATCHUP, {
    id: 999,
    campaign_id: 6,
    ci: String(CI_CATCHUP),
    status: 'sent',
    sent_at: '2026-01-01T00:00:00Z',
    cz_solicitud_id: null,
  });
  const attempts = buildHistoricalPilotAttemptsByStep({
    episodeId: CATCHUP_CZ,
    ci: CI_CATCHUP,
    episodeScopedByCampaignEpisode: new Map(),
    legacyNullByCiCampaign: legacyMap,
  });
  assert.strictEqual(attempts[1], null);
  const pilotLegacy = new Map();
  putPreferredAttempt(pilotLegacy, '6:15088043', {
    id: 999,
    campaign_id: 6,
    ci: '15088043',
    status: 'sent',
    sent_at: '2026-01-01T00:00:00Z',
    cz_solicitud_id: null,
  });
  const pilotAttempts = buildHistoricalPilotAttemptsByStep({
    episodeId: 1154,
    ci: 15088043,
    episodeScopedByCampaignEpisode: new Map(),
    legacyNullByCiCampaign: pilotLegacy,
  });
  assert.strictEqual(pilotAttempts[1] && pilotAttempts[1].id, 999);
}

// Hypothetical clock X → S2/S3 due (continuity contract)
{
  const x = tHist;
  assert.strictEqual(resolveHistoricalTHist({ sent_at: x }), x);
  assert.strictEqual(
    historicalStep2DueAt(x),
    new Date(Date.parse(x) + 24 * MS_HOUR).toISOString(),
  );
  assert.strictEqual(
    historicalStep3DueAt(x),
    new Date(Date.parse(x) + STEP3_OFFSET_MS).toISOString(),
  );
}

console.log('OK unit-rejected-survey-invite-pre-cutoff-catchup');
