'use strict';

/**
 * Survey conversion by rejection cohort.
 *
 * A month's cohort is the set of CIs with at least one historico estado 3
 * whose fechahora falls in that month. Repeated rejections in the same month
 * collapse to the earliest one. A CI rejected in several months is one member
 * of each month.
 *
 * Denominator: cohort CIs who had not completed a survey before that first
 * rejection. Numerator: those who completed at that moment or later.
 * Completion is lifetime per CI (earliest completed_at). A completion after
 * the cohort month still belongs to that cohort.
 *
 * This is not invite eligibility. Historical cohorts keep every month's first
 * rejection; they are not rebuilt from each CI's latest rejection.
 */

const REJECTED_ESTADO_ID = 3;

function tsMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

function safeCi(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Earliest completed_at per CI. Later rows of the same CI do not count again.
 * @param {Array<{ ci?: unknown, completed_at?: unknown }>|null|undefined} surveyRows
 * @returns {Map<number, number>}
 */
function firstSurveyCompletedAtByCi(surveyRows) {
  const byCi = new Map();
  for (let i = 0; i < (surveyRows || []).length; i += 1) {
    const row = surveyRows[i];
    const ci = safeCi(row && row.ci);
    const t = tsMs(row && row.completed_at);
    if (ci == null || t == null) continue;
    const prev = byCi.get(ci);
    if (prev == null || t < prev) byCi.set(ci, t);
  }
  return byCi;
}

/**
 * @param {{
 *   estadoRows?: Array<{ cz_solicitud_id?: unknown, solicitudes_estados_id?: unknown, fechahora_src?: unknown, cz_historico_id?: unknown }>,
 *   solicitudRows?: Array<{ cz_id?: unknown, ci?: unknown }>,
 *   surveyRows?: Array<{ ci?: unknown, completed_at?: unknown }>,
 * }} input
 * @param {(iso: unknown) => string|null} monthKey
 * @returns {Array<{ month: string, denominator: number, numerator: number, rate: number|null }>}
 */
function surveyConversionByRejectionMonth(input, monthKey) {
  const estadoRows = (input && input.estadoRows) || [];
  const solicitudRows = (input && input.solicitudRows) || [];
  const surveyRows = (input && input.surveyRows) || [];

  const solById = new Map();
  for (let i = 0; i < solicitudRows.length; i += 1) {
    const sol = solicitudRows[i];
    const id = Number(sol && sol.cz_id);
    if (!Number.isFinite(id)) continue;
    solById.set(id, sol);
  }

  /** @type {Map<string, { ci: number, month: string, t: number, histId: number }>} */
  const firstByCiMonth = new Map();
  for (let i = 0; i < estadoRows.length; i += 1) {
    const e = estadoRows[i];
    if (Number(e && e.solicitudes_estados_id) !== REJECTED_ESTADO_ID) continue;
    const solId = Number(e && e.cz_solicitud_id);
    const sol = Number.isFinite(solId) ? solById.get(solId) : null;
    const ci = safeCi(sol && sol.ci);
    const month = monthKey(e && e.fechahora_src);
    const t = tsMs(e && e.fechahora_src);
    if (ci == null || !month || t == null) continue;
    const histId = Number(e.cz_historico_id);
    const hist = Number.isFinite(histId) ? histId : 0;
    const key = String(ci) + '\0' + month;
    const prev = firstByCiMonth.get(key);
    if (!prev || t < prev.t || (t === prev.t && hist < prev.histId)) {
      firstByCiMonth.set(key, { ci: ci, month: month, t: t, histId: hist });
    }
  }

  const firstSurvey = firstSurveyCompletedAtByCi(surveyRows);
  /** @type {Map<string, { month: string, denominator: number, numerator: number }>} */
  const buckets = new Map();

  for (const entry of firstByCiMonth.values()) {
    let bucket = buckets.get(entry.month);
    if (!bucket) {
      bucket = { month: entry.month, denominator: 0, numerator: 0 };
      buckets.set(entry.month, bucket);
    }
    const completed = firstSurvey.has(entry.ci) ? firstSurvey.get(entry.ci) : null;
    if (completed != null && completed < entry.t) continue;
    bucket.denominator += 1;
    if (completed != null && completed >= entry.t) bucket.numerator += 1;
  }

  return [...buckets.values()]
    .map(function (b) {
      return {
        month: b.month,
        denominator: b.denominator,
        numerator: b.numerator,
        rate:
          b.denominator > 0
            ? Math.round((b.numerator / b.denominator) * 1000) / 10
            : null,
      };
    })
    .sort(function (a, b) {
      return String(a.month).localeCompare(String(b.month));
    });
}

module.exports = {
  REJECTED_ESTADO_ID,
  surveyConversionByRejectionMonth,
  firstSurveyCompletedAtByCi,
};
