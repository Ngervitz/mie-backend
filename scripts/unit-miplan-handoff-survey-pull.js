'use strict';

/**
 * node scripts/unit-miplan-handoff-survey-pull.js
 * Redeem-time on-demand /encuestas pull (survey → handoff race).
 * Mocked Supabase + stubbed fetch; no network, no env file.
 */

const assert = require('assert');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
    apifyToken: 'test',
    apifyActorId: 'test',
    sessionSecret: 'test-session',
    cronSecret: null,
    czTrackingHmacSecret: null,
  },
};

process.env.CZ_API_BEARER_TOKEN = 'unit-test-fake-cz-bearer';

const CI = 41234567;
const LRW = 'LRW-396-000-001';

function v1Row(overrides) {
  return Object.assign(
    {
      cz_id: 500,
      ci: CI,
      p1: 'A', p2: 'B', p3: 'C', p4: 'D', p5: 'A',
      p6: 'B', p7: 'C', p8: 'D', p9: 'A', p10: 'B',
      version_cuestionario: 1,
      completed_at: '2026-10-05T14:14:31.000Z',
    },
    overrides || {},
  );
}

function v2Row(overrides) {
  return v1Row(Object.assign({ cz_id: 501, p7: 'H', version_cuestionario: 2 }, overrides || {}));
}

function createStore() {
  const s = {
    tokens: new Map(),
    solicitudes: [],
    encuestas: new Map(),
    cursors: new Map(),
    cursorWrites: [],
    encuestaUpserts: 0,
    rpcCalls: [],
  };

  function run(table, filters, single) {
    if (table === 'cz_funnel_solicitudes') {
      const rows = s.solicitudes
        .filter((r) => r.lrw_id === filters.lrw_id)
        .sort((a, b) => b.cz_id - a.cz_id);
      return { data: single ? rows[0] || null : rows.slice(0, 5), error: null };
    }
    if (table === 'cz_funnel_encuestas') {
      const rows = [...s.encuestas.values()]
        .filter((r) => Number(r.ci) === Number(filters.ci))
        .sort((a, b) => {
          const d = Date.parse(b.completed_at || 0) - Date.parse(a.completed_at || 0);
          return d !== 0 ? d : b.cz_id - a.cz_id;
        });
      return { data: rows.slice(0, 20), error: null };
    }
    if (table === 'miplan_handoff_tokens') {
      const row = s.tokens.get(filters.token_hash) || null;
      return { data: single ? row : row ? [row] : [], error: null };
    }
    if (table === 'cz_funnel_sync_cursors') {
      const row = s.cursors.get(filters.source_name) || null;
      return { data: single ? row : row ? [row] : [], error: null };
    }
    return { data: single ? null : [], error: null };
  }

  s.from = function (table) {
    const filters = {};
    const api = {
      select: () => api,
      eq: (c, v) => {
        filters[c] = v;
        return api;
      },
      order: () => api,
      limit: () => api,
      maybeSingle: () => Promise.resolve(run(table, filters, true)),
      then: (res, rej) => Promise.resolve(run(table, filters, false)).then(res, rej),
      upsert: (rows, spec) => {
        if (table === 'cz_funnel_sync_cursors') {
          s.cursorWrites.push(rows);
          return Promise.resolve({ data: null, error: null });
        }
        if (table === 'cz_funnel_encuestas') {
          assert.strictEqual(spec && spec.onConflict, 'cz_id');
          s.encuestaUpserts += 1;
          for (const r of rows) s.encuestas.set(r.cz_id, Object.assign({}, r));
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: { message: 'unexpected upsert ' + table } });
      },
    };
    return api;
  };

  s.rpc = async function (name, args) {
    s.rpcCalls.push(name);
    if (name !== 'redeem_miplan_handoff_token') {
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    }
    const row = s.tokens.get(args.p_token_hash);
    if (!row || row.status !== 'issued' || row.redeemed_at) return { data: [], error: null };
    row.status = 'consumed';
    row.redeemed_at = new Date().toISOString();
    return { data: [Object.assign({}, row)], error: null };
  };

  return s;
}

