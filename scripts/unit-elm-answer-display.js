'use strict';

/**
 * Rechazados list: one compact line per ELM process, "Sol. N" then its state ("Rechazado · Repetido",
 * "Incierto · Repetido", "Aceptado"), same color classes, full label and original answer in the tooltip. CI detail:
 * ELM's original answer (persisted s1|s2_result_message) "Motivo ELM (S1): …". Once ELM Ops closed
 * the process, the CI detail keeps three separate facts: current state (label), "Resultado
 * original ELM (S1): …" and "Resolución ELM Ops: …". Classification, actions, retry and holds
 * are unchanged; Preaprobados (no `answer` option) renders as before.
 * Pure functions only: no network, no database.
 *
 * Run: node scripts/unit-elm-answer-display.js
 */

const assert = require('assert');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: { port: 3000, nodeEnv: 'test', supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'test' },
};
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from(table) {
      throw new Error('unexpected supabase access in test: ' + table);
    },
    rpc(name) {
      throw new Error('unexpected supabase rpc in test: ' + name);
    },
  },
};

const { S1, S2 } = require('../src/services/elm/constants');
const { computeElmCell } = require('../src/services/elm/listView');
const { summarizeCiElm, resolveRejectedSend } = require('../src/lib/rejectedElmRead');
const { evaluateCiResendHold } = require('../src/lib/rejectedElmResendGuard');
const ElmUi = require('../public/elm-ui-helpers');

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

const NOW = Date.parse('2026-10-09T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function proc(over) {
  return Object.assign(
    {
      id: '00000000-0000-4000-8000-000000000001',
      cz_solicitud_id: 1,
      ci: 1,
      trigger_origin: 'janus_manual',
      created_at: iso(NOW - 3600000),
      s1_status: S1.NOT_STARTED,
      s1_attempts: 1,
      s1_http_status: null,
      s1_error_code: null,
      s1_result_message: null,
      s1_started_at: iso(NOW - 3600000),
      s1_completed_at: iso(NOW - 3599000),
      s1_lease_expires_at: null,
      s2_status: S2.NOT_STARTED,
      s2_result_message: null,
      s2_lease_expires_at: null,
      referred_at: null,
      provider_status: null,
      disbursed_at: null,
      ops_resolved_at: null,
      ops_resolution_code: null,
    },
    over,
  );
}

/** Same values as production (2026-10-09), PII-free. */
const P1423 = proc({
  cz_solicitud_id: 1423,
  ci: 55597953,
  s1_status: S1.REJECTED,
  s1_http_status: 200,
  s1_result_message: 'Repetido. Rechazado',
});
const P1430 = proc({
  cz_solicitud_id: 1430,
  ci: 51001152,
  s1_status: S1.UNKNOWN,
  s1_attempts: 2,
  s1_http_status: 200,
  s1_error_code: 'elm_response_undocumented',
  s1_result_message: 'Repetido. Rechazado',
});

const cellOf = (p, over) =>
  computeElmCell(Object.assign({ process: p, nowMs: NOW, allowSend: true, sendReadiness: { ready: true, reasons: [] }, maxRetryAttempts: 3 }, over));

test('1 solicitud 1423: "Rechazado ELM (S1)" keeps its label and carries ELM\'s exact answer', () => {
  const c = cellOf(P1423);
  assert.strictEqual(c.state, 'rejected');
  assert.strictEqual(c.label, 'Rechazado ELM (S1)');
  assert.deepStrictEqual(c.elm_answer, { step: 's1', message: 'Repetido. Rechazado' });
});

test('2 solicitud 1430: uncertain result shows ELM\'s original answer, still in review', () => {
  const c = cellOf(P1430);
  assert.strictEqual(c.state, 'review');
  assert.strictEqual(c.detail, 's1_unknown');
  assert.strictEqual(c.label, 'Resultado incierto ELM (S1)');
  assert.deepStrictEqual(c.elm_answer, { step: 's1', message: 'Repetido. Rechazado' });
  assert.strictEqual(c.retry, null, 'no retry offered for an uncertain result');
});

test('3 the step is the one that decided the reading (S2 answer for S2 readings)', () => {
  const s2rej = cellOf(proc({ s1_status: S1.ELIGIBLE, s1_result_message: 'Listo para recibir datos en servicio 2', s2_status: S2.REJECTED, s2_result_message: 'Telefono no válido' }));
  assert.deepStrictEqual(s2rej.elm_answer, { step: 's2', message: 'Telefono no válido' });
  const s2unknown = cellOf(proc({ s1_status: S1.ELIGIBLE, s1_result_message: 'Listo para recibir datos en servicio 2', s2_status: S2.UNKNOWN, s2_result_message: 'Algo nuevo' }));
  assert.deepStrictEqual(s2unknown.elm_answer, { step: 's2', message: 'Algo nuevo' });
  const bcu = cellOf(proc({ s1_status: S1.TECHNICAL_ERROR, s1_error_code: 'elm_provider_bcu_error', s1_result_message: 'BCU error' }));
  assert.deepStrictEqual(bcu.elm_answer, { step: 's1', message: 'BCU error' });
});

