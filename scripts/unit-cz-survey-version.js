'use strict';

/**
 * node scripts/unit-cz-survey-version.js
 * JANUS-P7-V2-01: Credizona V1/V2 survey interpretation, Mi Plan handoff
 * survey block (flag on/off), fail-closed inconsistencies and version-aware
 * reporting. No network, no DB.
 */

const assert = require('assert');
const path = require('path');

for (const [k, v] of Object.entries({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  APIFY_TOKEN: 'test',
  APIFY_ACTOR_ID: 'test',
})) {
  if (!process.env[k]) process.env[k] = v;
}
delete process.env.MIPLAN_HANDOFF_SURVEY_V2_ENABLED;

const {
  V2_LOAN_PURPOSE_BY_CODE,
  surveyVersionOf,
  interpretSurveyRow,
  loanPurposeOf,
  summarizeSurveyScoresByMonth,
} = require('../src/lib/czSurveyVersion');
const {
  buildAllowlistedContext,
  selectLifetimeSurveyByCi,
} = require('../src/lib/miplanHandoffTokens');
const { assembleRejectedList, assembleRejectedDetail } = require('../src/lib/rejectedOpsRead');
const H = require(path.join(__dirname, '../public/rechazados-helpers.js'));

const EPISODE = {
  cz_id: 101,
  ci: 12345678,
  lrw_id: 'LRW-111-222-333',
  email: 'ada@example.com',
  nombre: 'Ada',
  apellido: 'Lovelace',
  celular: '59899111222',
  salario: 80000,
  fecha_nacimiento: '1990-05-08',
  relacion_laboral: 'EPR',
  solicitudes_estados_id: 3,
  synced_at: '2026-09-25T12:00:00.000Z',
};
const ISSUED = '2026-09-25T12:00:00.000Z';

function v1Row(overrides) {
  return Object.assign(
    {
      cz_id: 55,
      ci: 12345678,
      p1: 'A', p2: 'B', p3: 'A', p4: 'C', p5: 'B',
      p6: 'A', p7: 'B', p8: 'A', p9: 'A', p10: 'B',
      version_cuestionario: 1,
      score_v2: 24,
      segmentacion_base: 'A',
      completed_at: '2026-09-25T11:00:00.000Z',
    },
    overrides || {},
  );
}

function v2Row(overrides) {
  return Object.assign(
    {
      cz_id: 77,
      ci: 12345678,
      p1: 'A', p2: 'B', p3: 'A', p4: 'C', p5: 'B',
      p6: 'A', p7: 'G', p8: 'A', p9: 'A', p10: 'B',
      version_cuestionario: 2,
      score_v2: 18,
      segmentacion_base: 'A',
      completed_at: '2026-09-26T11:00:00.000Z',
    },
    overrides || {},
  );
}

/** Pre-V2 builder output, reproduced verbatim for the V1 equivalence check. */
function legacyV1SurveyBlock(survey) {
  return {
    selection_rule: 'lifetime_ci',
    completed_at: survey.completed_at || null,
    respuestas: {
      p1: survey.p1, p2: survey.p2, p3: survey.p3, p4: survey.p4, p5: survey.p5,
      p6: survey.p6, p7: survey.p7, p8: survey.p8, p9: survey.p9, p10: survey.p10,
    },
  };
}

function mockSupabaseEncuestas(rows) {
  return {
    from: function (table) {
      assert.strictEqual(table, 'cz_funnel_encuestas');
      const chain = {
        select: function (cols) {
          assert.ok(String(cols).includes('version_cuestionario'), 'selects version');
          return chain;
        },
        eq: function () { return chain; },
        order: function () { return chain; },
        limit: function () {
          const sorted = rows.slice().sort(function (a, b) {
            const ta = a.completed_at ? Date.parse(a.completed_at) : 0;
            const tb = b.completed_at ? Date.parse(b.completed_at) : 0;
            if (tb !== ta) return tb - ta;
            return Number(b.cz_id) - Number(a.cz_id);
          });
          return Promise.resolve({ data: sorted, error: null });
        },
      };
      return chain;
    },
  };
}

