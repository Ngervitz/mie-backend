'use strict';

/**
 * Pure Rechazados V0 helpers (CI + BCU operational rules).
 * No I/O. next_review_on depends only on consulted_on (calendar DATE).
 *
 * Amount flags are tri-state: TRUE | FALSE | UNKNOWN.
 * NULL is never treated as 0 for operational decisions.
 */

const OPS_STATUS = Object.freeze({
  BCU_PENDING: 'bcu_pending',
  RETRY_ELIGIBLE: 'retry_eligible',
  RECONSULTABLE: 'reconsultable',
  NO_AUTO_RECONSULT: 'no_auto_reconsult',
  UNDEFINED_CASE: 'undefined_case',
});

const TRI = Object.freeze({
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  UNKNOWN: 'UNKNOWN',
});

/** Best → worst. Do not use lexicographic string order. */
const BCU_CATEGORY_RANK = Object.freeze({
  '1C': 1,
  '2A': 2,
  '2B': 3,
  3: 4,
  4: 5,
  5: 6,
});

const BCU_CATEGORIES = Object.freeze(['1C', '2A', '2B', '3', '4', '5']);

/**
 * @param {unknown} raw
 * @returns {number|null} CI as JS number (safe integer), matching cz_funnel_*.ci bigint
 */
function normalizeCi(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || !Number.isSafeInteger(raw)) {
      return null;
    }
    return raw;
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function categoryRank(category) {
  const rank = BCU_CATEGORY_RANK[category];
  return typeof rank === 'number' ? rank : null;
}

/**
 * @param {Array<{ category?: string }|string>|null|undefined} institutionsOrCategories
 * @returns {string|null}
 */
function worstBcuCategory(institutionsOrCategories) {
  const list = Array.isArray(institutionsOrCategories)
    ? institutionsOrCategories
    : [];
  let worst = null;
  let worstRank = -1;
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const cat =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? item.category
          : null;
    const rank = categoryRank(cat);
    if (rank == null) continue;
    if (rank > worstRank) {
      worstRank = rank;
      worst = cat;
    }
  }
  return worst;
}

/**
 * Single amount → tri-state.
 * null/undefined → UNKNOWN; 0 → FALSE; >0 → TRUE.
 * Non-finite / negative → UNKNOWN (defensive; should not appear post-confirm).
 * @param {unknown} raw
 * @returns {'TRUE'|'FALSE'|'UNKNOWN'}
 */
function amountFlag(raw) {
  if (raw === null || raw === undefined || raw === '') return TRI.UNKNOWN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return TRI.UNKNOWN;
  if (n > 0) return TRI.TRUE;
  return TRI.FALSE;
}

/**
 * MN/ME pair aggregation:
 * TRUE if any side >0;
 * FALSE only if both sides are known zeros;
 * UNKNOWN if no TRUE and at least one side is null/unknown.
 * @param {unknown} mn
 * @param {unknown} me
 * @returns {'TRUE'|'FALSE'|'UNKNOWN'}
 */
function amountPairFlag(mn, me) {
  const a = amountFlag(mn);
  const b = amountFlag(me);
  if (a === TRI.TRUE || b === TRI.TRUE) return TRI.TRUE;
  if (a === TRI.FALSE && b === TRI.FALSE) return TRI.FALSE;
  return TRI.UNKNOWN;
}

/**
 * @deprecated Prefer amountFlag / amountPairFlag. Kept for non-ops numeric coercion.
 * null → 0 (legacy). Do NOT use for ops decisions.
 */
function toNonNegNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object|null|undefined} institution
 * @returns {{ hasMoroso: 'TRUE'|'FALSE'|'UNKNOWN', hasCastigado: 'TRUE'|'FALSE'|'UNKNOWN' }}
 */
function institutionFlags(institution) {
  const row = institution && typeof institution === 'object' ? institution : {};
  return {
    hasMoroso: amountPairFlag(row.moroso_mn, row.moroso_me),
    hasCastigado: amountPairFlag(row.castigado_mn, row.castigado_me),
  };
}

function isRetryCategory(category) {
  return category === '1C' || category === '2A';
}

function isTrue(flag) {
  return flag === TRI.TRUE;
}
function isFalse(flag) {
  return flag === TRI.FALSE;
}
function isUnknown(flag) {
  return flag === TRI.UNKNOWN;
}

