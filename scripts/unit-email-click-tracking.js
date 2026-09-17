'use strict';

/**
 * Unit tests: email click helpers + redirect HEAD/GET semantics.
 * node scripts/unit-email-click-tracking.js
 * No production I/O. No real sends.
 */

const assert = require('assert');
const crypto = require('crypto');

process.env.EMAIL_PUBLIC_BASE_URL = 'https://janus.test';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';

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
    emailUnsubscribeHmacSecret: 'test-email-unsubscribe-secret',
    emailPublicBaseUrl: 'https://janus.test',
  },
};

const {
  TRACKING_TOKEN_RE,
  buildEmailClickTrackedUrl,
  appendJtToDestination,
} = require('../src/lib/emailClickTracking');

const TOKEN = 'abcdefghijABCDEFGHIJ12';
assert.ok(TRACKING_TOKEN_RE.test(TOKEN));
assert.strictEqual(
  buildEmailClickTrackedUrl(TOKEN, 'https://janus.test'),
  'https://janus.test/email/c/' + TOKEN,
);
assert.throws(function () {
  buildEmailClickTrackedUrl('short');
});

const dest =
  'https://www.credizona.com.uy/solicitudes/sinoferta?lrw=LRW1';
const withJt = appendJtToDestination(dest, TOKEN);
assert.ok(withJt.indexOf('jt=' + TOKEN) !== -1);
assert.ok(withJt.indexOf('lrw=LRW1') !== -1);

// --- redirect router ---
const supabasePath = require.resolve('../src/clients/supabase');
const inserts = [];
let impactRow = {
  id: '11111111-1111-4111-8111-111111111111',
  tracking_token: TOKEN,
  channel: 'email',
  destination_url: dest,
};

function installSupabase(mock) {
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: mock,
  };
}

function createMock(opts) {
  const options = opts || {};
  return {
    from: function (table) {
      return {
        select: function () {
          return {
            eq: function (_col, value) {
              return {
                maybeSingle: function () {
                  if (table === 'marketing_impacts') {
                    if (options.missing) {
                      return Promise.resolve({ data: null, error: null });
                    }
                    if (options.wrongChannel) {
                      return Promise.resolve({
                        data: Object.assign({}, impactRow, { channel: 'sms' }),
                        error: null,
                      });
                    }
                    if (options.missingDest) {
                      return Promise.resolve({
                        data: Object.assign({}, impactRow, {
                          destination_url: null,
                        }),
                        error: null,
                      });
                    }
                    if (String(value) !== TOKEN) {
                      return Promise.resolve({ data: null, error: null });
                    }
                    return Promise.resolve({ data: impactRow, error: null });
                  }
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
        insert: function (row) {
          inserts.push(row);
          return Promise.resolve({ data: [row], error: null });
        },
      };
    },
  };
}

function clearRouterCache() {
  const p = require.resolve('../src/routes/email-click');
  delete require.cache[p];
}

function request(method, token) {
  return new Promise(function (resolve) {
    clearRouterCache();
    const router = require('../src/routes/email-click');
    const layer = router.stack.find(function (l) {
      return (
        l.route &&
        l.route.path === '/email/c/:token' &&
        l.route.methods[method.toLowerCase()]
      );
    });
    assert.ok(layer, 'route ' + method + ' missing');
    const req = {
      method: method,
      params: { token: token },
      url: '/email/c/' + token,
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      redirectedTo: null,
      status: function (code) {
        this.statusCode = code;
        return this;
      },
      type: function () {
        return this;
      },
      set: function (k, v) {
        this.headers[k] = v;
        return this;
      },
      send: function (b) {
        this.body = b;
        resolve(this);
        return this;
      },
      end: function () {
        resolve(this);
        return this;
      },
      redirect: function (code, loc) {
        this.statusCode = code;
        this.redirectedTo = loc;
        resolve(this);
        return this;
      },
    };
    layer.route.stack[0].handle(req, res, function (err) {
      if (err) resolve({ statusCode: 500, error: err });
    });
  });
}

(async function main() {
  inserts.length = 0;
  installSupabase(createMock());
  const get1 = await request('GET', TOKEN);
  assert.strictEqual(get1.statusCode, 302);
  assert.ok(String(get1.redirectedTo).indexOf('jt=' + TOKEN) !== -1);
  await new Promise(function (r) {
    setTimeout(r, 20);
  });
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0].event_name, 'click');
  assert.strictEqual(inserts[0].source, 'janus');
  assert.ok(inserts[0].external_event_id);

  const get2 = await request('GET', TOKEN);
  assert.strictEqual(get2.statusCode, 302);
  await new Promise(function (r) {
    setTimeout(r, 20);
  });
  assert.strictEqual(inserts.length, 2);
  assert.notStrictEqual(
    inserts[0].external_event_id,
    inserts[1].external_event_id,
  );

  const beforeHead = inserts.length;
  const head = await request('HEAD', TOKEN);
  assert.strictEqual(head.statusCode, 200);
  await new Promise(function (r) {
    setTimeout(r, 20);
  });
  assert.strictEqual(inserts.length, beforeHead, 'HEAD must not write events');

  installSupabase(createMock({ missing: true }));
  const bad = await request('GET', TOKEN);
  assert.strictEqual(bad.statusCode, 404);

  installSupabase(createMock({ missingDest: true }));
  const noDest = await request('GET', TOKEN);
  assert.strictEqual(noDest.statusCode, 404);

  installSupabase(createMock({ wrongChannel: true }));
  const sms = await request('GET', TOKEN);
  assert.strictEqual(sms.statusCode, 404);

  const inv = await request('GET', 'not-a-valid-token!!');
  assert.strictEqual(inv.statusCode, 404);

  // CSPRNG-ish uniqueness check for helper token format expectation
  const a = crypto.randomBytes(16).toString('base64url');
  assert.strictEqual(a.length, 22);

  console.log('unit-email-click-tracking: PASS');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