async function main() {
  // ---------------------------------------------------------------- A: V1 unchanged
  {
    assert.strictEqual(surveyVersionOf(v1Row()), 1);
    const r = interpretSurveyRow(v1Row());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source_survey_version, 1);
    assert.deepStrictEqual(Object.keys(r.respuestas), [
      'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10',
    ]);

    for (const flag of [false, true, undefined]) {
      const ctx = buildAllowlistedContext(EPISODE, v1Row(), ISSUED, { surveyV2Enabled: flag });
      const expected = Object.assign(legacyV1SurveyBlock(v1Row()), { source_survey_version: 1 });
      assert.deepStrictEqual(ctx.survey, expected, 'V1 survey = legacy + source_survey_version');
      assert.ok(!Object.prototype.hasOwnProperty.call(ctx, 'survey_handoff'));
      assert.ok(!('loan_purpose' in ctx.survey));
    }
    // No options argument at all (legacy call signature)
    const legacyCall = buildAllowlistedContext(EPISODE, v1Row(), ISSUED);
    assert.strictEqual(legacyCall.survey.respuestas.p7, 'B');
    assert.strictEqual(legacyCall.contract_version, 1);

    // Lifetime selection by CI: most recent complete V1; incomplete V1 skipped (as before)
    const picked = await selectLifetimeSurveyByCi(
      mockSupabaseEncuestas([
        v1Row({ cz_id: 1, completed_at: '2026-09-01T00:00:00.000Z' }),
        v1Row({ cz_id: 2, completed_at: '2026-09-20T00:00:00.000Z', p4: null }),
        v1Row({ cz_id: 3, completed_at: '2026-09-10T00:00:00.000Z' }),
      ]),
      12345678,
    );
    assert.strictEqual(picked.cz_id, 3, 'latest complete V1 wins, incomplete V1 skipped');
    assert.strictEqual(await selectLifetimeSurveyByCi(mockSupabaseEncuestas([]), 12345678), null);
    const none = buildAllowlistedContext(EPISODE, null, ISSUED, {});
    assert.ok(!('survey' in none) && !('survey_handoff' in none), 'no survey → unchanged shape');

    // Reporting V1: scoreTone 20/10 unchanged with or without V1 meta
    const v1Meta = { survey_version: 1, segmentacion_base: 'B' };
    for (const [score, tone] of [[30, 'success'], [20, 'success'], [19, 'warn'], [10, 'warn'], [9, 'danger'], [0, 'danger']]) {
      assert.strictEqual(H.scoreTone(score), tone);
      assert.strictEqual(H.scoreTone(score, v1Meta), tone);
    }
    assert.deepStrictEqual(H.scoreCell(24, null, false, v1Meta), H.scoreCell(24));
    assert.deepStrictEqual(H.scoreCell(24, null, false, v1Meta), { kind: 'text', label: '24', tone: 'success' });
    assert.strictEqual(H.formatScore(24, 1), '24');
    assert.strictEqual(H.formatScore(24), '24');
  }

  // ---------------------------------------------------------------- B: V2 valid
  {
    for (const [code, key] of Object.entries({
      E: 'purchase_or_home_improvement',
      F: 'unexpected_one_off_expense',
      G: 'debt_management',
      H: 'recurring_expense_shortfall',
      I: 'work_or_business_investment',
      J: 'other',
    })) {
      assert.strictEqual(V2_LOAN_PURPOSE_BY_CODE[code], key);
      const r = interpretSurveyRow(v2Row({ p7: code }));
      assert.strictEqual(r.ok, true, 'V2 P7=' + code + ' accepted');
      assert.strictEqual(r.source_survey_version, 2);
      assert.strictEqual(r.loan_purpose, key);
      assert.ok(!('p7' in r.respuestas), 'P7 out of ordinal respuestas');
      assert.deepStrictEqual(Object.keys(r.respuestas), [
        'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8', 'p9', 'p10',
      ]);
      assert.strictEqual(loanPurposeOf(v2Row({ p7: code })), key);
    }
    assert.strictEqual(loanPurposeOf(v1Row()), null, 'V1 P7 is never a loan purpose');
    const blob = JSON.stringify(interpretSurveyRow(v2Row()));
    assert.ok(!/DEF_DEBT_HORIZON|debt_horizon/i.test(blob), 'no debt-horizon semantics');
  }

  // ---------------------------------------------------------------- C: fail closed
  {
    const cases = [
      [v1Row({ p7: 'E' }), 1, 'survey_v1_p7_not_ordinal'],
      [v1Row({ p7: 'J' }), 1, 'survey_v1_p7_not_ordinal'],
      [v1Row({ p3: 'X' }), 1, 'survey_v1_invalid_answer'],
      [v1Row({ p10: null }), 1, 'survey_v1_incomplete'],
      [v2Row({ p7: 'A' }), 2, 'survey_v2_p7_invalid'],
      [v2Row({ p7: 'D' }), 2, 'survey_v2_p7_invalid'],
      [v2Row({ p7: 'Z' }), 2, 'survey_v2_p7_invalid'],
      [v2Row({ p7: null }), 2, 'survey_v2_incomplete'],
      [v2Row({ p5: null }), 2, 'survey_v2_incomplete'],
      [v2Row({ p8: 'E' }), 2, 'survey_v2_invalid_answer'],
      [v1Row({ version_cuestionario: 3 }), null, 'survey_version_unknown'],
      [v1Row({ version_cuestionario: null }), null, 'survey_version_unknown'],
      [v2Row({ version_cuestionario: undefined }), null, 'survey_version_unknown'],
    ];
    for (const [row, version, reason] of cases) {
      const r = interpretSurveyRow(row);
      assert.strictEqual(r.ok, false, reason);
      assert.strictEqual(r.reason, reason);
      assert.strictEqual(r.source_survey_version, version);
      for (const flag of [false, true]) {
        const ctx = buildAllowlistedContext(EPISODE, row, ISSUED, { surveyV2Enabled: flag });
        assert.ok(!('survey' in ctx), 'inconsistent survey never delivered: ' + reason);
        assert.deepStrictEqual(ctx.survey_handoff, {
          status: 'withheld',
          reason: reason,
          source_survey_version: version,
        });
        assert.ok(ctx.person && ctx.financial_prefill, 'rest of context intact');
      }
    }
    // V2 is never inferred from P7: P7=E without version is "unknown", not V2
    assert.strictEqual(surveyVersionOf(v2Row({ version_cuestionario: null })), null);

    // A newer non-V1 row is not bypassed in favor of an older valid V1
    const pickedInvalid = await selectLifetimeSurveyByCi(
      mockSupabaseEncuestas([
        v1Row({ cz_id: 1, completed_at: '2026-09-01T00:00:00.000Z' }),
        v2Row({ cz_id: 2, completed_at: '2026-09-20T00:00:00.000Z', p3: null }),
      ]),
      12345678,
    );
    assert.strictEqual(pickedInvalid.cz_id, 2);
    const unknownPicked = await selectLifetimeSurveyByCi(
      mockSupabaseEncuestas([
        v1Row({ cz_id: 1, completed_at: '2026-09-01T00:00:00.000Z' }),
        v1Row({ cz_id: 2, completed_at: '2026-09-20T00:00:00.000Z', version_cuestionario: 9 }),
      ]),
      12345678,
    );
    assert.strictEqual(unknownPicked.cz_id, 2);
    // Only incomplete V1 rows → no partial survey delivered
    const onlyPartial = await selectLifetimeSurveyByCi(
      mockSupabaseEncuestas([v1Row({ cz_id: 4, p9: null })]),
      12345678,
    );
    const partialCtx = buildAllowlistedContext(EPISODE, onlyPartial, ISSUED, {});
    assert.ok(!('survey' in partialCtx));
    assert.strictEqual(partialCtx.survey_handoff.reason, 'survey_v1_incomplete');
  }

  // ---------------------------------------------------------------- D: flag
  {
    // Flag OFF: V1 delivered, V2 withheld explicitly — no fallback to an older V1
    const pickedV2 = await selectLifetimeSurveyByCi(
      mockSupabaseEncuestas([
        v1Row({ cz_id: 1, completed_at: '2026-09-01T00:00:00.000Z' }),
        v2Row({ cz_id: 2, completed_at: '2026-09-20T00:00:00.000Z' }),
      ]),
      12345678,
    );
    assert.strictEqual(pickedV2.cz_id, 2, 'latest V2 selected, older V1 not used');
    const off = buildAllowlistedContext(EPISODE, pickedV2, ISSUED, { surveyV2Enabled: false });
    assert.ok(!('survey' in off), 'V2 not delivered with flag OFF');
    assert.deepStrictEqual(off.survey_handoff, {
      status: 'withheld',
      reason: 'survey_v2_handoff_disabled',
      source_survey_version: 2,
    });
    assert.ok(!JSON.stringify(off).includes('"p7"'), 'no E–J→A–D conversion, no partial survey');
    const offDefault = buildAllowlistedContext(EPISODE, pickedV2, ISSUED);
    assert.strictEqual(offDefault.survey_handoff.reason, 'survey_v2_handoff_disabled', 'default OFF');
    const offTruthy = buildAllowlistedContext(EPISODE, pickedV2, ISSUED, { surveyV2Enabled: 'true' });
    assert.ok(!('survey' in offTruthy), 'only boolean true enables');

    // Flag ON: new V2 context (no E2E against Mi Plan)
    const on = buildAllowlistedContext(EPISODE, pickedV2, ISSUED, { surveyV2Enabled: true });
    assert.ok(!('survey_handoff' in on));
    assert.deepStrictEqual(on.survey, {
      selection_rule: 'lifetime_ci',
      completed_at: '2026-09-20T00:00:00.000Z',
      source_survey_version: 2,
      respuestas: { p1: 'A', p2: 'B', p3: 'A', p4: 'C', p5: 'B', p6: 'A', p8: 'A', p9: 'A', p10: 'B' },
      loan_purpose: 'debt_management',
      provenance: { source_system: 'credizona', source_survey_version: 2 },
    });
    assert.strictEqual(on.contract_version, 1);

    // Env parsing: default false, only "true" enables
    const envPath = require.resolve('../src/config/env');
    for (const [raw, expected] of [[undefined, false], ['', false], ['false', false], ['1', false], ['yes', false], ['true', true], [' TRUE\n', true]]) {
      if (raw === undefined) delete process.env.MIPLAN_HANDOFF_SURVEY_V2_ENABLED;
      else process.env.MIPLAN_HANDOFF_SURVEY_V2_ENABLED = raw;
      delete require.cache[envPath];
      assert.strictEqual(
        require('../src/config/env').miplanHandoffSurveyV2Enabled,
        expected,
        'env ' + JSON.stringify(raw),
      );
    }
    delete process.env.MIPLAN_HANDOFF_SURVEY_V2_ENABLED;
    delete require.cache[envPath];
  }

  // ---------------------------------------------------------------- E: reporting
  {
    const monthKey = function (iso) { return iso ? String(iso).slice(0, 7) : null; };
    const rows = [
      { score_v2: 30, version_cuestionario: 1, completed_at: '2026-09-01' },
      { score_v2: 20, version_cuestionario: 1, completed_at: '2026-09-02' },
      { score_v2: 27, version_cuestionario: 2, completed_at: '2026-09-03' },
      { score_v2: 9, version_cuestionario: 2, completed_at: '2026-09-04' },
      { score_v2: 1, version_cuestionario: null, completed_at: '2026-09-05' },
      { score_v2: 12, version_cuestionario: 1, completed_at: '2026-08-05' },
    ];
    const out = summarizeSurveyScoresByMonth(rows, monthKey);
    assert.deepStrictEqual(out, [
      {
        month: '2026-08', total_encuestas: 1, score_promedio: 12,
        total_encuestas_v1: 1, total_encuestas_v2: 0, total_encuestas_version_unknown: 0,
        score_promedio_v2: null,
      },
      {
        month: '2026-09', total_encuestas: 5, score_promedio: 25,
        total_encuestas_v1: 2, total_encuestas_v2: 2, total_encuestas_version_unknown: 1,
        score_promedio_v2: 18,
      },
    ], 'V1 and V2 never averaged together; unknown excluded; no rescaling');

    // V1-only data: score_promedio identical to the pre-V2 formula
    const v1Only = [
      { score_v2: 7, version_cuestionario: 1, completed_at: '2026-09-01' },
      { score_v2: 30, version_cuestionario: 1, completed_at: '2026-09-02' },
      { score_v2: 22, version_cuestionario: 1, completed_at: '2026-09-03' },
    ];
    const legacyAvg = Math.round(((7 + 30 + 22) / 3) * 100) / 100;
    assert.strictEqual(summarizeSurveyScoresByMonth(v1Only, monthKey)[0].score_promedio, legacyAvg);

    // scoreTone never applies 20/10 to V2
    assert.strictEqual(H.scoreTone(19, { survey_version: 2, segmentacion_base: 'A' }), 'success');
    assert.strictEqual(H.scoreTone(20, { survey_version: 2, segmentacion_base: 'B' }), 'warn');
    assert.strictEqual(H.scoreTone(25, { survey_version: 2, segmentacion_base: 'C' }), 'danger');
    assert.strictEqual(H.scoreTone(25, { survey_version: 2, segmentacion_base: null }), null);
    assert.strictEqual(H.scoreTone(25, { survey_version: null, segmentacion_base: 'A' }), null);
    assert.strictEqual(H.scoreTone(25, null), null);
    assert.deepStrictEqual(H.scoreCell(18, null, false, { survey_version: 2, segmentacion_base: 'A' }), {
      kind: 'text',
      label: '18/27',
      tone: 'success',
      title: 'Encuesta V2 (score 0–27)',
    });
    assert.strictEqual(H.formatScore(18, 2), '18/27');
    assert.strictEqual(H.loanPurposeLabel('debt_management'), 'Manejo de deudas');
    assert.strictEqual(H.loanPurposeLabel('B'), '—', 'raw P7 letters never labelled');
    assert.strictEqual(H.loanPurposeLabel(null), '—');

    // Rejected ops read: explicit version + received segmentacion_base, loan purpose only for V2
    const estadoRows = [{ cz_historico_id: 1, cz_solicitud_id: 10, solicitudes_estados_id: 3, fechahora_src: '2026-09-20T10:00:00Z' }];
    const solicitudRows = [{ cz_id: 10, ci: 12345678, nombre: 'Ada', apellido: 'L', fecha_reg: '2026-09-19T10:00:00Z' }];
    const encV2 = v2Row({ cz_id: 900, email: 'a@x.com' });
    const encV1 = v1Row({ cz_id: 800, email: 'a@x.com' });
    const list = assembleRejectedList({ estadoRows, solicitudRows, encuestaRows: [encV1, encV2], snapshotRows: [], institutionRows: [] });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].score_v2, 18);
    assert.strictEqual(list[0].survey_version, 2);
    assert.strictEqual(list[0].segmentacion_base, 'A');
    const detail = assembleRejectedDetail({ ci: 12345678, estadoRows, solicitudRows, encuestaRows: [encV1, encV2], snapshotRows: [], institutionRows: [] });
    assert.strictEqual(detail.survey_version, 2);
    const byId = Object.fromEntries(detail.encuestas.map(function (e) { return [e.cz_id, e]; }));
    assert.strictEqual(byId[900].loan_purpose, 'debt_management');
    assert.strictEqual(byId[900].survey_version, 2);
    assert.strictEqual(byId[800].loan_purpose, null, 'V1 P7 not shown as loan purpose');
    assert.strictEqual(byId[800].survey_version, 1);
    assert.ok(!('p7' in byId[900]) && !('p7' in byId[800]), 'raw P7 not exposed');
  }

  console.log('unit-cz-survey-version: PASS');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
