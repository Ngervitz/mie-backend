/**
 * Pure Rechazados V0 helpers (CI + BCU operational rules).
 * No I/O. next_review_on depends only on consulted_on (calendar DATE).
 */

const OPS_STATUS = Object.freeze({
  BCU_PENDING: 'bcu_pending',
  RETRY_ELIGIBLE: 'retry_eligible',
  RECONSULTABLE: 'reconsultable',
  NO_AUTO_RECONSULT: 'no_auto_reconsult',
  UNDEFINED_CASE: 'undefined_case',
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

function toNonNegNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object|null|undefined} institution
 * @returns {{ hasMoroso: boolean, hasCastigado: boolean }}
 */
function institutionFlags(institution) {
  const row = institution && typeof institution === 'object' ? institution : {};
  const morosoMn = toNonNegNumber(row.moroso_mn);
  const morosoMe = toNonNegNumber(row.moroso_me);
  const castigadoMn = toNonNegNumber(row.castigado_mn);
  const castigadoMe = toNonNegNumber(row.castigado_me);
  return {
    hasMoroso: morosoMn > 0 || morosoMe > 0,
    hasCastigado: castigadoMn > 0 || castigadoMe > 0,
  };
}

function isRetryCategory(category) {
  return category === '1C' || category === '2A';
}

/**
 * Precedence is intentional and must not be reordered.
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
    if ((cat === '4' || cat === '5') && flags.hasCastigado) {
      return OPS_STATUS.NO_AUTO_RECONSULT;
    }
  }

  for (let i = 0; i < list.length; i += 1) {
    const cat = list[i] && list[i].category;
    const flags = institutionFlags(list[i]);
    if (cat === '5' && !flags.hasMoroso && !flags.hasCastigado) {
      return OPS_STATUS.UNDEFINED_CASE;
    }
  }

  for (let i = 0; i < list.length; i += 1) {
    const cat = list[i] && list[i].category;
    const flags = institutionFlags(list[i]);
    if (cat === '2B' || cat === '3') return OPS_STATUS.RECONSULTABLE;
    if (cat === '4' && flags.hasMoroso && !flags.hasCastigado) {
      return OPS_STATUS.RECONSULTABLE;
    }
    if (cat === '5' && flags.hasMoroso && !flags.hasCastigado) {
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
  BCU_CATEGORY_RANK,
  BCU_CATEGORIES,
  normalizeCi,
  categoryRank,
  worstBcuCategory,
  institutionFlags,
  deriveOpsStatus,
  parseConsultedOn,
  nextReviewOn,
  deriveRejectedOps,
};
