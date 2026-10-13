'use strict';

/**
 * Regression: ELM S1 result "Mocasist" is a definitive credit rejection (not incierto).
 * Wire classification, commercial read (incl. persisted s1 unknown + message), original text kept.
 *
 * Run: node scripts/unit-elm-s1-mocasist.js
 */

const assert = require('assert');
const { S1, OUTCOME, CODES } = require('../src/services/elm/constants');
const { classifyService1Response } = require('../src/services/elm/client');
const { classifyElmProcess, COMMERCIAL } = require('../src/services/elm/classification');
const { computeElmCell } = require('../src/services/elm/listView');
const ElmUi = require('../public/elm-ui-helpers.js');

const NOW = Date.parse('2026-10-10T15:00:00Z');

function proc(over) {
  return Object.assign(
    {
      cz_solicitud_id: 1421,
      ci: 46816299,
      trigger_origin: 'janus_manual',
      s1_status: S1.UNKNOWN,
      s1_http_status: 200,
      s1_error_code: CODES.RESPONSE_UNDOCUMENTED,
      s1_result_message: 'Mocasist',
      s2_status: 'not_started',
      referred_at: null,
      disbursed_at: null,
    },
    over,
  );
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack : err));
  }
}

test('S1 wire: Mocasist → negative (not unknown)', () => {
  assert.deepStrictEqual(classifyService1Response('Mocasist'), {
    outcome: OUTCOME.NEGATIVE,
    errorCode: null,
  });
});

test('commercial read: persisted unknown + Mocasist → rejected S1, message unchanged', () => {
  const p = proc();
  const c = classifyElmProcess(p, { nowMs: NOW });
  assert.strictEqual(c.state, COMMERCIAL.REJECTED);
  assert.strictEqual(c.detail, 's1_negative');
  assert.strictEqual(p.s1_result_message, 'Mocasist');
});

test('list UI: compact Rechazado · Mocasist (red), not Incierto', () => {
  const cell = computeElmCell({ process: proc(), nowMs: NOW });
  const html = ElmUi.elmCellHtml(cell, { compact: true });
  assert.ok(html.includes('is-rejected'), html);
  assert.ok(!html.includes('is-review'), html);
  assert.ok(html.includes('Rechazado'), html);
  assert.ok(html.includes('Mocasist'), html);
  assert.ok(!html.includes('Incierto'), html);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
