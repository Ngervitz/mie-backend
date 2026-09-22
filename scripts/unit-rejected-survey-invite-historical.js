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

// Pre-cutoff catch-up: no auto STEP1 materialize
{
  const d = decideHistoricalSurveyInviteAction({
    now: new Date('2026-09-01T12:00:00Z'),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: { 1: null, 2: null, 3: null },
    allowStep1Materialize: false,
  });
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.result, HISTORICAL_RESULTS.S1_NOT_STARTED);
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

// --- Legacy NULL bridge (historical pilot attempts) ---
const {
  buildHistoricalPilotAttemptsByStep,
  putPreferredAttempt,
} = require('../src/lib/rejectedSurveyInviteHistorical');

function legacyMapsFromRows(episodeRows, legacyRows) {
  const episodeScoped = new Map();
  for (const r of episodeRows || []) {
    putPreferredAttempt(
      episodeScoped,
      String(r.campaign_id) + ':' + String(r.cz_solicitud_id),
      r,
    );
  }
  const legacyNull = new Map();
  for (const r of legacyRows || []) {
    putPreferredAttempt(
      legacyNull,
      String(r.campaign_id) + ':' + String(r.ci),
      r,
    );
  }
  return { episodeScoped, legacyNull };
}

const CI_1154 = 15088043;
const tHist1154 = '2026-09-17T21:25:55.290Z';
const legacyS1_1154 = {
  id: 9,
  campaign_id: 6,
  ci: String(CI_1154),
  status: 'sent',
  sent_at: tHist1154,
  cz_solicitud_id: null,
  created_at: '2026-09-17T21:25:00Z',
};
const legacyS2_1154 = {
  id: 19,
  campaign_id: 7,
  ci: String(CI_1154),
  status: 'sent',
  sent_at: '2026-09-19T14:20:20.032Z',
  cz_solicitud_id: null,
  created_at: '2026-09-19T14:20:00Z',
};

// TEST 1 — historical 1154 legacy bridge → due_step 3 / campaign 8
{
  const maps = legacyMapsFromRows([], [legacyS1_1154, legacyS2_1154]);
  const attempts = buildHistoricalPilotAttemptsByStep({
    episodeId: 1154,
    ci: CI_1154,
    episodeScopedByCampaignEpisode: maps.episodeScoped,
    legacyNullByCiCampaign: maps.legacyNull,
  });
  assert.strictEqual(attempts[1] && attempts[1].id, 9);
  assert.strictEqual(attempts[2] && attempts[2].id, 19);
  assert.strictEqual(attempts[3], null);
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist1154) + 72 * MS_HOUR + 1000),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: attempts,
  });
  assert.strictEqual(d.action, 'materialize');
  assert.strictEqual(d.due_step, 3);
  assert.strictEqual(d.campaign_id, 8);
  assert.notStrictEqual(d.due_step, 1);
}

// TEST 2 — current episode 1357 must NOT inherit legacy NULL
{
  const maps = legacyMapsFromRows([], [legacyS1_1154, legacyS2_1154]);
  const attempts = buildHistoricalPilotAttemptsByStep({
    episodeId: 1357,
    ci: CI_1154,
    episodeScopedByCampaignEpisode: maps.episodeScoped,
    legacyNullByCiCampaign: maps.legacyNull,
  });
  assert.strictEqual(attempts[1], null);
  assert.strictEqual(attempts[2], null);
  assert.strictEqual(attempts[3], null);
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist1154) + 80 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: attempts,
  });
  // No S1 recognized → materialize STEP1 (episode-scoped normal), not STEP3
  assert.strictEqual(d.due_step, 1);
  assert.strictEqual(d.campaign_id, 6);
}

// TEST 3 — all 10 historical CZs with legacy S1/S2 → STEP3
{
  for (let i = 0; i < HISTORICAL_PILOT_CZ_IDS.length; i += 1) {
    const cz = HISTORICAL_PILOT_CZ_IDS[i];
    const ci = 10000000 + cz;
    const sentAt = '2026-09-17T21:26:00.000Z';
    const maps = legacyMapsFromRows(
      [],
      [
        {
          id: 1000 + i,
          campaign_id: 6,
          ci: String(ci),
          status: 'sent',
          sent_at: sentAt,
          cz_solicitud_id: null,
        },
        {
          id: 2000 + i,
          campaign_id: 7,
          ci: String(ci),
          status: 'sent',
          sent_at: '2026-09-19T14:20:00.000Z',
          cz_solicitud_id: null,
        },
      ],
    );
    const attempts = buildHistoricalPilotAttemptsByStep({
      episodeId: cz,
      ci: ci,
      episodeScopedByCampaignEpisode: maps.episodeScoped,
      legacyNullByCiCampaign: maps.legacyNull,
    });
    const d = decideHistoricalSurveyInviteAction({
      now: new Date(Date.parse(sentAt) + 72 * MS_HOUR + 1),
      inCohort: true,
      dataEligible: true,
      hasEncuesta: false,
      isSuppressed: false,
      attemptsByStep: attempts,
    });
    assert.strictEqual(d.due_step, 3, 'cz ' + cz + ' due_step');
    assert.strictEqual(d.campaign_id, 8, 'cz ' + cz + ' campaign');
  }
}

