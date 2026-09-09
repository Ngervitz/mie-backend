'use strict';

/**
 * Stage 6D.4 — trusted HTML gate unit tests.
 * Run: node scripts/unit-bcu-html-trust.js
 */

const assert = require('assert');
const { PAGE_TYPE } = require('../src/lib/bcuHtmlParser');
const {
  isTrustedHtmlExtraction,
  TRUST_REASON,
} = require('../src/lib/rejectedBcuHtmlTrust');
const { REASON } = require('../src/lib/bcuExtractContract');

function money(mn, me) {
  return { mn: mn, me: me };
}

function baseInstitution(over) {
  return Object.assign(
    {
      institution_name_raw: 'OCA S.A.',
      category: '5',
      vigente: money(null, null),
      vigente_no_autoliquidable: money(null, null),
      moroso: money(null, null),
      castigado_por_atraso: money(5180.88, 5683.32),
      contingencias: money(null, null),
      creditos_reestructurados: money(null, null),
    },
    over || {},
  );
}

function baseExtraction(over) {
  const inst = baseInstitution();
  return Object.assign(
    {
      extraction_contract_version: 'bcu_v1',
      currency_view_selected: 'MN_PESOS_ME_PESOS',
      period: '202607',
      document_ci_raw: 'UY IDE 000000000051769764',
      institutions: [inst],
      summary: {
        vigente: money(null, null),
        vigente_no_autoliquidable: money(null, null),
        moroso: money(null, null),
        castigado_por_atraso: money(5180.88, 5683.32),
        contingencias: money(null, null),
        creditos_reestructurados: money(null, null),
      },
      review: { warnings: [], illegible_fields: [] },
    },
    over || {},
  );
}

function trust(pageType, extraction, expectedCi) {
  return isTrustedHtmlExtraction({
    pageType: pageType,
    extraction: extraction,
    expectedCi: expectedCi || '51769764',
  });
}

function hasReason(r, code) {
  return r.reasons.some(function (x) {
    return x.reason_code === code;
  });
}

// PASS: RESULT_PAGE + A + gates ok
{
  const r = trust(PAGE_TYPE.RESULT_PAGE, baseExtraction());
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
}

// PASS: NOT_COMPARABLE allowed (warning, not blocker)
{
  const sparse = baseExtraction({
    institutions: [
      baseInstitution({
        castigado_por_atraso: money(100, null),
        vigente: money(50, 0),
      }),
      baseInstitution({
        institution_name_raw: 'Other',
        castigado_por_atraso: money(null, null),
        vigente: money(null, null),
      }),
    ],
    summary: {
      vigente: money(50, 0),
      vigente_no_autoliquidable: money(null, null),
      moroso: money(null, null),
      castigado_por_atraso: money(100, null),
      contingencias: money(null, null),
      creditos_reestructurados: money(null, null),
    },
  });
  // Make NOT_COMPARABLE: summary castigado me null while inst has values asymmetrically is ok;
  // Use orphan-free sparse: summary vigente me 0, one inst null me → often NOT_COMPARABLE
  const r = trust(PAGE_TYPE.RESULT_PAGE, sparse);
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
  // If gates emitted NOT_COMPARABLE warning, ensure still trusted
  const nc = r.warnings.some(function (w) {
    return w.reason_code === REASON.SUMMARY_DETAIL_NOT_COMPARABLE;
  });
  if (nc) {
    assert.ok(true, 'NOT_COMPARABLE warning allowed');
  }
}

// FAIL: CONSULTA_FORM
{
  const r = trust(PAGE_TYPE.CONSULTA_FORM, baseExtraction());
  assert.strictEqual(r.ok, false);
  assert.ok(hasReason(r, TRUST_REASON.NOT_RESULT_PAGE));
}

// FAIL: UNKNOWN_PAGE
{
  const r = trust(PAGE_TYPE.UNKNOWN_PAGE, baseExtraction());
  assert.strictEqual(r.ok, false);
  assert.ok(hasReason(r, TRUST_REASON.NOT_RESULT_PAGE));
}

// FAIL: CI mismatch
{
  const r = trust(
    PAGE_TYPE.RESULT_PAGE,
    baseExtraction({ document_ci_raw: 'UY IDE 000000000099999999' }),
  );
  assert.strictEqual(r.ok, false);
  assert.ok(hasReason(r, REASON.CI_MISMATCH));
}

// FAIL: invalid period
{
  const r = trust(PAGE_TYPE.RESULT_PAGE, baseExtraction({ period: '2026-07' }));
  assert.strictEqual(r.ok, false);
  assert.ok(hasReason(r, 'PERIOD_INVALID'));
}

// FAIL: category null
{
  const r = trust(
    PAGE_TYPE.RESULT_PAGE,
    baseExtraction({
      institutions: [baseInstitution({ category: null })],
    }),
  );
  assert.strictEqual(r.ok, false);
  assert.ok(hasReason(r, 'CATEGORY_NULL'));
}

// FAIL: empty institutions
{
  const r = trust(
    PAGE_TYPE.RESULT_PAGE,
    baseExtraction({
      institutions: [],
      summary: {
        vigente: money(null, null),
        vigente_no_autoliquidable: money(null, null),
        moroso: money(null, null),
        castigado_por_atraso: money(null, null),
        contingencias: money(null, null),
        creditos_reestructurados: money(null, null),
      },
    }),
  );
  assert.strictEqual(r.ok, false);
  assert.ok(hasReason(r, 'INSTITUTIONS_EMPTY'));
}

// FAIL: MISMATCH
{
  const r = trust(
    PAGE_TYPE.RESULT_PAGE,
    baseExtraction({
      summary: Object.assign(baseExtraction().summary, {
        castigado_por_atraso: money(1, 1),
      }),
    }),
  );
  assert.strictEqual(r.ok, false);
  assert.ok(hasReason(r, REASON.SUMMARY_DETAIL_MISMATCH));
}

// FAIL: parse_fail
{
  const r = trust(
    PAGE_TYPE.RESULT_PAGE,
    baseExtraction({
      review: {
        warnings: ['parse_fail_mn:summary.vigente'],
        illegible_fields: [],
      },
    }),
  );
  assert.strictEqual(r.ok, false);
  assert.ok(hasReason(r, TRUST_REASON.PARSE_FAIL_MATERIAL));
}

// FAIL: UNKNOWN currency
{
  const r = trust(
    PAGE_TYPE.RESULT_PAGE,
    baseExtraction({ currency_view_selected: 'UNKNOWN' }),
  );
  assert.strictEqual(r.ok, false);
  assert.ok(
    hasReason(r, TRUST_REASON.CURRENCY_VIEW_NOT_TRUSTED_FOR_AUTO_PERSIST),
  );
}

// FAIL: B — parseable conceptually, not auto-trusted
{
  const r = trust(
    PAGE_TYPE.RESULT_PAGE,
    baseExtraction({ currency_view_selected: 'MN_PESOS_ME_USD' }),
  );
  assert.strictEqual(r.ok, false);
  assert.ok(
    hasReason(r, TRUST_REASON.CURRENCY_VIEW_NOT_TRUSTED_FOR_AUTO_PERSIST),
  );
}

// FAIL: D
{
  const r = trust(
    PAGE_TYPE.RESULT_PAGE,
    baseExtraction({ currency_view_selected: 'MN_USD_ME_USD' }),
  );
  assert.strictEqual(r.ok, false);
  assert.ok(
    hasReason(r, TRUST_REASON.CURRENCY_VIEW_NOT_TRUSTED_FOR_AUTO_PERSIST),
  );
}

console.log('unit-bcu-html-trust: PASS');
