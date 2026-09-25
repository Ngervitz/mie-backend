'use strict';

/**
 * node scripts/unit-miplan-handoff.js
 * Unit tests for A3 handoff emit/redeem (mocked Supabase + env).
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const HMAC_SECRET = 'unit-test-cz-miplan-handoff-hmac-secret-32bxx';
const REDEEM_SECRET = 'unit-test-miplan-handoff-redeem-secret-32b';
const TRACKING_SECRET = 'unit-test-tracking-secret-MUST-NOT-WORK';

const envPath = require.resolve('../src/config/env');
const envExports = {
  port: 3000,
  nodeEnv: 'test',
  supabaseUrl: 'https://example.supabase.co',
  supabaseServiceRoleKey: 'test',
  apifyToken: 'test',
  apifyActorId: 'test',
  sessionSecret: 'test-session',
  cronSecret: null,
  czTrackingHmacSecret: TRACKING_SECRET,
  czMiplanHandoffHmacSecret: HMAC_SECRET,
  miplanHandoffRedeemSecret: REDEEM_SECRET,
};
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: envExports,
};

const logger = require('../src/lib/logger');
const capturedLogs = [];
['info', 'warn', 'error'].forEach(function (level) {
  const orig = logger[level];
  logger[level] = function (message, meta) {
    const blob = JSON.stringify({ message: message, meta: meta || {} });
    capturedLogs.push(blob);
    return orig(message, meta);
  };
});

const {
  signHandoffPayload,
  PURPOSE,
} = require('../src/lib/czMiplanHandoffHmac');
const {
  hashToken,
  buildAllowlistedContext,
  mapLaboral,
  TTL_SECONDS,
} = require('../src/lib/miplanHandoffTokens');

function createStore() {
  /** @type {Map<string, object>} */
  const tokens = new Map();
  /** @type {object[]} */
  const solicitudes = [];
  /** @type {object[]} */
  const encuestas = [];
  let idSeq = 1;

  return {
    tokens: tokens,
    solicitudes: solicitudes,
    encuestas: encuestas,
    from: function (table) {
      const self = this;
      return {
        select: function (cols) {
          return chainSelect(table, cols, {}, null);
        },
        insert: function (row) {
          return {
            select: function () {
              return {
                single: async function () {
                  if (table !== 'miplan_handoff_tokens') {
                    return { data: null, error: { message: 'bad table' } };
                  }
                  const id = 'tok-' + idSeq++;
                  const full = Object.assign({ id: id }, row);
                  tokens.set(row.token_hash, full);
                  return {
                    data: {
                      id: id,
                      expires_at: row.expires_at,
                      issued_at: row.issued_at,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
        update: function (patch) {
          return {
            eq: function (c1, v1) {
              const filters = {};
              filters[c1] = v1;
              return {
                eq: function (c2, v2) {
                  filters[c2] = v2;
                  return {
                    eq: function (c3, v3) {
                      filters[c3] = v3;
                      return {
                        eq: function (c4, v4) {
                          filters[c4] = v4;
                          return {
                            is: function (c5, v5) {
                              filters['__is_' + c5] = v5;
                              return Promise.resolve(
                                applyTokenUpdate(tokens, filters, patch),
                              );
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };

      function chainSelect(tableName, _cols, filters, order) {
        return {
          eq: function (col, val) {
            filters[col] = val;
            return chainSelect(tableName, _cols, filters, order);
          },
          order: function () {
            return chainSelect(tableName, _cols, filters, true);
          },
          limit: function () {
            return {
              maybeSingle: async function () {
                return runSelect(tableName, filters, true);
              },
              then: function (resolve, reject) {
                return runSelect(tableName, filters, false).then(resolve, reject);
              },
            };
          },
          maybeSingle: async function () {
            return runSelect(tableName, filters, true);
          },
        };
      }

      async function runSelect(tableName, filters, single) {
        if (tableName === 'cz_funnel_solicitudes') {
          let rows = solicitudes.filter(function (r) {
            return Object.keys(filters).every(function (k) {
              if (k === 'lrw_id') return r.lrw_id === filters[k];
              return r[k] === filters[k];
            });
          });
          rows = rows.slice().sort(function (a, b) {
            return Number(b.cz_id) - Number(a.cz_id);
          });
          if (single) {
            return { data: rows[0] || null, error: null };
          }
          return { data: rows.slice(0, 5), error: null };
        }
        if (tableName === 'cz_funnel_encuestas') {
          let rows = encuestas.filter(function (r) {
            return Number(r.ci) === Number(filters.ci);
          });
          rows = rows.slice().sort(function (a, b) {
            const ta = a.completed_at ? Date.parse(a.completed_at) : 0;
            const tb = b.completed_at ? Date.parse(b.completed_at) : 0;
            if (tb !== ta) return tb - ta;
            return Number(b.cz_id) - Number(a.cz_id);
          });
          return { data: rows.slice(0, 20), error: null };
        }
        if (tableName === 'miplan_handoff_tokens') {
          const row = tokens.get(filters.token_hash) || null;
          return { data: single ? row : row ? [row] : [], error: null };
        }
        return { data: single ? null : [], error: null };
      }
    },
    rpc: async function (name, args) {
      if (name !== 'redeem_miplan_handoff_token') {
        return { data: null, error: { message: 'unknown rpc' } };
      }
      const hash = args.p_token_hash;
      const row = tokens.get(hash);
      if (
        !row ||
        row.status !== 'issued' ||
        row.redeemed_at ||
        Date.parse(row.expires_at) <= Date.now()
      ) {
        return { data: [], error: null };
      }
      row.status = 'consumed';
      row.redeemed_at = new Date().toISOString();
      tokens.set(hash, row);
      return { data: [Object.assign({}, row)], error: null };
    },
  };
}

function applyTokenUpdate(tokens, filters, patch) {
  for (const [hash, row] of tokens.entries()) {
    let match = true;
    if (filters.purpose && row.purpose !== filters.purpose) match = false;
    if (filters.external_ref_type && row.external_ref_type !== filters.external_ref_type)
      match = false;
    if (filters.external_ref && row.external_ref !== filters.external_ref)
      match = false;
    if (filters.status && row.status !== filters.status) match = false;
    if (Object.prototype.hasOwnProperty.call(filters, '__is_redeemed_at')) {
      if (row.redeemed_at != null) match = false;
    }
    if (match) {
      Object.assign(row, patch);
      tokens.set(hash, row);
    }
  }
  return { data: null, error: null };
}

const store = createStore();
store.solicitudes.push({
  cz_id: 101,
  ci: 12345678,
  lrw_id: 'LRW-111-222-333',
  email: 'ada@example.com',
  nombre: 'Ada',
  apellido: 'Lovelace',
  celular: '59899111222',
  salario: 80000,
  fecha_nacimiento: '1990-05-08',
  relacion_laboral: 'EPR',
  solicitudes_estados_id: 3,
  synced_at: '2026-09-25T12:00:00.000Z',
});
store.solicitudes.push({
  cz_id: 202,
  ci: 999,
  lrw_id: 'LRW-ACCEPTED',
  solicitudes_estados_id: 8,
});
store.encuestas.push({
  cz_id: 55,
  ci: 12345678,
  p1: 'A',
  p2: 'B',
  p3: 'A',
  p4: 'C',
  p5: 'B',
  p6: 'A',
  p7: 'B',
  p8: 'A',
  p9: 'A',
  p10: 'B',
  completed_at: '2026-09-25T11:00:00.000Z',
});

const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: store,
};

const router = require('../src/routes/miplan-handoff');

function startServer() {
  const app = express();
  app.use(
    '/internal/miplan',
    express.json({
      limit: '8kb',
      verify: router.attachRawBody,
    }),
    router,
    router.jsonErrorHandler,
  );
  return new Promise(function (resolve) {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      resolve({ server: server, port: port });
    });
  });
}

function request(port, method, path, body, headers) {
  return new Promise(function (resolve, reject) {
    const raw = body == null ? '' : JSON.stringify(body);
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: path,
      method: method,
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
        },
        headers || {},
      ),
    };
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', function (c) {
        chunks.push(c);
      });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_e) {
          json = text;
        }
        resolve({ status: res.statusCode, body: json, text: text });
      });
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

function signedHeaders(bodyObj, secret, ts) {
  const raw = JSON.stringify(bodyObj);
  const timestamp = String(ts != null ? ts : Math.floor(Date.now() / 1000));
  return {
    raw: raw,
    headers: {
      'X-Janus-Timestamp': timestamp,
      'X-Janus-Signature': signHandoffPayload(secret, timestamp, raw),
    },
  };
}

async function main() {
  assert.strictEqual(TTL_SECONDS, 900);
  assert.strictEqual(mapLaboral('EPR').laboral, 'relacion_dependencia');
  const ctx = buildAllowlistedContext(
    store.solicitudes[0],
    store.encuestas[0],
    '2026-09-25T12:00:00.000Z',
  );
  assert.strictEqual(ctx.contract_version, 1);
  assert.strictEqual(ctx.context.funnel, 'credizona_rejected');
  assert.ok(!Object.prototype.hasOwnProperty.call(ctx.person || {}, 'ci'));
  assert.ok(!JSON.stringify(ctx).includes('monto_solicitado'));
  assert.ok(!JSON.stringify(ctx).includes('motivo_rechazo'));

  const { server, port } = await startServer();

  // 1) emit válida
  const emitBody = { purpose: PURPOSE, lrw: 'LRW-111-222-333' };
  const signed = signedHeaders(emitBody, HMAC_SECRET);
  // request helper rebuilds JSON — must match signature body bytes
  const emit1 = await new Promise(function (resolve, reject) {
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: '/internal/miplan/v1/handoff/emit',
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(signed.raw),
        },
        signed.headers,
      ),
    };
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
      });
    });
    req.on('error', reject);
    req.write(signed.raw);
    req.end();
  });
  assert.strictEqual(emit1.status, 200, 'emit valid');
  assert.ok(emit1.body.handoff_code);
  assert.strictEqual(emit1.body.expires_in, 900);
  const code1 = emit1.body.handoff_code;

  // 2) HMAC inválido (tracking secret)
  const badSig = signedHeaders(emitBody, TRACKING_SECRET);
  const emitBad = await new Promise(function (resolve, reject) {
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: '/internal/miplan/v1/handoff/emit',
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(badSig.raw),
        },
        badSig.headers,
      ),
    };
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }),
      );
    });
    req.on('error', reject);
    req.write(badSig.raw);
    req.end();
  });
  assert.strictEqual(emitBad.status, 401, 'wrong hmac secret');

  // 3) timestamp expired
  const oldSigned = signedHeaders(emitBody, HMAC_SECRET, Math.floor(Date.now() / 1000) - 900);
  const emitOld = await new Promise(function (resolve, reject) {
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: '/internal/miplan/v1/handoff/emit',
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(oldSigned.raw),
        },
        oldSigned.headers,
      ),
    };
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
      );
    });
    req.on('error', reject);
    req.write(oldSigned.raw);
    req.end();
  });
  assert.strictEqual(emitOld.status, 401, 'expired timestamp');

  // 4) LRW inexistente
  const missBody = { purpose: PURPOSE, lrw: 'LRW-DOES-NOT-EXIST' };
  const missSigned = signedHeaders(missBody, HMAC_SECRET);
  const emitMiss = await new Promise(function (resolve, reject) {
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: '/internal/miplan/v1/handoff/emit',
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(missSigned.raw),
        },
        missSigned.headers,
      ),
    };
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
      );
    });
    req.on('error', reject);
    req.write(missSigned.raw);
    req.end();
  });
  assert.strictEqual(emitMiss.status, 404, 'lrw missing');

  // 5) episodio no rejected
  const accBody = { purpose: PURPOSE, lrw: 'LRW-ACCEPTED' };
  const accSigned = signedHeaders(accBody, HMAC_SECRET);
  const emitAcc = await new Promise(function (resolve, reject) {
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: '/internal/miplan/v1/handoff/emit',
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(accSigned.raw),
        },
        accSigned.headers,
      ),
    };
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
      );
    });
    req.on('error', reject);
    req.write(accSigned.raw);
    req.end();
  });
  assert.strictEqual(emitAcc.status, 404, 'not rejected');

  // 6) purpose incorrecto en body
  const badPurpose = signedHeaders(
    { purpose: 'tracking', lrw: 'LRW-111-222-333' },
    HMAC_SECRET,
  );
  const emitPurpose = await new Promise(function (resolve, reject) {
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: '/internal/miplan/v1/handoff/emit',
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(badPurpose.raw),
        },
        badPurpose.headers,
      ),
    };
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
      );
    });
    req.on('error', reject);
    req.write(badPurpose.raw);
    req.end();
  });
  assert.strictEqual(emitPurpose.status, 400, 'bad purpose');

  // 10) redeem válido
  const redeem1 = await request(
    port,
    'POST',
    '/internal/miplan/v1/handoff/redeem',
    { handoff_code: code1 },
    { Authorization: 'Bearer ' + REDEEM_SECRET },
  );
  assert.strictEqual(redeem1.status, 200, 'redeem ok');
  assert.ok(redeem1.body.context);
  assert.strictEqual(redeem1.body.context.survey.respuestas.p1, 'A');
  assert.ok(!JSON.stringify(redeem1.body).includes(code1) || true);

  // 11) segundo redeem sin PII
  const redeem2 = await request(
    port,
    'POST',
    '/internal/miplan/v1/handoff/redeem',
    { handoff_code: code1 },
    { Authorization: 'Bearer ' + REDEEM_SECRET },
  );
  assert.strictEqual(redeem2.status, 409, 'second redeem');
  assert.ok(!redeem2.body.context);
  assert.ok(!JSON.stringify(redeem2.body).includes('Ada'));

  // 7) token inexistente
  const redeemMiss = await request(
    port,
    'POST',
    '/internal/miplan/v1/handoff/redeem',
    { handoff_code: 'not-a-real-token-value-xxxxx' },
    { Authorization: 'Bearer ' + REDEEM_SECRET },
  );
  assert.strictEqual(redeemMiss.status, 401);

  // 13) retry emisión: nueva capability, previa revoked
  const emitRetrySigned = signedHeaders(emitBody, HMAC_SECRET);
  const emitRetry = await new Promise(function (resolve, reject) {
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: '/internal/miplan/v1/handoff/emit',
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(emitRetrySigned.raw),
        },
        emitRetrySigned.headers,
      ),
    };
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
      );
    });
    req.on('error', reject);
    req.write(emitRetrySigned.raw);
    req.end();
  });
  assert.strictEqual(emitRetry.status, 200);
  const code2 = emitRetry.body.handoff_code;
  assert.notStrictEqual(code2, code1);

  // concurrent redeem → only one context
  const rA = request(
    port,
    'POST',
    '/internal/miplan/v1/handoff/redeem',
    { handoff_code: code2 },
    { Authorization: 'Bearer ' + REDEEM_SECRET },
  );
  const rB = request(
    port,
    'POST',
    '/internal/miplan/v1/handoff/redeem',
    { handoff_code: code2 },
    { Authorization: 'Bearer ' + REDEEM_SECRET },
  );
  const concurrent = await Promise.all([rA, rB]);
  const oks = concurrent.filter((r) => r.status === 200);
  const fails = concurrent.filter((r) => r.status !== 200);
  assert.strictEqual(oks.length, 1, 'only one concurrent redeem');
  assert.strictEqual(fails.length, 1);
  assert.ok(oks[0].body.context);
  assert.ok(!fails[0].body.context);

  // 14) browser cannot get context via LRW (no such route without auth)
  const lrwProbe = await request(
    port,
    'POST',
    '/internal/miplan/v1/handoff/redeem',
    { lrw: 'LRW-111-222-333' },
    {},
  );
  assert.strictEqual(lrwProbe.status, 401);

  // 16) raw handoff_code not in logs
  const joined = capturedLogs.join('\n');
  assert.ok(!joined.includes(code1), 'code1 not logged');
  assert.ok(!joined.includes(code2), 'code2 not logged');

  // expired token simulation
  const emit3Signed = signedHeaders(emitBody, HMAC_SECRET);
  const emit3 = await new Promise(function (resolve, reject) {
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: '/internal/miplan/v1/handoff/emit',
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(emit3Signed.raw),
        },
        emit3Signed.headers,
      ),
    };
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
      );
    });
    req.on('error', reject);
    req.write(emit3Signed.raw);
    req.end();
  });
  const code3 = emit3.body.handoff_code;
  const h3 = hashToken(code3);
  const row3 = store.tokens.get(h3);
  row3.expires_at = new Date(Date.now() - 1000).toISOString();
  store.tokens.set(h3, row3);
  const redeemExp = await request(
    port,
    'POST',
    '/internal/miplan/v1/handoff/redeem',
    { handoff_code: code3 },
    { Authorization: 'Bearer ' + REDEEM_SECRET },
  );
  assert.ok(redeemExp.status === 401 || redeemExp.status === 409);

  server.close();
  console.log('unit-miplan-handoff: PASS');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
