'use strict';

/**
 * Unit tests for BCU HTML batch classifier (no DB writes).
 * Run: node scripts/unit-bcu-html-batch.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const {
  ACTION,
  discoverLoginServlets,
  classifyHtmlFile,
  summarize,
} = require('./import-bcu-html-batch');
const { PAGE_TYPE } = require('../src/lib/bcuHtmlParser');

const FIX = path.join(__dirname, 'fixtures', 'bcu-html-regression');

// discover
{
  const files = discoverLoginServlets(FIX);
  // fixtures are flat *.html not LoginServlet — expect 0
  assert.ok(Array.isArray(files));
}

// RESULT trusted
{
  const p = path.join(FIX, '51769764.html');
  // copy semantics: classify expects LoginServlet name but reads any path
  const r = classifyHtmlFile(p, new Map());
  assert.strictEqual(r.page_type, PAGE_TYPE.RESULT_PAGE);
  assert.strictEqual(r.trusted, true);
  assert.strictEqual(r.action, ACTION.READY_TO_IMPORT);
  assert.strictEqual(r.ci, 51769764);
  assert.strictEqual(r.captcha_leak, false);
  assert.strictEqual(r.extraction.institutions[0].castigado_por_atraso.mn, 0);
  assert.strictEqual(r.extraction.institutions[0].vigente.mn, null);
}

// CONSULTA skip
{
  const r = classifyHtmlFile(path.join(FIX, '40564987.html'), new Map());
  assert.strictEqual(r.page_type, PAGE_TYPE.CONSULTA_FORM);
  assert.strictEqual(r.action, ACTION.NOT_RESULT_PAGE);
}

// ALREADY when existing map has entry
{
  const map = new Map();
  map.set('51769764|202607', {
    id: 'snap-x',
    source: 'html_import',
    reviewed_payload_sha256: 'a'.repeat(64),
  });
  const r = classifyHtmlFile(path.join(FIX, '51769764.html'), map);
  assert.strictEqual(r.action, ACTION.ALREADY_CONFIRMED);
  assert.strictEqual(r.existing, true);
}

// untrusted B currency
{
  // mutate via temp not needed — use parse override by checking trust on known RESULT with fake: skip
  // Covered in unit-bcu-html-trust.js
}

// error individual: missing file
{
  const r = classifyHtmlFile(path.join(FIX, 'nope.html'), new Map());
  assert.strictEqual(r.action, ACTION.PARSE_FAILED);
}

// summarize
{
  const s = summarize([
    { page_type: PAGE_TYPE.RESULT_PAGE, action: ACTION.READY_TO_IMPORT },
    { page_type: PAGE_TYPE.CONSULTA_FORM, action: ACTION.NOT_RESULT_PAGE },
  ]);
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.READY_TO_IMPORT, 1);
  assert.strictEqual(s.CONSULTA_FORM, 1);
}

console.log('unit-bcu-html-batch: PASS');
