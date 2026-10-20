'use strict';

/**
 * node scripts/unit-meta-agent-cz-attribution-api.js
 * Auth, validation, and PII guardrails for GET /api/meta-agent/cz-attribution.
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    sessionSecret: 'unit-test-secret',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
  },
};

const USERS = new Map();
const SECTION_PERMS = new Set();

const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    requireAuth: function (req, res, next) {
      const raw = req.headers.cookie || '';
      const m = /janus_session=([^;]+)/.exec(raw);
      if (!m) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const userId = decodeURIComponent(m[1]).split('.')[0];
      let payload;
      try {
        payload = JSON.parse(
          Buffer.from(userId, 'base64url').toString('utf8'),
        );
      } catch (e) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const user = USERS.get(payload.user_id);
      if (!user || !user.active) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      req.dashboardUser = user;
      next();
    },
  },
};

const permPath = require.resolve('../src/middleware/requireDashboardPermission');
require.cache[permPath] = {
  id: permPath,
  filename: permPath,
  loaded: true,
  exports: {
    requireDashboardPermission: function (sectionKey) {
      return function (req, res, next) {
        const uid = req.dashboardUser && req.dashboardUser.id;
        if (!uid) return res.status(401).json({ error: 'Unauthorized' });
        if (req.dashboardUser.is_admin) return next();
        const key = uid + ':' + sectionKey;
        if (!SECTION_PERMS.has(key)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        next();
      };
    },
  },
};

const servicePath = require.resolve('../src/services/metaAgentCzAttributionService');
const samplePayload = {
  entityId: 'dd6dcb1a-4458-4534-993d-a2c4c0ca20df',
  timezone: 'America/Montevideo',
  range: { from: '2026-10-14', to: '2026-10-15' },
  byAdId: {
    '120253337803970508': { solicitudCount: 2, uniqueCi: 2 },
  },
  buckets: {
    meta_ad_attributed: { solicitudes: 2, uniqueCi: 2 },
  },
  globalAttributed: { solicitudCount: 2, uniqueCi: 2 },
  ciOverlap: {
    sumUniqueCiByAd: 2,
    globalUniqueCi: 2,
    excessFromMultiAd: 0,
    ciPresentInMultipleAdsCount: 0,
  },
  pendingAdIds: [],
};

require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    buildCzAttributionAggregates: async function (input) {
      if (input.from === '2026-01-01' && input.to === '2026-05-01') {
        const err = new Error('El rango no puede superar 90 días');
        err.code = 'range_too_large';
        err.status = 400;
        throw err;
      }
      return Object.assign({}, samplePayload, {
        range: { from: input.from, to: input.to },
      });
    },
  },
};

const {
  requireDashboardPermission,
} = require('../src/middleware/requireDashboardPermission');
const { requireAuth } = require('../src/middleware/auth');
const metaRouter = require('../src/routes/meta-agent-cz-attribution');

function makeToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({ user_id: userId, issuedAt: Date.now() }),
    'utf8',
  ).toString('base64url');
  return payload + '.sig';
}

function startServer() {
  const app = express();
  app.use(requireAuth);
  app.use('/api/meta-agent', requireDashboardPermission('meta'), metaRouter);
  return new Promise(function (resolve) {
    const server = app.listen(0, function () {
      resolve({
        server: server,
        base: 'http://127.0.0.1:' + server.address().port,
      });
    });
  });
}

function get(base, path, cookie) {
  return new Promise(function (resolve, reject) {
    const url = new URL(path, base);
    http
      .get(
        url,
        { headers: cookie ? { cookie: 'janus_session=' + cookie } : {} },
        function (res) {
          let body = '';
          res.on('data', function (c) {
            body += c;
          });
          res.on('end', function () {
            resolve({ status: res.statusCode, body: body });
          });
        },
      )
      .on('error', reject);
  });
}

function assertNoPii(json) {
  const s = JSON.stringify(json);
  assert.ok(!s.includes('tracking_data_summary'));
  assert.ok(!/"ci"\s*:/.test(s));
  assert.ok(!s.includes('fecha_reg'));
  assert.ok(!s.includes('nombre'));
  assert.ok(!s.includes('telefono'));
  assert.ok(!s.includes('email'));
}

(async function main() {
  USERS.set('admin-1', { id: 'admin-1', is_admin: true, active: true });
  USERS.set('reader-1', { id: 'reader-1', is_admin: false, active: true });
  SECTION_PERMS.add('reader-1:market');

  const { server, base } = await startServer();

  try {
    const noAuth = await get(
      base,
      '/api/meta-agent/cz-attribution?from=2026-10-14&to=2026-10-15',
    );
    assert.strictEqual(noAuth.status, 401);

    const forbidden = await get(
      base,
      '/api/meta-agent/cz-attribution?from=2026-10-14&to=2026-10-15',
      makeToken('reader-1'),
    );
    assert.strictEqual(forbidden.status, 403);

    const badDate = await get(
      base,
      '/api/meta-agent/cz-attribution?from=bad&to=2026-10-15',
      makeToken('admin-1'),
    );
    assert.strictEqual(badDate.status, 400);

    const inverted = await get(
      base,
      '/api/meta-agent/cz-attribution?from=2026-10-20&to=2026-10-14',
      makeToken('admin-1'),
    );
    assert.strictEqual(inverted.status, 400);

    const tooLong = await get(
      base,
      '/api/meta-agent/cz-attribution?from=2026-01-01&to=2026-05-01',
      makeToken('admin-1'),
    );
    assert.strictEqual(tooLong.status, 400);

    const ok = await get(
      base,
      '/api/meta-agent/cz-attribution?from=2026-10-14&to=2026-10-15',
      makeToken('admin-1'),
    );
    assert.strictEqual(ok.status, 200);
    const json = JSON.parse(ok.body);
    assert.strictEqual(json.globalAttributed.solicitudCount, 2);
    assertNoPii(json);
    assert.ok(json.byAdId['120253337803970508']);

    console.log('all meta-agent cz-attribution API checks passed');
  } finally {
    server.close();
  }
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
