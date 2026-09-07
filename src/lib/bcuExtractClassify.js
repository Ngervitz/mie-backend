'use strict';

/**
 * Classify a bcu_v1-shaped extraction after deterministic gates.
 *
 * REVIEW_READY = no known blockers (queue priority only).
 * V1 always requires human review + confirm before persist.
 * No auto-persist flags. Blind to payload origin.
 */

const {
  CLASSIFICATION,
  EXTRACTION_CONTRACT_VERSION,
} = require('./bcuExtractContract');
const { runBcuExtractGates } = require('./bcuExtractGates');

/**
 * @param {unknown} extraction
 * @param {{ expected_ci?: string|null }} [options]
 */
function classifyBcuExtraction(extraction, options) {
  const findings = runBcuExtractGates(extraction, options);
  const blockers = findings.filter(function (f) {
    return f.severity === 'blocker';
  });
  const infos = findings.filter(function (f) {
    return f.severity === 'info';
  });

  const reason_codes = [];
  const seen = Object.create(null);
  for (let i = 0; i < findings.length; i += 1) {
    const code = findings[i].reason_code;
    if (!seen[code]) {
      seen[code] = true;
      reason_codes.push(code);
    }
  }

  let classification;
  if (extraction == null) {
    classification = CLASSIFICATION.EXTRACTION_FAILED;
  } else if (typeof extraction !== 'object' || Array.isArray(extraction)) {
    classification = CLASSIFICATION.EXTRACTION_FAILED;
  } else if (
    extraction.extraction_contract_version !== EXTRACTION_CONTRACT_VERSION
  ) {
    classification = CLASSIFICATION.EXTRACTION_FAILED;
  } else if (blockers.length) {
    classification = CLASSIFICATION.HUMAN_REVIEW;
  } else {
    classification = CLASSIFICATION.REVIEW_READY;
  }

  return {
    classification: classification,
    reason_codes: reason_codes,
    findings: findings,
    blockers: blockers,
    infos: infos,
    human_review_required: true,
    auto_persist_allowed: false,
  };
}

module.exports = {
  classifyBcuExtraction,
  CLASSIFICATION,
};
