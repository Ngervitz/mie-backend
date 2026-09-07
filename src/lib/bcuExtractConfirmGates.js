'use strict';

/**
 * Stage 4 confirmation gates over a human-reviewed bcu_v1 payload.
 * Separates BLOCK_CONFIRM / ALLOW_WITH_WARNING / IRRELEVANT.
 *
 * Stage 1 gates remain authoritative for money/CI/currency/structure findings.
 * Confirm adds: period YYYYMM, empty institutions, explicit category null.
 * Every RUBRO_ORPHAN_* finding BLOCKS confirm.
 * SUMMARY_DETAIL_NOT_COMPARABLE warns only when no RUBRO_ORPHAN_* blocker exists.
 */

const { BCU_CATEGORIES } = require('./rejectedOps');
const {
  EXTRACTION_CONTRACT_VERSION,
  CURRENCY_VIEW_REVIEW_READY,
  RUBRO_KEYS,
  MONEY_SIDES,
  CLASSIFICATION,
  REASON,
} = require('./bcuExtractContract');
const { classifyBcuExtraction } = require('./bcuExtractClassify');
const { moneyPairSlots } = require('./bcuExtractMoney');

const SUMMARY_STATUS = Object.freeze({
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  NOT_COMPARABLE: 'NOT_COMPARABLE',
});

const YYYYMM_RE = /^(\d{4})(\d{2})$/;

