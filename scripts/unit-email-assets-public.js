'use strict';

/**
 * Public /email-assets mount (Encuesta HTML images).
 * Run: node scripts/unit-email-assets-public.js
 *
 * Builds a minimal Express app mirroring production order:
 *   public email-assets static → requireAuth → protected public/
 * without loading the full app (no DB).
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

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
    sessionSecret: 'unit-email-assets-session-secret',
    cronSecret: null,
  },
};

const { requireAuth } = require('../src/middleware/auth');

const ROOT = path.resolve(__dirname, '..');
const EMAIL_ASSETS_ROOT = path.join(ROOT, 'public', 'email-assets');
const PUBLIC_ROOT = path.join(ROOT, 'public');

const ASSETS = {
  logo: {
    file: 'credizona-email-logo-v1.png',
    source: path.join(
      ROOT,
      'samples',
      'email-drafts',
      'credizona_app_icon.email-crop.png',
    ),
  },
  clock: {
    file: 'encuesta-clock-v1.png',
    source: path.join(
      ROOT,
      'samples',
      'email-drafts',
      'encuesta-clock-icon.png',
    ),
  },
  gift: {
    file: 'sorteo-gift-v1.png',
    source: path.join(ROOT, 'samples', 'email-drafts', 'sorteo-gift-icon.png'),
  },
};

function sha256File(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildApp() {
  const app = express();
  app.use(
    '/email-assets',
    express.static(EMAIL_ASSETS_ROOT, {
      index: false,
      fallthrough: false,
    }),
    function emailAssetsStaticError(err, _req, res, next) {
      const code = Number(err && (err.statusCode || err.status)) || 0;
      if (code >= 400 && code < 500) {
        res.sendStatus(code);
        return;
      }
      next(err);
    },
  );
  app.use(requireAuth);
  app.use(express.static(PUBLIC_ROOT));
  app.get('/api/auth/me', function (_req, res) {
    res.status(200).json({ ok: true });
  });
  return app;
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        server: server,
        base: 'http://127.0.0.1:' + server.address().port,
      });
    });
  });
}

async function request(base, method, urlPath, options) {
  const opts = options || {};
  const res = await fetch(base + urlPath, {
    method: method,
    redirect: opts.redirect || 'manual',
    headers: opts.headers || {},
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: res.headers,
    buf: buf,
    location: res.headers.get('location'),
    contentType: res.headers.get('content-type'),
  };
}

function assertNotEscaped(res, label) {
  assert.notStrictEqual(
    res.status,
    200,
    label + ' must not return 200 (got ' + res.status + ')',
  );
}

(async function main() {
  // Production mount position in app.js source
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const emailAssetsIdx = appSrc.indexOf("'/email-assets'");
  const authIdx = appSrc.indexOf('app.use(requireAuth)');
  assert.ok(emailAssetsIdx > 0, 'email-assets mount present in app.js');
  assert.ok(authIdx > emailAssetsIdx, 'email-assets mounted before requireAuth');
  assert.ok(
    /index:\s*false/.test(appSrc) && /fallthrough:\s*false/.test(appSrc),
    'static options index/fallthrough false',
  );

  // On-disk assets identical to sources
  Object.keys(ASSETS).forEach(function (key) {
    const a = ASSETS[key];
    const dest = path.join(EMAIL_ASSETS_ROOT, a.file);
    assert.ok(fs.existsSync(dest), dest + ' exists');
    assert.strictEqual(
      sha256File(a.source),
      sha256File(dest),
      key + ' hash matches source',
    );
  });

  const { server, base } = await listen(buildApp());

  try {
    // GET logo/clock/gift → 200 + image/png + hash
    for (const key of Object.keys(ASSETS)) {
      const a = ASSETS[key];
      const res = await request(base, 'GET', '/email-assets/' + a.file);
      assert.strictEqual(res.status, 200, key + ' GET status');
      assert.ok(
        String(res.contentType || '').includes('image/png'),
        key + ' content-type png',
      );
      assert.strictEqual(
        sha256Buf(res.buf),
        sha256File(path.join(EMAIL_ASSETS_ROOT, a.file)),
        key + ' body hash',
      );
    }

    // HEAD
    const head = await request(
      base,
      'HEAD',
      '/email-assets/credizona-email-logo-v1.png',
    );
    assert.strictEqual(head.status, 200, 'HEAD status');
    assert.ok(
      String(head.contentType || '').includes('image/png'),
      'HEAD content-type',
    );
    assert.strictEqual(head.buf.length, 0, 'HEAD body empty');

    // Missing asset
    const missing = await request(base, 'GET', '/email-assets/does-not-exist.png');
    assert.ok(
      missing.status === 404 || missing.status === 403,
      'missing → 404/403, got ' + missing.status,
    );

    // POST must not serve asset bytes
    const post = await request(
      base,
      'POST',
      '/email-assets/credizona-email-logo-v1.png',
      { headers: { 'content-type': 'application/json' } },
    );
    assert.notStrictEqual(post.status, 200, 'POST not 200');
    assert.notStrictEqual(
      sha256Buf(post.buf),
      sha256File(path.join(EMAIL_ASSETS_ROOT, 'credizona-email-logo-v1.png')),
      'POST must not return logo bytes',
    );

    // Directory listing / index
    const dirListing = await request(base, 'GET', '/email-assets/');
    assert.notStrictEqual(dirListing.status, 200, '/email-assets/ not 200 list');
    const bodyText = dirListing.buf.toString('utf8').toLowerCase();
    assert.ok(
      !bodyText.includes('credizona-email-logo-v1.png') ||
        dirListing.status >= 300,
      'no directory listing of filenames',
    );

    // Auth regression: dashboard / API / Janus asset remain gated
    const dash = await request(base, 'GET', '/mie-dashboard.html');
    assert.ok(
      dash.status === 302 || dash.status === 401,
      'dashboard protected, got ' + dash.status,
    );
    if (dash.status === 302) {
      assert.ok(
        String(dash.location || '').includes('login.html'),
        'dashboard redirects to login',
      );
    }

    const api = await request(base, 'GET', '/api/auth/me');
    assert.strictEqual(api.status, 401, 'API without auth → 401');

    const janusLogo = await request(base, 'GET', '/assets/janus-logo.svg');
    assert.ok(
      janusLogo.status === 302 || janusLogo.status === 401,
      'janus logo protected, got ' + janusLogo.status,
    );

    // Drafts / previews / samples not served publicly via this app surface
    const draft = await request(
      base,
      'GET',
      '/samples/email-drafts/rechazados-survey-invite-step1.draft.html',
    );
    assert.notStrictEqual(draft.status, 200, 'draft not publicly served');

    const preview = await request(
      base,
      'GET',
      '/samples/email-drafts/rechazados-survey-invite-step1.preview.html',
    );
    assert.notStrictEqual(preview.status, 200, 'preview not publicly served');

    const samples = await request(base, 'GET', '/samples/');
    assert.notStrictEqual(samples.status, 200, 'samples not publicly served');

    // Traversal variants — never 200 with content outside email-assets root
    const neighborHash = sha256File(
      path.join(PUBLIC_ROOT, 'assets', 'janus-logo.svg'),
    );
    const draftHash = sha256File(
      path.join(
        ROOT,
        'samples',
        'email-drafts',
        'rechazados-survey-invite-step1.draft.html',
      ),
    );

    const traversalPaths = [
      '/email-assets/../assets/janus-logo.svg',
      '/email-assets/..%2fassets/janus-logo.svg',
      '/email-assets/%2e%2e/assets/janus-logo.svg',
      '/email-assets/%2e%2e%2fassets/janus-logo.svg',
      '/email-assets/%252e%252e%252fassets/janus-logo.svg',
      '/email-assets/..\\assets\\janus-logo.svg',
      '/email-assets/....//assets/janus-logo.svg',
      '/email-assets/../../samples/email-drafts/rechazados-survey-invite-step1.draft.html',
      '/email-assets/%2e%2e/%2e%2e/samples/email-drafts/rechazados-survey-invite-step1.draft.html',
      '/email-assets/../email-assets/../assets/janus-logo.svg',
    ];

    for (let i = 0; i < traversalPaths.length; i += 1) {
      const p = traversalPaths[i];
      const res = await request(base, 'GET', p);
      if (res.status === 200) {
        const h = sha256Buf(res.buf);
        assert.notStrictEqual(
          h,
          neighborHash,
          'traversal must not serve janus logo: ' + p,
        );
        assert.notStrictEqual(
          h,
          draftHash,
          'traversal must not serve draft: ' + p,
        );
        // If somehow 200, it must be one of the three allowed assets only
        const allowed = Object.keys(ASSETS).map(function (k) {
          return sha256File(path.join(EMAIL_ASSETS_ROOT, ASSETS[k].file));
        });
        assert.ok(
          allowed.indexOf(h) !== -1,
          'unexpected 200 body for traversal path ' + p,
        );
      } else {
        assertNotEscaped(res, p);
      }
    }

    console.log('OK unit-email-assets-public');
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