test('4 no answer without ELM text or outside rejected / review / ops-closed readings', () => {
  const none = [
    ['403 rejected credentials', proc({ s1_status: S1.TECHNICAL_ERROR, s1_http_status: 403, s1_error_code: 'elm_http_auth_rejected' })],
    ['timeout', proc({ s1_status: S1.UNKNOWN, s1_error_code: 'elm_http_timeout' })],
    ['blank text', proc({ s1_status: S1.REJECTED, s1_result_message: '   ' })],
    ['in flight', proc({ s1_status: S1.IN_FLIGHT, s1_lease_expires_at: iso(NOW + 60000), s1_result_message: null })],
    ['S1 favorable', proc({ s1_status: S1.ELIGIBLE, s1_result_message: 'Listo para recibir datos en servicio 2' })],
    ['referred', proc({ s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, s2_result_message: 'Lead Aprobado correctamente', referred_at: iso(NOW) })],
    ['granted', proc({ s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, referred_at: iso(NOW), disbursed_at: iso(NOW) })],
    ['ops closed without ELM text', proc({ s1_status: S1.UNKNOWN, s1_error_code: 'elm_http_timeout', ops_resolved_at: iso(NOW), ops_resolution_code: 'provider_confirmed_not_received' })],
  ];
  for (const [name, p] of none) assert.strictEqual(cellOf(p).elm_answer, null, name);
});

test('5 no technical data or credentials reach the cell', () => {
  const p = proc({
    s1_status: S1.TECHNICAL_ERROR,
    s1_http_status: 403,
    s1_error_code: 'elm_http_auth_rejected',
    s1_response: { error: { code: 'INVALID_LOGIN_ATTEMPT', message: 'Invalid login attempt.' } },
    s1_request: { docNumber: '51001152', mobilePhone: '099000000' },
  });
  const json = JSON.stringify(cellOf(p));
  for (const needle of ['INVALID_LOGIN_ATTEMPT', 'Invalid login', 'docNumber', '099000000', 's1_response', 's1_request']) {
    assert.ok(!json.includes(needle), needle);
  }
  const long = cellOf(proc({ s1_status: S1.REJECTED, s1_result_message: '  ' + 'x'.repeat(500) + '  ' }));
  assert.strictEqual(long.elm_answer.message.length, 200, 'capped, trimmed');
});

test('6 classification, action and retry are unchanged by the answer', () => {
  const variants = [
    P1423,
    P1430,
    proc({ s1_status: S1.TECHNICAL_ERROR, s1_http_status: 403, s1_error_code: 'elm_http_auth_rejected' }),
    proc({ s1_status: S1.REJECTED, s1_result_message: 'Otro texto' }),
  ];
  for (const p of variants) {
    const withText = cellOf(p);
    const noText = cellOf(Object.assign({}, p, { s1_result_message: null }));
    const strip = (c) => Object.assign({}, c, { elm_answer: undefined, state: undefined, detail: undefined, label: undefined, detail_label: undefined, kind: undefined });
    assert.deepStrictEqual(strip(withText), strip(noText), p.cz_solicitud_id + ' action/retry');
  }
  assert.strictEqual(cellOf(proc({ s1_status: S1.REJECTED, s1_result_message: 'Otro texto' })).detail, 's1_rejection_not_definitive');
});

const visible = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
/** Visible state of a single-process row, without its "Sol. N" prefix. */
const stateText = (html) => visible(html).replace(/^Sol\. \d+ /, '');
/** Left column of every grid row ("Sol. N" or '' for a continuation row), in order. */
const targets = (html) => Array.from(html.matchAll(/<span class="rechazados-elm-target">([^<]*)<\/span><span class="rechazados-elm-value">/g), (m) => m[1]);
const gridInner = (html) => html.replace(/^<div class="rechazados-elm-grid">/, '').replace(/<\/div>$/, '');
const rowOf = (cell, send) => ElmUi.rejectedRowElmHtml({ available: true, cell: cell, other_processes: [], send: send || { available: true, candidates: [], retry_candidates: [] } }, 1);

test('7 Rechazados list: solicitud number, then one compact label with state and reason', () => {
  const html = rowOf(cellOf(P1423));
  assert.strictEqual(visible(html), 'Sol. 1423 Rechazado · Repetido', html);
  assert.ok(html.includes('<span class="rechazados-elm-target">Sol. 1423</span>'), html);
  assert.ok(html.includes('class="preaprobados-elm is-rejected is-compact"'), html);
  assert.ok(html.includes('title="Rechazado ELM (S1) · Motivo ELM (S1): Repetido. Rechazado · Origen: Manual (JANUS)"'), 'full label and original answer in the tooltip');
  const uncertain = rowOf(cellOf(P1430));
  assert.strictEqual(visible(uncertain), 'Sol. 1430 Incierto · Repetido', uncertain);
  assert.ok(uncertain.includes('is-review is-compact'), 'yellow');
});

test('8 CI detail: full reason with its step', () => {
  const html = ElmUi.elmCellHtml(cellOf(P1423), { rejectedAt: '2026-10-09T10:00:00', retryCi: 55597953, answer: 'full' });
  assert.ok(html.includes('>Motivo ELM (S1): Repetido. Rechazado</span>'), html);
  const uncertain = ElmUi.elmCellHtml(cellOf(P1430), { retryCi: 51001152, answer: 'full' });
  assert.ok(uncertain.includes('>Respuesta ELM (S1): Repetido. Rechazado</span>'), uncertain);
  const retryable = cellOf(proc({ s1_status: S1.TECHNICAL_ERROR, s1_http_status: 403, s1_error_code: 'elm_http_auth_rejected' }));
  const rhtml = ElmUi.elmCellHtml(retryable, { retryCi: 1, answer: 'full' });
  assert.ok(rhtml.includes('Reintentar ELM') && !rhtml.includes('elm-answer'), 'retry kept, no answer without ELM text');
});