// TEST 4 — lifetime completion blocks STEP3
{
  const maps = legacyMapsFromRows([], [legacyS1_1154, legacyS2_1154]);
  const attempts = buildHistoricalPilotAttemptsByStep({
    episodeId: 1154,
    ci: CI_1154,
    episodeScopedByCampaignEpisode: maps.episodeScoped,
    legacyNullByCiCampaign: maps.legacyNull,
  });
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist1154) + 80 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: true,
    isSuppressed: false,
    attemptsByStep: attempts,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.SEQUENCE_STOPPED_SURVEY);
  assert.strictEqual(d.action, 'skip');
}

// TEST 5 — suppression blocks STEP3
{
  const maps = legacyMapsFromRows([], [legacyS1_1154, legacyS2_1154]);
  const attempts = buildHistoricalPilotAttemptsByStep({
    episodeId: 1154,
    ci: CI_1154,
    episodeScopedByCampaignEpisode: maps.episodeScoped,
    legacyNullByCiCampaign: maps.legacyNull,
  });
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist1154) + 80 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: true,
    attemptsByStep: attempts,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.SEQUENCE_STOPPED_SUPPRESSION);
  assert.strictEqual(d.action, 'skip');
}

// TEST 6 — S3 already present → no duplicate materialize
{
  const s3 = {
    id: 99,
    campaign_id: 8,
    ci: String(CI_1154),
    status: 'queued',
    sent_at: null,
    cz_solicitud_id: 1154,
  };
  const maps = legacyMapsFromRows([s3], [legacyS1_1154, legacyS2_1154]);
  const attempts = buildHistoricalPilotAttemptsByStep({
    episodeId: 1154,
    ci: CI_1154,
    episodeScopedByCampaignEpisode: maps.episodeScoped,
    legacyNullByCiCampaign: maps.legacyNull,
  });
  assert.strictEqual(attempts[3] && attempts[3].id, 99);
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist1154) + 80 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: attempts,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.SEQUENCE_COMPLETE);
  assert.strictEqual(d.action, 'skip');
}

// TEST 7 — timing <72h → STEP3 not due (S1.sent_at only)
{
  const maps = legacyMapsFromRows([], [legacyS1_1154, legacyS2_1154]);
  const attempts = buildHistoricalPilotAttemptsByStep({
    episodeId: 1154,
    ci: CI_1154,
    episodeScopedByCampaignEpisode: maps.episodeScoped,
    legacyNullByCiCampaign: maps.legacyNull,
  });
  const d = decideHistoricalSurveyInviteAction({
    now: new Date(Date.parse(tHist1154) + 71 * MS_HOUR),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: attempts,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.NOT_DUE);
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.t_hist, tHist1154);
}

// TEST 8 — S1 exists but sent_at NULL → waiting_step1_send (no created_at fallback)
{
  const s1Queued = {
    id: 9,
    campaign_id: 6,
    ci: String(CI_1154),
    status: 'queued',
    sent_at: null,
    created_at: '2026-09-01T00:00:00Z',
    cz_solicitud_id: null,
  };
  const maps = legacyMapsFromRows([], [s1Queued]);
  const attempts = buildHistoricalPilotAttemptsByStep({
    episodeId: 1154,
    ci: CI_1154,
    episodeScopedByCampaignEpisode: maps.episodeScoped,
    legacyNullByCiCampaign: maps.legacyNull,
  });
  const d = decideHistoricalSurveyInviteAction({
    now: new Date('2026-09-21T00:00:00Z'),
    inCohort: true,
    dataEligible: true,
    hasEncuesta: false,
    isSuppressed: false,
    attemptsByStep: attempts,
  });
  assert.strictEqual(d.result, HISTORICAL_RESULTS.WAITING_STEP1_SEND);
  assert.strictEqual(d.t_hist, null);
}

// Episode-scoped attempt wins over legacy NULL for same step
{
  const episodeS1 = {
    id: 900,
    campaign_id: 6,
    ci: String(CI_1154),
    status: 'sent',
    sent_at: '2026-09-20T00:00:00Z',
    cz_solicitud_id: 1154,
  };
  const maps = legacyMapsFromRows([episodeS1], [legacyS1_1154, legacyS2_1154]);
  const attempts = buildHistoricalPilotAttemptsByStep({
    episodeId: 1154,
    ci: CI_1154,
    episodeScopedByCampaignEpisode: maps.episodeScoped,
    legacyNullByCiCampaign: maps.legacyNull,
  });
  assert.strictEqual(attempts[1] && attempts[1].id, 900);
  assert.strictEqual(attempts[2] && attempts[2].id, 19);
}

console.log('OK unit-rejected-survey-invite-historical');
