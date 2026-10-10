'use strict';

/**
 * Applicant date of birth validation (pure). Shared by the CZ sync parser, ELM eligibility and
 * the ELM S1 payload so all three agree on what a usable date of birth is: a real calendar date
 * with an age between MIN_AGE_YEARS and MAX_AGE_YEARS (inclusive) on the evaluation day (UTC).
 * Never repairs or guesses a year: anything else is invalid.
 */

const MIN_AGE_YEARS = 18;
const MAX_AGE_YEARS = 100;
const DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Calendar date from a "YYYY-MM-DD" prefix (time part ignored), or null.
 * @param {unknown} raw
 * @returns {{ y: number, mo: number, d: number }|null}
 */
function parseCalendarDate(raw) {
  if (raw == null) return null;
  const m = DATE_PREFIX_RE.exec(String(raw).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999.
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return { y: y, mo: mo, d: d };
}

/**
 * Whole years between the date and `now` (UTC calendar day).
 * @param {{ y: number, mo: number, d: number }} date
 * @param {Date} [now]
 */
function ageInYears(date, now) {
  const ref = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const nm = ref.getUTCMonth() + 1;
  const nd = ref.getUTCDate();
  let age = ref.getUTCFullYear() - date.y;
  if (nm < date.mo || (nm === date.mo && nd < date.d)) age -= 1;
  return age;
}

/**
 * "YYYY-MM-DD" when raw is a valid date of birth on `now`, else null.
 * @param {unknown} raw
 * @param {Date} [now]
 * @returns {string|null}
 */
function normalizeBirthDate(raw, now) {
  const date = parseCalendarDate(raw);
  if (!date) return null;
  const age = ageInYears(date, now);
  if (age < MIN_AGE_YEARS || age > MAX_AGE_YEARS) return null;
  return (
    String(date.y).padStart(4, '0') +
    '-' +
    String(date.mo).padStart(2, '0') +
    '-' +
    String(date.d).padStart(2, '0')
  );
}

/**
 * @param {unknown} raw
 * @param {Date} [now]
 */
function isValidBirthDate(raw, now) {
  return normalizeBirthDate(raw, now) !== null;
}

/**
 * Mirrors the CHECK of cz_funnel_solicitudes.fecha_nacimiento_status
 * (migrations/20261014_cz_funnel_fecha_nacimiento_status.sql).
 */
const BIRTH_DATE_STATUS = Object.freeze({
  VALID: 'valid',
  ABSENT: 'absent',
  IMPOSSIBLE: 'impossible',
  OVER_MAX_AGE: 'over_max_age',
  UNDERAGE: 'underage',
  FUTURE: 'future',
});

/**
 * Invalid dates that carry no usable information. underage / future are real or possible dates
 * of a minor and are never in this list.
 */
const OMITTABLE_BIRTH_DATE_STATUSES = Object.freeze([
  BIRTH_DATE_STATUS.ABSENT,
  BIRTH_DATE_STATUS.IMPOSSIBLE,
  BIRTH_DATE_STATUS.OVER_MAX_AGE,
]);

function isAfterToday(date, now) {
  const ref = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const today = [ref.getUTCFullYear(), ref.getUTCMonth() + 1, ref.getUTCDate()];
  const d = [date.y, date.mo, date.d];
  for (let i = 0; i < 3; i += 1) {
    if (d[i] !== today[i]) return d[i] > today[i];
  }
  return false;
}

/**
 * Why a raw CZ fecha_nacimiento is (not) a usable date of birth on `now`.
 * @param {unknown} raw
 * @param {Date} [now]
 * @returns {string} BIRTH_DATE_STATUS value
 */
function classifyBirthDate(raw, now) {
  if (raw == null || String(raw).trim() === '') return BIRTH_DATE_STATUS.ABSENT;
  const date = parseCalendarDate(raw);
  if (!date) return BIRTH_DATE_STATUS.IMPOSSIBLE;
  if (isAfterToday(date, now)) return BIRTH_DATE_STATUS.FUTURE;
  const age = ageInYears(date, now);
  if (age < MIN_AGE_YEARS) return BIRTH_DATE_STATUS.UNDERAGE;
  if (age > MAX_AGE_YEARS) return BIRTH_DATE_STATUS.OVER_MAX_AGE;
  return BIRTH_DATE_STATUS.VALID;
}

module.exports = {
  MIN_AGE_YEARS,
  MAX_AGE_YEARS,
  BIRTH_DATE_STATUS,
  OMITTABLE_BIRTH_DATE_STATUSES,
  parseCalendarDate,
  ageInYears,
  normalizeBirthDate,
  isValidBirthDate,
  classifyBirthDate,
};