test('9 other solicitud of the CI also shows its answer', () => {
  const s = summarizeCiElm({ ci: 55597953, focusCzIds: [9999], processes: [P1423], nowMs: NOW });
  assert.deepStrictEqual(s.other_processes[0].elm_answer, { step: 's1', message: 'Repetido. Rechazado' });
  const html = ElmUi.rejectedRowElmHtml({ available: true, cell: null, other_processes: s.other_processes, send: null }, 55597953);
  assert.strictEqual(visible(html), 'Sol. 1423 Rechazado · Repetido', html);
  assert.ok(html.includes('title="Rechazado ELM (S1) · Motivo ELM (S1): Repetido. Rechazado · Origen: Manual (JANUS)"'), html);
  assert.strictEqual(ElmUi.elmAnswerText(s.other_processes[0], true), 'Motivo ELM (S1): Repetido. Rechazado');
});

test('10 answer text is escaped', () => {
  const c = cellOf(proc({ s1_status: S1.REJECTED, s1_result_message: '<img src=x onerror=alert(1)> "x"' }));
  const html = ElmUi.elmCellHtml(c, { answer: 'full' });
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &quot;x&quot;'), html);
});

test('11 Preaprobados (no answer option) renders exactly as before', () => {
  const c = cellOf(P1423);
  const html = ElmUi.elmCellHtml(c);
  assert.ok(!html.includes('elm-answer') && !html.includes('Motivo ELM'), html);
  assert.strictEqual(html, ElmUi.elmCellHtml(Object.assign({}, c, { elm_answer: null })));
});

/** 1430 as it would read after "ELM confirmó que no hubo derivación" in ELM Ops (not applied). */
const P1430_CLOSED = Object.assign({}, P1430, {
  ops_resolved_at: '2026-10-09T21:15:00.000Z',
  ops_resolution_code: 'provider_confirmed_no_referral',
  ops_resolution_note: 'Nota interna con 099000000',
});

test('12 ops-closed process keeps ELM\'s original answer apart from the current state', () => {
  const c = cellOf(P1430_CLOSED);
  assert.strictEqual(c.state, 'closed');
  assert.strictEqual(c.detail, 'ops_provider_confirmed_no_referral');
  assert.deepStrictEqual(c.elm_answer, { step: 's1', message: 'Repetido. Rechazado' });
  assert.deepStrictEqual(c.ops_resolution, { code: 'provider_confirmed_no_referral', resolved_at: '2026-10-09T21:15:00.000Z' });
  assert.ok(!JSON.stringify(c).includes('Nota interna') && !JSON.stringify(c).includes('099000000'), 'ops note never exposed');
  assert.strictEqual(cellOf(P1430).ops_resolution, null, 'open process: no resolution');
});

test('13 ops-closed after S2: original answer is the S2 one; without S2 text falls back to S1', () => {
  const s2 = cellOf(proc({ s1_status: S1.ELIGIBLE, s1_result_message: 'Listo para recibir datos en servicio 2', s2_status: S2.REFERRED, s2_result_message: 'Lead Aprobado correctamente', referred_at: iso(NOW), ops_resolved_at: iso(NOW), ops_resolution_code: 'provider_closed_no_loan' }));
  assert.strictEqual(s2.state, 'rejected', 'classification unchanged (post-referral rejection)');
  assert.deepStrictEqual(s2.elm_answer, { step: 's2', message: 'Lead Aprobado correctamente' });
  const s1only = cellOf(proc({ s1_status: S1.ELIGIBLE, s1_result_message: 'Listo para recibir datos en servicio 2', s2_status: S2.UNKNOWN, ops_resolved_at: iso(NOW), ops_resolution_code: 'other' }));
  assert.deepStrictEqual(s1only.elm_answer, { step: 's1', message: 'Listo para recibir datos en servicio 2' });
});

test('14 CI detail: current state, original ELM result and ops resolution, in that order', () => {
  const html = ElmUi.elmCellHtml(cellOf(P1430_CLOSED), { retryCi: 51001152, answer: 'full' });
  const label = cellOf(P1430_CLOSED).label;
  const original = '>Resultado original ELM (S1): Repetido. Rechazado</span>';
  const resolution = '>Resolución ELM Ops: ELM confirmó que no hubo derivación (09/10/2026)</span>';
  assert.strictEqual(label, 'Cerrado ELM: sin derivación');
  assert.ok(html.includes(label), html);
  assert.ok(html.includes(original), html);
  assert.ok(html.includes(resolution), html);
  assert.ok(html.indexOf(original) < html.indexOf(resolution), 'original before resolution');
  assert.ok(!html.includes('Motivo ELM') && !html.includes('Nota interna'), html);
  const s2 = cellOf(proc({ s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, s2_result_message: 'Lead Aprobado correctamente', referred_at: iso(NOW), ops_resolved_at: iso(NOW), ops_resolution_code: 'provider_closed_no_loan' }));
  const s2html = ElmUi.elmCellHtml(s2, { answer: 'full' });
  assert.ok(s2html.includes('>Resultado original ELM (S2): Lead Aprobado correctamente</span>'), 'rejected-by-ops is not "Motivo ELM"');
  assert.ok(s2html.includes('Resolución ELM Ops: ELM cerró el caso sin préstamo'), s2html);
});

