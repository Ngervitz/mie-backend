'use strict';

/**
 * Mi Plan waitlist interest conversion (Funnel CZ KPI).
 *
 * Denominator: unique CI with encuesta tipo prestamo-rechazado and completed_at
 * on or after the waitlist CTA launch (2026-10-06).
 *
 * Numerator: unique CI with rejected_ci_outreach interest (credizona_rejected_thank_you).
 * Monthly: same encuesta cohort for the civil month; interest counted through month cut-off.
 * Months before 2026-10: available false (dashboard shows N/D, not 0%).
 */

const { endOfMonthCutoffMs } = require('./czSurveyConversionByCi');

const MIPLAN_WAITLIST_CTA_LAUNCH_ISO = '2026-10-06T00:00:00.000Z';
const MIPLAN_WAITLIST_CTA_LAUNCH_MS = Date.parse(MIPLAN_WAITLIST_CTA_LAUNCH_ISO);
const MIPLAN_WAITLIST_FIRST_MONTH = '2026-10';
const MIPLAN_INTEREST_SOURCE = 'credizona_rejected_thank_you';
const ENCUESTA_TIPO_RECHAZADO = 'prestamo-rechazado';

function tsMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

function safeCi(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function roundRatePct(numerator, denominator) {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function isQualifyingEncuesta(row) {
  if (!row || typeof row !== 'object') return false;
  const tipo = row.tipo != null ? String(row.tipo).trim() : '';
  if (tipo !== ENCUESTA_TIPO_RECHAZADO) return false;
  const t = tsMs(row.completed_at);
  if (t == null || t < MIPLAN_WAITLIST_CTA_LAUNCH_MS) return false;
  const ci = safeCi(row.ci);
  return ci != null;
}

/**
 * @param {Array<{ ci?: unknown, tipo?: unknown, completed_at?: unknown }>} encuestaRows
 * @param {(iso: unknown) => string|null} monthKey
 */
function encuestadosRechazadosByMonth(encuestaRows, monthKey) {
  /** @type {Map<string, Set<number>>} */
  const byMonth = new Map();
  /** @type {Set<number>} */
  const overall = new Set();
  for (let i = 0; i < (encuestaRows || []).length; i += 1) {
    const row = encuestaRows[i];
    if (!isQualifyingEncuesta(row)) continue;
    const ci = safeCi(row.ci);
    if (ci == null) continue;
    overall.add(ci);
    const month = monthKey(row.completed_at);
    if (!month) continue;
    let set = byMonth.get(month);
    if (!set) {
      set = new Set();
      byMonth.set(month, set);
    }
    set.add(ci);
  }
  return { byMonth, overall };
}

/**
 * @param {Array<{ ci?: unknown, mi_plan_interest_at?: unknown, mi_plan_interest_source?: unknown }>} outreachRows
 * @returns {Map<number, number>}
 */
function interestAtMsByCi(outreachRows) {
  const map = new Map();
  for (let i = 0; i < (outreachRows || []).length; i += 1) {
    const row = outreachRows[i];
    const source =
      row && row.mi_plan_interest_source != null
        ? String(row.mi_plan_interest_source).trim()
        : '';
    if (source !== MIPLAN_INTEREST_SOURCE) continue;
    const ci = safeCi(row && row.ci);
    const t = tsMs(row && row.mi_plan_interest_at);
    if (ci == null || t == null || t < MIPLAN_WAITLIST_CTA_LAUNCH_MS) continue;
    map.set(ci, t);
  }
  return map;
}

function numeratorForCohort(ciSet, interestByCi, cutOffMs) {
  let n = 0;
  for (const ci of ciSet) {
    const t = interestByCi.get(ci);
    if (t == null || t > cutOffMs) continue;
    n += 1;
  }
  return n;
}

function monthAvailable(month) {
  return String(month).localeCompare(MIPLAN_WAITLIST_FIRST_MONTH) >= 0;
}

/**
 * @param {{
 *   encuestaRows?: Array<{ ci?: unknown, tipo?: unknown, completed_at?: unknown }>,
 *   outreachRows?: Array<{ ci?: unknown, mi_plan_interest_at?: unknown, mi_plan_interest_source?: unknown }>,
 * }} input
 * @param {{
 *   monthKey: (iso: unknown) => string|null,
 *   nowMs?: number,
 *   currentMonthKey?: string|null,
 * }} opts
 */
function miPlanInterestConversion(input, opts) {
  const monthKey = opts && opts.monthKey;
  if (!monthKey) {
    throw new Error('miPlanInterestConversion requires monthKey');
  }
  const nowMs =
    opts && Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const currentMonthKey =
    opts && opts.currentMonthKey != null ? String(opts.currentMonthKey) : null;

  const { byMonth, overall } = encuestadosRechazadosByMonth(
    (input && input.encuestaRows) || [],
    monthKey,
  );
  const interestByCi = interestAtMsByCi((input && input.outreachRows) || []);

  const months = [...new Set([...byMonth.keys()])].sort(function (a, b) {
    return String(a).localeCompare(String(b));
  });

  const miPlanInterestConversionByMonth = months.map(function (month) {
    const denomSet = byMonth.get(month) || new Set();
    const denominator = denomSet.size;
    const available = monthAvailable(month);
    if (!available) {
      return {
        month,
        available: false,
        denominator: 0,
        numerator: 0,
        rate: null,
      };
    }
    const cutOffMs =
      currentMonthKey && month === currentMonthKey
        ? nowMs
        : endOfMonthCutoffMs(month);
    const numerator = numeratorForCohort(denomSet, interestByCi, cutOffMs);
    return {
      month,
      available: true,
      denominator,
      numerator,
      rate: roundRatePct(numerator, denominator),
    };
  });

  const overallDenominator = overall.size;
  const overallNumerator = numeratorForCohort(overall, interestByCi, nowMs);

  return {
    miPlanInterestConversionByMonth,
    miPlanInterestConversionOverall: {
      available: true,
      launch_at: MIPLAN_WAITLIST_CTA_LAUNCH_ISO,
      denominator: overallDenominator,
      numerator: overallNumerator,
      rate: roundRatePct(overallNumerator, overallDenominator),
    },
  };
}

module.exports = {
  MIPLAN_WAITLIST_CTA_LAUNCH_ISO,
  MIPLAN_WAITLIST_CTA_LAUNCH_MS,
  MIPLAN_WAITLIST_FIRST_MONTH,
  MIPLAN_INTEREST_SOURCE,
  ENCUESTA_TIPO_RECHAZADO,
  miPlanInterestConversion,
  encuestadosRechazadosByMonth,
  interestAtMsByCi,
  monthAvailable,
};