function isValidPeriodYyyymm(raw) {
  if (raw == null || typeof raw !== 'string') return false;
  const m = YYYYMM_RE.exec(raw);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

function moneyOf(obj, rubro) {
  const block = obj && typeof obj === 'object' ? obj[rubro] : null;
  return moneyPairSlots(block);
}

/**
 * Explicit reconciliation status — never invent MATCH from "no findings".
 * @param {object} extraction
 * @returns {'MATCH'|'MISMATCH'|'NOT_COMPARABLE'}
 */
function reconcileSummaryValidationStatus(extraction) {
  const institutions = Array.isArray(extraction && extraction.institutions)
    ? extraction.institutions
    : [];
  const summary =
    extraction && extraction.summary && typeof extraction.summary === 'object'
      ? extraction.summary
      : {};

  let comparable = 0;
  let mismatches = 0;

  for (let r = 0; r < RUBRO_KEYS.length; r += 1) {
    const rubro = RUBRO_KEYS[r];
    for (let s = 0; s < MONEY_SIDES.length; s += 1) {
      const side = MONEY_SIDES[s];
      const sumSlot = moneyOf(summary, rubro)[side];
      if (sumSlot.kind !== 'cents') continue;

      let nCents = 0;
      let nNull = 0;
      let nError = 0;
      let detailSum = 0n;

      for (let i = 0; i < institutions.length; i += 1) {
        const slot = moneyOf(institutions[i], rubro)[side];
        if (slot.kind === 'cents') {
          nCents += 1;
          detailSum += slot.cents;
        } else if (slot.kind === 'null') {
          nNull += 1;
        } else {
          nError += 1;
        }
      }

      // Comparable only when summary + every institution cell are numeric.
      if (nError > 0 || nNull > 0 || nCents === 0 || nCents !== institutions.length) {
        continue;
      }
      comparable += 1;
      if (detailSum !== sumSlot.cents) mismatches += 1;
    }
  }

  if (mismatches > 0) return SUMMARY_STATUS.MISMATCH;
  if (comparable > 0) return SUMMARY_STATUS.MATCH;
  return SUMMARY_STATUS.NOT_COMPARABLE;
}

/**
 * @param {unknown} reviewed
 * @param {{ expected_ci: string|number }} options
 */
function evaluateConfirmGates(reviewed, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const blockers = [];
  const warnings = [];
  const irrelevant = [];

  function block(code, path, detail) {
    blockers.push({ reason_code: code, path: path || null, detail: detail || null });
  }
  function warn(code, path, detail) {
    warnings.push({ reason_code: code, path: path || null, detail: detail || null });
  }

  if (reviewed == null || typeof reviewed !== 'object' || Array.isArray(reviewed)) {
    block(REASON.EXTRACTION_NOT_OBJECT);
    return {
      ok: false,
      blockers: blockers,
      warnings: warnings,
      irrelevant: irrelevant,
      classification: CLASSIFICATION.EXTRACTION_FAILED,
      validation: null,
      summary_validation_status: SUMMARY_STATUS.NOT_COMPARABLE,
      summary_validation: { reason_codes: [REASON.EXTRACTION_NOT_OBJECT] },
    };
  }

  // --- Confirm-specific: contract / currency / period / institutions empty / category null ---
  if (reviewed.extraction_contract_version !== EXTRACTION_CONTRACT_VERSION) {
    block(REASON.EXTRACTION_CONTRACT_INVALID, 'extraction_contract_version', {
      got: reviewed.extraction_contract_version,
    });
  }

  if (reviewed.currency_view_selected !== CURRENCY_VIEW_REVIEW_READY) {
    block(REASON.CURRENCY_VIEW_NOT_MN_PESOS_ME_PESOS, 'currency_view_selected', {
      got: reviewed.currency_view_selected,
    });
  }

  if (reviewed.period == null) {
    block('PERIOD_MISSING', 'period');
  } else if (!isValidPeriodYyyymm(reviewed.period)) {
    block('PERIOD_INVALID', 'period', { got: reviewed.period });
  }

  const institutions = reviewed.institutions;
  if (!Array.isArray(institutions)) {
    block(REASON.STRUCTURE_INSTITUTIONS_NOT_ARRAY, 'institutions');
  } else if (!institutions.length) {
    block('INSTITUTIONS_EMPTY', 'institutions');
  } else {
    for (let i = 0; i < institutions.length; i += 1) {
      const inst = institutions[i];
      const cat = inst && typeof inst === 'object' ? inst.category : undefined;
      // Explicit null/missing category must BLOCK (Stage 1 only validates when present).
      if (cat === null || cat === undefined) {
        block('CATEGORY_NULL', 'institutions[' + i + '].category');
      } else if (BCU_CATEGORIES.indexOf(cat) < 0) {
        block(REASON.CATEGORY_INVALID, 'institutions[' + i + '].category', {
          got: cat,
        });
      }
    }
  }

  const validation = classifyBcuExtraction(reviewed, {
    expected_ci: opts.expected_ci,
  });

  if (validation.classification === CLASSIFICATION.EXTRACTION_FAILED) {
    block('CLASSIFICATION_EXTRACTION_FAILED', null, {
      classification: validation.classification,
    });
  }

  const stage1Findings = validation.findings || [];
  const pendingNotComparable = [];
  for (let i = 0; i < stage1Findings.length; i += 1) {
    const f = stage1Findings[i];
    const code = f.reason_code;

    if (code === REASON.SUMMARY_DETAIL_NOT_COMPARABLE) {
      pendingNotComparable.push({
        reason_code: code,
        path: f.path || null,
        detail: f.detail || null,
      });
      continue;
    }

    if (f.severity === 'blocker') {
      block(code, f.path, f.detail);
    } else if (f.severity === 'info') {
      irrelevant.push({
        reason_code: code,
        path: f.path || null,
        detail: f.detail || null,
      });
    }
  }

  function hasRubroOrphanBlocker() {
    return blockers.some(function (b) {
      return (
        typeof b.reason_code === 'string' &&
        b.reason_code.indexOf('RUBRO_ORPHAN_') === 0
      );
    });
  }

  // NOT_COMPARABLE warns only when no RUBRO_ORPHAN_* blocker is present.
  if (!hasRubroOrphanBlocker()) {
    for (let i = 0; i < pendingNotComparable.length; i += 1) {
      const w = pendingNotComparable[i];
      warn(w.reason_code, w.path, w.detail);
    }
  }

  const review =
    reviewed.review && typeof reviewed.review === 'object' ? reviewed.review : {};
  const illegible = Array.isArray(review.illegible_fields)
    ? review.illegible_fields
    : [];
  if (illegible.length && !blockers.length) {
    warn('ILLEGIBLE_FIELDS_PRESENT', 'review.illegible_fields', {
      count: illegible.length,
    });
  }

  if (
    validation.classification === CLASSIFICATION.HUMAN_REVIEW &&
    !blockers.length
  ) {
    warn('CLASSIFICATION_HUMAN_REVIEW', null, {
      classification: validation.classification,
    });
  }

  const summary_validation_status = reconcileSummaryValidationStatus(reviewed);
  if (summary_validation_status === SUMMARY_STATUS.MISMATCH) {
    // Ensure mismatch always blocks even if finding list was filtered oddly.
    const hasMismatchBlock = blockers.some(function (b) {
      return b.reason_code === REASON.SUMMARY_DETAIL_MISMATCH;
    });
    if (!hasMismatchBlock) {
      block(REASON.SUMMARY_DETAIL_MISMATCH);
    }
  } else if (
    summary_validation_status === SUMMARY_STATUS.NOT_COMPARABLE &&
    !blockers.length &&
    !hasRubroOrphanBlocker()
  ) {
    const hasWarn = warnings.some(function (w) {
      return w.reason_code === REASON.SUMMARY_DETAIL_NOT_COMPARABLE;
    });
    if (!hasWarn) {
      warn(REASON.SUMMARY_DETAIL_NOT_COMPARABLE);
    }
  }

  const summary_validation = {
    status: summary_validation_status,
    reason_codes: (validation.reason_codes || []).filter(function (c) {
      return (
        c === REASON.SUMMARY_DETAIL_MISMATCH ||
        c === REASON.SUMMARY_DETAIL_NOT_COMPARABLE ||
        c === REASON.RUBRO_ORPHAN_INCONSISTENT_SUPPORT ||
        c === REASON.RUBRO_ORPHAN_SUMMARY_WITHOUT_INST
      );
    }),
    findings: stage1Findings.filter(function (f) {
      return (
        f.gate === 'SUMMARY_DETAIL' ||
        f.gate === 'RUBRO_ORPHAN'
      );
    }),
  };

  return {
    ok: blockers.length === 0,
    blockers: blockers,
    warnings: warnings,
    irrelevant: irrelevant,
    classification: validation.classification,
    validation: validation,
    summary_validation_status: summary_validation_status,
    summary_validation: summary_validation,
  };
}

module.exports = {
  SUMMARY_STATUS,
  isValidPeriodYyyymm,
  reconcileSummaryValidationStatus,
  evaluateConfirmGates,
};
