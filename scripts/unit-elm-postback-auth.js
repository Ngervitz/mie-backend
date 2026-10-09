'use strict';

/**
 * POST /elm/postback authentication (X-Credizona-Postback-Token), end to end on a LOCAL database.
 *
 * Real pieces: route (src/routes/elmPostback.js), token auth (src/lib/elmPostbackToken.js),
 * processor (src/services/elm/postback.js), repository (src/services/elm/repository.js) and the
 * SQL of migrations 1A + 1B + 3A + 3B, run on in-memory PGlite through a minimal supabase-js
 * adapter. HTTP only on 127.0.0.1; every other socket/fetch is blocked and counted.
 *
 * Tokens are generated at runtime (crypto.randomBytes); none is stored in the repository.
 *
 * Run: node scripts/unit-elm-postback-auth.js   (PGLITE_DIR as in db-local-elm-postback-pglite.js)
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const ROOT = path.join(__dirname, '..');
const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');
const MIG = (f) => path.join(ROOT, 'migrations', f);

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
    from(t) {
      throw new Error('default supabase client must not be used: ' + t);
    },
    rpc(n) {
      throw new Error('default supabase client must not be used: ' + n);
    },
  },
};

// ---------------------------------------------------------------------------
// Network guard: loopback HTTP only.
// ---------------------------------------------------------------------------
const externalNet = [];
const origHttpRequest = http.request;
http.request = function guardedRequest(opts) {
  const host = opts && typeof opts === 'object' ? opts.host || opts.hostname : null;
  if (host !== '127.0.0.1') {
    externalNet.push('http.request');
    throw new Error('external network blocked in test');
  }
  return origHttpRequest.apply(this, arguments);
};
for (const [mod, name] of [[https, 'request'], [https, 'get'], [tls, 'connect']]) {
  mod[name] = function blocked() {
    externalNet.push(name);
    throw new Error('external network blocked in test: ' + name);
  };
}
const origNetConnect = net.connect;
net.connect = net.createConnection = function guardedConnect(a, b) {
  const host = a && typeof a === 'object' ? a.host : b;
  if (host !== '127.0.0.1') {
    externalNet.push('net.connect');
    throw new Error('external network blocked in test');
  }
  return origNetConnect.apply(this, arguments);
};
globalThis.fetch = async function blockedFetch() {
  externalNet.push('fetch');
  throw new Error('fetch blocked in test');
};

const express = require('express');
const { CODES } = require('../src/services/elm/constants');
const tokenLib = require('../src/lib/elmPostbackToken');
const { createElmPostbackRouter } = require('../src/routes/elmPostback');
const { createElmPostbackProcessor } = require('../src/services/elm/postback');
const { createElmRepository } = require('../src/services/elm/repository');

const STUBS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE public.dashboard_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
`;
const REQ = JSON.stringify({ docNumber: '12345678', source: 'copanel' });
const newToken = () => crypto.randomBytes(32).toString('hex');
const H = tokenLib.HEADER;

let groups = 0;
function pass(label) {
  groups += 1;
  console.log('ok - ' + label);
}

/** supabase-js surface used by the ELM repository for postbacks, backed by PGlite as service_role. */
function pgliteSupabase(db) {
  const calls = [];
  async function asService(fn) {
    await db.exec('SET ROLE service_role');
    try {
      return await fn();
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const RPC = {
    elm_postback_record_event: [
      'SELECT * FROM public.elm_postback_record_event($1, $2, $3, $4, $5, $6, $7::jsonb)',
      (p) => [p.p_raw_status, p.p_normalized_status, p.p_ci, p.p_provider_external_id, p.p_received_cz_solicitud_id, p.p_provider_event_at, JSON.stringify(p.p_payload)],
    ],
    elm_postback_resolve_event: [
      'SELECT * FROM public.elm_postback_resolve_event($1, $2, $3, $4, $5)',
      (p) => [p.p_event_id, p.p_process_id, p.p_match_method, p.p_unresolved_status, p.p_error_code],
    ],
  };
  return {
    calls,
    from(table) {
      assert.strictEqual(table, 'elm_lead_processes', 'unexpected table ' + table);
      const q = {};
      const b = {
        select() {
          return b;
        },
        eq(col, val) {
          assert.strictEqual(col, 'cz_solicitud_id');
          q.val = val;
          return b;
        },
        async maybeSingle() {
          calls.push('from:' + table);
          const r = await asService(() => db.query('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [q.val]));
          return { data: r.rows[0] || null, error: null };
        },
      };
      return b;
    },
    async rpc(name, params) {
      calls.push('rpc:' + name);
      const spec = RPC[name];
      if (!spec) throw new Error('unexpected rpc ' + name);
      try {
        const r = await asService(() => db.query(spec[0], spec[1](params)));
        return { data: r.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
}

async function main() {
  let PGlite;
  try {
    PGlite = require(PGLITE_DIR).PGlite;
  } catch (e) {
    console.error('PGlite not available at ' + PGLITE_DIR + ' (set PGLITE_DIR). SKIPPED.');
    process.exit(2);
  }
  const db = new PGlite();
  await db.exec(STUBS);
  for (const f of ['20261007_elm_lead_processes.sql', '20261007_elm_postback_events.sql', '20261008_provider_fallback_requests.sql', '20261009_elm_phase3b_operations.sql']) {
    await db.exec(fs.readFileSync(MIG(f), 'utf8'));
  }
  const svc = async (sql, params) => {
    await db.exec('SET ROLE service_role');
    try {
      return await db.query(sql, params || []);
    } finally {
      await db.exec('RESET ROLE');
    }
  };
  async function makeProcess(czId, ci, s2) {
    const claimed = await svc('SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) AS r', [
      czId, ci, 'copanel', 'cz_automatic', null, 6, 'LRW-' + czId, REQ, 300, null,
    ]);
    const id = claimed.rows[0].r.process.id;
    await svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [id, 'eligible', '{}', 200, 'ok', 5, null, null]);
    if (s2 === 'not_started') return id;
    await svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [czId, REQ, 300]);
    if (s2 === 'in_flight') return id;
    await svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [id, s2, '{}', 200, 'ok', 5, null, null]);
    return id;
  }
  const proc = async (czId) => (await db.query('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId])).rows[0];
  const eventCount = async () => (await db.query('SELECT count(*)::int AS n FROM public.elm_postback_events')).rows[0].n;
  async function dbSnapshot() {
    const p = await db.query('SELECT * FROM public.elm_lead_processes ORDER BY cz_solicitud_id');
    const e = await db.query('SELECT * FROM public.elm_postback_events ORDER BY received_at, id');
    return JSON.stringify([p.rows, e.rows]);
  }

  await makeProcess(700, 12345678, 'referred');
  await makeProcess(900, 12345678, 'referred');
  await makeProcess(950, 22222222, 'not_started');
  await makeProcess(970, 33333333, 'rejected');
  await makeProcess(980, 44444444, 'in_flight');

  // App wired like app.js: postback router first, then a global parser + a dashboard gate that
  // rejects everything (a request reaching it would mean the route sits behind dashboard auth).
  const sb = pgliteSupabase(db);
  const logLines = [];
  const logger = {
    info: (m, meta) => logLines.push(m + ' ' + JSON.stringify(meta || {})),
    warn: (m, meta) => logLines.push(m + ' ' + JSON.stringify(meta || {})),
    error: (m, meta) => logLines.push(m + ' ' + JSON.stringify(meta || {})),
  };
  const testEnv = {};
  let dashboardGateHits = 0;
  const app = express();
  app.use(
    '/elm/postback',
    createElmPostbackRouter({
      authenticateElmPostback: tokenLib.createElmPostbackAuthenticator({ env: testEnv }),
      processor: createElmPostbackProcessor({ repository: createElmRepository(sb), logger: logger }),
      logger: logger,
    }),
  );
  app.use(express.json());
  app.use((req, res) => {
    dashboardGateHits += 1;
    res.status(401).json({ error: 'dashboard_auth_required' });
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  function post(headers, body, pathSuffix) {
    return new Promise((resolve, reject) => {
      const data = typeof body === 'string' ? body : JSON.stringify(body || {});
      const req = http.request(
        {
          host: '127.0.0.1',
          port: port,
          method: 'POST',
          path: '/elm/postback' + (pathSuffix || ''),
          headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}),
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(buf);
            } catch (_) {
              json = null;
            }
            resolve({ status: res.statusCode, body: json, raw: buf });
          });
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
  function setTokens(current, previous) {
    for (const k of Object.keys(testEnv)) delete testEnv[k];
    if (current !== undefined) testEnv.ELM_POSTBACK_TOKEN_CURRENT = current;
    if (previous !== undefined) testEnv.ELM_POSTBACK_TOKEN_PREVIOUS = previous;
  }
  const UNAUTHORIZED = { ok: false, error: CODES.POSTBACK_UNAUTHORIZED };
  const NOT_CONFIGURED = { ok: false, error: CODES.POSTBACK_AUTH_NOT_CONFIGURED };
  const matchable = { estado: 'Convertido', internal_id: '700', cedula: '12345678' };
  const usedTokens = [];
  const remember = (t) => (usedTokens.push(t), t);

  try {
    // -----------------------------------------------------------------------
    // Configuration absent / invalid → 503, nothing touched.
    // -----------------------------------------------------------------------
    const A = remember(newToken());
    const B = remember(newToken());
    const before0 = await dbSnapshot();
    const badConfigs = [
      [undefined, undefined, 'token_current_missing'],
      ['   ', undefined, 'token_current_missing'],
      ['not-hex-' + 'a'.repeat(60), undefined, 'token_current_invalid'],
      [A.slice(0, 62), undefined, 'token_current_invalid'],
      [A + 'a', undefined, 'token_current_invalid'],
      [A.repeat(5), undefined, 'token_current_invalid'],
      ['0'.repeat(64), undefined, 'token_current_weak'],
      ['ab'.repeat(32), undefined, 'token_current_weak'],
      [A, 'zz' + B.slice(2), 'token_previous_invalid'],
      [A, B.slice(0, 40), 'token_previous_invalid'],
    ];
    for (const [cur, prev, reason] of badConfigs) {
      setTokens(cur, prev);
      assert.deepStrictEqual(tokenLib.describeElmPostbackTokenConfig(testEnv), { configured: false, reason: reason, acceptedTokens: 0 });
      for (const presented of [A, B, undefined]) {
        const r = await post(presented ? { [H]: presented } : {}, matchable);
        assert.strictEqual(r.status, 503, reason);
        assert.deepStrictEqual(r.body, NOT_CONFIGURED);
      }
    }
    for (const otherVar of tokenLib.OTHER_SECRET_VARS) {
      setTokens(A);
      testEnv[otherVar] = A.toUpperCase();
      assert.strictEqual(tokenLib.describeElmPostbackTokenConfig(testEnv).reason, 'token_current_reused', otherVar);
      assert.strictEqual((await post({ [H]: A }, matchable)).status, 503);
      setTokens(A, B);
      testEnv[otherVar] = B;
      assert.strictEqual(tokenLib.describeElmPostbackTokenConfig(testEnv).reason, 'token_previous_reused', otherVar);
    }
    assert.strictEqual(await dbSnapshot(), before0);
    assert.strictEqual(sb.calls.length, 0, 'no DB access while not configured');
    pass('configuration absent/blank/non-hex/short/odd/too long/weak/reused (current or previous) → 503, zero DB access');

    // Default authenticator reads process.env (and only ELM_POSTBACK_TOKEN_*).
    const defaultAuth = tokenLib.createElmPostbackAuthenticator();
    delete process.env.ELM_POSTBACK_TOKEN_CURRENT;
    delete process.env.ELM_POSTBACK_TOKEN_PREVIOUS;
    assert.strictEqual((await defaultAuth({ headers: { [H]: A } })).status, 503);
    process.env.ELM_POSTBACK_TOKEN_CURRENT = A;
    try {
      assert.deepStrictEqual(await defaultAuth({ headers: { [H]: A } }), { ok: true });
      assert.strictEqual((await defaultAuth({ headers: { [H]: B } })).status, 401);
    } finally {
      delete process.env.ELM_POSTBACK_TOKEN_CURRENT;
    }
    pass('default authenticator reads ELM_POSTBACK_TOKEN_CURRENT from process.env; absent → 503');

    // -----------------------------------------------------------------------
    // Presented token: missing / wrong / malformed → identical 401, nothing touched.
    // -----------------------------------------------------------------------
    setTokens(A, B);
    assert.deepStrictEqual(tokenLib.describeElmPostbackTokenConfig(testEnv), { configured: true, reason: null, acceptedTokens: 2 });
    const before1 = await dbSnapshot();
    const wrong = remember(newToken());
    const rejected = [
      [{}, null],
      [{ [H]: '' }, null],
      [{ [H]: wrong }, null],
      [{ [H]: A.slice(0, 63) }, null],
      [{ [H]: A + '0' }, null],
      [{ [H]: A + '00' }, null],
      [{ [H]: A.slice(0, 32) + ' ' + A.slice(32) }, null],
      [{ [H]: 'Bearer ' + A }, null],
      [{ [H]: A.slice(0, 62) + 'zz' }, null],
      [{ [H]: A + ', ' + B }, null],
      [{ Authorization: 'Bearer ' + A }, null],
      [{ 'X-Postback-Token': A }, null],
      [{}, '?token=' + A],
      [{}, '?X-Credizona-Postback-Token=' + A],
    ];
    for (const [headers, q] of rejected) {
      const r = await post(headers, matchable, q);
      assert.strictEqual(r.status, 401, JSON.stringify(Object.keys(headers)) + (q ? ' query' : ''));
      assert.deepStrictEqual(r.body, UNAUTHORIZED, 'same body for every 401 (no detail)');
    }
    const bodyToken = await post({}, Object.assign({ token: A, [H]: A }, matchable));
    assert.strictEqual(bodyToken.status, 401, 'token in the body is never accepted');
    const notJson = await post({ [H]: wrong }, '{not json');
    assert.strictEqual(notJson.status, 401, 'auth runs before the body is parsed');
    assert.strictEqual(await dbSnapshot(), before1);
    assert.strictEqual(sb.calls.length, 0);
    assert.strictEqual(dashboardGateHits, 0, 'route answered itself; never fell through to dashboard auth');
    pass('token missing / empty / wrong / malformed / other header / query / body → identical 401, body not parsed, zero DB access');

    // timingSafeEqual on equal-length buffers, against every configured token; never for malformed.
    const origTse = crypto.timingSafeEqual;
    const tseCalls = [];
    crypto.timingSafeEqual = function spy(a, b) {
      tseCalls.push([a.length, b.length]);
      return origTse(a, b);
    };
    try {
      const auth = tokenLib.createElmPostbackAuthenticator({ env: testEnv });
      assert.deepStrictEqual(await auth({ headers: { [H]: A } }), { ok: true });
      assert.strictEqual(tseCalls.length, 2, 'compared against both tokens (no early exit)');
      tseCalls.length = 0;
      assert.strictEqual((await auth({ headers: { [H]: wrong } })).reason, 'token_mismatch');
      assert.strictEqual(tseCalls.length, 2);
      assert.ok(tseCalls.every(([x, y]) => x === y));
      tseCalls.length = 0;
      assert.strictEqual((await auth({ headers: { [H]: 'xyz' } })).reason, 'token_malformed');
      assert.strictEqual((await auth({ headers: {} })).reason, 'token_missing');
      setTokens(A + 'ab');
      assert.strictEqual((await auth({ headers: { [H]: A } })).reason, 'token_mismatch');
      assert.strictEqual(tseCalls.length, 0, 'different length → no compare, no throw');
    } finally {
      crypto.timingSafeEqual = origTse;
    }
    const libSrc = fs.readFileSync(path.join(ROOT, 'src/lib/elmPostbackToken.js'), 'utf8');
    assert.ok(/crypto\.timingSafeEqual\(/.test(libSrc));
    assert.ok(!/===\s*presented\.token(?!\.length)|presented\.token\s*[!=]==|\.equals\(/.test(libSrc), 'no plain comparison of token values');
    pass('constant-time compare: timingSafeEqual on equal lengths, every configured token, never on malformed input');

    // -----------------------------------------------------------------------
    // Valid current / previous; rotation without interruption.
    // -----------------------------------------------------------------------
    setTokens(A);
    const ok1 = await post({ [H]: A }, { estado: 'Pendiente de Doc', internal_id: '900', cedula: '1.234.567-8' });
    assert.strictEqual(ok1.status, 200);
    assert.strictEqual(ok1.body.data.processing_status, 'applied');
    assert.strictEqual((await proc(900)).provider_status, 'Pendiente de Doc');
    assert.strictEqual((await post({ [H]: A.toUpperCase() }, { estado: 'Pendiente de Doc', internal_id: '900' })).status, 200, 'hex is case-insensitive');
    assert.strictEqual((await post({ [H]: B }, matchable)).status, 401, 'B not configured yet');

    setTokens(B, A); // rotation: new current, old one still accepted
    assert.strictEqual((await post({ [H]: A }, { estado: 'Aprobado', internal_id: '900' })).status, 200, 'previous valid during rotation');
    assert.strictEqual((await post({ [H]: B }, { estado: 'Aprobado', internal_id: '900' })).status, 200, 'current valid during rotation');
    setTokens(B); // rotation finished: previous removed
    const before2 = await dbSnapshot();
    const stale = await post({ [H]: A }, { estado: 'Convertido', internal_id: '900' });
    assert.strictEqual(stale.status, 401, 'old token rejected once PREVIOUS is removed');
    assert.strictEqual(await dbSnapshot(), before2);
    assert.strictEqual((await post({ [H]: B }, { estado: 'Aprobado', internal_id: '900' })).status, 200);
    setTokens(B, B);
    assert.strictEqual(tokenLib.describeElmPostbackTokenConfig(testEnv).configured, true, 'previous = current is harmless');
    pass('current valid; previous valid during rotation; old token 401 after rotation (no restart, no DB change)');

    // -----------------------------------------------------------------------
    // Authenticated processing on the real SQL: internal_id, duplicates, unknown states, transitions.
    // -----------------------------------------------------------------------
    setTokens(B);
    const auth = { [H]: B };
    const before900 = await proc(900);
    const conv = await post(auth, matchable);
    assert.strictEqual(conv.body.data.processing_status, 'applied');
    assert.strictEqual(conv.body.data.match_method, 'cz_solicitud_id');
    const p700 = await proc(700);
    assert.ok(p700.disbursed_at, 'Convertido → GRANTED ELM on the internal_id process');
    assert.strictEqual(p700.provider_status, 'Convertido');
    assert.strictEqual(JSON.stringify(await proc(900)), JSON.stringify(before900), 'same CI, other solicitud untouched');

    const n0 = await eventCount();
    const dup = await post(auth, matchable);
    assert.strictEqual(dup.status, 200);
    assert.strictEqual(dup.body.data.processing_status, 'ignored_granted');
    const later = await post(auth, { estado: 'Desiste', internal_id: '700' });
    assert.strictEqual(later.body.data.processing_status, 'ignored_granted');
    const p700b = await proc(700);
    assert.strictEqual(String(p700b.disbursed_at), String(p700.disbursed_at));
    assert.strictEqual(p700b.provider_status, 'Convertido');
    assert.strictEqual(p700b.granted_event_id, p700.granted_event_id);
    assert.strictEqual(await eventCount(), n0 + 2, 'every authenticated delivery kept as an event');
    pass('internal_id association; duplicate Convertido and later status → ignored_granted; GRANTED frozen (idempotent)');

    const snapOthers = async () => JSON.stringify((await db.query('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id <> 900 ORDER BY 1')).rows);
    const others = await snapOthers();
    const cases = [
      [{ estado: 'Raro', internal_id: '900' }, 'invalid', CODES.POSTBACK_STATUS_UNKNOWN],
      [{ internal_id: '900' }, 'invalid', CODES.POSTBACK_STATUS_MISSING],
      [{ estado: 'Convertido', TrackingId: '900' }, 'invalid', CODES.POSTBACK_UNDOCUMENTED_FIELD],
      [{ estado: 'Convertido', internal_id: '900', TrackingId: '700' }, 'invalid', CODES.POSTBACK_CZ_ID_INVALID],
      [{ estado: 'Convertido', cedula: '12345678' }, 'unmatched', CODES.POSTBACK_CZ_ID_MISSING],
      [{ estado: 'Convertido', internal_id: '123456' }, 'unmatched', CODES.POSTBACK_CZ_ID_NOT_FOUND],
      [{ estado: 'Convertido', internal_id: '900', cedula: '99999999' }, 'unmatched', CODES.POSTBACK_CI_MISMATCH],
      [{ estado: 'Convertido', internal_id: '950' }, 'unmatched', CODES.POSTBACK_PROCESS_NOT_COMPATIBLE],
      [{ estado: 'Convertido', internal_id: '970' }, 'unmatched', CODES.POSTBACK_PROCESS_NOT_COMPATIBLE],
      [{ estado: 'Convertido', internal_id: '980' }, 'unmatched', CODES.POSTBACK_PROCESS_NOT_COMPATIBLE],
    ];
    const p900 = JSON.stringify(await proc(900));
    for (const [body, status, code] of cases) {
      const r = await post(auth, body);
      assert.strictEqual(r.status, 200, JSON.stringify(body));
      assert.strictEqual(r.body.data.processing_status, status, JSON.stringify(body));
      assert.strictEqual(r.body.data.error_code, code, JSON.stringify(body));
    }
    assert.strictEqual(JSON.stringify(await proc(900)), p900, 'invalid/unmatched never mutate');
    assert.strictEqual(await snapOthers(), others);
    const newer = await post(auth, { estado: 'Aprobado', internal_id: '900', event_at: new Date(Date.now() + 60000).toISOString() });
    assert.strictEqual(newer.body.data.processing_status, 'applied');
    const older = await post(auth, { estado: 'Inicial', internal_id: '900', event_at: new Date(Date.now() - 86400000).toISOString() });
    assert.strictEqual(older.body.data.processing_status, 'stale', 'older status never overwrites a newer one');
    assert.strictEqual((await proc(900)).provider_status, 'Aprobado');
    assert.strictEqual((await proc(900)).disbursed_at, null, 'non-Convertido never GRANTED');
    pass('unknown/missing state, undocumented or contradictory id → invalid; S2 not started / rejected / in_flight → unmatched; older → stale');

    const badJson = await post(auth, '{not json');
    assert.strictEqual(badJson.status, 400);
    assert.deepStrictEqual(badJson.body, { ok: false, error: CODES.POSTBACK_BODY_INVALID });
    const big = await post(auth, JSON.stringify({ estado: 'Aprobado', internal_id: '900', blob: 'x'.repeat(70 * 1024) }));
    assert.strictEqual(big.status, 413);
    assert.deepStrictEqual(big.body, { ok: false, error: CODES.POSTBACK_BODY_TOO_LARGE });
    pass('authenticated but unparseable / oversized body → 400 / 413 without detail');

    // -----------------------------------------------------------------------
    // Unauthenticated battery against matchable bodies: DB byte-identical, no repository call.
    // -----------------------------------------------------------------------
    const finalBefore = await dbSnapshot();
    const callsBefore = sb.calls.length;
    const attack = [
      { estado: 'Convertido', internal_id: '900', cedula: '12345678' },
      { estado: 'Convertido', internal_id: '700' },
      { estado: 'Rechazado', internal_id: '900' },
    ];
    for (const body of attack) {
      for (const h of [{}, { [H]: A }, { [H]: wrong }, { [H]: 'x' }, { Authorization: 'Bearer ' + B }]) {
        assert.strictEqual((await post(h, body)).status, 401);
      }
    }
    setTokens(undefined);
    for (const body of attack) assert.strictEqual((await post({ [H]: B }, body)).status, 503);
    assert.strictEqual(await dbSnapshot(), finalBefore, 'no event stored, no process modified');
    assert.strictEqual(sb.calls.length, callsBefore, 'no repository read or write');
    assert.strictEqual(dashboardGateHits, 0);
    pass('unauthenticated (missing/old/wrong/malformed token, or unconfigured) never reads or modifies the database');

    // -----------------------------------------------------------------------
    // Logs and wiring.
    // -----------------------------------------------------------------------
    const logs = logLines.join('\n');
    for (const t of usedTokens) {
      assert.ok(!logs.includes(t) && !logs.toLowerCase().includes(t.slice(0, 16)), 'token in logs');
    }
    assert.ok(!/credizona-postback-token|authorization/i.test(logs), 'auth header names/values never logged');
    assert.ok(!logs.includes('12345678') && !logs.includes('1.234.567-8'), 'no CI in logs');
    assert.ok(/elm postback auth rejected .*"reason":"token_mismatch"/.test(logs), 'rejections logged with reason only');
    const events = await db.query('SELECT payload::text AS p FROM public.elm_postback_events');
    for (const row of events.rows) for (const t of usedTokens) assert.ok(!row.p.includes(t), 'token persisted');
    const routeSrc = fs.readFileSync(path.join(ROOT, 'src/routes/elmPostback.js'), 'utf8');
    assert.ok(!/req\.headers|rawHeaders/.test(routeSrc), 'route never reads headers itself');
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
    const mountAt = appSrc.indexOf("app.use('/elm/postback', createElmPostbackRouter())");
    assert.ok(mountAt > 0, 'mounted in app.js');
    assert.ok(mountAt < appSrc.indexOf('app.use(express.json());'), 'before the global JSON parser');
    assert.ok(mountAt < appSrc.indexOf('app.use(requireAuth);'), 'before requireAuth');
    assert.ok(!/elm\/postback/.test(fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8')), 'not mounted again after requireAuth');
    for (const f of ['src/lib/elmPostbackToken.js', 'src/routes/elmPostback.js', 'dev/backend-arch/ELM-ACTIVATION-CHECKLIST.md']) {
      assert.ok(!/[0-9a-f]{64}/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), 'no hex token literal in ' + f);
    }
    pass('logs carry no token, auth header or CI; payloads never store the token; mounted before parser + requireAuth');
  } finally {
    await new Promise((r) => server.close(r));
    await db.close();
  }

  assert.strictEqual(externalNet.length, 0);
  console.log('unit-elm-postback-auth: ' + groups + ' groups passed (LOCAL PGlite + loopback HTTP); external network attempts: ' + externalNet.length);
}

main().catch((err) => {
  console.error('FAIL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
