'use strict';

/**
 * Unit tests: survey sequence display (SCORE state + overlap + legacy pilot bridge).
 * Run: node scripts/unit-rejected-survey-invite-display.js
 */

const assert = require('assert');
const {
  resolveDisplaySurveyInviteStepCampaigns,
  buildSurveySequenceForCi,
  getHistoricalSurveyInviteStepCampaignIds,
  attachSurveySequenceToListRows,
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
  { kind: 'badge', label: 'S1', badgeClass: 'is-survey-step' },
);
assert.deepStrictEqual(
  H.scoreCell(null, { step1_sent_at: 't1', step2_sent_at: 't2' }),
  { kind: 'badge', label: 'S2', badgeClass: 'is-survey-step' },
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

/**
 * Mock supabase for attachSurveySequenceToListRows:
 * - episode path ends at .in('cz_solicitud_id', ...)
 * - legacy path ends at .is('cz_solicitud_id', null)
 */
function createDisplaySupabaseMock(opts) {
  const byEpisode = opts.byEpisode || {};
  const byLegacyCi = opts.byLegacyCi || {};
  return {
    from: function () {
      return {
        select: function () {
          const state = {
            episodes: null,
            cis: null,
            nullCz: false,
          };
          function finish() {
            if (state.nullCz) {
              const out = [];
              const cis = state.cis || [];
              for (let i = 0; i < cis.length; i += 1) {
                const rows = byLegacyCi[String(cis[i])] || [];
                for (let j = 0; j < rows.length; j += 1) out.push(rows[j]);
              }
              return Promise.resolve({ data: out, error: null });
            }
            const out = [];
            const eps = state.episodes || [];
            for (let i = 0; i < eps.length; i += 1) {
              const rows = byEpisode[String(eps[i])] || [];
              for (let j = 0; j < rows.length; j += 1) out.push(rows[j]);
            }
            return Promise.resolve({ data: out, error: null });
          }
          const api = {
            in: function (col, vals) {
              if (col === 'cz_solicitud_id') state.episodes = vals;
              if (col === 'ci') state.cis = vals;
              return api;
            },
            eq: function () {
              return api;
            },
            is: function (col, val) {
              if (col === 'cz_solicitud_id' && val === null) {
                state.nullCz = true;
              }
              return finish();
            },
            then: function (onFulfilled, onRejected) {
              return finish().then(onFulfilled, onRejected);
            },
            catch: function (onRejected) {
              return finish().catch(onRejected);
            },
          };
          return api;
        },
      };
    },
  };
}

(async function legacyBridgeTests() {
  const CI_1153 = '22000022';
  const CI_1154 = '15088043';
  const CI_OTHER = '99999999';

  // 1. PILOTO HISTÓRICO: cz 1153 + legacy S1/S2 NULL → S2
  {
    const sb = createDisplaySupabaseMock({
      byEpisode: {},
      byLegacyCi: {
        [CI_1153]: [
          {
            ci: CI_1153,
            campaign_id: 6,
            status: 'sent',
            sent_at: '2026-09-17T21:00:00.000Z',
            cz_solicitud_id: null,
          },
          {
            ci: CI_1153,
            campaign_id: 7,
            status: 'sent',
            sent_at: '2026-09-19T14:00:00.000Z',
            cz_solicitud_id: null,
          },
        ],
      },
    });
    const rows = await attachSurveySequenceToListRows(sb, [
      { ci: CI_1153, cz_solicitud_id: 1153, score_v2: null },
    ]);
    const cell = H.scoreCell(null, rows[0].survey_sequence);
    assert.strictEqual(cell.label, 'S2', '1 piloto histórico → S2');
    assert.ok(rows[0].survey_sequence.step2_sent_at);
  }

  // 2. PILOTO CON STEP3 → Sin respuesta
  {
    const sb = createDisplaySupabaseMock({
      byEpisode: {},
      byLegacyCi: {
        [CI_1153]: [
          {
            ci: CI_1153,
            campaign_id: 6,
            status: 'sent',
            sent_at: 't1',
            cz_solicitud_id: null,
          },
          {
            ci: CI_1153,
            campaign_id: 7,
            status: 'sent',
            sent_at: 't2',
            cz_solicitud_id: null,
          },
          {
            ci: CI_1153,
            campaign_id: 8,
            status: 'sent',
            sent_at: 't3',
            cz_solicitud_id: null,
          },
        ],
      },
    });
    const rows = await attachSurveySequenceToListRows(sb, [
      { ci: CI_1153, cz_solicitud_id: 1153 },
    ]);
    assert.strictEqual(
      H.scoreCell(null, rows[0].survey_sequence).label,
      'Sin respuesta',
      '2 piloto STEP3 → Sin respuesta',
    );
  }

  // 3. SCORE TIENE PRIORIDAD
  {
    const sb = createDisplaySupabaseMock({
      byEpisode: {},
      byLegacyCi: {
        [CI_1153]: [
          {
            ci: CI_1153,
            campaign_id: 6,
            status: 'sent',
            sent_at: 't1',
            cz_solicitud_id: null,
          },
          {
            ci: CI_1153,
            campaign_id: 7,
            status: 'sent',
            sent_at: 't2',
            cz_solicitud_id: null,
          },
        ],
      },
    });
    const rows = await attachSurveySequenceToListRows(sb, [
      { ci: CI_1153, cz_solicitud_id: 1153, score_v2: 18 },
    ]);
    assert.strictEqual(
      H.scoreCell(18, rows[0].survey_sequence).label,
      '18',
      '3 score beats legacy steps',
    );
  }

  // 4. CROSS-EPISODE: cz 1357 must NOT inherit legacy NULL from CI of 1154
  {
    const sb = createDisplaySupabaseMock({
      byEpisode: {},
      byLegacyCi: {
        [CI_1154]: [
          {
            ci: CI_1154,
            campaign_id: 6,
            status: 'sent',
            sent_at: 't1',
            cz_solicitud_id: null,
          },
          {
            ci: CI_1154,
            campaign_id: 7,
            status: 'sent',
            sent_at: 't2',
            cz_solicitud_id: null,
          },
        ],
      },
    });
    const rows = await attachSurveySequenceToListRows(sb, [
      { ci: CI_1154, cz_solicitud_id: 1357 },
    ]);
    const seq1357 = rows[0].survey_sequence;
    assert.strictEqual(seq1357.step1_sent_at, null);
    assert.strictEqual(seq1357.step2_sent_at, null);
    assert.strictEqual(
      H.scoreCell(null, seq1357).kind,
      'clock',
      '4 cz 1357 → reloj (no legacy contamination)',
    );
  }

  // 5. EPISODIO NORMAL: own cz_solicitud_id STEP1 → S1
  {
    const sb = createDisplaySupabaseMock({
      byEpisode: {
        1357: [
          {
            ci: CI_1154,
            campaign_id: 6,
            status: 'sent',
            sent_at: '2026-09-20T12:00:00.000Z',
            cz_solicitud_id: 1357,
          },
        ],
      },
      byLegacyCi: {
        [CI_1154]: [
          {
            ci: CI_1154,
            campaign_id: 7,
            status: 'sent',
            sent_at: 'legacy-s2',
            cz_solicitud_id: null,
          },
        ],
      },
    });
    const rows = await attachSurveySequenceToListRows(sb, [
      { ci: CI_1154, cz_solicitud_id: 1357 },
    ]);
    assert.strictEqual(
      H.scoreCell(null, rows[0].survey_sequence).label,
      'S1',
      '5 normal episode own STEP1 → S1',
    );
    assert.strictEqual(
      rows[0].survey_sequence.step2_sent_at,
      null,
      '5 must not pick legacy STEP2',
    );
  }

  // 6. CI NO PERTENECIENTE AL PILOTO: legacy NULL accidental ignored
  {
    const sb = createDisplaySupabaseMock({
      byEpisode: {},
      byLegacyCi: {
        [CI_OTHER]: [
          {
            ci: CI_OTHER,
            campaign_id: 6,
            status: 'sent',
            sent_at: 't1',
            cz_solicitud_id: null,
          },
          {
            ci: CI_OTHER,
            campaign_id: 7,
            status: 'sent',
            sent_at: 't2',
            cz_solicitud_id: null,
          },
        ],
      },
    });
    const rows = await attachSurveySequenceToListRows(sb, [
      { ci: CI_OTHER, cz_solicitud_id: 9999 },
    ]);
    assert.strictEqual(
      H.scoreCell(null, rows[0].survey_sequence).kind,
      'clock',
      '6 non-pilot CI legacy NULL ignored',
    );
  }

  // 7. NORMAL EPISODE + LEGACY: show only current episode attempts
  {
    const sb = createDisplaySupabaseMock({
      byEpisode: {
        1357: [
          {
            ci: CI_1154,
            campaign_id: 6,
            status: 'sent',
            sent_at: 'new-s1',
            cz_solicitud_id: 1357,
          },
          {
            ci: CI_1154,
            campaign_id: 7,
            status: 'sent',
            sent_at: 'new-s2',
            cz_solicitud_id: 1357,
          },
        ],
      },
      byLegacyCi: {
        [CI_1154]: [
          {
            ci: CI_1154,
            campaign_id: 8,
            status: 'sent',
            sent_at: 'legacy-s3',
            cz_solicitud_id: null,
          },
        ],
      },
    });
    const rows = await attachSurveySequenceToListRows(sb, [
      { ci: CI_1154, cz_solicitud_id: 1357 },
    ]);
    assert.strictEqual(rows[0].survey_sequence.step1_sent_at, 'new-s1');
    assert.strictEqual(rows[0].survey_sequence.step2_sent_at, 'new-s2');
    assert.strictEqual(
      rows[0].survey_sequence.step3_sent_at,
      null,
      '7 must not inherit legacy STEP3 on new episode',
    );
    assert.strictEqual(
      H.scoreCell(null, rows[0].survey_sequence).label,
      'S2',
    );
  }

  // Bonus: historical row 1154 still gets legacy S2 when that episode is shown
  {
    const sb = createDisplaySupabaseMock({
      byEpisode: {},
      byLegacyCi: {
        [CI_1154]: [
          {
            ci: CI_1154,
            campaign_id: 6,
            status: 'sent',
            sent_at: 't1',
            cz_solicitud_id: null,
          },
          {
            ci: CI_1154,
            campaign_id: 7,
            status: 'sent',
            sent_at: 't2',
            cz_solicitud_id: null,
          },
        ],
      },
    });
    const rows = await attachSurveySequenceToListRows(sb, [
      { ci: CI_1154, cz_solicitud_id: 1154 },
      { ci: CI_1154, cz_solicitud_id: 1357 },
    ]);
    assert.strictEqual(
      H.scoreCell(null, rows[0].survey_sequence).label,
      'S2',
      'bonus 1154 historical → S2',
    );
    assert.strictEqual(
      H.scoreCell(null, rows[1].survey_sequence).kind,
      'clock',
      'bonus 1357 sibling → clock',
    );
  }

  console.log('unit-rejected-survey-invite-display: PASS');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