let store = createStore();
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from: (...a) => store.from(...a),
    rpc: (...a) => store.rpc(...a),
  },
};

const { PURPOSE } = require('../src/lib/czMiplanHandoffHmac');
const {
  hashToken,
  redeemHandoffToken,
  SURVEY_PULL_TIMEOUT_MS,
} = require('../src/lib/miplanHandoffTokens');
const { pullEncuestasOnDemand, SOURCE_ENCUESTAS } = require('../src/jobs/czFunnelSync');

let tokenSeq = 0;
function freshStore() {
  store = createStore();
  store.solicitudes.push({
    cz_id: 1359,
    ci: CI,
    lrw_id: LRW,
    nombre: 'Test',
    relacion_laboral: 'EPR',
    solicitudes_estados_id: 3,
    synced_at: '2026-10-05T17:10:14.000Z',
  });
  store.cursors.set(SOURCE_ENCUESTAS, {
    source_name: SOURCE_ENCUESTAS,
    last_since: '2026-10-05 14:10:00',
    last_sync_status: 'success',
  });
  return store;
}

function issueToken() {
  tokenSeq += 1;
  const raw = 'unit-raw-token-' + tokenSeq;
  store.tokens.set(hashToken(raw), {
    id: 'tok-' + tokenSeq,
    token_hash: hashToken(raw),
    purpose: PURPOSE,
    external_ref_type: 'lrw',
    external_ref: LRW,
    status: 'issued',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 900000).toISOString(),
  });
  return raw;
}

function spyPull(effect) {
  const spy = async function (opts) {
    spy.calls.push(opts);
    return effect ? effect(opts) : undefined;
  };
  spy.calls = [];
  return spy;
}

function insertEncuesta(row) {
  return function () {
    store.encuestas.set(row.cz_id, Object.assign({}, row));
  };
}

const realFetch = global.fetch;
function stubFetch(handler) {
  const calls = [];
  global.fetch = async function (url, init) {
    calls.push({ url: String(url), init: init });
    return handler(String(url), init);
  };
  return calls;
}
function jsonResponse(body, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    text: async () => JSON.stringify(body),
  };
}
function czItem(row) {
  return Object.assign({ id: row.cz_id, tipo: 'prestamo-rechazado', estado: 'completada' }, row, {
    completed_at: '2026-10-05 14:14:31',
  });
}

