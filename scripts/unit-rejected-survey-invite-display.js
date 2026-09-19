'use strict';

/**
 * Unit tests: survey sequence display (SCORE state + overlap).
 * Run: node scripts/unit-rejected-survey-invite-display.js
 */

const assert = require('assert');
const {
  resolveDisplaySurveyInviteStepCampaigns,
  buildSurveySequenceForCi,
  getHistoricalSurveyInviteStepCampaignIds,
} = require('../src/lib/rejectedSurveyInviteDisplay');
const H = require('../public/rechazados-helpers');

const HIST = getHistoricalSurveyInviteStepCampaignIds();
assert.deepStrictEqual(HIST, { 1: '6', 2: '7', 3: '8' });

// Historical visible with normal envs unset
const resUnset = resolveDisplaySurveyInviteStepCampaigns({
  normalStepCampaignIds: { 1: null, 2: null, 3: null },
  historicalStepCampaignIds: HIST,
});
assert.deepStrictEqual(resUnset.uniqueCampaignIds.sort(), ['6', '7', '8']);
assert.strictEqual(resUnset.sameCampaignUniverse, true);

// Normal configured + hist; dedupe shared id
const resMixed = resolveDisplaySurveyInviteStepCampaigns({
  normalStepCampaignIds: { 1: '9', 2: '10', 3: '11' },
  historicalStepCampaignIds: HIST,
});
assert.strictEqual(resMixed.sameCampaignUniverse, false);
assert.strictEqual(resMixed.uniqueCampaignIds.length, 6);

const resDedupe = resolveDisplaySurveyInviteStepCampaigns({
  normalStepCampaignIds: { 1: '6', 2: '7', 3: '8' },
  historicalStepCampaignIds: HIST,
});
assert.strictEqual(resDedupe.uniqueCampaignIds.length, 3);
assert.strictEqual(resDedupe.sameCampaignUniverse, true);

function seq(rows, resolution) {
  return buildSurveySequenceForCi(rows, resolution);
}

// no sent → nulls
assert.deepStrictEqual(seq([], resUnset), {
  step1_sent_at: null,
  step2_sent_at: null,
  step3_sent_at: null,
  sources_overlap: false,
});

// STEP1 only
assert.deepStrictEqual(
  seq(
    [{ campaign_id: 6, sent_at: '2026-09-17T21:00:00.000Z' }],
    resUnset,
  ),
  {
    step1_sent_at: '2026-09-17T21:00:00.000Z',
    step2_sent_at: null,
    step3_sent_at: null,
    sources_overlap: false,
  },
);

// STEP2
assert.strictEqual(
  seq(
    [
      { campaign_id: 6, sent_at: '2026-09-17T21:00:00.000Z' },
      { campaign_id: 7, sent_at: '2026-09-19T14:00:00.000Z' },
    ],
    resUnset,
  ).step2_sent_at,
  '2026-09-19T14:00:00.000Z',
);

// STEP3
assert.ok(
  seq(
    [
      { campaign_id: 6, sent_at: 'a' },
      { campaign_id: 7, sent_at: 'b' },
      { campaign_id: 8, sent_at: 'c' },
    ],
    resUnset,
  ).step3_sent_at,
);

// OVERLAP 1: hist STEP1 + normal STEP2 → visual STEP2 + overlap
const overlap1 = seq(
  [
    { campaign_id: 6, sent_at: '2026-09-17T21:00:00.000Z' },
    { campaign_id: 10, sent_at: '2026-09-19T14:00:00.000Z' },
  ],
  resMixed,
);
assert.strictEqual(overlap1.step1_sent_at, '2026-09-17T21:00:00.000Z');
assert.strictEqual(overlap1.step2_sent_at, '2026-09-19T14:00:00.000Z');
assert.strictEqual(overlap1.sources_overlap, true);

// OVERLAP 2: hist STEP2 + normal STEP1 → visual STEP2 + overlap
const overlap2 = seq(
  [
    { campaign_id: 7, sent_at: '2026-09-19T14:00:00.000Z' },
    { campaign_id: 9, sent_at: '2026-09-18T10:00:00.000Z' },
  ],
  resMixed,
);
assert.strictEqual(overlap2.step1_sent_at, '2026-09-18T10:00:00.000Z');
assert.strictEqual(overlap2.step2_sent_at, '2026-09-19T14:00:00.000Z');
assert.strictEqual(overlap2.sources_overlap, true);

// Same universe: no overlap flag even with hist+norm same ids
assert.strictEqual(
  seq(
    [
      { campaign_id: 6, sent_at: 'a' },
      { campaign_id: 7, sent_at: 'b' },
    ],
    resDedupe,
  ).sources_overlap,
  false,
);

// --- Frontend state machine ---
assert.deepStrictEqual(H.scoreCell(0), {
  kind: 'text',
  label: '0',
  tone: 'danger',
});
assert.deepStrictEqual(H.scoreCell(26), {
  kind: 'text',
  label: '26',
  tone: 'success',
});
assert.deepStrictEqual(H.scoreCell(null), {
  kind: 'clock',
  title: 'Encuesta programada',
});
assert.deepStrictEqual(
  H.scoreCell(null, { step1_sent_at: 't1' }),
  { kind: 'badge', label: 'STEP 1', badgeClass: 'is-survey-step' },
);
assert.deepStrictEqual(
  H.scoreCell(null, { step1_sent_at: 't1', step2_sent_at: 't2' }),
  { kind: 'badge', label: 'STEP 2', badgeClass: 'is-survey-step' },
);
assert.deepStrictEqual(
  H.scoreCell(null, {
    step1_sent_at: 't1',
    step2_sent_at: 't2',
    step3_sent_at: 't3',
  }),
  { kind: 'badge', label: 'Sin respuesta', badgeClass: 'is-survey-no-reply' },
);
// score beats any STEP
assert.deepStrictEqual(
  H.scoreCell(12, {
    step1_sent_at: 't1',
    step2_sent_at: 't2',
    step3_sent_at: 't3',
  }),
  { kind: 'text', label: '12', tone: 'warn' },
);
// STEP3 > STEP2 > STEP1 already covered; queued/failed not in sentRows by construction

console.log('unit-rejected-survey-invite-display: PASS');
