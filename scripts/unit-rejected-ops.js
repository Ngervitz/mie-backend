'use strict';

/**
 * node scripts/unit-rejected-ops.js
 */

const assert = require('assert');
const {
  OPS_STATUS,
  normalizeCi,
  worstBcuCategory,
  institutionFlags,
  deriveOpsStatus,
  nextReviewOn,
  deriveRejectedOps,
} = require('../src/lib/rejectedOps');

function inst(category, extras) {
  return Object.assign(
    {
      category: category,
      vigente_mn: 0,
      vigente_me: 0,
      moroso_mn: 0,
      moroso_me: 0,
      castigado_mn: 0,
      castigado_me: 0,
      contingencias_mn: 0,
      contingencias_me: 0,
    },
    extras || {},
  );
}

// --- CI ---
assert.strictEqual(normalizeCi('45006120'), 45006120);
assert.strictEqual(normalizeCi(' 45006120 '), 45006120);
assert.strictEqual(normalizeCi(45006120), 45006120);
assert.strictEqual(normalizeCi(''), null);
assert.strictEqual(normalizeCi('   '), null);
assert.strictEqual(normalizeCi('12a'), null);
assert.strictEqual(normalizeCi('12.3'), null);
assert.strictEqual(normalizeCi(-1), null);
assert.strictEqual(normalizeCi('-1'), null);
assert.strictEqual(normalizeCi(Number.MAX_SAFE_INTEGER + 1), null);
assert.strictEqual(normalizeCi(String(Number.MAX_SAFE_INTEGER) + '0'), null);
assert.strictEqual(normalizeCi(null), null);
assert.strictEqual(normalizeCi(undefined), null);

// --- worst category (not lexicographic: 2A vs 2B) ---
assert.strictEqual(worstBcuCategory([inst('1C'), inst('2A')]), '2A');
assert.strictEqual(worstBcuCategory([inst('1C'), inst('2B')]), '2B');
assert.strictEqual(worstBcuCategory([inst('2A'), inst('5')]), '5');
assert.strictEqual(worstBcuCategory([inst('3'), inst('4')]), '4');
assert.strictEqual(worstBcuCategory(['1C', '2B']), '2B');
assert.strictEqual(worstBcuCategory([]), null);

// --- flags: MN/ME never summed; either side > 0 is enough ---
assert.deepStrictEqual(institutionFlags(inst('4', { moroso_mn: 1, moroso_me: 0 })), {
  hasMoroso: true,
  hasCastigado: false,
});
assert.deepStrictEqual(institutionFlags(inst('4', { moroso_mn: 0, moroso_me: 2 })), {
  hasMoroso: true,
  hasCastigado: false,
});
assert.deepStrictEqual(
  institutionFlags(inst('5', { castigado_mn: 0, castigado_me: 1 })),
  { hasMoroso: false, hasCastigado: true },
);
assert.deepStrictEqual(
  institutionFlags(inst('5', { moroso_mn: 0, moroso_me: 0, castigado_mn: 0, castigado_me: 0 })),
  { hasMoroso: false, hasCastigado: false },
);

// --- retry ---
assert.strictEqual(deriveOpsStatus([inst('1C')]), OPS_STATUS.RETRY_ELIGIBLE);
assert.strictEqual(deriveOpsStatus([inst('2A')]), OPS_STATUS.RETRY_ELIGIBLE);
assert.strictEqual(
  deriveOpsStatus([inst('1C'), inst('2A')]),
  OPS_STATUS.RETRY_ELIGIBLE,
);

// --- reconsultable ---
assert.strictEqual(deriveOpsStatus([inst('2B')]), OPS_STATUS.RECONSULTABLE);
assert.strictEqual(deriveOpsStatus([inst('3')]), OPS_STATUS.RECONSULTABLE);
assert.strictEqual(
  deriveOpsStatus([inst('4', { moroso_mn: 100, castigado_mn: 0, castigado_me: 0 })]),
  OPS_STATUS.RECONSULTABLE,
);
assert.strictEqual(
  deriveOpsStatus([inst('5', { moroso_me: 50, castigado_mn: 0, castigado_me: 0 })]),
  OPS_STATUS.RECONSULTABLE,
);

// --- no auto reconsult ---
assert.strictEqual(
  deriveOpsStatus([inst('4', { castigado_mn: 1 })]),
  OPS_STATUS.NO_AUTO_RECONSULT,
);
assert.strictEqual(
  deriveOpsStatus([inst('5', { castigado_me: 1 })]),
  OPS_STATUS.NO_AUTO_RECONSULT,
);
assert.strictEqual(
  deriveOpsStatus([inst('3'), inst('5', { castigado_mn: 10 })]),
  OPS_STATUS.NO_AUTO_RECONSULT,
);

// --- undefined ---
assert.strictEqual(deriveOpsStatus([inst('5')]), OPS_STATUS.UNDEFINED_CASE);
assert.strictEqual(
  deriveOpsStatus([inst('4')]),
  OPS_STATUS.UNDEFINED_CASE,
  '4 without moroso/castigado is uncovered',
);
assert.strictEqual(
  deriveOpsStatus([inst('2B'), inst('5')]),
  OPS_STATUS.UNDEFINED_CASE,
  '5 without moroso/castigado wins over 2B (step 4 before step 5)',
);

// --- pending ---
assert.strictEqual(deriveOpsStatus(null), OPS_STATUS.BCU_PENDING);
assert.strictEqual(deriveOpsStatus([]), OPS_STATUS.BCU_PENDING);
assert.strictEqual(deriveOpsStatus(undefined), OPS_STATUS.BCU_PENDING);

// --- next review: calendar only, not "today" ---
assert.strictEqual(nextReviewOn('2026-09-02'), '2026-10-05');
assert.strictEqual(nextReviewOn('2026-12-20'), '2027-01-05');
assert.strictEqual(nextReviewOn('2026-10-01'), '2026-11-05');
assert.strictEqual(nextReviewOn('not-a-date'), null);
assert.strictEqual(nextReviewOn(null), null);

const before = nextReviewOn('2026-09-02');
assert.strictEqual(before, '2026-10-05');
assert.strictEqual(
  deriveRejectedOps({
    institutions: [inst('2B')],
    consultedOn: '2026-09-02',
  }).next_review_on,
  '2026-10-05',
);
assert.strictEqual(
  deriveRejectedOps({
    institutions: [inst('1C')],
    consultedOn: '2026-09-02',
  }).next_review_on,
  null,
);
assert.strictEqual(
  deriveRejectedOps({
    institutions: [inst('2B')],
    consultedOn: '2026-09-02',
  }).ops_status,
  OPS_STATUS.RECONSULTABLE,
);

console.log('OK unit-rejected-ops');
