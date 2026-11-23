'use strict';

/**
 * Survey conversion by unique CI (solicitantes vs encuesta completada).
 *
 * Monthly denominator: distinct CI with at least one solicitud (fecha_reg) in that month.
 * Monthly numerator: those CI with earliest completed_at on or before the month cut-off.
 * Past months: cut-off = end of that civil month (America/Montevideo).
 * Current month: cut-off = nowMs (no future completions).
 *
 * Overall: all distinct solicitud CI vs those with a completed survey by nowMs.
 * Numerator is always a subset of the period denominator.
 */

const { firstSurveyCompletedAtByCi } = require('./czSurveyConversion');

function safeCi(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Last instant of civil month in America/Montevideo (UTC-3, no DST).
 * @param {string} monthKey YYYY-MM
 */
function endOfMonthCutoffMs(monthKey) {
  const parts = String(monthKey || '').split('-');
  if (parts.length < 2) return 0;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 0;
  let ny = y;
  let nm = m + 1;
  if (nm > 12) {
    nm = 1;
    ny += 1;
  }
  const nextFirst = `${ny}-${pad2(nm)}-01`;
  const startNextMs = Date.parse(`${nextFirst}T03:00:00.000Z`);
  if (!Number.isFinite(startNextMs)) return 0;
  return startNextMs - 1;
}

function roundRatePct(numerator, denominator) {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * @param {{
 *   solicitudRows?: Array<{ ci?: unknown, fecha_reg?: unknown }>,
 *   surveyRows?: Array<{ ci?: unknown, completed_at?: unknown }>,
 * }} input
 * @param {{
 *   monthKey: (iso: unknown) => string|null,
 *   nowMs?: number,
 *   currentMonthKey?: string|null,
 * }} opts
 */
function surveyConversionByCi(input, opts) {
  const solicitudRows = (input && input.solicitudRows) || [];
  const surveyRows = (input && input.surveyRows) || [];
  const monthKey = opts && opts.monthKey;
  const nowMs =
    opts && Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const currentMonthKey =
    opts && opts.currentMonthKey != null ? String(opts.currentMonthKey) : null;

  if (!monthKey) {
    throw new Error('surveyConversionByCi requires monthKey');
  }

  const firstSurvey = firstSurveyCompletedAtByCi(surveyRows);
  /** @type {Map<string, Set<number>>} */
  const cisByMonth = new Map();
  const allSolicitudCis = new Set();

  for (let i = 0; i < solicitudRows.length; i += 1) {
    const row = solicitudRows[i];
    const ci = safeCi(row && row.ci);
    if (ci == null) continue;
    allSolicitudCis.add(ci);
    const month = monthKey(row && row.fecha_reg);
    if (!month) continue;
    let set = cisByMonth.get(month);
    if (!set) {
      set = new Set();
      cisByMonth.set(month, set);
    }
    set.add(ci);
  }

  function numeratorForSet(ciSet, cutOffMs) {
    let numerator = 0;
    for (const ci of ciSet) {
      const completed = firstSurvey.get(ci);
      if (completed != null && completed <= cutOffMs) numerator += 1;
    }
    return numerator;
  }

  const surveyConversionByMonth = [...cisByMonth.keys()]
    .sort(function (a, b) {
      return String(a).localeCompare(String(b));
    })
    .map(function (month) {
      const denomSet = cisByMonth.get(month) || new Set();
      const denominator = denomSet.size;
      const cutOffMs =
        currentMonthKey && month === currentMonthKey
          ? nowMs
          : endOfMonthCutoffMs(month);
      const numerator = numeratorForSet(denomSet, cutOffMs);
      return {
        month: month,
        denominator: denominator,
        numerator: numerator,
        rate: roundRatePct(numerator, denominator),
      };
    });

  const overallDenominator = allSolicitudCis.size;
  const overallNumerator = numeratorForSet(allSolicitudCis, nowMs);

  return {
    surveyConversionByMonth: surveyConversionByMonth,
    surveyConversionOverall: {
      denominator: overallDenominator,
      numerator: overallNumerator,
      rate: roundRatePct(overallNumerator, overallDenominator),
    },
  };
}

module.exports = {
  surveyConversionByCi,
  endOfMonthCutoffMs,
};