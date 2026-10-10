'use strict';

/**
 * Unit tests: "Resolver ELM" in the Rechazados / Preaprobados solicitud detail
 * (ElmOps.createProcessResolver + dashboard wiring). Fake fetch and a minimal fake DOM; the
 * process views come from the real openProcessView on production-shaped rows. No network.
 *
 * Run: node scripts/unit-elm-resolve-detail.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ElmOps = require('../public/elm-ops');
const { openProcessView } = require('../src/services/elmOps/service');

const NOW = Date.parse('2026-10-10T21:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack : err));
  }
}

function baseRow(czId, ci, over) {
  return Object.assign({
    id: '00000000-0000-4000-8000-' + String(czId).padStart(12, '0'),
    cz_solicitud_id: czId,
    ci: ci,
    trigger_origin: 'janus_manual',
    commercial_origin: null,
    created_at: iso(NOW - 864e5),
    updated_at: iso(NOW - 864e5 + 8000),
    s1_status: 'eligible',
    s1_started_at: iso(NOW - 864e5),
    s1_lease_expires_at: null,
    s2_status: 'unknown',
    s2_http_status: 200,
    s2_error_code: 'elm_response_undocumented',
    s2_response: { result: null, success: true, docNumber: String(ci) },
    s2_result_message: null,
    s2_started_at: iso(NOW - 864e5 + 2000),
    s2_lease_expires_at: null,
    referred_at: null,
    provider_status: null,
    provider_status_at: null,
    disbursed_at: null,
    last_postback_event_id: null,
    last_postback_at: null,
    ops_resolved_at: null,
  }, over);
}
const ACCEPTED = openProcessView(baseRow(1333, 32392154), { nowMs: NOW });
const S1_UNKNOWN = openProcessView(baseRow(1341, 41960071, {
  s1_status: 'unknown', s2_status: 'not_started', s2_http_status: null, s2_error_code: null,
  s2_response: null, s2_started_at: null,
}), { nowMs: NOW });
const NO_S2 = openProcessView(baseRow(1106, 18827733, {
  s2_status: 'not_started', s2_http_status: null, s2_error_code: null, s2_response: null, s2_started_at: null,
}), { nowMs: NOW });

// ---------------------------------------------------------------- minimal fake DOM
function matches(e, sel) {
  return sel.split(',').map((s) => s.trim()).some((s) => {
    const m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (m) return e.attrs[m[1]] !== undefined && (m[2] === undefined || e.attrs[m[1]] === m[2]);
    return e.tag === s;
  });
}
function el(tag, attrs, parent) {
  const e = {
    tag: tag,
    attrs: attrs || {},
    parent: parent || null,
    name: (attrs || {}).name,
    value: (attrs || {}).value,
    getAttribute(n) {
      return this.attrs[n] !== undefined ? this.attrs[n] : null;
    },
    closest(sel) {
      let x = this;
      while (x) {
        if (matches(x, sel)) return x;
        x = x.parent;
      }
      return null;
    },
  };
  return e;
}
function boxOf(czId) {
  return el('div', { 'data-elm-resolve-cz': String(czId) });
}
function formOf(czId, values) {
  const form = el('form', { 'data-elm-ops-form': 'resolve-process' }, boxOf(czId));
  form.elements = {
    resolution_code: { value: values.choice },
    cz_outcome: { value: values.cz_outcome || 'none' },
    note: { value: values.note },
  };
  return form;
}

// ---------------------------------------------------------------- fake fetch
function fakeApi(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const p = url.replace(/^\/preaprobados\/elm-ops/, '');
    calls.push({ method, path: p, body: init && init.body ? JSON.parse(init.body) : null });
    const key = method + ' ' + p.split('?')[0];
    const r = typeof routes[key] === 'function' ? routes[key](calls) : routes[key];
    const out = r || { status: 404, body: {} };
    return { status: out.status, json: async () => out.body };
  };
  return { fetch, calls };
}
function listRoute(items) {
  return { status: 200, body: { ok: true, items: items } };
}

function makeResolver(routes, hooks) {
  const api = fakeApi(routes);
  const h = Object.assign({ changes: 0, resolved: [] }, hooks || {});
  const r = ElmOps.createProcessResolver({
    fetch: api.fetch,
    onChange: () => { h.changes += 1; },
    onResolved: (czId) => { h.resolved.push(czId); },
  });
  return { r, api, h };
}

const ADMIN = { 'GET /assignees': { status: 200, body: { ok: true, items: [] } } };

(async function main() {
  await test('1 form: Aceptado offers closed / other; "loan disbursed" disabled without Convertido; correction kept apart', () => {
    const html = ElmOps.resolveProcessFormHtml(ACCEPTED);
    assert.ok(html.includes('<option value="provider_closed_no_loan">'), html);
    assert.ok(html.includes('<option value="other">'));
    assert.ok(/<option value="provider_loan_disbursed" disabled>[^<]*sin evidencia de otorgamiento<\/option>/.test(html), html);
    assert.ok(html.includes('<optgroup label="Corrección auditada (contradice Aceptado ELM)"><option value="correction:provider_confirmed_not_received">'));
    assert.ok(!html.includes('value="provider_confirmed_not_received">'), 'not an ordinary option');
    const granted = ElmOps.resolveProcessFormHtml(Object.assign({}, ACCEPTED, { elm: Object.assign({}, ACCEPTED.elm, { granted_elm: true }) }));
    assert.ok(granted.includes('<option value="provider_loan_disbursed">'), 'enabled with GRANTED evidence');
    assert.ok(html.includes('No envía nada a ELM') && html.includes('el bloqueo de la CI se recalcula'));
    assert.ok(!html.includes('Deja de bloquear'), 'never promises to free the CI');
  });

  await test('2 form: S1 unknown offers not received / no referral / other; draft restored and escaped', () => {
    assert.deepStrictEqual(S1_UNKNOWN.allowed_resolutions, ['provider_confirmed_not_received', 'provider_confirmed_no_referral', 'other']);
    const html = ElmOps.resolveProcessFormHtml(S1_UNKNOWN, { choice: 'provider_confirmed_no_referral', cz_outcome: 'none', note: '<b>nota</b> de prueba' });
    assert.ok(html.includes('<option value="provider_confirmed_no_referral" selected>'));
    assert.ok(html.includes('&lt;b&gt;nota&lt;/b&gt; de prueba</textarea>'));
    assert.ok(!html.includes('optgroup'), 'no correction outside Aceptado');
    assert.deepStrictEqual(NO_S2.allowed_resolutions, [], '1106-like: nothing to resolve');
  });

  await test('3 load: action only for the solicitud\'s own resolvable process; 1106-like and siblings get nothing', async () => {
    const { r, api, h } = makeResolver(Object.assign({ 'GET /processes': listRoute([ACCEPTED, S1_UNKNOWN, NO_S2]) }, ADMIN));
    assert.strictEqual(r.html(1333), '', 'nothing before loading');
    await r.load();
    assert.strictEqual(h.changes, 1);
    assert.deepStrictEqual(api.calls.map((c) => c.method + ' ' + c.path), ['GET /processes?limit=200', 'GET /assignees']);
    for (const cz of [1333, 1341]) {
      const html = r.html(cz);
      assert.ok(html.includes('data-elm-resolve-cz="' + cz + '"') && html.includes('data-elm-resolve-open="' + cz + '">Resolver ELM</button>'), html);
    }
    assert.ok(r.html(1333).includes('Aceptado ELM (S2, asignado a Copanel)'));
    assert.ok(r.html(1341).includes('Evaluación incierta (S1)'));
    assert.strictEqual(r.html(1106), '', '1106-like: no action');
    assert.strictEqual(r.html(1342), '', 'another solicitud of a blocked CI: no action');
    await r.load();
    assert.strictEqual(api.calls.filter((c) => c.path === '/assignees').length, 1, 'permission read once');
  });

  await test('4 permissions: non-admin sees the pending resolution but no button; no list access → nothing', async () => {
    const viewer = makeResolver({ 'GET /processes': listRoute([S1_UNKNOWN]), 'GET /assignees': { status: 403, body: {} } });
    await viewer.r.load();
    const html = viewer.r.html(1341);
    assert.ok(html.includes('Solo un administrador puede registrar la resolución.') && !html.includes('<button'), html);
    viewer.r.handleClick(el('button', { 'data-elm-resolve-open': '1341' }, boxOf(1341)));
    assert.ok(!viewer.r.html(1341).includes('<form'), 'cannot open the form');
    const none = makeResolver({ 'GET /processes': { status: 403, body: {} }, 'GET /assignees': { status: 403, body: {} } });
    await none.r.load();
    assert.strictEqual(none.r.html(1341), '');
  });

  await test('5 open / type / re-render / cancel keeps the draft only while open', async () => {
    const { r, h } = makeResolver(Object.assign({ 'GET /processes': listRoute([S1_UNKNOWN]) }, ADMIN));
    await r.load();
    assert.strictEqual(r.handleClick(el('button', { 'data-elm-resolve-open': '1341' }, boxOf(1341))), true);
    assert.ok(r.html(1341).includes('data-elm-ops-form="resolve-process"'));
    const box = boxOf(1341);
    assert.strictEqual(r.handleInput(el('select', { name: 'resolution_code', value: 'provider_confirmed_not_received' }, box)), true);
    assert.strictEqual(r.handleInput(el('textarea', { name: 'note', value: 'ELM confirmó por mail que no lo recibió.' }, box)), true);
    assert.strictEqual(r.handleInput(el('input', { name: 'q', value: 'x' })), false, 'other inputs ignored');
    const again = r.html(1341);
    assert.ok(again.includes('<option value="provider_confirmed_not_received" selected>') && again.includes('no lo recibió.</textarea>'), 'host re-render keeps it');
    assert.strictEqual(r.handleClick(el('button', { 'data-elm-ops-action': 'cancel' }, boxOf(1341))), true);
    assert.ok(!r.html(1341).includes('<form') && r.html(1341).includes('Resolver ELM'));
    assert.strictEqual(r.handleClick(el('button', { 'data-action': 'close-detail' })), false, 'host clicks untouched');
    assert.ok(h.changes >= 3);
  });

  await test('6 submit S1 unknown: existing endpoint, seen version, audited note; host refreshes, action disappears', async () => {
    let listed = [S1_UNKNOWN];
    const { r, api, h } = makeResolver(Object.assign({
      'GET /processes': () => listRoute(listed),
      ['POST /processes/' + S1_UNKNOWN.process_id + '/resolve']: () => {
        listed = [];
        return { status: 200, body: { ok: true, status: 'resolved', kind: 's1_unknown' } };
      },
    }, ADMIN));
    await r.load();
    r.handleClick(el('button', { 'data-elm-resolve-open': '1341' }, boxOf(1341)));
    const handled = await r.handleSubmit(formOf(1341, { choice: 'provider_confirmed_not_received', note: 'ELM confirmó por mail que no lo recibió.' }));
    assert.strictEqual(handled, true);
    const post = api.calls.find((c) => c.method === 'POST');
    assert.strictEqual(post.path, '/processes/' + S1_UNKNOWN.process_id + '/resolve');
    assert.deepStrictEqual(post.body, {
      expected_updated_at: S1_UNKNOWN.version,
      resolution_code: 'provider_confirmed_not_received',
      correction: false,
      cz_outcome: 'none',
      note: 'ELM confirmó por mail que no lo recibió.',
    });
    assert.deepStrictEqual(h.resolved, [1341], 'host refreshes its solicitud (no page reload)');
    const html = r.html(1341);
    assert.ok(html.includes('is-ok') && html.includes('Resolución registrada y auditada: ELM confirmó que no recibió el lead.'), html);
    assert.ok(!html.includes('Resolver ELM'), 'resolved process leaves the action');
  });

  await test('7 submit Aceptado correction: correction flag sent; "loan disbursed" without evidence → error, form and draft kept', async () => {
    const { r, api, h } = makeResolver(Object.assign({
      'GET /processes': listRoute([ACCEPTED]),
      ['POST /processes/' + ACCEPTED.process_id + '/resolve']: (calls) => {
        const body = calls[calls.length - 1].body;
        return body.resolution_code === 'provider_loan_disbursed'
          ? { status: 409, body: { ok: false, status: 'evidence_required' } }
          : { status: 200, body: { ok: true, status: 'resolved' } };
      },
    }, ADMIN));
    await r.load();
    r.handleClick(el('button', { 'data-elm-resolve-open': '1333' }, boxOf(1333)));
    r.handleInput(el('textarea', { name: 'note', value: 'Pedido de otorgado sin Convertido.' }, boxOf(1333)));
    await r.handleSubmit(formOf(1333, { choice: 'provider_loan_disbursed', note: 'Pedido de otorgado sin Convertido.' }));
    assert.deepStrictEqual(h.resolved, [], 'nothing to refresh');
    const html = r.html(1333);
    assert.ok(html.includes('is-error') && html.includes('No hay evidencia de otorgamiento'), html);
    assert.ok(html.includes('<form') && html.includes('sin Convertido.</textarea>'), 'form and draft kept');
    await r.handleSubmit(formOf(1333, { choice: 'correction:provider_confirmed_not_received', note: 'ELM confirmó por correo que el lead nunca ingresó a su CRM.' }));
    const last = api.calls.filter((c) => c.method === 'POST').pop();
    assert.deepStrictEqual([last.body.resolution_code, last.body.correction], ['provider_confirmed_not_received', true]);
    assert.ok(r.html(1333).includes('Resolución registrada y auditada: Corrección: ELM confirmó que no recibió el lead.'));
  });

  await test('8 stale / already resolved: form closes, host refreshes, list re-read; a second submit while busy is ignored', async () => {
    let gets = 0;
    const { r, api, h } = makeResolver(Object.assign({
      'GET /processes': () => { gets += 1; return listRoute([S1_UNKNOWN]); },
      ['POST /processes/' + S1_UNKNOWN.process_id + '/resolve']: () => ({ status: 409, body: { ok: false, status: 'stale' } }),
    }, ADMIN));
    await r.load();
    r.handleClick(el('button', { 'data-elm-resolve-open': '1341' }, boxOf(1341)));
    await r.handleSubmit(formOf(1341, { choice: 'other', note: 'Cerrado tras hablar con ELM.' }));
    assert.deepStrictEqual(h.resolved, [1341]);
    assert.strictEqual(gets, 2, 'list re-read after stale');
    const html = r.html(1341);
    assert.ok(html.includes('El caso cambió mientras lo mirabas') && !html.includes('<form'), html);
    assert.strictEqual(await r.handleSubmit(el('form', {}, null)), false, 'foreign forms untouched');
    assert.strictEqual(api.calls.filter((c) => c.method === 'POST').length, 1);

    let release;
    const pending = new Promise((res) => { release = res; });
    let posts = 0;
    const list = fakeApi(Object.assign({ 'GET /processes': listRoute([S1_UNKNOWN]) }, ADMIN));
    const r2 = ElmOps.createProcessResolver({
      fetch: async (url, init) => {
        if (!init || init.method !== 'POST') return list.fetch(url, init);
        posts += 1;
        await pending;
        return { status: 200, json: async () => ({ ok: true, status: 'resolved' }) };
      },
    });
    await r2.load();
    r2.handleClick(el('button', { 'data-elm-resolve-open': '1341' }, boxOf(1341)));
    const first = r2.handleSubmit(formOf(1341, { choice: 'other', note: 'Cerrado tras hablar con ELM.' }));
    await r2.handleSubmit(formOf(1341, { choice: 'other', note: 'Cerrado tras hablar con ELM.' }));
    release();
    await first;
    assert.strictEqual(posts, 1, 'double submit → one POST');
  });

  await test('9 reset clears everything (detail closed / another solicitud opened)', async () => {
    const { r } = makeResolver(Object.assign({ 'GET /processes': listRoute([S1_UNKNOWN]) }, ADMIN));
    await r.load();
    r.handleClick(el('button', { 'data-elm-resolve-open': '1341' }, boxOf(1341)));
    r.reset();
    assert.strictEqual(r.html(1341), '');
  });

  await test('10 dashboard wiring: both details, own solicitudes only, partial refresh, panels stay retired', () => {
    const page = readSrc('public/mie-dashboard.html');
    assert.ok(!page.includes('id="elm-ops-root"'), 'no ELM Ops panel');
    const helpers = page.indexOf('elm-ui-helpers.js');
    const ops = page.indexOf('elm-ops.js');
    const dash = page.indexOf('mie-dashboard.js');
    assert.ok(helpers < ops && ops < dash, 'elm-ops.js loaded as helper before the dashboard');
    assert.strictEqual((page.match(/\?v=20261010-elm-manual-flex/g) || []).length, 4, 'cache version bumped');
    const src = readSrc('public/mie-dashboard.js');
    assert.ok(!src.includes('ElmOps.mount'), 'no ELM Ops panel mounted');
    assert.strictEqual((src.match(/ElmOps\.createProcessResolver\(/g) || []).length, 2, 'Rechazados + Preaprobados');
    assert.ok(/onResolved: function \(\) \{\s*return state\.detailCi \? refreshCiAfterElmAction\(state\.detailCi\) : null;/.test(src), 'Rechazados: re-reads only that CI');
    assert.ok(/return \(d\.elm\.solicitudes \|\| \[\]\)\s*\.map\(function \(s\) \{\s*return elmResolver\.html\(s\.cz_solicitud_id\);/.test(src), 'Rechazados: own rejected solicitudes only');
    assert.ok(src.includes("(elmResolver && state.elmCzId != null ? elmResolver.html(state.elmCzId) : '')"), 'Preaprobados: the detail solicitud only');
    assert.ok(/modalRoot\.addEventListener\('click', function \(ev\) \{\s*elmResolver\.handleClick\(ev\.target\);\s*\}, true\);/.test(src), 'Preaprobados: resolver capture listener');
    assert.ok(!src.includes('aria-label="Detalle preaprobado" onclick="event.stopPropagation()"'), 'Preaprobados: dialog does not swallow the «Cerrar» click');
    assert.ok(src.includes("if (t.classList.contains('ad-modal-backdrop') || t.closest('button[data-action=\"close-modal\"]')) {"), 'Preaprobados: «Cerrar» or the backdrop itself close; clicks inside the dialog do not');
    assert.ok(src.includes('async function postPreaprobadoElmSend(czId, btn)') && src.includes('async function postElmSend(ci, czId, btn)') && src.includes('async function postElmRetry(ci, btn)'), 'send / retry untouched');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