test('15 Rechazados list: ops-closed process shows only its current state', () => {
  const html = ElmUi.rejectedRowElmHtml({ available: true, cell: cellOf(P1430_CLOSED), other_processes: [], send: null }, 51001152);
  assert.ok(html.includes(cellOf(P1430_CLOSED).label), html);
  assert.ok(!html.includes('elm-answer'), html);
  const s = summarizeCiElm({ ci: 51001152, focusCzIds: [9999], processes: [P1430_CLOSED], nowMs: NOW });
  const other = ElmUi.rejectedRowElmHtml({ available: true, cell: null, other_processes: s.other_processes, send: null }, 51001152);
  assert.ok(!other.includes('elm-answer'), other);
});

test('16 other solicitud summary carries original answer and resolution, without the note', () => {
  const s = summarizeCiElm({ ci: 51001152, focusCzIds: [9999], processes: [P1430_CLOSED], nowMs: NOW });
  const o = s.other_processes[0];
  assert.strictEqual(ElmUi.elmAnswerText(o, true), 'Resultado original ELM (S1): Repetido. Rechazado');
  assert.strictEqual(ElmUi.opsResolutionText(o), 'Resolución ELM Ops: ELM confirmó que no hubo derivación (09/10/2026)');
  assert.ok(!JSON.stringify(s).includes('Nota interna'), 'ops note never exposed');
  assert.strictEqual(ElmUi.opsResolutionText(Object.assign({}, o, { ops_resolution: null })), '');
});

test('17 classification and action of an ops-closed process are unchanged by the answer', () => {
  const strip = (c) => Object.assign({}, c, { elm_answer: undefined });
  assert.deepStrictEqual(strip(cellOf(P1430_CLOSED)), strip(cellOf(Object.assign({}, P1430_CLOSED, { s1_result_message: null }))));
});

test('18 compact labels per reading keep the current color class', () => {
  const cases = [
    ['referred', proc({ s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, s2_result_message: 'Lead Aprobado correctamente', referred_at: iso(NOW) }), 'Aceptado', 'is-referred'],
    ['granted', proc({ s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, referred_at: iso(NOW), disbursed_at: iso(NOW) }), 'Otorgado', 'is-granted'],
    ['in flight', proc({ s1_status: S1.IN_FLIGHT, s1_lease_expires_at: iso(NOW + 60000) }), 'En evaluación', 'is-in_evaluation'],
    ['S2 rejected', proc({ s1_status: S1.ELIGIBLE, s2_status: S2.REJECTED, s2_result_message: 'Telefono no válido' }), 'Rechazado · Telefono no válido', 'is-rejected'],
    ['technical 403', proc({ s1_status: S1.TECHNICAL_ERROR, s1_http_status: 403, s1_error_code: 'elm_http_auth_rejected' }), 'Error técnico', 'is-review'],
    ['BCU error', proc({ s1_status: S1.TECHNICAL_ERROR, s1_error_code: 'elm_provider_bcu_error', s1_result_message: 'BCU error' }), 'Error técnico · BCU error', 'is-review'],
    ['ops closed', P1430_CLOSED, 'Cerrado · Sin derivación', 'is-closed'],
    ['ops closed no loan', proc({ s1_status: S1.ELIGIBLE, s2_status: S2.REFERRED, s2_result_message: 'Lead Aprobado correctamente', referred_at: iso(NOW), ops_resolved_at: iso(NOW), ops_resolution_code: 'provider_closed_no_loan' }), 'Rechazado · Sin préstamo', 'is-rejected'],
  ];
  for (const [name, p, text, cls] of cases) {
    const html = rowOf(cellOf(p));
    assert.strictEqual(stateText(html), text, name + ': ' + html);
    assert.ok(html.includes(cls + ' ') || html.includes(cls + '"'), name + ' color: ' + html);
  }
});

test('19 visible reason normalized; data and CI detail keep the original text', () => {
  assert.strictEqual(ElmUi.compactReason('Repetido. Rechazado'), 'Repetido');
  assert.strictEqual(ElmUi.compactReason('Repetido. rechazado'), 'Repetido');
  assert.strictEqual(ElmUi.compactReason('Rechazado'), '');
  assert.strictEqual(ElmUi.compactReason('Telefono no válido'), 'Telefono no válido');
  assert.strictEqual(ElmUi.compactReason(null), '');
  const c = cellOf(P1423);
  rowOf(c);
  assert.deepStrictEqual(c.elm_answer, { step: 's1', message: 'Repetido. Rechazado' }, 'cell data untouched');
  assert.ok(ElmUi.elmCellHtml(c, { answer: 'full' }).includes('>Motivo ELM (S1): Repetido. Rechazado</span>'), 'detail unchanged');
});

test('20 list shows no redundant ELM / step / prefix text and no second line', () => {
  for (const p of [P1423, P1430, P1430_CLOSED, proc({ s1_status: S1.TECHNICAL_ERROR, s1_http_status: 403, s1_error_code: 'elm_http_auth_rejected' })]) {
    const html = rowOf(cellOf(p));
    const text = visible(html);
    for (const needle of ['ELM', 'S1', 'S2', 'Motivo', 'Respuesta', 'Resultado']) assert.ok(!text.includes(needle), needle + ' in ' + text);
    assert.ok(!html.includes('elm-answer') && !html.includes('rechazados-elm-stack'), html);
  }
});

