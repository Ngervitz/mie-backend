'use strict';

/**
 * Local-only harness for POST /miplan/v1/interest: the real router + lib on an
 * in-memory Supabase fake (no network, no real DB). Used by
 * scripts/unit-miplan-interest.js and by the Credizona thank-you E2E.
 *
 *   const h = await startLocalMiplanInterestServer({ allowedOrigins: 'http://cz.test' });
 *   h.store.addToken({ code, ci, lrw, cz_solicitud_id });
 *   ... POST h.url ...
 *   await h.close();
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');

function hash(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

const OUTREACH_DEFAULTS = Object.freeze({
  mi_plan_status: 'not_invited',
  mi_plan_updated_at: null,
  mi_plan_interest_at: null,
  mi_plan_interest_source: null,
  mi_plan_interest_lrw: null,
  mi_plan_interest_cz_solicitud_id: null,
  mi_deuda_status: 'not_invited',
  mi_deuda_updated_at: null,
  mi_deuda_invited_at: null,
  mi_deuda_responded_at: null,
});

function createInterestStore() {
  const tables = { miplan_handoff_tokens: [], rejected_ci_outreach: [] };
  const ops = [];
  const store = {
    tables: tables,
    ops: ops,
    rpcCalls: [],
    failNext: null,
    addToken: function (t) {
      const row = {
        id: t.id || crypto.randomUUID(),
        token_hash: hash(t.code),
        purpose: t.purpose || 'miplan_handoff',
        external_ref_type: 'lrw',
        external_ref: t.lrw != null ? t.lrw : 'LRW-000-000-001',
        cz_solicitud_id: t.cz_solicitud_id != null ? t.cz_solicitud_id : null,
        ci: t.ci !== undefined ? t.ci : 12345678,
        status: t.status || 'issued',
        issued_at: new Date().toISOString(),
        expires_at: t.expires_at || new Date(Date.now() + 900e3).toISOString(),
        redeemed_at: t.redeemed_at || null,
        revoked_at: t.revoked_at || null,
      };
      tables.miplan_handoff_tokens.push(row);
      return row;
    },
    outreach: function (ci) {
      return tables.rejected_ci_outreach.find(function (r) { return r.ci === ci; }) || null;
    },
    from: function (table) {
      if (!tables[table]) tables[table] = [];
      return query(store, table);
    },
    rpc: function (name, args) {
      store.rpcCalls.push({ name: name, args: args });
      return Promise.resolve({ data: null, error: { message: 'rpc not allowed in this harness' } });
    },
  };
  return store;
}

function checkOutreach(row) {
  if ((row.mi_plan_interest_at == null) !== (row.mi_plan_interest_source == null)) {
    return { code: '23514', message: 'rejected_ci_outreach_mi_plan_interest_complete_check' };
  }
  if (row.mi_plan_interest_source != null && row.mi_plan_interest_source !== 'credizona_rejected_thank_you') {
    return { code: '23514', message: 'rejected_ci_outreach_mi_plan_interest_source_check' };
  }
  return null;
}

function pick(row, cols) {
  if (!cols || cols === '*') return Object.assign({}, row);
  const out = {};
  cols.split(',').forEach(function (c) {
    const k = c.trim();
    if (k) out[k] = row[k] !== undefined ? row[k] : null;
  });
  return out;
}

function query(store, table) {
  const q = { op: 'select', cols: '*', filters: [], payload: null, options: null, returning: null };
  function rows() {
    return store.tables[table].filter(function (r) {
      return q.filters.every(function (f) {
        if (f.kind === 'eq') return r[f.col] === f.val;
        if (f.kind === 'is') return f.val === null ? r[f.col] == null : r[f.col] === f.val;
        return true;
      });
    });
  }
  function injected() {
    const f = store.failNext;
    if (f && f.table === table && f.op === q.op) {
      store.failNext = null;
      return { message: 'injected failure' };
    }
    return null;
  }
  function run() {
    store.ops.push({ table: table, op: q.op, filters: q.filters.slice(), payload: q.payload });
    const fail = injected();
    if (fail) return { data: null, error: fail };
    if (q.op === 'select') {
      return { data: rows().map(function (r) { return pick(r, q.cols); }), error: null };
    }
    if (q.op === 'upsert') {
      const key = q.options && q.options.onConflict;
      const exists = store.tables[table].find(function (r) { return r[key] === q.payload[key]; });
      if (exists) {
        if (q.options && q.options.ignoreDuplicates) return { data: null, error: null };
        Object.assign(exists, q.payload);
        return { data: null, error: null };
      }
      const row = Object.assign({}, table === 'rejected_ci_outreach' ? OUTREACH_DEFAULTS : {}, q.payload, {
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      store.tables[table].push(row);
      return { data: null, error: null };
    }
    if (q.op === 'update') {
      const matched = rows();
      for (let i = 0; i < matched.length; i += 1) {
        const next = Object.assign({}, matched[i], q.payload);
        const bad = table === 'rejected_ci_outreach' ? checkOutreach(next) : null;
        if (bad) return { data: null, error: bad };
      }
      matched.forEach(function (r) {
        Object.assign(r, q.payload, { updated_at: new Date().toISOString() });
      });
      return {
        data: q.returning != null ? matched.map(function (r) { return pick(r, q.returning); }) : null,
        error: null,
      };
    }
    return { data: null, error: { message: 'unsupported op ' + q.op } };
  }
  const builder = {
    select: function (cols) {
      if (q.op === 'select') q.cols = cols || '*';
      else q.returning = cols || '*';
      return builder;
    },
    upsert: function (payload, options) { q.op = 'upsert'; q.payload = payload; q.options = options || {}; return builder; },
    update: function (payload) { q.op = 'update'; q.payload = payload; return builder; },
    insert: function (payload) { q.op = 'insert'; q.payload = payload; return builder; },
    delete: function () { q.op = 'delete'; return builder; },
    eq: function (col, val) { q.filters.push({ kind: 'eq', col: col, val: val }); return builder; },
    is: function (col, val) { q.filters.push({ kind: 'is', col: col, val: val }); return builder; },
    maybeSingle: function () {
      const r = run();
      if (r.error) return Promise.resolve(r);
      const list = r.data || [];
      if (list.length > 1) return Promise.resolve({ data: null, error: { message: 'multiple rows' } });
      return Promise.resolve({ data: list[0] || null, error: null });
    },
    then: function (resolve, reject) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };
  return builder;
}

function stubModule(relPath, exportsValue) {
  const p = require.resolve(path.join(SRC, relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsValue };
}

/**
 * Stubs env/supabase in require.cache (only if not already loaded) so the real
 * router can be mounted without credentials or a database.
 */