/**
 * Precedence is intentional and must not be reordered.
 * NULL amounts never count as evidence of "no moroso/castigado".
 * @param {Array<object>|null|undefined} institutions
 * @returns {string}
 */
function deriveOpsStatus(institutions) {
  const list = Array.isArray(institutions) ? institutions : [];
  if (!list.length) return OPS_STATUS.BCU_PENDING;

  let allRetry = true;
  for (let i = 0; i < list.length; i += 1) {
    if (!isRetryCategory(list[i] && list[i].category)) {
      allRetry = false;
      break;
    }
  }
  if (allRetry) return OPS_STATUS.RETRY_ELIGIBLE;

  for (let i = 0; i < list.length; i += 1) {
    const cat = list[i] && list[i].category;
    const flags = institutionFlags(list[i]);
    if ((cat === '4' || cat === '5') && isTrue(flags.hasCastigado)) {
      return OPS_STATUS.NO_AUTO_RECONSULT;
    }
  }

  for (let i = 0; i < list.length; i += 1) {
    const cat = list[i] && list[i].category;
    const flags = institutionFlags(list[i]);
    if (
      cat === '5' &&
      isFalse(flags.hasMoroso) &&
      isFalse(flags.hasCastigado)
    ) {
      return OPS_STATUS.UNDEFINED_CASE;
    }
  }

  // 4/5 with UNKNOWN evidence needed for remaining rules → not evaluable.
  for (let i = 0; i < list.length; i += 1) {
    const cat = list[i] && list[i].category;
    if (cat !== '4' && cat !== '5') continue;
    const flags = institutionFlags(list[i]);
    if (isUnknown(flags.hasMoroso) || isUnknown(flags.hasCastigado)) {
      return OPS_STATUS.UNDEFINED_CASE;
    }
  }

  for (let i = 0; i < list.length; i += 1) {
    const cat = list[i] && list[i].category;
    const flags = institutionFlags(list[i]);
    if (cat === '2B' || cat === '3') return OPS_STATUS.RECONSULTABLE;
    if (
      cat === '4' &&
      isTrue(flags.hasMoroso) &&
      isFalse(flags.hasCastigado)
    ) {
      return OPS_STATUS.RECONSULTABLE;
    }
    if (
      cat === '5' &&
      isTrue(flags.hasMoroso) &&
      isFalse(flags.hasCastigado)
    ) {
      return OPS_STATUS.RECONSULTABLE;
    }
  }

  return OPS_STATUS.UNDEFINED_CASE;
}

/**
 * Parse a calendar DATE (YYYY-MM-DD). No clock, no timezone conversion.
 * @param {unknown} raw
 * @returns {{ year: number, month: number }|null} month 1–12
 */
function parseConsultedOn(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: year, month: month };
}

/**
 * Day 5 of the calendar month after consulted_on.
 * Does not roll forward if that date is in the past.
 * @param {unknown} consultedOn  DATE string YYYY-MM-DD
 * @returns {string|null} YYYY-MM-DD
 */
function nextReviewOn(consultedOn) {
  const parsed = parseConsultedOn(consultedOn);
  if (!parsed) return null;
  let year = parsed.year;
  let month = parsed.month + 1;
  if (month === 13) {
    month = 1;
    year += 1;
  }
  return (
    String(year) +
    '-' +
    String(month).padStart(2, '0') +
    '-05'
  );
}

/**
 * @param {{ institutions?: Array<object>|null, consultedOn?: unknown }} input
 */
function deriveRejectedOps(input) {
  const institutions = input && input.institutions;
  const opsStatus = deriveOpsStatus(institutions);
  const next =
    opsStatus === OPS_STATUS.RECONSULTABLE
      ? nextReviewOn(input && input.consultedOn)
      : null;
  return {
    ops_status: opsStatus,
    worst_bcu: worstBcuCategory(institutions),
    next_review_on: next,
  };
}

module.exports = {
  OPS_STATUS,
  TRI,
  BCU_CATEGORY_RANK,
  BCU_CATEGORIES,
  normalizeCi,
  categoryRank,
  worstBcuCategory,
  amountFlag,
  amountPairFlag,
  toNonNegNumber,
  institutionFlags,
  deriveOpsStatus,
  parseConsultedOn,
  nextReviewOn,
  deriveRejectedOps,
};