test('21 send / retry controls bound to their solicitud; held send is text, never a button', () => {
  const enabledSend = { available: true, candidates: [{ cz_solicitud_id: 1500, enabled: true, rejected_at: '2026-10-01T10:00:00' }], target_cz_id: 1500, retry_candidates: [] };
  const html = rowOf(cellOf(P1423), enabledSend);
  assert.ok(html.includes(gridInner(ElmUi.rejectedSendHtml(1, enabledSend))), 'same send control');
  assert.ok(html.includes('data-action="elm-send"') && html.includes('data-cz-id="1500"') && html.includes('>Enviar a ELM</button>'), html);
  assert.deepStrictEqual(targets(html), ['Sol. 1423', 'Sol. 1500'], 'sent solicitud first, then the other one, each on its row');
  const heldSend = { available: true, candidates: [{ cz_solicitud_id: 1500, enabled: false, reasons: ['elm_ci_recent_send'], until: '2026-11-08' }], retry_candidates: [] };
  const held = rowOf(cellOf(P1423), heldSend);
  assert.ok(held.includes(gridInner(ElmUi.rejectedSendHtml(1, heldSend))), held);
  assert.ok(!held.includes('<button') && !held.includes('Enviar'), 'no send button under a sent solicitud: ' + held);
  assert.ok(held.includes('class="rechazados-elm-blocked" title="Sin enviar (sol. 1500). ELM no admite otro envío de esta CI dentro de los 30 días del anterior; disponible desde el 08/11/2026."'), held);
  assert.strictEqual(visible(held), 'Sol. 1423 Rechazado · Repetido Sol. 1500 Envío desde 08/11');
  const retry = { available: true, candidates: [], retry_candidates: [{ cz_solicitud_id: 1430, enabled: true, expected_attempts: 1 }] };
  const rhtml = rowOf(cellOf(P1430), retry);
  const retryButton = ElmUi.retryButtonHtml(retry.retry_candidates[0], 1);
  assert.ok(rhtml.includes('Sol. 1430</span>') && rhtml.includes(retryButton) && rhtml.includes('data-action="elm-retry"'), rhtml);
  assert.ok(rhtml.includes('<span class="rechazados-elm-target"></span><span class="rechazados-elm-value">' + retryButton + '</span>'), 'retry on the next row, right column, under its own solicitud');
  assert.deepStrictEqual(targets(rhtml), ['Sol. 1430', ''], rhtml);
  assert.ok(!rhtml.includes('elm-send"'), 'no send button with a retry');
});

test('22 CI detail and Preaprobados render exactly as before (no compact)', () => {
  for (const p of [P1423, P1430, P1430_CLOSED]) {
    const c = cellOf(p);
    assert.ok(!ElmUi.elmCellHtml(c).includes('is-compact'));
    assert.ok(!ElmUi.elmCellHtml(c, { answer: 'full', retryCi: 1 }).includes('is-compact'));
    assert.ok(ElmUi.elmCellHtml(c).includes('>' + c.label + '</span>'), 'full label kept');
  }
});

test('23 Mocasist: red "Rechazado · Mocasist" in the list, full reason in the CI detail', () => {
  for (const text of ['Mocasist', 'MOCASIST', '  mocasist  ']) {
    const c = cellOf(proc({ cz_solicitud_id: 1421, ci: 46816299, s1_status: S1.REJECTED, s1_http_status: 200, s1_result_message: text }));
    assert.strictEqual(c.state, 'rejected', text);
    assert.strictEqual(c.label, 'Rechazado ELM (S1)', text);
    const html = rowOf(c);
    assert.strictEqual(visible(html), 'Sol. 1421 Rechazado · ' + text.trim(), html);
    assert.ok(html.includes('class="preaprobados-elm is-rejected is-compact"'), 'red: ' + html);
    assert.ok(ElmUi.elmCellHtml(c, { answer: 'full' }).includes('>Motivo ELM (S1): ' + text.trim() + '</span>'), text);
  }
  const p1421 = proc({ cz_solicitud_id: 1421, ci: 46816299, s1_status: S1.UNKNOWN, s1_http_status: 200, s1_error_code: 'elm_response_undocumented', s1_result_message: 'Mocasist' });
  const historical = rowOf(cellOf(p1421));
  assert.strictEqual(visible(historical), 'Sol. 1421 Incierto · Mocasist', 'persisted unknown row is not reclassified');
  assert.ok(historical.includes('is-review is-compact'), historical);
});

/** List row ELM block as attachElmToRejectedRows builds it: the sent solicitud and an unsent one. */
function sentAndUnsentRow(sent, unsentId) {
  const unsent = computeElmCell({
    process: null,
    czId: unsentId,
    eligibility: { eligible: true, blockers: [] },
    nowMs: NOW,
    allowSend: true,
    sendReadiness: { ready: true, reasons: [] },
  });
  const czId = sent.cz_solicitud_id;
  const resolved = resolveRejectedSend({
    rejected: [{ cz_solicitud_id: czId }, { cz_solicitud_id: unsentId }],
    cells: new Map([[czId, cellOf(sent)], [unsentId, unsent]]),
    hold: evaluateCiResendHold({ ci: sent.ci, processes: [sent], locks: [], nowMs: NOW }),
  });
  return { resolved, elm: { available: true, cell: cellOf(sent, { allowSend: false }), other_processes: [], send: resolved.send } };
}

