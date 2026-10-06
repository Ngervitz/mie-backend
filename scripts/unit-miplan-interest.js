'use strict';

/**
 * node scripts/unit-miplan-interest.js
 * POST /miplan/v1/interest (Mi Plan waitlist from the Credizona thank-you page).
 * In-memory Supabase fake; no network, no real DB.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORIGIN = 'https://www.credizona.com.uy';
const {
  startLocalMiplanInterestServer,
} = require('./miplan-interest-local-server');

const logger = require('../src/lib/logger');
const capturedLogs = [];
['info', 'warn', 'error'].forEach(function (level) {
  logger[level] = function (message, meta) {
    capturedLogs.push(JSON.stringify({ message: message, meta: meta || {} }));
  };
});

const fetchCalls = [];
const realFetch = global.fetch;

function code() {
  return crypto.randomBytes(32).toString('base64url');
}

let passed = 0;
function ok(name, cond, detail) {
  if (!cond) {
    console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log('PASS ' + name);
}

async function main() {
  const h = await startLocalMiplanInterestServer({ allowedOrigins: null });
  const store = h.store;
  global.fetch = function (url, init) {
    if (String(url).indexOf(h.url) === 0) return realFetch(url, init);
    fetchCalls.push(String(url));
    return Promise.reject(new Error('outbound fetch not allowed'));
  };

  async function post(body, headers, raw) {
    const res = await realFetch(h.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Origin: ORIGIN }, headers || {}),
      body: raw != null ? raw : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_e) { json = null; }
    return { status: res.status, body: json, headers: res.headers };
  }

  try {
    // 1. First registration: identity from the token, timestamp from the server.
    const c1 = code();
    const t1 = store.addToken({ code: c1, ci: 11111111, lrw: 'LRW-111-111-111', cz_solicitud_id: 9001 });
    const before = Date.now();
    const r1 = await post({ handoff_code: c1 });
    const after = Date.now();
    const row1 = store.outreach(11111111);
    ok('first registration -> 200 {ok:true, registered:true} exactly',
      r1.status === 200 && JSON.stringify(r1.body) === '{"ok":true,"registered":true}', r1);
    ok('CORS: allowed origin echoed, no-store', r1.headers.get('access-control-allow-origin') === ORIGIN &&
      r1.headers.get('cache-control') === 'no-store', Object.fromEntries(r1.headers));
    const at1 = row1 && Date.parse(row1.mi_plan_interest_at);
    ok('interest persisted on rejected_ci_outreach for the token CI with server timestamp',
      row1 && at1 >= before - 5 && at1 <= after + 5, row1);
    ok('source / LRW / solicitud come from the token',
      row1.mi_plan_interest_source === 'credizona_rejected_thank_you' &&
      row1.mi_plan_interest_lrw === 'LRW-111-111-111' && row1.mi_plan_interest_cz_solicitud_id === 9001, row1);
    ok('mi_plan_status and Mi Deuda columns keep defaults (separate signal)',
      row1.mi_plan_status === 'not_invited' && row1.mi_plan_updated_at === null &&
      row1.mi_deuda_status === 'not_invited' && row1.mi_deuda_invited_at === null &&
      row1.mi_deuda_responded_at === null && row1.mi_deuda_updated_at === null, row1);
    ok('handoff token not consumed (status issued, redeemed_at null, no RPC)',
      t1.status === 'issued' && t1.redeemed_at === null && store.rpcCalls.length === 0, t1);

    // 2. Replay with the same code: success, nothing changes.
    const snapshot = JSON.stringify(row1);
    const r2 = await post({ handoff_code: c1 });
    ok('second registration (same code) -> same success body', r2.status === 200 &&
      JSON.stringify(r2.body) === '{"ok":true,"registered":true}', r2);
    ok('second registration does not change the stored interest',
      JSON.stringify(Object.assign({}, store.outreach(11111111), { updated_at: null })) ===
      JSON.stringify(Object.assign({}, JSON.parse(snapshot), { updated_at: null })), store.outreach(11111111));

    // 3. Many concurrent clicks with one code -> one interest.
    const c3 = code();
    store.addToken({ code: c3, ci: 33333333, lrw: 'LRW-333' });
    const burst = await Promise.all([1, 2, 3, 4, 5, 6].map(function () { return post({ handoff_code: c3 }); }));
    const rows3 = store.tables.rejected_ci_outreach.filter(function (r) { return r.ci === 33333333; });
    ok('6 concurrent clicks -> all 200, exactly one row with one interest',
      burst.every(function (r) { return r.status === 200 && r.body.ok === true; }) &&
      rows3.length === 1 && rows3[0].mi_plan_interest_at != null, { burst: burst.map(function (r) { return r.status; }), rows3: rows3 });

    // 4. Another code for the same CI (later episode) -> replay; first interest wins.
    const c4 = code();
    store.addToken({ code: c4, ci: 11111111, lrw: 'LRW-111-NEW', cz_solicitud_id: 9002 });
    const r4 = await post({ handoff_code: c4 });
    const row4 = store.outreach(11111111);
    ok('same CI, different handoff -> success, first interest (time/LRW/solicitud) kept',
      r4.status === 200 && row4.mi_plan_interest_lrw === 'LRW-111-111-111' &&
      row4.mi_plan_interest_cz_solicitud_id === 9001 && row4.mi_plan_interest_at === JSON.parse(snapshot).mi_plan_interest_at, row4);

    // 5. Existing outreach row (Mi Plan invited, Mi Deuda accepted) keeps its statuses.
    store.tables.rejected_ci_outreach.push(Object.assign({
      ci: 55555555, mi_plan_status: 'invited', mi_plan_updated_at: '2026-09-01T00:00:00.000Z',
      mi_plan_interest_at: null, mi_plan_interest_source: null, mi_plan_interest_lrw: null,
      mi_plan_interest_cz_solicitud_id: null, mi_deuda_status: 'opt_in_accepted',
      mi_deuda_updated_at: '2026-09-02T00:00:00.000Z', mi_deuda_invited_at: '2026-09-01T00:00:00.000Z',
      mi_deuda_responded_at: '2026-09-02T00:00:00.000Z',
    }));
    const c5 = code();
    store.addToken({ code: c5, ci: 55555555, lrw: 'LRW-555' });
    const r5 = await post({ handoff_code: c5 });
    const row5 = store.outreach(55555555);
    ok('existing outreach row: interest added, Mi Plan status and Mi Deuda opt-in untouched',
      r5.status === 200 && row5.mi_plan_interest_at != null && row5.mi_plan_status === 'invited' &&
      row5.mi_plan_updated_at === '2026-09-01T00:00:00.000Z' && row5.mi_deuda_status === 'opt_in_accepted' &&
      row5.mi_deuda_responded_at === '2026-09-02T00:00:00.000Z', row5);

    // 6. Invalid / unusable handoffs fail closed with {ok:false} only.
    const writesBefore = store.ops.filter(function (o) { return o.op !== 'select'; }).length;
    const cases = [
      ['unknown code', { handoff_code: code() }, 401],
      ['malformed code', { handoff_code: 'abc<script>' }, 400],
      ['missing code', {}, 400],
      ['non-string code', { handoff_code: { $ne: null } }, 400],
    ];
    const expiredCode = code();
    store.addToken({ code: expiredCode, ci: 66666666, expires_at: new Date(Date.now() - 1000).toISOString() });
    cases.push(['expired handoff', { handoff_code: expiredCode }, 401]);
    const revokedCode = code();
    store.addToken({ code: revokedCode, ci: 66666666, status: 'revoked', revoked_at: new Date().toISOString() });
    cases.push(['revoked handoff (re-emitted)', { handoff_code: revokedCode }, 401]);
    const consumedCode = code();
    store.addToken({ code: consumedCode, ci: 66666666, status: 'consumed', redeemed_at: new Date().toISOString() });
    cases.push(['consumed handoff', { handoff_code: consumedCode }, 401]);
    const otherPurpose = code();
    store.addToken({ code: otherPurpose, ci: 66666666, purpose: 'rechazados_survey_invite' });
    cases.push(['handoff of another purpose', { handoff_code: otherPurpose }, 401]);
    const noCi = code();
    store.addToken({ code: noCi, ci: null });
    cases.push(['token without CI (identity unresolvable)', { handoff_code: noCi }, 409]);
    for (let i = 0; i < cases.length; i += 1) {
      const r = await post(cases[i][1]);
      ok('fail closed: ' + cases[i][0] + ' -> ' + cases[i][2] + ' {ok:false}',
        r.status === cases[i][2] && JSON.stringify(r.body) === '{"ok":false}', r);
    }
    const rawCases = [
      ['array body', '[1,2]', 400],
      ['invalid JSON', '{"handoff_code":', 400],
      ['oversized body', JSON.stringify({ handoff_code: code(), pad: 'x'.repeat(2048) }), 413],
    ];
    for (let i = 0; i < rawCases.length; i += 1) {
      const r = await post(null, null, rawCases[i][1]);
      ok('fail closed: ' + rawCases[i][0] + ' -> ' + rawCases[i][2], r.status === rawCases[i][2] &&
        JSON.stringify(r.body) === '{"ok":false}', r);
    }
    ok('no write happened for any rejected request',
      store.ops.filter(function (o) { return o.op !== 'select'; }).length === writesBefore &&
      !store.outreach(66666666), store.ops.slice(-5));

    // 7. Manipulated input: only handoff_code is read.
    const c7 = code();
    store.addToken({ code: c7, ci: 77777777, lrw: 'LRW-777', cz_solicitud_id: 7 });
    const r7 = await post({
      handoff_code: c7, ci: 99999999, email: 'x@y.z', telefono: '099', event_type: 'mi_deuda_opt_in',
      source: 'evil', occurred_at: '2000-01-01T00:00:00Z', mi_plan_interest_at: '2000-01-01T00:00:00Z',
      lrw: 'LRW-EVIL', mi_plan_status: 'active', mi_deuda_status: 'opt_in_accepted',
    });
    const row7 = store.outreach(77777777);
    ok('manipulated fields ignored (CI, source, timestamps, LRW, statuses from token/server only)',
      r7.status === 200 && !store.outreach(99999999) && row7.mi_plan_interest_source === 'credizona_rejected_thank_you' &&
      row7.mi_plan_interest_lrw === 'LRW-777' && Date.parse(row7.mi_plan_interest_at) > Date.parse('2026-01-01') &&
      row7.mi_plan_status === 'not_invited' && row7.mi_deuda_status === 'not_invited', row7);

    // 8. Tables touched / no Mi Plan side effects.
    const touched = Array.from(new Set(store.ops.map(function (o) { return o.table + ':' + o.op; }))).sort();
    ok('only miplan_handoff_tokens:select and rejected_ci_outreach:{select,update,upsert} are touched',
      JSON.stringify(touched) === JSON.stringify([
        'miplan_handoff_tokens:select', 'rejected_ci_outreach:select', 'rejected_ci_outreach:update', 'rejected_ci_outreach:upsert']), touched);
    ok('no token is ever updated (no consume/redeem), no RPC',
      !store.ops.some(function (o) { return o.table === 'miplan_handoff_tokens' && o.op !== 'select'; }) &&
      store.rpcCalls.length === 0, store.rpcCalls);
    ok('no outbound HTTP (no Mi Plan journey / USER_CHOICE / FinancialAction / consent)', fetchCalls.length === 0, fetchCalls);
    const updates = store.ops.filter(function (o) { return o.table === 'rejected_ci_outreach' && o.op === 'update'; });
    ok('updates only write mi_plan_interest_* and are conditional on mi_plan_interest_at IS NULL',
      updates.every(function (u) {
        return Object.keys(u.payload).every(function (k) { return k.indexOf('mi_plan_interest_') === 0; }) &&
          u.filters.some(function (f) { return f.kind === 'is' && f.col === 'mi_plan_interest_at' && f.val === null; });
      }), updates.map(function (u) { return Object.keys(u.payload); }));
    ok('upserts only carry ci and never overwrite (ignoreDuplicates)',
      store.ops.filter(function (o) { return o.op === 'upsert'; }).every(function (u) {
        return JSON.stringify(Object.keys(u.payload)) === '["ci"]';
      }), null);

    // 9. Logs: no raw code, no CI.
    const allLogs = capturedLogs.join('\n');
    ok('logs never contain a raw handoff_code or a CI',
      [c1, c3, c4, c5, c7].every(function (c) { return allLogs.indexOf(c) === -1; }) &&
      ['11111111', '33333333', '55555555', '77777777'].every(function (ci) { return allLogs.indexOf(ci) === -1; }), null);

    // 10. CORS.
    const pre = await realFetch(h.url, { method: 'OPTIONS', headers: {
      Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    ok('preflight from Credizona -> 204 with allow-origin/methods/headers', pre.status === 204 &&
      pre.headers.get('access-control-allow-origin') === ORIGIN && pre.headers.get('access-control-allow-methods') === 'POST' &&
      /content-type/i.test(pre.headers.get('access-control-allow-headers') || ''), pre.status);
    const evilPre = await realFetch(h.url, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    const c10 = code();
    store.addToken({ code: c10, ci: 10101010 });
    const evil = await post({ handoff_code: c10 }, { Origin: 'https://evil.example' });
    ok('non-allowlisted origin -> 403 {ok:false}, no allow-origin, nothing written',
      evilPre.status === 403 && evil.status === 403 && !evil.headers.get('access-control-allow-origin') &&
      !store.outreach(10101010), { pre: evilPre.status, post: evil.status });

    // 11. Backend failures -> 503 {ok:false}.
    const c11 = code();
    store.addToken({ code: c11, ci: 12121212 });
    store.failNext = { table: 'miplan_handoff_tokens', op: 'select' };
    const f1 = await post({ handoff_code: c11 });
    store.failNext = { table: 'rejected_ci_outreach', op: 'update' };
    const f2 = await post({ handoff_code: c11 });
    ok('token lookup / write failures -> 503 {ok:false}', f1.status === 503 && f2.status === 503 &&
      JSON.stringify(f1.body) === '{"ok":false}' && JSON.stringify(f2.body) === '{"ok":false}', [f1, f2]);
    const f3 = await post({ handoff_code: c11 });
    ok('retry after a backend failure succeeds', f3.status === 200 && store.outreach(12121212).mi_plan_interest_at != null, f3);

    // 12. Rate limit.
    h.router.resetRateLimitForTests();
    let last = null;
    for (let i = 0; i < 31; i += 1) last = await post({ handoff_code: 'short' });
    ok('rate limit -> 429 {ok:false} after 30/min per IP', last.status === 429 && JSON.stringify(last.body) === '{"ok":false}', last);
    h.router.resetRateLimitForTests();

    // 13. Consultable from JANUS Rechazados (list + detail + UI helpers).
    const { assembleRejectedList, assembleRejectedDetail } = require('../src/lib/rejectedOpsRead');
    const { OUTREACH_SELECT } = require('../src/lib/rejectedOutreach');
    const H = require('../public/rechazados-helpers.js');
    ok('Rechazados select reads mi_plan_interest_at', /\bmi_plan_interest_at\b/.test(OUTREACH_SELECT), OUTREACH_SELECT);
    const estadoRows = [{ cz_historico_id: 1, cz_solicitud_id: 9001, solicitudes_estados_id: 3, estado: 'NEGADA', fechahora_src: '2026-10-06T12:00:00.000Z' }];
    const solicitudRows = [{ cz_id: 9001, ci: 11111111, nombre: 'Ana', apellido: 'Prueba', fecha_reg: '2026-10-06', solicitudes_estados_id: 3 }];
    const listInput = { estadoRows: estadoRows, solicitudRows: solicitudRows, encuestaRows: [], snapshotRows: [], institutionRows: [],
      outreachRows: [store.outreach(11111111)] };
    const list = assembleRejectedList(listInput);
    const detail = assembleRejectedDetail(Object.assign({ ci: 11111111 }, listInput));
    ok('Rechazados list row exposes mi_plan_interest_at; Mi Plan / Mi Deuda statuses unchanged',
      list.length === 1 && list[0].mi_plan_interest_at === store.outreach(11111111).mi_plan_interest_at &&
      list[0].mi_plan_status === 'not_invited' && list[0].mi_deuda_status === 'not_invited', list[0]);
    ok('Rechazados detail exposes outreach.mi_plan_interest_at',
      detail && detail.outreach.mi_plan_interest_at === store.outreach(11111111).mi_plan_interest_at, detail && detail.outreach);
    const cell = H.miPlanCell(list[0].mi_plan_status, list[0].mi_plan_interest_at);
    const invitedRow = store.outreach(55555555);
    ok('UI: Mi Plan column shows "Interesado" + DD/MM HH:mm; invited keeps precedence; Mi Deuda cell unaffected',
      cell.label === 'Interesado' && cell.kind === 'badge' && cell.badgeClass === 'is-miplan-interest' &&
      /^\d{2}\/\d{2} \d{2}:\d{2}$/.test(cell.dateText) &&
      H.miPlanCell(invitedRow.mi_plan_status, invitedRow.mi_plan_interest_at).label === 'Invitado' &&
      H.miPlanCell('not_invited', null).label === 'Invitar' &&
      H.miDeudaCell('not_invited', false).label === 'Invitar', cell);

    // 14. Mounted before requireAuth (public) with its own small JSON parser.
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    const mountIdx = appSrc.indexOf("'/miplan',");
    ok('app.js mounts /miplan before requireAuth and before the global JSON parser',
      mountIdx !== -1 && mountIdx < appSrc.indexOf('app.use(requireAuth)') &&
      mountIdx < appSrc.indexOf('app.use(express.json());') && /'\/miplan',\s*express\.json\(\{ limit: '1kb' \}\)/.test(appSrc), null);
  } finally {
    global.fetch = realFetch;
    await h.close();
  }
  console.log('\nunit-miplan-interest: ' + passed + ' passed' + (process.exitCode ? ', FAILURES' : ''));
}

main().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
