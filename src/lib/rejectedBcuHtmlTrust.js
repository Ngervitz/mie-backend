'use strict';

/**
 * Trusted HTML gate for direct BCU auto-persist (Stage 6D.4).
 * Reuses evaluateConfirmGates — does not duplicate Stage 1.
 *
 * V1 auto-trust currency: MN_PESOS_ME_PESOS only (A).
 * Parser may support B/D; auto-persist does not.
 */

const { PAGE_TYPE } = require('./bcuHtmlParser');
const { evaluateConfirmGates } = require('./bcuExtractConfirmGates');
const { CURRENCY_VIEW_REVIEW_READY } = require('./bcuExtractContract');

const TRUST_REASON = Object.freeze({
  NOT_RESULT_PAGE: 'NOT_RESULT_PAGE',
  CURRENCY_VIEW_NOT_TRUSTED_FOR_AUTO_PERSIST:
    'CURRENCY_VIEW_NOT_TRUSTED_FOR_AUTO_PERSIST',
  PARSE_FAIL_MATERIAL: 'PARSE_FAIL_MATERIAL',
  CONFIRM_GATE_BLOCKER: 'CONFIRM_GATE_BLOCKER',
});

/**
 * @param {{
 *   pageType: string|null|undefined,
 *   extraction: object|null|undefined,
 *   expectedCi: string|number|null|undefined,
 *   parserMeta?: object|null,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   reasons: Array<{ reason_code: string, path?: string|null, detail?: object|null }>,
 *   warnings: Array<object>,
 *   validation: object|null,
 *   gate: object|null,
 * }}
 */
function isTrustedHtmlExtraction(input) {
  const pageType = input && input.pageType;
  const extraction = input && input.extraction;
  const reasons = [];
  const warnings = [];

  if (pageType !== PAGE_TYPE.RESULT_PAGE) {
    reasons.push({
      reason_code: TRUST_REASON.NOT_RESULT_PAGE,
      path: 'page_type',
      detail: { got: pageType || null },
    });
    return {
      ok: false,
      reasons: reasons,
      warnings: warnings,
      validation: null,
      gate: null,
    };
  }

  if (extraction == null || typeof extraction !== 'object' || Array.isArray(extraction)) {
    reasons.push({
      reason_code: TRUST_REASON.CONFIRM_GATE_BLOCKER,
      path: null,
      detail: { reason_code: 'EXTRACTION_NOT_OBJECT' },
    });
    return {
      ok: false,
      reasons: reasons,
      warnings: warnings,
      validation: null,
      gate: null,
    };
  }

  const currency = extraction.currency_view_selected;
  if (currency !== CURRENCY_VIEW_REVIEW_READY) {
    reasons.push({
      reason_code: TRUST_REASON.CURRENCY_VIEW_NOT_TRUSTED_FOR_AUTO_PERSIST,
      path: 'currency_view_selected',
      detail: { got: currency != null ? currency : null },
    });
  }

  const review =
    extraction.review && typeof extraction.review === 'object'
      ? extraction.review
      : {};
  const parseWarnings = Array.isArray(review.warnings) ? review.warnings : [];
  const parseFails = parseWarnings.filter(function (w) {
    return typeof w === 'string' && w.indexOf('parse_fail') === 0;
  });
  if (parseFails.length) {
    reasons.push({
      reason_code: TRUST_REASON.PARSE_FAIL_MATERIAL,
      path: 'review.warnings',
      detail: { count: parseFails.length, samples: parseFails.slice(0, 5) },
    });
  }

  const gate = evaluateConfirmGates(extraction, {
    expected_ci: input.expectedCi,
  });

  for (let i = 0; i < (gate.warnings || []).length; i += 1) {
    warnings.push(gate.warnings[i]);
  }

  for (let i = 0; i < (gate.blockers || []).length; i += 1) {
    const b = gate.blockers[i];
    // Avoid duplicating the dedicated auto-persist currency reason.
    if (
      b.reason_code === 'CURRENCY_VIEW_NOT_MN_PESOS_ME_PESOS' &&
      reasons.some(function (r) {
        return (
          r.reason_code ===
          TRUST_REASON.CURRENCY_VIEW_NOT_TRUSTED_FOR_AUTO_PERSIST
        );
      })
    ) {
      continue;
    }
    reasons.push({
      reason_code: b.reason_code || TRUST_REASON.CONFIRM_GATE_BLOCKER,
      path: b.path || null,
      detail: b.detail || null,
    });
  }

  return {
    ok: reasons.length === 0 && gate.ok === true,
    reasons: reasons,
    warnings: warnings,
    validation: gate.validation || null,
    gate: gate,
  };
}

module.exports = {
  TRUST_REASON,
  isTrustedHtmlExtraction,
};
