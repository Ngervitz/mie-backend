'use strict';

/**
 * Unit tests: survey sequence display (SCORE state + overlap + legacy pilot bridge).
 * Run: node scripts/unit-rejected-survey-invite-display.js
 */

const assert = require('assert');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
    apifyToken: 'test',
    apifyActorId: 'test',
    sessionSecret: 'test-session',
    cronSecret: null,
    emailPublicBaseUrl: 'https://janus.test',
    rechazadosSurveyInviteStep1CampaignId: '6',
    rechazadosSurveyInviteStep2CampaignId: '7',
    rechazadosSurveyInviteStep3CampaignId: '8',
  },
};

const {
  resolveDisplaySurveyInviteStepCampaigns,
  buildSurveySequenceForCi,
  getHistoricalSurveyInviteStepCampaignIds,
  attachSurveySequenceToListRows,
  SEQUENCE_QUERY_CHUNK,
  SEQUENCE_PAGE_SIZE,
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
 * - episode path: .in('cz_solicitud_id') → .order('id') → .range(from, to)
 * - legacy path ends at .is('cz_solicitud_id', null)
 * - `.range()` slices like PostgREST (inclusive). Omitting it would cap at
 *   SEQUENCE_PAGE_SIZE when simulating the production 1000-row default.
 */
function createDisplaySupabaseMock(opts) {
  const byEpisode = opts.byEpisode || {};
  const byLegacyCi = opts.byLegacyCi || {};
  const calls = opts.calls || { ranges: [], episodeChunks: [] };
  const capWithoutRange =
    opts.capWithoutRange === undefined ? SEQUENCE_PAGE_SIZE : opts.capWithoutRange;
  function rowsForEpisodes(eps) {
    const out = [];
    const list = eps || [];
    for (let i = 0; i < list.length; i += 1) {
      const rows = byEpisode[String(list[i])] || [];
      for (let j = 0; j < rows.length; j += 1) out.push(rows[j]);
    }
    out.sort(function (a, b) {
      return Number(a.id || 0) - Number(b.id || 0);
    });
    return out;
  }
  return {
    from: function () {
      return {
        select: function () {
          const state = {
            episodes: null,
            cis: null,
            nullCz: false,
          };
          function finishLegacy() {
            const out = [];
            const cis = state.cis || [];
            for (let i = 0; i < cis.length; i += 1) {
              const rows = byLegacyCi[String(cis[i])] || [];
              for (let j = 0; j < rows.length; j += 1) out.push(rows[j]);
            }
            return Promise.resolve({ data: out, error: null });
          }
          function finishUnpaged() {
            if (state.nullCz) return finishLegacy();
            const all = rowsForEpisodes(state.episodes);
            return Promise.resolve({
              data: all.slice(0, capWithoutRange),
              error: null,
            });
          }
          const api = {
            in: function (col, vals) {
              if (col === 'cz_solicitud_id') {
                state.episodes = vals;
                calls.episodeChunks.push((vals || []).length);
              }
              if (col === 'ci') state.cis = vals;
              return api;
            },
            eq: function () {
              return api;
            },
            order: function () {
              return api;
            },
            range: function (from, to) {
              calls.ranges.push({
                from: from,
                to: to,
                episodes: state.episodes ? state.episodes.length : 0,
              });
              if (state.nullCz) return finishLegacy();
              const all = rowsForEpisodes(state.episodes);
              return Promise.resolve({
                data: all.slice(from, to + 1),
                error: null,
              });
            },
            is: function (col, val) {
              if (col === 'cz_solicitud_id' && val === null) {
                state.nullCz = true;
              }
              return finishLegacy();
            },
            then: function (onFulfilled, onRejected) {
              return finishUnpaged().then(onFulfilled, onRejected);
            },
            catch: function (onRejected) {
              return finishUnpaged().catch(onRejected);
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

  assert.strictEqual(SEQUENCE_QUERY_CHUNK, 200);
  assert.strictEqual(SEQUENCE_PAGE_SIZE, 1000);

  // 8. PostgREST 1000-row cap: high-id S1 of the 5 identified CIs recovered;
  //    existing S2 / S3 / score in the first page stay unchanged.
  {
    const TARGETS = [
      { ci: 36578633, cz_solicitud_id: 2083 },
      { ci: 42484137, cz_solicitud_id: 2074 },
      { ci: 43599547, cz_solicitud_id: 2081 },
      { ci: 46599108, cz_solicitud_id: 2076 },
      { ci: 52571847, cz_solicitud_id: 2075 },
    ];
    const S2_EP = 9001;
    const S3_EP = 9002;
    const SCORE_EP = 9003;
    const FILLER_COUNT = 192;
    const byEpisode = {};
    const listRows = [];
    let nextId = 1;

    function pushSent(ep, ci, campaignId, sentAt) {
      const key = String(ep);
      if (!byEpisode[key]) byEpisode[key] = [];
      byEpisode[key].push({
        id: nextId,
        ci: String(ci),
        campaign_id: campaignId,
        status: 'sent',
        purpose: 'rechazados_survey_invite',
        sent_at: sentAt,
        cz_solicitud_id: ep,
      });
      nextId += 1;
    }

    pushSent(S2_EP, 10000002, 6, '2026-10-01T00:00:00.000Z');
    pushSent(S2_EP, 10000002, 7, '2026-10-02T00:00:00.000Z');
    pushSent(S3_EP, 10000003, 6, '2026-10-01T00:00:00.000Z');
    pushSent(S3_EP, 10000003, 7, '2026-10-02T00:00:00.000Z');
    pushSent(S3_EP, 10000003, 8, '2026-10-04T00:00:00.000Z');
    pushSent(SCORE_EP, 10000015, 6, '2026-10-01T00:00:00.000Z');
    listRows.push({ ci: 10000002, cz_solicitud_id: S2_EP, score_v2: null });
    listRows.push({ ci: 10000003, cz_solicitud_id: S3_EP, score_v2: null });
    listRows.push({
      ci: 10000015,
      cz_solicitud_id: SCORE_EP,
      score_v2: 15,
    });

    for (let i = 0; i < FILLER_COUNT; i += 1) {
      const ep = 3000 + i;
      const ci = 20000000 + i;
      listRows.push({ ci: ci, cz_solicitud_id: ep, score_v2: null });
      for (let k = 0; k < 6; k += 1) {
        pushSent(ep, ci, 6, '2026-10-10T00:00:00.000Z');
      }
    }
    for (let t = 0; t < TARGETS.length; t += 1) {
      const row = TARGETS[t];
      listRows.push({
        ci: row.ci,
        cz_solicitud_id: row.cz_solicitud_id,
        score_v2: null,
      });
      pushSent(
        row.cz_solicitud_id,
        row.ci,
        6,
        '2026-10-19T15:20:00.000Z',
      );
    }
    for (let i = 0; i < 8; i += 1) {
      const ep = 4000 + i;
      const ci = 30000000 + i;
      listRows.push({ ci: ci, cz_solicitud_id: ep, score_v2: null });
      pushSent(ep, ci, 6, '2026-10-19T16:00:00.000Z');
    }

    let sentTotal = 0;
    Object.keys(byEpisode).forEach(function (k) {
      sentTotal += byEpisode[k].length;
    });
    assert.ok(
      sentTotal > SEQUENCE_PAGE_SIZE,
      '8 fixture must exceed PostgREST 1000-row cap, got ' + sentTotal,
    );
    assert.ok(
      listRows.length > SEQUENCE_QUERY_CHUNK,
      '8 list must span more than one 200-episode chunk',
    );
    TARGETS.forEach(function (row) {
      const recs = byEpisode[String(row.cz_solicitud_id)];
      assert.ok(recs && recs[0] && recs[0].id > SEQUENCE_PAGE_SIZE);
    });

    const calls = { ranges: [], episodeChunks: [] };
    const sb = createDisplaySupabaseMock({ byEpisode: byEpisode, calls: calls });
    const rows = await attachSurveySequenceToListRows(sb, listRows);

    const paged = {};
    rows.forEach(function (r) {
      paged[Number(r.ci)] = r;
    });

    TARGETS.forEach(function (row) {
      const attached = paged[row.ci];
      assert.ok(attached, '8 missing list row for CI ' + row.ci);
      assert.strictEqual(
        H.scoreCell(attached.score_v2, attached.survey_sequence).label,
        'S1',
        '8 CI ' + row.ci + ' must recover S1 past the 1000-row cap',
      );
      assert.ok(attached.survey_sequence.step1_sent_at);
      assert.strictEqual(attached.survey_sequence.step2_sent_at, null);
      assert.strictEqual(attached.survey_sequence.step3_sent_at, null);
    });

    assert.strictEqual(
      H.scoreCell(
        paged[10000002].score_v2,
        paged[10000002].survey_sequence,
      ).label,
      'S2',
      '8 existing S2 must stay S2',
    );
    assert.strictEqual(
      H.scoreCell(
        paged[10000003].score_v2,
        paged[10000003].survey_sequence,
      ).label,
      'Sin respuesta',
      '8 existing S3 must stay Sin respuesta',
    );
    assert.deepStrictEqual(
      H.scoreCell(
        paged[10000015].score_v2,
        paged[10000015].survey_sequence,
      ),
      { kind: 'text', label: '15', tone: 'warn' },
      '8 existing score must beat S1',
    );

    const firstChunkEps = listRows
      .slice(0, SEQUENCE_QUERY_CHUNK)
      .map(function (r) {
        return r.cz_solicitud_id;
      });
    const firstChunkSent = [];
    firstChunkEps.forEach(function (ep) {
      const recs = byEpisode[String(ep)] || [];
      for (let i = 0; i < recs.length; i += 1) firstChunkSent.push(recs[i]);
    });
    firstChunkSent.sort(function (a, b) {
      return Number(a.id) - Number(b.id);
    });
    const truncatedIds = new Set(
      firstChunkSent.slice(0, SEQUENCE_PAGE_SIZE).map(function (r) {
        return Number(r.cz_solicitud_id);
      }),
    );
    TARGETS.forEach(function (row) {
      assert.strictEqual(
        truncatedIds.has(row.cz_solicitud_id),
        false,
        '8 CI ' + row.ci + ' would be truncated without .range() paging',
      );
    });

    assert.ok(
      calls.ranges.length >= 2,
      '8 must issue at least two .range() pages, got ' + calls.ranges.length,
    );
    assert.strictEqual(calls.ranges[0].from, 0);
    assert.strictEqual(calls.ranges[0].to, SEQUENCE_PAGE_SIZE - 1);
    assert.ok(calls.ranges.some(function (r) { return r.from === SEQUENCE_PAGE_SIZE; }));
    assert.ok(
      calls.episodeChunks.every(function (n) {
        return n <= SEQUENCE_QUERY_CHUNK;
      }),
      '8 episode .in() chunks must be ≤ 200',
    );
  }

  console.log('unit-rejected-survey-invite-display: PASS');
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