test('24 production 2026-10-09: sent solicitud shows only its result; the unsent one is held text', () => {
  const sentAt = '2026-10-09T20:53:17.949Z';
  const p1429 = proc({ cz_solicitud_id: 1429, ci: 49658210, created_at: sentAt, s1_started_at: sentAt, s1_completed_at: sentAt, s1_status: S1.REJECTED, s1_http_status: 200, s1_result_message: 'Score bajo' });
  const a = sentAndUnsentRow(p1429, 1231);
  assert.strictEqual(a.elm.send.hold.reason, 'elm_ci_recent_send', 'hold unchanged');
  const html = ElmUi.rejectedRowElmHtml(a.elm, 49658210);
  assert.ok(!html.includes('<button') && !html.includes('Enviar'), html);
  assert.strictEqual(visible(html), 'Sol. 1429 Rechazado · Score bajo Sol. 1231 Envío desde 08/11');
  assert.deepStrictEqual(targets(html), ['Sol. 1429', 'Sol. 1231']);
  assert.ok(html.includes('title="Sin enviar (sol. 1231). ELM no admite otro envío de esta CI dentro de los 30 días del anterior (sol. 1429); disponible desde el 08/11/2026."'), html);
  const d1231 = ElmUi.rejectedDetailCellHtml(a.resolved.solicitudes[1].cell, { retryCi: 49658210, answer: 'full' });
  assert.ok(!d1231.includes('<button') && d1231.includes('>Sin enviar · disponible desde 08/11/2026</span>'), d1231);
  const d1429 = ElmUi.rejectedDetailCellHtml(a.resolved.solicitudes[0].cell, { retryCi: 49658210, answer: 'full' });
  assert.ok(!d1429.includes('<button') && d1429.includes('Rechazado ELM (S1)'), d1429);

  const p1428 = proc({ cz_solicitud_id: 1428, ci: 39236232, created_at: '2026-10-09T20:54:00.146Z', s1_status: S1.UNKNOWN, s1_result_message: null });
  const b = sentAndUnsentRow(p1428, 1427);
  assert.strictEqual(b.elm.send.hold.reason, 'elm_ci_active', 'hold unchanged');
  const bhtml = ElmUi.rejectedRowElmHtml(b.elm, 39236232);
  assert.ok(!bhtml.includes('<button'), bhtml);
  assert.strictEqual(visible(bhtml), 'Sol. 1428 Incierto Sol. 1427 Sin enviar');
  assert.ok(bhtml.includes('title="Sin enviar (sol. 1427). Hay un proceso ELM vigente para esta CI (sol. 1428)."'), bhtml);
});

test('25 enabled and held unsent solicitudes side by side: button only for the enabled one', () => {
  const send = {
    available: true,
    candidates: [
      { cz_solicitud_id: 1600, enabled: true, rejected_at: '2026-10-02T10:00:00' },
      { cz_solicitud_id: 1601, enabled: false, reasons: ['elm_missing_required_fields'] },
    ],
    target_cz_id: 1600,
    needs_selection: false,
    retry_candidates: [],
  };
  const html = ElmUi.rejectedSendHtml(7, send);
  assert.strictEqual((html.match(/<button/g) || []).length, 1, html);
  assert.ok(html.includes('<span class="rechazados-elm-target">Sol. 1600</span><span class="rechazados-elm-value"><button') && html.includes('data-cz-id="1600"') && html.includes('>Enviar a ELM</button>') && html.includes('title="Enviar la solicitud 1600 (rechazada 02/10/2026) a ELM"'), html);
  assert.ok(html.includes('<span class="rechazados-elm-target">Sol. 1601</span><span class="rechazados-elm-value"><span class="rechazados-elm-blocked" title="Sin enviar (sol. 1601). Faltan datos obligatorios de la solicitud.">Sin enviar</span></span>'), html);
  assert.strictEqual(ElmUi.rejectedSendLabel('1601'), 'Enviar sol. 1601');
});

