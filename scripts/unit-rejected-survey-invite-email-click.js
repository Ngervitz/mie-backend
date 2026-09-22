'use strict';

/**
 * Unit tests: CI-lifetime survey email click signal + SCORE ✉ glyph.
 * Run: node scripts/unit-rejected-survey-invite-email-click.js
 */

const assert = require('assert');
const {
  PURPOSE,
  buildSurveyEmailClickedCiSet,
  attachSurveyEmailClickedToListRows,
} = require('../src/lib/rejectedSurveyInviteDisplay');
const H = require('../public/rechazados-helpers');

assert.strictEqual(PURPOSE, 'rechazados_survey_invite');

const TIP = 'Hubo un clic desde un email de encuesta';

// 1. score=15 + no click → no glyph fields
assert.deepStrictEqual(H.scoreCell(15, null, false), {
  kind: 'text',
  label: '15',
  tone: 'warn',
});
assert.strictEqual(H.scoreCell(15).emailClicked, undefined);

// 2. score=15 + click → glyph metadata
assert.deepStrictEqual(H.scoreCell(15, null, true), {
  kind: 'text',
  label: '15',
  tone: 'warn',
  emailClicked: true,
  emailClickedTitle: TIP,
});

// 3. S1 + click → keeps S1, adds glyph
assert.deepStrictEqual(
  H.scoreCell(null, { step1_sent_at: 't1' }, true),
  {
    kind: 'badge',
    label: 'S1',
    badgeClass: 'is-survey-step',
    emailClicked: true,
    emailClickedTitle: TIP,
  },
);

// S2 / Sin respuesta / clock with click
assert.strictEqual(
  H.scoreCell(null, { step1_sent_at: 'a', step2_sent_at: 'b' }, true).label,
  'S2',
);
assert.strictEqual(
  H.scoreCell(null, { step1_sent_at: 'a', step2_sent_at: 'b' }, true)
    .emailClicked,
  true,
);
// Sin respuesta + click → NO glyph (UI exception)
assert.deepStrictEqual(
  H.scoreCell(
    null,
    { step1_sent_at: 'a', step2_sent_at: 'b', step3_sent_at: 'c' },
    true,
  ),
  {
    kind: 'badge',
    label: 'Sin respuesta',
    badgeClass: 'is-survey-no-reply',
  },
);
assert.strictEqual(
  H.scoreCell(
    null,
    { step1_sent_at: 'a', step2_sent_at: 'b', step3_sent_at: 'c' },
    true,
  ).emailClicked,
  undefined,
);
assert.strictEqual(H.scoreCell(null, null, true).kind, 'clock');
assert.strictEqual(H.scoreCell(null, null, true).emailClicked, true);

// Numeric / S1 / S2 keep glyph with click
assert.strictEqual(H.scoreCell(15, null, true).emailClicked, true);
assert.strictEqual(
  H.scoreCell(null, { step1_sent_at: 't1' }, true).emailClicked,
  true,
);
assert.strictEqual(
  H.scoreCell(null, { step1_sent_at: 'a', step2_sent_at: 'b' }, true)
    .emailClicked,
  true,
);

// 6. multiple raw clicks → single boolean glyph (set has one CI)
{
  const set = buildSurveyEmailClickedCiSet(
    [
      { ci: '10768808', marketing_impact_id: 'imp-a' },
      { ci: '10768808', marketing_impact_id: 'imp-b' },
      { ci: '10768808', marketing_impact_id: 'imp-c' },
    ],
    [
      { id: 'imp-a', channel: 'email' },
      { id: 'imp-b', channel: 'email' },
      { id: 'imp-c', channel: 'email' },
    ],
    [
      { impact_id: 'imp-a', event_name: 'click' },
      { impact_id: 'imp-b', event_name: 'click' },
      { impact_id: 'imp-c', event_name: 'click' },
    ],
  );
  assert.strictEqual(set.size, 1);
  assert.ok(set.has('10768808'));
}

