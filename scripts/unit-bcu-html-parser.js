'use strict';

/**
 * Stage 6D.2 — BCU HTML parser production regression (offline).
 *
 * Fixtures under scripts/fixtures/bcu-html-regression/ are sanitized UTF-8
 * copies of real LoginServlet.html result pages (CAPTCHA / saved-from URL redacted).
 * CONSULTA_FORM fixtures are minimal structural stand-ins (no tokens).
 *
 * Run: node scripts/unit-bcu-html-parser.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  PAGE_TYPE,
  decodeBcuHtml,
  sanitizeBcuHtmlSensitive,
  parseBcuHtml,
  parseBcuHtmlBuffer,
  parseBcuMoneyCell,
  assertNoCaptchaLeak,
} = require('../src/lib/bcuHtmlParser');
const { classifyBcuExtraction } = require('../src/lib/bcuExtractClassify');
const { reconcileSummaryValidationStatus } = require('../src/lib/bcuExtractConfirmGates');
const { RUBRO_KEYS } = require('../src/lib/bcuExtractContract');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'bcu-html-regression');

function loadFixtureHtml(caseId) {
  const p = path.join(FIXTURE_DIR, caseId + '.html');
  const html = fs.readFileSync(p, 'utf8');
  assertNoCaptchaLeak(html, caseId + '.html');
  return html;
}

function presentRubros(obj) {
  const keys = [];
  for (let i = 0; i < RUBRO_KEYS.length; i += 1) {
    const k = RUBRO_KEYS[i];
    const pair = obj && obj[k];
    if (pair && (pair.mn != null || pair.me != null)) keys.push(k);
  }
  return keys;
}

function expectedCiDigits(documentCiRaw) {
  const m = /IDE\s+0*([0-9]{7,8})\b/i.exec(String(documentCiRaw || ''));
  return m ? m[1] : null;
}

function runResultCase(spec) {
  const html = loadFixtureHtml(spec.id);
  const parsed = parseBcuHtml(html, { charset: 'utf-8-fixture' });
  assert.strictEqual(parsed.page_type, PAGE_TYPE.RESULT_PAGE, spec.id + ' page_type');
  assert.ok(parsed.extraction, spec.id + ' extraction present');
  assertNoCaptchaLeak(parsed, spec.id + ' parse output');

  const ex = parsed.extraction;
  assert.strictEqual(ex.extraction_contract_version, 'bcu_v1');
  assert.strictEqual(ex.document_ci_raw, spec.ci);
  assert.strictEqual(ex.period, '202607');
  assert.strictEqual(ex.currency_view_selected, 'MN_PESOS_ME_PESOS');
  assert.strictEqual(ex.institutions.length, spec.institution_count, spec.id + ' inst count');
  assert.deepStrictEqual(
    ex.institutions.map(function (i) {
      return i.category;
    }),
    spec.categories,
    spec.id + ' categories',
  );

  const sumRubros = presentRubros(ex.summary);
  assert.deepStrictEqual(sumRubros, spec.summary_rubros, spec.id + ' summary rubros');

  const classified = classifyBcuExtraction(ex, {
    expected_ci: expectedCiDigits(ex.document_ci_raw),
  });
  const recon = reconcileSummaryValidationStatus(ex);
  assert.strictEqual(classified.classification, spec.classification, spec.id + ' class');
  assert.strictEqual(recon, spec.reconciliation, spec.id + ' recon');
  assert.strictEqual(classified.blockers.length, 0, spec.id + ' blockers');

  return {
    id: spec.id,
    page_type: parsed.page_type,
    institutions: ex.institutions.length,
    reconciliation: recon,
    classification: classified.classification,
    status: 'PASS',
  };
}

// --- money cell unit ---
assert.deepStrictEqual(parseBcuMoneyCell('5,180.88'), {
  value: 5180.88,
  ok: true,
  raw: '5,180.88',
});
assert.deepStrictEqual(parseBcuMoneyCell('0.00'), { value: 0, ok: true, raw: '0.00' });
assert.strictEqual(parseBcuMoneyCell('').ok, false);
assert.strictEqual(parseBcuMoneyCell('').value, null);
assert.strictEqual(parseBcuMoneyCell('abc').value, null);

// --- charset helper (windows-1252 Buffer) ---
const accentBuf = Buffer.from(
  '<meta charset=windows-1252>CR' + String.fromCharCode(0xc9) + 'DITOS REESTRUCTURADOS',
  'binary',
);
const decoded = decodeBcuHtml(accentBuf);
assert.strictEqual(decoded.charset, 'windows-1252');
assert.ok(decoded.html.indexOf('CRÉDITOS REESTRUCTURADOS') >= 0, 'accent decode');

// --- sanitize ---
const dirty =
  '<!-- saved from url=(0500)https://x?g-recaptcha-response=03AFcWeA_FAKE_TOKEN_XXXXXXXX -->';
const clean = sanitizeBcuHtmlSensitive(dirty);
assert.ok(!/03AFcWeA_FAKE/.test(clean));
assert.ok(/REDACTED/.test(clean));
let captcha_leak = false;
try {
  assertNoCaptchaLeak(clean, 'sanitized');
  captcha_leak = false;
} catch (_e) {
  captcha_leak = true;
}
assert.strictEqual(captcha_leak, false);

// --- RESULT cases ---
const RESULT_SPECS = [
  {
    id: '16868094',
    ci: 'UY IDE 000000000016868094',
    institution_count: 5,
    categories: ['5', '3', '5', '5', '5'],
    summary_rubros: [
      'vigente',
      'vigente_no_autoliquidable',
      'moroso',
      'castigado_por_atraso',
    ],
    reconciliation: 'NOT_COMPARABLE',
    classification: 'REVIEW_READY',
  },
  {
    id: '32062278',
    ci: 'UY IDE 000000000032062278',
    institution_count: 3,
    categories: ['3', '5', '5'],
    summary_rubros: ['vigente', 'vigente_no_autoliquidable', 'moroso'],
    reconciliation: 'NOT_COMPARABLE',
    classification: 'REVIEW_READY',
  },
  {
    id: '36692223',
    ci: 'UY IDE 000000000036692223',
    institution_count: 9,
    categories: ['2A', '1C', '2A', '2A', '1C', '3', '2A', '1C', '2A'],
    summary_rubros: ['vigente', 'vigente_no_autoliquidable', 'contingencias'],
    reconciliation: 'MATCH',
    classification: 'REVIEW_READY',
  },
  {
    id: '37403039',
    ci: 'UY IDE 000000000037403039',
    institution_count: 8,
    categories: ['3', '3', '5', '5', '3', '3', '3', '5'],
    summary_rubros: [
      'vigente',
      'vigente_no_autoliquidable',
      'moroso',
      'contingencias',
    ],
    reconciliation: 'NOT_COMPARABLE',
    classification: 'REVIEW_READY',
  },
  {
    id: '50212550',
    ci: 'UY IDE 000000000050212550',
    institution_count: 4,
    categories: ['5', '5', '5', '5'],
    summary_rubros: [
      'vigente',
      'vigente_no_autoliquidable',
      'moroso',
      'castigado_por_atraso',
      'contingencias',
      'creditos_reestructurados',
    ],
    reconciliation: 'NOT_COMPARABLE',
    classification: 'REVIEW_READY',
  },
  {
    id: '51769764',
    ci: 'UY IDE 000000000051769764',
    institution_count: 2,
    categories: ['5', '5'],
    summary_rubros: ['castigado_por_atraso'],
    reconciliation: 'MATCH',
    classification: 'REVIEW_READY',
  },
];

const table = [];
for (let i = 0; i < RESULT_SPECS.length; i += 1) {
  table.push(runResultCase(RESULT_SPECS[i]));
}

// --- strong regression 51769764 ---
(function regression51769764() {
  const html = loadFixtureHtml('51769764');
  const parsed = parseBcuHtml(html);
  const ex = parsed.extraction;
  assert.strictEqual(ex.document_ci_raw, 'UY IDE 000000000051769764');
  assert.strictEqual(ex.period, '202607');
  assert.strictEqual(ex.currency_view_selected, 'MN_PESOS_ME_PESOS');
  assert.strictEqual(ex.institutions.length, 2);

  const santander = ex.institutions[0];
  const oca = ex.institutions[1];
  assert.strictEqual(santander.institution_name_raw, 'Banco Santander S.A.');
  assert.strictEqual(santander.category, '5');
  assert.deepStrictEqual(santander.castigado_por_atraso, { mn: 0, me: 3938.3 });
  assert.strictEqual(santander.vigente.mn, null);
  assert.strictEqual(santander.vigente.me, null);

  assert.strictEqual(oca.institution_name_raw, 'OCA S.A.');
  assert.strictEqual(oca.category, '5');
  assert.deepStrictEqual(oca.castigado_por_atraso, { mn: 5180.88, me: 5683.32 });

  assert.deepStrictEqual(ex.summary.castigado_por_atraso, {
    mn: 5180.88,
    me: 9621.62,
  });
  assert.strictEqual(reconcileSummaryValidationStatus(ex), 'MATCH');
  assert.strictEqual(
    classifyBcuExtraction(ex, { expected_ci: '51769764' }).classification,
    'REVIEW_READY',
  );
})();

// --- dense 50212550: six rubros; VIGENTE ≠ VNA ---
(function dense50212550() {
  const html = loadFixtureHtml('50212550');
  const ex = parseBcuHtml(html).extraction;
  const keys = presentRubros(ex.summary);
  assert.deepStrictEqual(keys, [
    'vigente',
    'vigente_no_autoliquidable',
    'moroso',
    'castigado_por_atraso',
    'contingencias',
    'creditos_reestructurados',
  ]);
  assert.ok(ex.summary.vigente);
  assert.ok(ex.summary.vigente_no_autoliquidable);
  // Fields remain separate objects (not aliased)
  assert.notStrictEqual(ex.summary.vigente, ex.summary.vigente_no_autoliquidable);
  // Observed HTML has both present with values (may be equal numerically — still separate keys)
  assert.ok(ex.summary.vigente.mn != null || ex.summary.vigente.me != null);
  assert.ok(
    ex.summary.vigente_no_autoliquidable.mn != null ||
      ex.summary.vigente_no_autoliquidable.me != null,
  );
  // Absent elsewhere remains null for institutions without that rubro
  const admin = ex.institutions.find(function (i) {
    return /Administradora de Soluciones Integrales/i.test(i.institution_name_raw);
  });
  assert.ok(admin);
  assert.strictEqual(admin.vigente.mn, null);
  assert.strictEqual(admin.vigente.me, null);
  assert.ok(admin.castigado_por_atraso.mn != null || admin.castigado_por_atraso.me != null);
})();

// --- CONSULTA_FORM cases ---
['40564987', '59933359'].forEach(function (id) {
  const html = loadFixtureHtml(id);
  const parsed = parseBcuHtml(html);
  assert.strictEqual(parsed.page_type, PAGE_TYPE.CONSULTA_FORM, id);
  assert.strictEqual(parsed.extraction, null, id + ' no extraction');
  assertNoCaptchaLeak(parsed, id);

  // Must NOT run Stage 1 on null and claim HUMAN_REVIEW for missing currency.
  // Callers should gate on page_type; if classify is invoked on null:
  const classified = classifyBcuExtraction(null);
  assert.strictEqual(classified.classification, 'EXTRACTION_FAILED');
  assert.ok(
    !classified.reason_codes.includes('CURRENCY_VIEW_NOT_MN_PESOS_ME_PESOS'),
    id + ' no misleading currency blocker on null',
  );

  table.push({
    id: id,
    page_type: parsed.page_type,
    institutions: 0,
    reconciliation: 'n/a',
    classification: 'n/a (no extraction)',
    status: 'PASS',
  });
});

// --- captcha_leak global ---
const allFixtureText = fs
  .readdirSync(FIXTURE_DIR)
  .filter(function (f) {
    return f.endsWith('.html');
  })
  .map(function (f) {
    return fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8');
  })
  .join('\n');
assert.strictEqual(
  /g-recaptcha-response=(?!REDACTED)/i.test(allFixtureText),
  false,
);
assert.strictEqual(/03AFcWeA[A-Za-z0-9_-]{20,}/.test(allFixtureText), false);
captcha_leak = false;

console.log(
  JSON.stringify(
    {
      ok: true,
      captcha_leak: captcha_leak,
      cases: table,
    },
    null,
    2,
  ),
);
console.log('unit-bcu-html-parser: PASS');