test('26 compact list column: short visible text, full reason only in tooltip / detail, one line per item', () => {
  const fs = require('fs');
  const path = require('path');
  const hint = 'ELM no admite otro envío de esta CI dentro de los 30 días del anterior; disponible desde el 08/11/2026.';
  const held = { available: true, candidates: [{ cz_solicitud_id: 1231, enabled: false, reasons: ['elm_ci_recent_send'], until: '2026-11-08' }], retry_candidates: [] };
  const list = ElmUi.rejectedSendHtml(1, held);
  assert.strictEqual(visible(list), 'Sol. 1231 Envío desde 08/11');
  assert.ok(visible(list).length <= 32, 'fits one line');
  assert.ok(!visible(list).includes('30 días'), 'reason not repeated in the cell');
  assert.ok(list.includes('title="Sin enviar (sol. 1231). ' + hint + '"'), 'full reason in the tooltip');
  const detail = ElmUi.rejectedDetailCellHtml({ kind: 'not_sent', cz_solicitud_id: 1231, action: { show: true, enabled: false, reasons: ['elm_ci_recent_send'], hold: { until: '2026-11-08' } } }, {});
  assert.ok(detail.includes('title="' + hint + '"') && visible(detail) === 'Sin enviar · disponible desde 08/11/2026', detail);
  const single = rowOf(cellOf(P1423));
  assert.ok(!single.includes('rechazados-elm-stack') && (single.match(/rechazados-elm-grid/g) || []).length === 1, 'single process: one grid, no stack');
  assert.deepStrictEqual(targets(single), ['Sol. 1423'], 'single process: one row');
  const css = fs.readFileSync(path.join(__dirname, '../public/mie-dashboard.css'), 'utf8');
  const rule = (sel) => {
    const i = css.indexOf(sel + ' {');
    assert.ok(i >= 0, sel);
    return css.slice(i, css.indexOf('}', i));
  };
  const grid = rule('#mie-dashboard-app .rechazados-elm-grid');
  assert.ok(/grid-template-columns:\s*3rem minmax\(0, 1fr\)/.test(grid), 'fixed-width "Sol. N" column, same in every table row');
  assert.ok(/align-items:\s*center/.test(grid) && /justify-items:\s*start/.test(grid), 'rows centered vertically, values left-aligned');
  assert.ok(/text-align:\s*left/.test(rule('#mie-dashboard-app .ga4-table.rechazados-table .rechazados-col-elm')), 'column left-aligned');
  const blocked = rule('#mie-dashboard-app .rechazados-elm-blocked');
  assert.ok(/white-space:\s*nowrap/.test(blocked) && /text-overflow:\s*ellipsis/.test(blocked), 'held text on one line');
  assert.ok(/white-space:\s*normal/.test(rule('#mie-dashboard-app .rechazados-detail-modal .rechazados-elm-blocked')), 'detail keeps the full text');
  const buttons = rule('#mie-dashboard-app .rechazados-elm-retry');
  assert.ok(/#mie-dashboard-app \.rechazados-elm-send,\r?\n#mie-dashboard-app \.rechazados-elm-retry \{/.test(css), 'send and retry share the one-line rule');
  assert.ok(/white-space:\s*nowrap/.test(buttons) && /text-overflow:\s*ellipsis/.test(buttons), 'button text never wraps nor spills out of the column');
});

test('27 every list cell is the same two-column grid: "Sol. N" left, value right, one row per solicitud', () => {
  const pairs = (html) => {
    assert.ok(/^<div class="rechazados-elm-grid">/.test(html) && html.endsWith('</div>'), 'one grid: ' + html);
    const inner = gridInner(html);
    const t = (inner.match(/<span class="rechazados-elm-target">/g) || []).length;
    const v = (inner.match(/<span class="rechazados-elm-value">/g) || []).length;
    assert.strictEqual(t, v, 'every row has both columns: ' + html);
    assert.ok(inner.startsWith('<span class="rechazados-elm-target">'), 'rows start with the left column: ' + html);
    return targets(html);
  };
  const p1429 = proc({ cz_solicitud_id: 1429, ci: 49658210, s1_status: S1.REJECTED, s1_http_status: 200, s1_result_message: 'Score bajo' });
  const cases = [
    [rowOf(cellOf(P1423)), ['Sol. 1423']],
    [sentAndUnsentRow(p1429, 1231).elm, ['Sol. 1429', 'Sol. 1231']],
    [rowOf(null, { available: true, candidates: [{ cz_solicitud_id: 1600, enabled: true }], target_cz_id: 1600, retry_candidates: [] }), ['Sol. 1600']],
    [rowOf(null, { available: true, candidates: [{ cz_solicitud_id: 1700, enabled: true }, { cz_solicitud_id: 1701, enabled: true }], needs_selection: true, retry_candidates: [] }), ['']],
    [rowOf(null, { available: true, candidates: [], retry_candidates: [] }), ['']],
    [ElmUi.rejectedRowElmHtml({ available: false }, 1), ['']],
    [rowOf(null, { available: true, candidates: [], not_sendable: { cz_solicitud_id: 1800, reason: 'elm_missing_required_fields' }, retry_candidates: [] }), ['Sol. 1800']],
  ];
  for (const [value, expected] of cases) {
    const html = typeof value === 'string' ? value : ElmUi.rejectedRowElmHtml(value, 49658210);
    assert.deepStrictEqual(pairs(html), expected, html);
  }
  const multi = ElmUi.rejectedRowElmHtml({
    available: true,
    cell: cellOf(P1423),
    other_processes: [Object.assign(cellOf(P1430), { cz_solicitud_id: 1430 })],
    send: { available: true, candidates: [{ cz_solicitud_id: 1500, enabled: false, reasons: ['elm_ci_active'] }, { cz_solicitud_id: 1501, enabled: false, reasons: ['elm_ci_active'] }], retry_candidates: [] },
  }, 1);
  assert.deepStrictEqual(pairs(multi), ['Sol. 1423', 'Sol. 1430', 'Sol. 1500', 'Sol. 1501'], 'held solicitudes are no longer grouped: one row each');
  assert.ok(multi.includes('<span class="rechazados-elm-target">Sol. 1500</span><span class="rechazados-elm-value"><span class="rechazados-elm-blocked" title="Sin enviar (sol. 1500). '), multi);

  const s = summarizeCiElm({ ci: 55597953, focusCzIds: [9999], processes: [P1423], nowMs: NOW });
  const others = ElmUi.rejectedOtherProcessesHtml(s.other_processes);
  assert.deepStrictEqual(pairs(others), ['Sol. 1423'], 'CI detail other processes use the same grid');
  assert.ok(others.includes('class="preaprobados-elm is-rejected is-compact"'), others);
  assert.ok(others.includes('<span class="rechazados-elm-note" title="Manual (JANUS) · Motivo ELM (S1): Repetido. Rechazado">'), others);
  assert.strictEqual(ElmUi.rejectedOtherProcessesHtml([]), '');
});

/** Same values as production solicitud 1341 (2026-10-10), PII-free: S1 {"success":true,"result":"Repetido. Aprobado"}. */
const P1341 = proc({
  cz_solicitud_id: 1341,
  s1_status: S1.UNKNOWN,
  s1_http_status: 200,
  s1_error_code: 'elm_response_undocumented',
  s1_result_message: 'Repetido. Aprobado',
});

test('28 "Repetido. Aprobado" stays uncertain and keeps "Aprobado" visible', () => {
  assert.strictEqual(ElmUi.compactReason('Repetido. Aprobado'), 'Repetido. Aprobado');
  const c = cellOf(P1341);
  assert.strictEqual(c.state, 'review');
  assert.strictEqual(c.detail, 's1_unknown');
  assert.strictEqual(c.label, 'Resultado incierto ELM (S1)');
  assert.deepStrictEqual(c.elm_answer, { step: 's1', message: 'Repetido. Aprobado' });
  assert.strictEqual(c.retry, null, 'no retry for an uncertain result');
  const html = rowOf(c);
  assert.strictEqual(visible(html), 'Sol. 1341 Incierto · Repetido. Aprobado', html);
  assert.ok(html.includes('class="preaprobados-elm is-review is-compact is-wrap"'), 'yellow, not accepted / rejected; may wrap so "Aprobado" is never cut: ' + html);
  const css = require('fs').readFileSync(require('path').join(__dirname, '../public/mie-dashboard.css'), 'utf8');
  const wrapRule = css.slice(css.indexOf('.preaprobados-elm.is-compact.is-wrap {'));
  assert.ok(/^\.preaprobados-elm\.is-compact\.is-wrap \{[^}]*white-space:\s*normal;/.test(wrapRule), 'wrap rule present');
  for (const p of [P1423, P1430, proc({ s1_status: S1.REJECTED, s1_result_message: 'Score bajo' })]) {
    assert.ok(!rowOf(cellOf(p)).includes('is-wrap'), 'single-sentence labels stay on one line with ellipsis');
  }
  assert.ok(html.includes('title="Resultado incierto ELM (S1) · Respuesta ELM (S1): Repetido. Aprobado · Origen: Manual (JANUS)"'), html);
  assert.ok(!html.includes('<button'), 'no send / retry button: ' + html);
  const detail = ElmUi.elmCellHtml(c, { retryCi: 1, answer: 'full' });
  assert.ok(detail.includes('>Respuesta ELM (S1): Repetido. Aprobado</span>') && !detail.includes('Reintentar'), detail);
});

test('29 "Repetido. Rechazado" is still a definitive rejection shown as "Rechazado · Repetido"', () => {
  for (const message of ['Repetido. Rechazado', 'Repetido. rechazado']) {
    const c = cellOf(Object.assign({}, P1423, { s1_result_message: message }));
    assert.strictEqual(c.state, 'rejected', message);
    assert.strictEqual(ElmUi.compactReason(message), 'Repetido', message);
    const html = rowOf(c);
    assert.strictEqual(visible(html), 'Sol. 1423 Rechazado · Repetido', html);
    assert.ok(html.includes('class="preaprobados-elm is-rejected is-compact"'), html);
  }
  assert.strictEqual(stateText(rowOf(cellOf(P1430))), 'Incierto · Repetido', 'historical uncertain 1430 unchanged');
});

/** A new S1 "Repetido. Aprobado" as the orchestrator persists it now (1341 stays as stored). */
const PDUP = proc({
  cz_solicitud_id: 1600,
  s1_status: S1.REJECTED,
  s1_http_status: 200,
  s1_error_code: 'elm_s1_duplicate_other_channel',
  s1_result_message: 'Repetido. Aprobado',
});

test('30 new "Repetido. Aprobado" reads "Duplicado · Otro canal": terminal, original answer kept, no actions', () => {
  const c = cellOf(PDUP);
  assert.strictEqual(c.kind, 'closed');
  assert.strictEqual(c.state, 'closed', 'neither accepted, rejected nor uncertain');
  assert.strictEqual(c.detail, 's1_duplicate_other_channel');
  assert.strictEqual(c.label, 'Duplicado · Otro canal');
  assert.deepStrictEqual(c.elm_answer, { step: 's1', message: 'Repetido. Aprobado' });
  assert.strictEqual(c.retry, null, 'no retry');
  assert.strictEqual(c.action.show, false, 'no send');
  const html = rowOf(c);
  assert.strictEqual(visible(html), 'Sol. 1600 Duplicado · Otro canal', html);
  assert.ok(html.includes('class="preaprobados-elm is-closed is-compact"'), html);
  assert.ok(html.includes('title="Duplicado · Otro canal · Respuesta ELM (S1): Repetido. Aprobado · Origen: Manual (JANUS)"'), html);
  assert.ok(!html.includes('<button'), html);
  const detail = ElmUi.elmCellHtml(c, { retryCi: 1, answer: 'full' });
  assert.ok(detail.includes('>Respuesta ELM (S1): Repetido. Aprobado</span>') && !detail.includes('Reintentar'), detail);
  assert.strictEqual(stateText(rowOf(cellOf(P1341))), 'Incierto · Repetido. Aprobado', 'historical 1341 unchanged');

  const msg = ElmUi.sendResultMessage({ ok: true, outcome: 'duplicate_other_channel', cell: c });
  assert.strictEqual(msg.tone, 'warn');
  assert.ok(/aprobado por otro canal/.test(msg.text) && !/rechaz|preaprobado/i.test(msg.text), msg.text);

  const sibling = evaluateCiResendHold({ ci: 1, czSolicitudId: 1601, processes: [PDUP], locks: [], nowMs: NOW });
  assert.ok(sibling && sibling.reason === 'elm_ci_recent_send', 'another solicitud of the CI still waits the ELM window: ' + JSON.stringify(sibling));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
