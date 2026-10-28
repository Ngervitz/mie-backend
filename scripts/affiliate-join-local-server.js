'use strict';

const http = require('http');
const path = require('path');
const { createAffiliateJoinStore } = require('./affiliate-join-local-store');

const SRC = path.join(__dirname, '..', 'src');

function stubModule(relPath, exportsValue) {
  const p = require.resolve(path.join(SRC, relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsValue };
}

function loadJoinRouter(store, joinEnabled) {
  const enabled = joinEnabled !== false;
  process.env.AFFILIATE_JOIN_ENABLED = enabled ? 'true' : 'false';
  const envPath = require.resolve(path.join(SRC, 'config', 'env'));
  if (!require.cache[envPath]) {
    stubModule('config/env', {
      port: 0,
      nodeEnv: 'test',
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'test',
      sessionSecret: 'test-session',
      affiliateJoinSessionHmacSecret: 'unit-affiliate-join-session-secret-xx',
      affiliateOtpHmacSecret: 'unit-affiliate-otp-hmac-secret-xxxxx',
      affiliateTermsVersion: 'affiliate_v3',
      affiliatePublicReferralOrigin: 'https://s.credizona.net',
      affiliateTxSmsEnabled: false,
      affiliateJoinEnabled: enabled,
    });
  } else {
    const exp = require.cache[envPath].exports;
    exp.affiliateJoinSessionHmacSecret = 'unit-affiliate-join-session-secret-xx';
    exp.affiliateOtpHmacSecret = 'unit-affiliate-otp-hmac-secret-xxxxx';
    exp.affiliateTermsVersion = 'affiliate_v3';
    exp.affiliatePublicReferralOrigin = 'https://s.credizona.net';
    exp.affiliateTxSmsEnabled = false;
    exp.affiliateJoinEnabled = enabled;
  }
  stubModule('clients/supabase', store);
  delete require.cache[require.resolve(path.join(SRC, 'lib', 'affiliateJoinEnabled'))];
  const router = require(path.join(SRC, 'routes', 'affiliate-join-public'));
  const rate = require(path.join(SRC, 'lib', 'affiliateJoinRateLimit'));
  rate.resetForTests();
  return router;
}

async function startLocalAffiliateJoinServer(opts) {
  const options = opts || {};
  const express = require('express');
  const store = options.store || createAffiliateJoinStore();
  const joinEnabled = options.joinEnabled;
  const router = loadJoinRouter(store, joinEnabled);
  const pagesRouter = require(path.join(SRC, 'routes', 'affiliate-join-pages'));
  const app = express();
  app.use('/affiliates', pagesRouter);
  app.use(
    '/affiliates',
    express.json({ limit: '2kb' }),
    router,
    router.jsonErrorHandler,
  );
  const server = http.createServer(app);
  await new Promise(function (resolve) {
    server.listen(options.port || 0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const origin = 'http://127.0.0.1:' + port;
  const base = origin + '/affiliates/v1';
  return {
    origin: origin,
    base: base,
    store: store,
    router: router,
    close: function () {
      return new Promise(function (resolve) {
        server.close(resolve);
      });
    },
  };
}

module.exports = {
  createAffiliateJoinStore,
  startLocalAffiliateJoinServer,
};