// 4. other purpose-equivalent: impact without email channel → no click
{
  const set = buildSurveyEmailClickedCiSet(
    [{ ci: '1', marketing_impact_id: 'sms-1' }],
    [{ id: 'sms-1', channel: 'sms' }],
    [{ impact_id: 'sms-1', event_name: 'click' }],
  );
  assert.strictEqual(set.size, 0);
}

// 5. survey recipient but no click events → no glyph
{
  const set = buildSurveyEmailClickedCiSet(
    [{ ci: '2', marketing_impact_id: 'imp-x' }],
    [{ id: 'imp-x', channel: 'email' }],
    [],
  );
  assert.strictEqual(set.size, 0);
}

// non-click event name ignored
{
  const set = buildSurveyEmailClickedCiSet(
    [{ ci: '3', marketing_impact_id: 'imp-y' }],
    [{ id: 'imp-y', channel: 'email' }],
    [{ impact_id: 'imp-y', event_name: 'open' }],
  );
  assert.strictEqual(set.size, 0);
}

// 7. legacy recipient (cz NULL irrelevant at this layer) + click → CI lifetime
{
  const set = buildSurveyEmailClickedCiSet(
    [{ ci: '10768808', marketing_impact_id: 'legacy-imp' }],
    [{ id: 'legacy-imp', channel: 'email' }],
    [{ impact_id: 'legacy-imp', event_name: 'click' }],
  );
  assert.ok(set.has('10768808'));
}

// 8. current episode different; historical click on same CI → glyph
{
  const set = buildSurveyEmailClickedCiSet(
    [
      { ci: '10768808', marketing_impact_id: 'old-camp9' },
      { ci: '10768808', marketing_impact_id: 'new-camp6' },
    ],
    [
      { id: 'old-camp9', channel: 'email' },
      { id: 'new-camp6', channel: 'email' },
    ],
    [{ impact_id: 'old-camp9', event_name: 'click' }],
  );
  assert.ok(set.has('10768808'));
}

// 9. CI10768808 fixture equivalent
{
  const set = buildSurveyEmailClickedCiSet(
    [
      { ci: '10768808', marketing_impact_id: '757a6e23' },
      { ci: '10768808', marketing_impact_id: 'c5734880' },
      { ci: '10768808', marketing_impact_id: '76022f46' },
    ],
    [
      { id: '757a6e23', channel: 'email' },
      { id: 'c5734880', channel: 'email' },
      { id: '76022f46', channel: 'email' },
    ],
    [
      { impact_id: '757a6e23', event_name: 'click' },
      { impact_id: 'c5734880', event_name: 'click' },
      { impact_id: '76022f46', event_name: 'click' },
    ],
  );
  assert.ok(set.has('10768808'));
  const cell = H.scoreCell(15, { step1_sent_at: '2026-09-22T02:05:05Z' }, true);
  assert.strictEqual(cell.label, '15');
  assert.strictEqual(cell.emailClicked, true);
  assert.strictEqual(cell.emailClickedTitle, TIP);
}

/**
 * Mock supabase: counts table hits. Not N+1 per row.
 * from(table).select().eq().in().not() / .in().eq()
 */
