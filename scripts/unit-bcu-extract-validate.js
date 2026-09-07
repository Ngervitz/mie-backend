'use strict';

/**
 * Stage 1 — bcu extract validate (offline).
 *
 * REGRESSION_N6_NOT_GENERALIZATION:
 * fixtures under scripts/fixtures/bcu-extract-regression/ are the 6 real BCU
 * pass1 payloads from Stage 0D. They do NOT prove gate sensitivity/specificity.
 *
 * Run: node scripts/unit-bcu-extract-validate.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { moneyToCents, moneySlot } = require('../src/lib/bcuExtractMoney');
const {
  CLASSIFICATION,
  REASON,
  CURRENCY_VIEW_REVIEW_READY,
} = require('../src/lib/bcuExtractContract');
const { runBcuExtractGates } = require('../src/lib/bcuExtractGates');
const { classifyBcuExtraction } = require('../src/lib/bcuExtractClassify');

function baseExtraction(over) {
  return Object.assign(
    {
      extraction_contract_version: 'bcu_v1',
      currency_view_selected: CURRENCY_VIEW_REVIEW_READY,
      period: '202607',
      document_ci_raw: 'UY IDE 000000000045006120',
      institutions: [
        {
          institution_name_raw: 'OCA S.A.',
          category: '1C',
          vigente: { mn: 17.5, me: 0 },
          vigente_no_autoliquidable: { mn: 17.5, me: 0 },
          moroso: { mn: null, me: null },
          castigado_por_atraso: { mn: null, me: null },
          contingencias: { mn: null, me: null },
          creditos_reestructurados: { mn: null, me: null },
        },
      ],
      summary: {
        vigente: { mn: 17.5, me: 0 },
        vigente_no_autoliquidable: { mn: 17.5, me: 0 },
        moroso: { mn: null, me: null },
        castigado_por_atraso: { mn: null, me: null },
        contingencias: { mn: null, me: null },
        creditos_reestructurados: { mn: null, me: null },
      },
      review: { warnings: [], illegible_fields: [] },
    },
    over || {},
  );
}

// --- money / BigInt cents ---
assert.strictEqual(moneyToCents(5723.7).ok, true);
assert.strictEqual(moneyToCents(5723.7).cents, 572370n);
assert.strictEqual(moneyToCents(5723.7).cents, moneyToCents(5723.7).cents);
assert.strictEqual(moneyToCents(0).cents, 0n);
assert.strictEqual(moneyToCents(0.0).cents, 0n);
assert.strictEqual(moneyToCents(10).cents, 1000n);
assert.strictEqual(moneyToCents(10.5).cents, 1050n);
assert.strictEqual(moneyToCents(10.50).cents, 1050n);

assert.strictEqual(moneyToCents(1.234).ok, false);
assert.strictEqual(moneyToCents(1.234).reason, REASON.AMOUNT_PRECISION_INVALID);
assert.strictEqual(moneyToCents(-1).reason, REASON.AMOUNT_NEGATIVE);
assert.strictEqual(moneyToCents(Infinity).reason, REASON.AMOUNT_NOT_FINITE);
assert.strictEqual(moneyToCents('10').reason, REASON.AMOUNT_UNSUPPORTED_TYPE);
assert.strictEqual(moneySlot(null).kind, 'null');
assert.strictEqual(moneySlot(17.5).kind, 'cents');
assert.strictEqual(moneySlot(17.5).cents, 1750n);

// Exact cent equality (no epsilon): 1 cent mismatch
assert.notStrictEqual(moneyToCents(1.0).cents, moneyToCents(1.01).cents);

// --- classification / no auto-persist ---
const clean = classifyBcuExtraction(baseExtraction(), { expected_ci: '45006120' });
assert.strictEqual(clean.classification, CLASSIFICATION.REVIEW_READY);
assert.strictEqual(clean.human_review_required, true);
assert.strictEqual(clean.auto_persist_allowed, false);
assert.ok(!clean.reason_codes.includes(REASON.SUMMARY_DETAIL_MISMATCH));

assert.strictEqual(
  classifyBcuExtraction(null).classification,
  CLASSIFICATION.EXTRACTION_FAILED,
);
assert.strictEqual(
  classifyBcuExtraction({ extraction_contract_version: 'nope' }).classification,
  CLASSIFICATION.EXTRACTION_FAILED,
);

// currency view gate
const usdView = classifyBcuExtraction(
  baseExtraction({ currency_view_selected: 'MN_PESOS_ME_USD' }),
  { expected_ci: '45006120' },
);
assert.strictEqual(usdView.classification, CLASSIFICATION.HUMAN_REVIEW);
assert.ok(
  usdView.reason_codes.includes(REASON.CURRENCY_VIEW_NOT_MN_PESOS_ME_PESOS),
);

const unknownView = classifyBcuExtraction(
  baseExtraction({ currency_view_selected: 'UNKNOWN' }),
  { expected_ci: '45006120' },
);
assert.strictEqual(unknownView.classification, CLASSIFICATION.HUMAN_REVIEW);

// CI mismatch
const ciBad = classifyBcuExtraction(baseExtraction(), { expected_ci: '999' });
assert.strictEqual(ciBad.classification, CLASSIFICATION.HUMAN_REVIEW);
assert.ok(ciBad.reason_codes.includes(REASON.CI_MISMATCH));

// summary/detail mismatch in cents
const mismatch = classifyBcuExtraction(
  baseExtraction({
    summary: Object.assign({}, baseExtraction().summary, {
      vigente: { mn: 17.5, me: 0 },
    }),
    institutions: [
      {
        institution_name_raw: 'A',
        category: '1C',
        vigente: { mn: 10, me: 0 },
        vigente_no_autoliquidable: { mn: 10, me: 0 },
        moroso: { mn: null, me: null },
        castigado_por_atraso: { mn: null, me: null },
        contingencias: { mn: null, me: null },
        creditos_reestructurados: { mn: null, me: null },
      },
      {
        institution_name_raw: 'B',
        category: '1C',
        vigente: { mn: 7.51, me: 0 },
        vigente_no_autoliquidable: { mn: 7.51, me: 0 },
        moroso: { mn: null, me: null },
        castigado_por_atraso: { mn: null, me: null },
        contingencias: { mn: null, me: null },
        creditos_reestructurados: { mn: null, me: null },
      },
    ],
  }),
  { expected_ci: '45006120' },
);
assert.strictEqual(mismatch.classification, CLASSIFICATION.HUMAN_REVIEW);
assert.ok(mismatch.reason_codes.includes(REASON.SUMMARY_DETAIL_MISMATCH));
const mmFinding = mismatch.blockers.find(function (f) {
  return f.reason_code === REASON.SUMMARY_DETAIL_MISMATCH;
});
assert.ok(mmFinding);
assert.strictEqual(mmFinding.detail.delta_cents, '1');

// orphan / inconsistent support (summary numeric + null mix)
const orphan = classifyBcuExtraction(
  baseExtraction({
    document_ci_raw: 'UY IDE 000000000051769764',
    institutions: [
      {
        institution_name_raw: 'BANCO SANTANDER S.A.',
        category: '5',
        vigente: { mn: null, me: null },
        vigente_no_autoliquidable: { mn: null, me: null },
        moroso: { mn: null, me: null },
        castigado_por_atraso: { mn: 0, me: 3938.3 },
        contingencias: { mn: null, me: null },
        creditos_reestructurados: { mn: null, me: null },
      },
      {
        institution_name_raw: 'OCA S.A.',
        category: '5',
        vigente: { mn: null, me: null },
        vigente_no_autoliquidable: { mn: null, me: null },
        moroso: { mn: 0, me: 3938.3 },
        castigado_por_atraso: { mn: 5180.88, me: 5683.32 },
        contingencias: { mn: null, me: null },
        creditos_reestructurados: { mn: null, me: null },
      },
    ],
    summary: {
      vigente: { mn: null, me: null },
      vigente_no_autoliquidable: { mn: null, me: null },
      moroso: { mn: 0, me: 3938.3 },
      castigado_por_atraso: { mn: 5180.88, me: 9621.62 },
      contingencias: { mn: null, me: null },
      creditos_reestructurados: { mn: null, me: null },
    },
  }),
  { expected_ci: '51769764' },
);
assert.strictEqual(orphan.classification, CLASSIFICATION.HUMAN_REVIEW);
assert.ok(
  orphan.reason_codes.includes(REASON.RUBRO_ORPHAN_INCONSISTENT_SUPPORT) ||
    orphan.reason_codes.includes(REASON.SUMMARY_DETAIL_MISMATCH),
);

// origin-blind: same payload without "llm" metadata
const handBuilt = classifyBcuExtraction(baseExtraction(), {
  expected_ci: '45006120',
});
assert.strictEqual(handBuilt.classification, CLASSIFICATION.REVIEW_READY);

// --- REGRESSION n=6 ---
const fixDir = path.join(__dirname, 'fixtures', 'bcu-extract-regression');
const expectedClass = {
  '45006120': CLASSIFICATION.REVIEW_READY,
  '50212550': CLASSIFICATION.HUMAN_REVIEW, // sparse orphan
  '19569164': CLASSIFICATION.HUMAN_REVIEW,
  '50375358': CLASSIFICATION.HUMAN_REVIEW,
  '36692223': CLASSIFICATION.HUMAN_REVIEW, // CI mismatch vs filename
  '51769764': CLASSIFICATION.HUMAN_REVIEW,
};

const files = fs.readdirSync(fixDir).filter(function (f) {
  return f.endsWith('.pass1.json');
});
assert.ok(files.length >= 6, 'expected n=6 regression fixtures');

files.forEach(function (file) {
  const fix = JSON.parse(fs.readFileSync(path.join(fixDir, file), 'utf8'));
  const result = classifyBcuExtraction(fix.extraction, {
    expected_ci: fix.expected_ci,
  });
  const want = expectedClass[fix.case_id];
  assert.ok(want, 'missing expectation for ' + fix.case_id);
  assert.strictEqual(
    result.classification,
    want,
    fix.case_id +
      ' got ' +
      result.classification +
      ' codes=' +
      result.reason_codes.join(','),
  );
  assert.strictEqual(result.human_review_required, true);
  assert.strictEqual(result.auto_persist_allowed, false);
  // No AUTO_* classifications exist
  assert.ok(!String(result.classification).includes('AUTO'));
});

// 517 specifically must not be REVIEW_READY with phantom-style moroso support
const fix517 = JSON.parse(
  fs.readFileSync(path.join(fixDir, '51769764.pass1.json'), 'utf8'),
);
const r517 = classifyBcuExtraction(fix517.extraction, {
  expected_ci: '51769764',
});
assert.notStrictEqual(r517.classification, CLASSIFICATION.REVIEW_READY);

console.log('unit-bcu-extract-validate: OK');
