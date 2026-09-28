'use strict';

/**
 * Credizona survey version interpretation (V1 / V2) for JANUS consumers.
 *
 * Credizona is the scoring authority: score_v2, segmentacion_base, b_plus and
 * bloque_*_score_v2 are stored as received and never recalculated here.
 *
 * V1 (version_cuestionario = 1): P1–P10 ordinal A–D, raw score 0–30.
 * V2 (version_cuestionario = 2): P1–P6 + P8–P10 ordinal A–D, raw score 0–27;
 *   P7 is categorical loan purpose E–J (not scored, not debt horizon).
 *
 * The version is never inferred from P7.
 */

const ORDINAL = new Set(['A', 'B', 'C', 'D']);

const V2_LOAN_PURPOSE_BY_CODE = Object.freeze({
  E: 'purchase_or_home_improvement',
  F: 'unexpected_one_off_expense',
  G: 'debt_management',
  H: 'recurring_expense_shortfall',
  I: 'work_or_business_investment',
  J: 'other',
});

const V1_KEYS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];
const V2_ORDINAL_KEYS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8', 'p9', 'p10'];

const SCORE_SCALE_MAX_BY_VERSION = Object.freeze({ 1: 30, 2: 27 });

function answer(row, key) {
  const raw = row ? row[key] : null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * Explicit questionnaire version from version_cuestionario. 1 | 2 | null.
 * @param {object|null} row
 * @returns {1|2|null}
 */
function surveyVersionOf(row) {
  if (!row || row.version_cuestionario == null || row.version_cuestionario === '') {
    return null;
  }
  const n = Number(row.version_cuestionario);
  if (n === 1) return 1;
  if (n === 2) return 2;
  return null;
}

/**
 * Strict interpretation of one cz_funnel_encuestas row.
 *
 * @param {object|null} row
 * @returns {{
 *   ok: true,
 *   source_survey_version: 1,
 *   respuestas: Record<string, string>,
 * } | {
 *   ok: true,
 *   source_survey_version: 2,
 *   respuestas: Record<string, string>,
 *   loan_purpose: string,
 *   loan_purpose_code: string,
 * } | {
 *   ok: false,
 *   source_survey_version: 1|2|null,
 *   reason: string,
 * }}
 */
function interpretSurveyRow(row) {
  const version = surveyVersionOf(row);
  if (version === null) {
    return { ok: false, source_survey_version: null, reason: 'survey_version_unknown' };
  }

  if (version === 1) {
    const respuestas = {};
    for (const key of V1_KEYS) {
      const v = answer(row, key);
      if (v == null) {
        return { ok: false, source_survey_version: 1, reason: 'survey_v1_incomplete' };
      }
      if (!ORDINAL.has(v)) {
        return {
          ok: false,
          source_survey_version: 1,
          reason:
            key === 'p7' && V2_LOAN_PURPOSE_BY_CODE[v]
              ? 'survey_v1_p7_not_ordinal'
              : 'survey_v1_invalid_answer',
        };
      }
      respuestas[key] = v;
    }
    return { ok: true, source_survey_version: 1, respuestas: respuestas };
  }

  const respuestas = {};
  for (const key of V2_ORDINAL_KEYS) {
    const v = answer(row, key);
    if (v == null) {
      return { ok: false, source_survey_version: 2, reason: 'survey_v2_incomplete' };
    }
    if (!ORDINAL.has(v)) {
      return { ok: false, source_survey_version: 2, reason: 'survey_v2_invalid_answer' };
    }
    respuestas[key] = v;
  }
  const p7 = answer(row, 'p7');
  if (p7 == null) {
    return { ok: false, source_survey_version: 2, reason: 'survey_v2_incomplete' };
  }
  const loanPurpose = Object.prototype.hasOwnProperty.call(V2_LOAN_PURPOSE_BY_CODE, p7)
    ? V2_LOAN_PURPOSE_BY_CODE[p7]
    : null;
  if (!loanPurpose) {
    return { ok: false, source_survey_version: 2, reason: 'survey_v2_p7_invalid' };
  }
  return {
    ok: true,
    source_survey_version: 2,
    respuestas: respuestas,
    loan_purpose: loanPurpose,
    loan_purpose_code: p7,
  };
}

/**
 * V2 loan purpose for display/reporting; null unless the row is a valid V2.
 * @param {object|null} row
 * @returns {string|null}
 */
function loanPurposeOf(row) {
  const interpreted = interpretSurveyRow(row);
  return interpreted.ok && interpreted.source_survey_version === 2
    ? interpreted.loan_purpose
    : null;
}

function roundAvg(sum, n) {
  return n > 0 ? Math.round((sum / n) * 100) / 100 : null;
}

/**
 * Monthly survey counts and score averages, separated by version.
 * V1 (0–30) and V2 (0–27) are never averaged together and never rescaled.
 * score_promedio stays V1-only; unknown versions are counted but excluded
 * from every average.
 *
 * @param {Array<{ score_v2?: unknown, version_cuestionario?: unknown, completed_at?: string|null }>} rows
 * @param {(iso: string|null|undefined) => string|null} monthKey
 */
function summarizeSurveyScoresByMonth(rows, monthKey) {
  const byMonth = new Map();
  for (const row of rows || []) {
    const key = monthKey(row.completed_at);
    if (!key) continue;
    const b = byMonth.get(key) || {
      month: key,
      total: 0,
      v1: 0,
      v2: 0,
      unknown: 0,
      v1Sum: 0,
      v1N: 0,
      v2Sum: 0,
      v2N: 0,
    };
    b.total += 1;
    const version = surveyVersionOf(row);
    const hasScore = row.score_v2 != null && Number.isFinite(Number(row.score_v2));
    if (version === 1) {
      b.v1 += 1;
      if (hasScore) {
        b.v1Sum += Number(row.score_v2);
        b.v1N += 1;
      }
    } else if (version === 2) {
      b.v2 += 1;
      if (hasScore) {
        b.v2Sum += Number(row.score_v2);
        b.v2N += 1;
      }
    } else {
      b.unknown += 1;
    }
    byMonth.set(key, b);
  }
  return [...byMonth.values()]
    .map(function (b) {
      return {
        month: b.month,
        total_encuestas: b.total,
        score_promedio: roundAvg(b.v1Sum, b.v1N),
        total_encuestas_v1: b.v1,
        total_encuestas_v2: b.v2,
        total_encuestas_version_unknown: b.unknown,
        score_promedio_v2: roundAvg(b.v2Sum, b.v2N),
      };
    })
    .sort(function (a, b) {
      return String(a.month).localeCompare(String(b.month));
    });
}

module.exports = {
  V2_LOAN_PURPOSE_BY_CODE,
  SCORE_SCALE_MAX_BY_VERSION,
  surveyVersionOf,
  interpretSurveyRow,
  loanPurposeOf,
  summarizeSurveyScoresByMonth,
};