function createClickSupabaseMock(opts) {
  const recipientsByCi = opts.recipientsByCi || {};
  const impactsById = opts.impactsById || {};
  const clicksByImpact = opts.clicksByImpact || {};
  const counters = { fromCalls: 0, byTable: {} };

  function chain(table) {
    counters.fromCalls += 1;
    counters.byTable[table] = (counters.byTable[table] || 0) + 1;
    const state = { cis: null, impactIds: null };

    function finish() {
      if (table === 'email_campaign_recipients') {
        const out = [];
        for (const ci of state.cis || []) {
          const rows = recipientsByCi[String(ci)] || [];
          for (let i = 0; i < rows.length; i += 1) out.push(rows[i]);
        }
        return { data: out, error: null };
      }
      if (table === 'marketing_impacts') {
        const out = [];
        for (const id of state.impactIds || []) {
          const row = impactsById[String(id)];
          if (row) out.push(row);
        }
        return { data: out, error: null };
      }
      if (table === 'marketing_impact_events') {
        const out = [];
        for (const id of state.impactIds || []) {
          const n = clicksByImpact[String(id)] || 0;
          for (let i = 0; i < n; i += 1) {
            out.push({ impact_id: id, event_name: 'click' });
          }
        }
        return { data: out, error: null };
      }
      return { data: [], error: null };
    }

    const api = {
      select: function () {
        return api;
      },
      eq: function (col) {
        if (col === 'event_name') {
          return Promise.resolve(finish());
        }
        return api;
      },
      in: function (col, vals) {
        if (col === 'ci') state.cis = vals;
        if (col === 'id' || col === 'impact_id') state.impactIds = vals;
        if (table === 'marketing_impacts') {
          return Promise.resolve(finish());
        }
        return api;
      },
      not: function () {
        return Promise.resolve(finish());
      },
    };

    return api;
  }

  return {
    from: function (table) {
      return chain(table);
    },
    counters: counters,
  };
}

(async function main() {
  // attach: other CI without click stays false
  const mock = createClickSupabaseMock({
    recipientsByCi: {
      '10768808': [
        { ci: '10768808', marketing_impact_id: 'imp-1' },
        { ci: '10768808', marketing_impact_id: 'imp-2' },
      ],
      '999': [{ ci: '999', marketing_impact_id: 'imp-other' }],
      '888': [{ ci: '888', marketing_impact_id: 'imp-sms' }],
    },
    impactsById: {
      'imp-1': { id: 'imp-1', channel: 'email' },
      'imp-2': { id: 'imp-2', channel: 'email' },
      'imp-other': { id: 'imp-other', channel: 'email' },
      'imp-sms': { id: 'imp-sms', channel: 'sms' },
    },
    clicksByImpact: {
      'imp-1': 2,
      'imp-2': 1,
      'imp-other': 0,
      'imp-sms': 5,
    },
  });

  const rows = [
    { ci: 10768808, cz_solicitud_id: 1195, score_v2: 15 },
    { ci: 999, cz_solicitud_id: 1, score_v2: null },
    { ci: 888, cz_solicitud_id: 2, score_v2: 10 },
    { ci: 777, cz_solicitud_id: 3, score_v2: 20 },
  ];

  const out = await attachSurveyEmailClickedToListRows(mock, rows);
  assert.strictEqual(out[0].survey_email_clicked, true);
  assert.strictEqual(out[1].survey_email_clicked, false);
  assert.strictEqual(out[2].survey_email_clicked, false); // sms channel
  assert.strictEqual(out[3].survey_email_clicked, false); // no recipients

  // 10. N+1: query count bounded vs row count (3 tables, not per row)
  assert.ok(
    mock.counters.fromCalls <= 6,
    'expected few batch queries, got ' + mock.counters.fromCalls,
  );
  assert.strictEqual(mock.counters.byTable.email_campaign_recipients, 1);
  assert.ok(mock.counters.byTable.marketing_impacts >= 1);
  assert.ok(mock.counters.byTable.marketing_impact_events >= 1);

  // Scale: 50 rows same CI set still few queries
  const mock2 = createClickSupabaseMock({
    recipientsByCi: {
      A: [{ ci: 'A', marketing_impact_id: 'i1' }],
    },
    impactsById: { i1: { id: 'i1', channel: 'email' } },
    clicksByImpact: { i1: 1 },
  });
  const many = [];
  for (let i = 0; i < 50; i += 1) {
    many.push({ ci: 'A', cz_solicitud_id: 1000 + i });
  }
  const outMany = await attachSurveyEmailClickedToListRows(mock2, many);
  assert.strictEqual(outMany.length, 50);
  assert.ok(outMany.every(function (r) {
    return r.survey_email_clicked === true;
  }));
  assert.ok(
    mock2.counters.fromCalls <= 6,
    '50 rows must not N+1; got ' + mock2.counters.fromCalls,
  );

  console.log('OK unit-rejected-survey-invite-email-click');
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