function loadRouter(store, allowedOrigins) {
  const envPath = require.resolve(path.join(SRC, 'config', 'env'));
  if (!require.cache[envPath]) {
    stubModule('config/env', {
      port: 0,
      nodeEnv: 'test',
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'test',
      sessionSecret: 'test-session',
      czMiplanHandoffHmacSecret: 'unit-test-not-used-by-interest-route-xxxxxx',
      miplanHandoffRedeemSecret: 'unit-test-not-used-by-interest-route-yyyyyy',
    });
  }
  require.cache[envPath].exports.miplanInterestAllowedOrigins = allowedOrigins || null;
  stubModule('clients/supabase', store);
  return require(path.join(SRC, 'routes', 'miplan-interest'));
}

async function startLocalMiplanInterestServer(opts) {
  const options = opts || {};
  const express = require('express');
  const store = options.store || createInterestStore();
  const router = loadRouter(store, options.allowedOrigins);
  router.resetRateLimitForTests();
  const app = express();
  app.use('/miplan', express.json({ limit: '1kb' }), router, router.jsonErrorHandler);
  const server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(options.port || 0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return {
    url: 'http://127.0.0.1:' + port + '/miplan/v1/interest',
    store: store,
    router: router,
    close: function () { return new Promise(function (resolve) { server.close(resolve); }); },
  };
}

module.exports = {
  createInterestStore,
  startLocalMiplanInterestServer,
};

if (require.main === module) {
  startLocalMiplanInterestServer({
    allowedOrigins: process.env.MIPLAN_INTEREST_ALLOWED_ORIGINS || null,
    port: Number(process.env.PORT) || 0,
  }).then(function (h) {
    const code = crypto.randomBytes(32).toString('base64url');
    h.store.addToken({ code: code, ci: 12345678, lrw: 'LRW-LOCAL-0001', cz_solicitud_id: 1 });
    console.log('local Mi Plan interest endpoint: ' + h.url);
    console.log('fake handoff_code (local store only): ' + code);
  });
}
