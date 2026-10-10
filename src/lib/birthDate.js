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

module.exports = {
  MIN_AGE_YEARS,
  MAX_AGE_YEARS,
  parseCalendarDate,
  ageInYears,
  normalizeBirthDate,
  isValidBirthDate,
};
