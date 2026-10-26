'use strict';

/**
 * Local HTTP check for /affiliates authorization.
 * Uses dummy env set before the app modules load. Does not call Supabase
 * for the denial cases. A permitted session reaches the handler, which then
 * fails closed because the database URL is local and closed.
 */

process.env.SESSION_SECRET = 'review-only-session';
process.env.CRON_SECRET = 'review-only-cron';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'review-only';
process.env.APIFY_TOKEN = 'review-only';
process.env.APIFY_ACTOR_ID = 'review-only';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const express = require('express');

const USERS = pathUsers();
const usersPath = require.resolve('../src/services/dashboardUsers');
require.cache[usersPath] = {
  id: usersPath,
  filename: usersPath,
  loaded: true,
  exports: {
    findUserById: async function (id) {
      return USERS[id] || null;
    },
    userHasSectionPermission: async function (id, section) {
      return USERS[id] && USERS[id].sections.indexOf(section) !== -1;
    },
  },
};

const { createSessionToken, requireAuth, isValidCronKey } = require('../src/middleware/auth');
const { requireDashboardPermission } = require('../src/middleware/requireDashboardPermission');
const { resolveSectionForPath } = require('../src/middleware/dashboardSections');
const affiliatesAdminRouter = require('../src/routes/affiliates-admin');

function pathUsers() {
  return {
    '11111111-1111-4111-8111-111111111111': {
      id: '11111111-1111-4111-8111-111111111111',
      active: true,
      is_admin: false,
      sections: ['cz-funnel'],
    },
    '22222222-2222-4222-8222-222222222222': {
      id: '22222222-2222-4222-8222-222222222222',
      active: true,
      is_admin: true,
      sections: [],
    },
    '33333333-3333-4333-8333-333333333333': {
      id: '33333333-3333-4333-8333-333333333333',
      active: false,
      is_admin: false,
      sections: ['cz-funnel'],
    },
    '44444444-4444-4444-8444-444444444444': {
      id: '44444444-4444-4444-8444-444444444444',
      active: true,
      is_admin: false,
      sections: ['rechazados'],
    },
  };
}

function cookie(userId) {
  return 'janus_session=' + encodeURIComponent(createSessionToken(userId));
}

function mount(handler) {
  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  app.use('/affiliates', requireDashboardPermission('cz-funnel'), handler);
  return app;
}

function request(app, method, urlPath, headers) {
  return new Promise(function (resolve, reject) {
    const server = app.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      const req = http.request({
        host: '127.0.0.1',
        port: port,
        path: urlPath,
        method: method,
        headers: headers || {},
      }, function (res) {
        const chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          server.close(function () {
            resolve({
              status: res.statusCode,
              location: res.headers.location || '',
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        });
      });
      req.on('error', function (err) {
        server.close(function () { reject(err); });
      });
      req.setTimeout(8000, function () {
        req.destroy(new Error('timeout'));
      });
      req.end();
    });
  });
}

async function main() {
  assert.strictEqual(resolveSectionForPath('/affiliates'), 'cz-funnel');
  assert.strictEqual(resolveSectionForPath('/affiliates/pending-attributions'), 'cz-funnel');

  const real = mount(affiliatesAdminRouter);
  const sentinel = mount(function (_req, res) {
    res.status(204).end();
  });

  const anonymous = await request(real, 'GET', '/affiliates');
  assert.strictEqual(anonymous.status, 401);
  assert.strictEqual(JSON.parse(anonymous.body).error, 'No autenticado');

  const posted = await request(real, 'POST', '/affiliates');
  assert.strictEqual(posted.status, 401);

  const browser = await request(real, 'GET', '/affiliates', { accept: 'text/html' });
  assert.strictEqual(browser.status, 401);

  const cronHeaders = { 'x-cron-key': 'review-only-cron', accept: 'application/json' };
  const probe = { headers: cronHeaders };
  assert.strictEqual(isValidCronKey(probe), true);
  const cron = await request(real, 'GET', '/affiliates', cronHeaders);
  assert.strictEqual(cron.status, 401);
  assert.strictEqual(JSON.parse(cron.body).error, 'No autenticado');
  const cronPost = await request(real, 'POST', '/affiliates', cronHeaders);
  assert.strictEqual(cronPost.status, 401);

  const wrongCron = await request(real, 'GET', '/affiliates', { 'x-cron-key': 'not-the-secret' });
  assert.strictEqual(wrongCron.status, 401);

  const allowed = await request(sentinel, 'GET', '/affiliates', {
    cookie: cookie('11111111-1111-4111-8111-111111111111'),
  });
  assert.strictEqual(allowed.status, 204);

  const admin = await request(sentinel, 'GET', '/affiliates', {
    cookie: cookie('22222222-2222-4222-8222-222222222222'),
  });
  assert.strictEqual(admin.status, 204);

  const inactive = await request(sentinel, 'GET', '/affiliates', {
    cookie: cookie('33333333-3333-4333-8333-333333333333'),
  });
  assert.strictEqual(inactive.status, 401);

  const otherSection = await request(sentinel, 'GET', '/affiliates', {
    cookie: cookie('44444444-4444-4444-8444-444444444444'),
  });
  assert.strictEqual(otherSection.status, 403);
  assert.strictEqual(JSON.parse(otherSection.body).section, 'cz-funnel');

  const reached = await request(real, 'GET', '/affiliates', {
    cookie: cookie('11111111-1111-4111-8111-111111111111'),
    accept: 'application/json',
  });
  assert.notStrictEqual(reached.status, 401);
  assert.notStrictEqual(reached.status, 403);
  assert.ok(reached.body.indexOf('real01') === -1);

  const preaprobados = require('../src/routes/preaprobados');
  const rechazados = require('../src/routes/rechazados');
  assert.strictEqual(typeof preaprobados, 'function');
  assert.strictEqual(typeof rechazados, 'function');

  console.log('unit-affiliate-admin-auth: ok');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