async function main() {
  assert.strictEqual(SURVEY_PULL_TIMEOUT_MS, 3000);

  // 1) survey already present → no pull
  {
    freshStore();
    store.encuestas.set(500, v1Row());
    const pull = spyPull();
    const r = await redeemHandoffToken(store, issueToken(), { pullSurveys: pull });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(pull.calls.length, 0, 'no pull when present');
    assert.strictEqual(r.context.survey.source_survey_version, 1);
    assert.deepStrictEqual(r.survey_pull, { outcome: 'not_needed' });
  }

  // 2) ABSENT → pull finds valid V1 → survey V1
  {
    freshStore();
    const pull = spyPull(insertEncuesta(v1Row()));
    const r = await redeemHandoffToken(store, issueToken(), { pullSurveys: pull });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(pull.calls.length, 1);
    assert.strictEqual(pull.calls[0].timeoutMs, 3000, 'default budget 3s');
    assert.strictEqual(r.context.survey.source_survey_version, 1);
    assert.strictEqual(r.context.survey.respuestas.p7, 'C');
    assert.ok(!r.context.survey_handoff);
    assert.strictEqual(r.survey_pull.outcome, 'found');
  }

  // 3) ABSENT → pull finds valid V2 + flag ON → survey V2
  {
    freshStore();
    const pull = spyPull(insertEncuesta(v2Row()));
    const r = await redeemHandoffToken(store, issueToken(), {
      surveyV2Enabled: true,
      pullSurveys: pull,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.context.survey.source_survey_version, 2);
    assert.strictEqual(r.context.survey.loan_purpose, 'recurring_expense_shortfall');
    assert.ok(!Object.prototype.hasOwnProperty.call(r.context.survey.respuestas, 'p7'));
    assert.ok(!r.context.survey_handoff);
  }

  // 4) ABSENT → pull finds valid V2 + flag OFF → withheld survey_v2_handoff_disabled
  for (const opts of [{ surveyV2Enabled: false }, {}]) {
    freshStore();
    const pull = spyPull(insertEncuesta(v2Row()));
    const r = await redeemHandoffToken(
      store,
      issueToken(),
      Object.assign({ pullSurveys: pull }, opts),
    );
    assert.strictEqual(r.ok, true);
    assert.ok(!r.context.survey, 'V2 never delivered while flag off');
    assert.deepStrictEqual(r.context.survey_handoff, {
      status: 'withheld',
      reason: 'survey_v2_handoff_disabled',
      source_survey_version: 2,
    });
  }

  // 5) pull ends without a survey → ABSENT (no survey, no survey_handoff)
  {
    freshStore();
    const pull = spyPull();
    const r = await redeemHandoffToken(store, issueToken(), { pullSurveys: pull });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(pull.calls.length, 1);
    assert.ok(!r.context.survey && !r.context.survey_handoff);
    assert.strictEqual(r.survey_pull.outcome, 'not_found');
  }

  // 6) timeout → ABSENT, redeem continues; a late write does not leak into this context
  {
    freshStore();
    let lateWrite = null;
    const pull = spyPull(
      () =>
        new Promise((resolve) => {
          lateWrite = setTimeout(() => {
            insertEncuesta(v1Row())();
            resolve();
          }, 300);
        }),
    );
    const t0 = Date.now();
    const r = await redeemHandoffToken(store, issueToken(), {
      pullSurveys: pull,
      surveyPullTimeoutMs: 50,
    });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.ok, true);
    assert.ok(elapsed < 250, 'bounded by timeout, took ' + elapsed + 'ms');
    assert.ok(!r.context.survey && !r.context.survey_handoff);
    assert.strictEqual(r.survey_pull.outcome, 'timeout');
    await new Promise((res) => setTimeout(res, 350));
    clearTimeout(lateWrite);
  }

  // 7) Credizona error (async and sync throw) → ABSENT, redeem continues
  for (const thrower of [
    async () => {
      throw new Error('CZ API /encuestas failed: HTTP 500');
    },
    () => {
      throw new Error('sync boom');
    },
  ]) {
    freshStore();
    const r = await redeemHandoffToken(store, issueToken(), { pullSurveys: thrower });
    assert.strictEqual(r.ok, true);
    assert.ok(!r.context.survey && !r.context.survey_handoff);
    assert.strictEqual(r.survey_pull.outcome, 'error');
    assert.ok(r.survey_pull.error.length <= 120);
  }

  // 8) pullSurveys: null disables the pull (explicit opt-out keeps old behavior)
  {
    freshStore();
    const r = await redeemHandoffToken(store, issueToken(), { pullSurveys: null });
    assert.strictEqual(r.ok, true);
    assert.ok(!r.context.survey && !r.context.survey_handoff);
    assert.strictEqual(r.survey_pull.outcome, 'skipped');
  }

  // 9) token stays single-use; second redeem never pulls
  {
    freshStore();
    const pull = spyPull(insertEncuesta(v1Row()));
    const raw = issueToken();
    const r1 = await redeemHandoffToken(store, raw, { pullSurveys: pull });
    const r2 = await redeemHandoffToken(store, raw, { pullSurveys: pull });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.reason, 'already_redeemed');
    assert.strictEqual(r2.status, 409);
    assert.strictEqual(pull.calls.length, 1);

    // failed pull still consumes exactly once
    const raw2 = issueToken();
    const failing = async () => {
      throw new Error('down');
    };
    const f1 = await redeemHandoffToken(store, raw2, { pullSurveys: failing });
    const f2 = await redeemHandoffToken(store, raw2, { pullSurveys: failing });
    assert.strictEqual(f1.ok, true);
    assert.strictEqual(f2.reason, 'already_redeemed');

    // concurrent redeem with pull → exactly one context
    const raw3 = issueToken();
    store.encuestas.clear();
    const slow = spyPull(
      () => new Promise((res) => setTimeout(() => { insertEncuesta(v1Row())(); res(); }, 20)),
    );
    const both = await Promise.all([
      redeemHandoffToken(store, raw3, { pullSurveys: slow }),
      redeemHandoffToken(store, raw3, { pullSurveys: slow }),
    ]);
    assert.strictEqual(both.filter((x) => x.ok).length, 1);
    assert.strictEqual(slow.calls.length, 1);
  }

  // 10) default wiring: real pullEncuestasOnDemand via czFunnelSync (stubbed fetch)
  {
    freshStore();
    const calls = stubFetch(() =>
      jsonResponse({
        data: { items: [czItem(v2Row())], hasMore: false, nextSince: '2026-10-05 14:14:31' },
      }),
    );
    const r = await redeemHandoffToken(store, issueToken(), { surveyV2Enabled: false });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.length, 1, 'one /encuestas page');
    const u = new URL(calls[0].url);
    assert.strictEqual(u.pathname, '/api/encuestas');
    assert.strictEqual(u.searchParams.get('since'), '2026-10-05 14:10:00', 'cron cursor as read floor');
    assert.ok(calls[0].init.signal, 'request is abortable');
    assert.strictEqual(r.context.survey_handoff.reason, 'survey_v2_handoff_disabled');
    assert.strictEqual(store.cursorWrites.length, 0, 'cron cursor never written');
    assert.deepStrictEqual(store.rpcCalls.filter((n) => n !== 'redeem_miplan_handoff_token'), [],
      'no job lock taken');
    assert.strictEqual(store.cursors.get(SOURCE_ENCUESTAS).last_since, '2026-10-05 14:10:00');
  }

  // 11) default wiring timeout: hung Credizona request is aborted, ABSENT
  {
    freshStore();
    let aborted = false;
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    const t0 = Date.now();
    const r = await redeemHandoffToken(store, issueToken(), { surveyPullTimeoutMs: 80 });
    assert.ok(Date.now() - t0 < 1000);
    assert.strictEqual(r.ok, true);
    assert.ok(!r.context.survey && !r.context.survey_handoff);
    assert.strictEqual(r.survey_pull.outcome, 'timeout');
    await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(aborted, true, 'fetch aborted by per-page timeout');
    assert.strictEqual(store.cursorWrites.length, 0);
  }

  // 12) default wiring HTTP error → ABSENT, no cursor write
  {
    freshStore();
    stubFetch(() => jsonResponse({ msg: 'boom' }, 500));
    const r = await redeemHandoffToken(store, issueToken(), {});
    assert.strictEqual(r.ok, true);
    assert.ok(!r.context.survey && !r.context.survey_handoff);
    assert.strictEqual(r.survey_pull.outcome, 'error');
    assert.ok(!/unit-test-fake-cz-bearer/.test(r.survey_pull.error), 'no bearer in error');
    assert.strictEqual(store.cursorWrites.length, 0);
  }

  // 13) pullEncuestasOnDemand idempotent: repeated pulls → one row, cursor untouched
  {
    freshStore();
    const item = czItem(v1Row({ cz_id: 777 }));
    stubFetch(() =>
      jsonResponse({ data: { items: [item], hasMore: true, nextSince: '2026-10-05 14:20:00' } }),
    );
    const a = await pullEncuestasOnDemand({ timeoutMs: 500 });
    const b = await pullEncuestasOnDemand({ timeoutMs: 500 });
    assert.strictEqual(a.itemsUpserted, 1);
    assert.strictEqual(b.itemsUpserted, 1);
    assert.strictEqual(a.incomplete, true, 'single page by default');
    assert.strictEqual(store.encuestas.size, 1);
    assert.strictEqual(store.encuestaUpserts, 2);
    assert.strictEqual(store.cursorWrites.length, 0);
    assert.strictEqual(store.cursors.get(SOURCE_ENCUESTAS).last_since, '2026-10-05 14:10:00');
    assert.strictEqual(store.cursors.get(SOURCE_ENCUESTAS).last_sync_status, 'success');
  }

  global.fetch = realFetch;
  console.log('unit-miplan-handoff-survey-pull: PASS');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
