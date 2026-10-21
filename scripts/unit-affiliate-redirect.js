'use strict';

/**
 * node scripts/unit-affiliate-redirect.js
 * Mocks Supabase. Does not connect to production.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const AFFILIATE_ID = '22222222-2222-4222-8222-222222222222';
const DEST = 'https://www.credizona.com.uy/solicitudes?hola=1#form';
const SECRET = 'test-hash-secret';

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    affiliateDestUrl: DEST,
    affiliateIpHashSecret: SECRET,
  },
};

const supabasePath = require.resolve('../src/clients/supabase');

function installSupabase(mock) {
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: mock,
  };
}

installSupabase({});

const router = require('../src/routes/affiliate-links');
const logger = require('../src/lib/logger');
const { hashIp } = require('../src/lib/affiliateRedirect');
const {
  assertNotProduction,
  assertSeedAllowed,
  supabaseHost,
  confirmationAccepted,
  seedAffiliates,
  PROD_REF,
} = require('./seed-affiliates');

function createMock(options) {
  const opts = options || {};
  const calls = {
    tables: [],
    inserts: [],
  };
  return {
    calls: calls,
    from: function (table) {
      calls.tables.push(table);
      if (table === 'marketing_impacts' || table === 'marketing_impact_events') {
        throw new Error('affiliate route touched ' + table);
      }
      return {
        select: function () {
          return {
            eq: function (_column, value) {
              return {
                maybeSingle: function () {
                  if (typeof opts.lookup === 'function') {
                    return Promise.resolve(opts.lookup(value));
                  }
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
        insert: function (row) {
          calls.inserts.push(row);
          if (opts.insertThrow) {
            return Promise.reject(new Error('insert exploded'));
          }
          if (opts.insertError) {
            return Promise.resolve({ error: { code: 'XX000' } });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

function request(method, code, headers) {
  return new Promise(function (resolve, reject) {
    const req = {
      method: method,
      url: '/a/' + code,
      params: { code: code },
      headers: headers || {},
      socket: { remoteAddress: '203.0.113.8' },
      get: function (name) {
        const key = String(name || '').toLowerCase();
        if (key === 'user-agent') return this.headers['user-agent'] || undefined;
        if (key === 'referer') return this.headers.referer || undefined;
        return undefined;
      },
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      status: function (statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      type: function () {
        return this;
      },
      set: function (key, value) {
        this.headers[key] = value;
        return this;
      },
      send: function (body) {
        this.body = body;
        resolve(this);
        return this;
      },
      end: function () {
        resolve(this);
        return this;
      },
      redirect: function (statusCode, location) {
        this.statusCode = statusCode;
        this.headers.Location = location;
        resolve(this);
        return this;
      },
    };
    try {
      router.handle(req, res, function (err) {
        if (err) reject(err);
        else resolve(res);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function activeLookup() {
  return {
    data: { id: AFFILIATE_ID, status: 'active' },
    error: null,
  };
}

function captureErrors(fn) {
  const seen = [];
  const original = logger.error;
  logger.error = function (message, meta) {
    seen.push({ message: message, meta: meta || {} });
    return original(message, meta);
  };
  return Promise.resolve()
    .then(function () {
      return fn(seen);
    })
    .then(function () {
      logger.error = original;
    })
    .catch(function (err) {
      logger.error = original;
      throw err;
    });
}

(async function run() {
  {
    const mock = createMock({ lookup: activeLookup });
    installSupabase(mock);
    const res = await request('GET', 'partner1', {
      'user-agent': 'Mozilla/5.0 bot-scanner',
      referer: 'https://partner.example/landing',
      'x-forwarded-for': '198.51.100.20, 10.0.0.1',
    });
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers['Cache-Control'], 'private, no-store');
    const loc = new URL(res.headers.Location);
    assert.strictEqual(loc.searchParams.get('utm_source'), 'referral');
    assert.strictEqual(loc.searchParams.get('hola'), '1');
    assert.strictEqual(loc.hash, '#form');
    const clickId = loc.searchParams.get('cz_click');
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        clickId,
      ),
    );
    assert.strictEqual(mock.calls.inserts.length, 1);
    const row = mock.calls.inserts[0];
    assert.strictEqual(row.click_id, clickId);
    assert.strictEqual(row.affiliate_id, AFFILIATE_ID);
    assert.strictEqual(row.user_agent, 'Mozilla/5.0 bot-scanner');
    assert.strictEqual(row.referer, 'https://partner.example/landing');
    assert.strictEqual(row.ip_hash, hashIp('198.51.100.20', SECRET));
    assert.ok(!Object.prototype.hasOwnProperty.call(row, 'ip'));
    assert.ok(row.ip_hash.indexOf('198.51.100.20') === -1);
    assert.ok(Number.isFinite(Date.parse(row.occurred_at)));
    assert.ok(mock.calls.tables.indexOf('marketing_impacts') === -1);
    assert.ok(mock.calls.tables.indexOf('affiliate_clicks') !== -1);
  }

  {
    const mock = createMock({ lookup: activeLookup });
    installSupabase(mock);
    const first = await request('GET', 'partner1');
    const second = await request('GET', 'partner1');
    const a = new URL(first.headers.Location).searchParams.get('cz_click');
    const b = new URL(second.headers.Location).searchParams.get('cz_click');
    assert.notStrictEqual(a, b);
    assert.strictEqual(mock.calls.inserts.length, 2);
  }

  {
    const mock = createMock({
      lookup: function () {
        return { data: null, error: null };
      },
    });
    installSupabase(mock);
    const res = await request('GET', 'missing1');
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location, DEST);
    assert.strictEqual(res.headers['Cache-Control'], 'private, no-store');
    assert.strictEqual(mock.calls.inserts.length, 0);
  }

  {
    const mock = createMock({
      lookup: function () {
        return {
          data: { id: AFFILIATE_ID, status: 'inactive' },
          error: null,
        };
      },
    });
    installSupabase(mock);
    const res = await request('GET', 'paused01');
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location, DEST);
    assert.strictEqual(mock.calls.inserts.length, 0);
  }

  {
    const mock = createMock({
      lookup: function () {
        throw new Error('should not look up an invalid code');
      },
    });
    installSupabase(mock);
    const res = await request('GET', 'no');
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location, DEST);
    assert.strictEqual(mock.calls.tables.length, 0);
    assert.strictEqual(mock.calls.inserts.length, 0);
  }

  {
    const mock = createMock({ lookup: activeLookup });
    installSupabase(mock);
    const res = await request('HEAD', 'partner1');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers.Location, undefined);
    assert.strictEqual(res.headers['Cache-Control'], 'private, no-store');
    assert.strictEqual(mock.calls.inserts.length, 0);
    assert.ok(mock.calls.tables.indexOf('affiliate_clicks') === -1);
  }

  {
    await captureErrors(async function (seen) {
      const mock = createMock({
        lookup: activeLookup,
        insertError: true,
      });
      installSupabase(mock);
      const res = await request('GET', 'partner1');
      assert.strictEqual(res.statusCode, 302);
      assert.strictEqual(res.headers.Location, DEST);
      assert.strictEqual(new URL(res.headers.Location).searchParams.get('cz_click'), null);
      assert.strictEqual(res.headers['Cache-Control'], 'private, no-store');
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].meta.reason, 'affiliate_click_insert_failed');
      assert.ok(JSON.stringify(seen).indexOf('203.0.113.8') === -1);
    });
  }

  {
    await captureErrors(async function (seen) {
      const mock = createMock({
        lookup: activeLookup,
        insertThrow: true,
      });
      installSupabase(mock);
      const res = await request('GET', 'partner1');
      assert.strictEqual(res.statusCode, 302);
      assert.strictEqual(res.headers.Location, DEST);
      assert.strictEqual(seen[0].meta.reason, 'affiliate_click_insert_failed');
    });
  }

  {
    await captureErrors(async function (seen) {
      const mock = createMock({
        lookup: function () {
          return { data: null, error: { code: 'XX000', message: 'secret-row' } };
        },
      });
      installSupabase(mock);
      const res = await request('GET', 'partner1');
      assert.strictEqual(res.statusCode, 302);
      assert.strictEqual(res.headers.Location, DEST);
      assert.strictEqual(mock.calls.inserts.length, 0);
      assert.strictEqual(seen[0].meta.reason, 'affiliate_lookup_failed');
      assert.ok(JSON.stringify(seen).indexOf('secret-row') === -1);
    });
  }

  {
    await captureErrors(async function (seen) {
      const mock = createMock({
        lookup: function () {
          return { data: null, error: { code: 'XX000' } };
        },
      });
      installSupabase(mock);
      const res = await request('HEAD', 'partner1');
      assert.strictEqual(res.statusCode, 302);
      assert.strictEqual(res.headers.Location, DEST);
      assert.strictEqual(mock.calls.inserts.length, 0);
      assert.strictEqual(seen[0].meta.reason, 'affiliate_lookup_failed');
    });
  }

  {
    const saved = envPath && require.cache[envPath].exports.affiliateDestUrl;
    require.cache[envPath].exports.affiliateDestUrl = '';
    const mock = createMock({ lookup: activeLookup });
    installSupabase(mock);
    const res = await request('GET', 'partner1');
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.headers.Location, undefined);
    assert.strictEqual(mock.calls.inserts.length, 0);
    require.cache[envPath].exports.affiliateDestUrl = 'notaurl';
    const invalid = await request('GET', 'partner1');
    assert.strictEqual(invalid.statusCode, 503);
    assert.strictEqual(invalid.headers.Location, undefined);
    require.cache[envPath].exports.affiliateDestUrl = saved;
  }

  {
    const mock = createMock({ lookup: activeLookup });
    installSupabase(mock);
    for (let i = 0; i < 80; i += 1) {
      const res = await request('GET', 'partner1', {
        'x-forwarded-for': '198.51.100.20',
      });
      assert.strictEqual(res.statusCode, 302);
    }
    assert.strictEqual(mock.calls.inserts.length, 80);
  }

  {
    await captureErrors(async function (seen) {
      const savedSecret = require.cache[envPath].exports.affiliateIpHashSecret;
      require.cache[envPath].exports.affiliateIpHashSecret = '';
      const mock = createMock({ lookup: activeLookup });
      installSupabase(mock);
      const res = await request('GET', 'partner1', {
        'x-forwarded-for': '198.51.100.20',
      });
      assert.strictEqual(res.statusCode, 302);
      assert.strictEqual(res.headers.Location, DEST);
      assert.strictEqual(new URL(res.headers.Location).searchParams.get('cz_click'), null);
      assert.strictEqual(mock.calls.tables.length, 0);
      assert.strictEqual(mock.calls.inserts.length, 0);
      assert.strictEqual(seen[0].meta.reason, 'affiliate_ip_hash_secret_missing');
      assert.ok(seen[0].message.indexOf('AFFILIATE_IP_HASH_SECRET') !== -1);
      assert.ok(JSON.stringify(seen).indexOf('198.51.100.20') === -1);
      require.cache[envPath].exports.affiliateIpHashSecret = savedSecret;
    });
  }

  {
    assert.throws(function () {
      assertNotProduction('https://' + PROD_REF + '.supabase.co');
    }, /production supabase/);
    assert.throws(function () {
      assertNotProduction('');
    }, /SUPABASE_URL/);
    assert.doesNotThrow(function () {
      assertNotProduction('https://example.supabase.co');
    });
  }

  {
    assert.throws(function () {
      assertSeedAllowed('');
    }, /ALLOW_AFFILIATE_SEED/);
    assert.throws(function () {
      assertSeedAllowed('1');
    }, /ALLOW_AFFILIATE_SEED/);
    assert.doesNotThrow(function () {
      assertSeedAllowed('true');
    });
    assert.strictEqual(supabaseHost('https://example.supabase.co'), 'example.supabase.co');
    assert.strictEqual(confirmationAccepted('yes'), true);
    assert.strictEqual(confirmationAccepted('no'), false);
    assert.strictEqual(confirmationAccepted('YES'), false);
  }

  {
    const existing = {
      real01: { id: 'real', code: 'real01', is_test: false },
      test01: { id: 'test', code: 'test01', is_test: true },
    };
    const inserts = [];
    const mock = {
      from: function () {
        return {
          select: function () {
            return {
              eq: function (_column, code) {
                return {
                  maybeSingle: function () {
                    return Promise.resolve({
                      data: existing[code] || null,
                      error: null,
                    });
                  },
                };
              },
            };
          },
          insert: function (row) {
            inserts.push(row);
            return {
              select: function () {
                return {
                  maybeSingle: function () {
                    return Promise.resolve({
                      data: { id: 'new', code: row.code, is_test: row.is_test },
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      },
    };
    const created = await seedAffiliates(['newcode1', 'test01'], mock);
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].is_test, true);
    assert.strictEqual(inserts[0].status, 'active');
    assert.strictEqual(created.length, 2);
    await assert.rejects(
      function () {
        return seedAffiliates(['real01'], mock);
      },
      /non-test affiliate/,
    );
    assert.strictEqual(inserts.length, 1);
  }

  {
    const script = path.join(__dirname, 'seed-affiliates.js');
    const child = spawnSync(process.execPath, [script, 'partner1'], {
      env: Object.assign({}, process.env, {
        SUPABASE_URL: 'https://' + PROD_REF + '.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'unused',
        ALLOW_AFFILIATE_SEED: 'true',
      }),
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.notStrictEqual(child.status, 0);
    assert.ok(String(child.stderr).indexOf('production supabase') !== -1);
  }

  {
    const script = path.join(__dirname, 'seed-affiliates.js');
    const child = spawnSync(process.execPath, [script, 'partner1'], {
      env: Object.assign({}, process.env, {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'unused',
        ALLOW_AFFILIATE_SEED: '',
      }),
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.notStrictEqual(child.status, 0);
    assert.ok(String(child.stderr).indexOf('ALLOW_AFFILIATE_SEED=true is required') !== -1);
  }

  {
    const script = path.join(__dirname, 'seed-affiliates.js');
    const child = spawnSync(process.execPath, [script, 'partner1'], {
      input: 'no\n',
      env: Object.assign({}, process.env, {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'unused',
        ALLOW_AFFILIATE_SEED: 'true',
      }),
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.notStrictEqual(child.status, 0);
    assert.ok(String(child.stdout).indexOf('Supabase host: example.supabase.co') !== -1);
    assert.ok(String(child.stdout).indexOf('never generate prizes') !== -1);
    assert.ok(String(child.stderr).indexOf('seed cancelled') !== -1);
  }

  {
    const appJs = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app.js'),
      'utf8',
    );
    const affiliateAt = appJs.indexOf('app.use(affiliateLinksRouter)');
    const authAt = appJs.indexOf('app.use(requireAuth)');
    assert.ok(affiliateAt > 0);
    assert.ok(authAt > affiliateAt);
  }

  {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '20261020_affiliates_clicks.sql'),
      'utf8',
    );
    assert.ok(sql.indexOf('CREATE TABLE IF NOT EXISTS public.affiliates') !== -1);
    assert.ok(sql.indexOf('CREATE TABLE IF NOT EXISTS public.affiliate_clicks') !== -1);
    assert.ok(sql.indexOf('ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false') !== -1);
    assert.ok(sql.indexOf('never generate prizes') !== -1);
    assert.ok(sql.indexOf('ENABLE ROW LEVEL SECURITY') !== -1);
    assert.ok(sql.indexOf('REVOKE ALL ON TABLE public.affiliates FROM PUBLIC, anon, authenticated') !== -1);
    assert.ok(sql.indexOf('REVOKE ALL ON TABLE public.affiliate_clicks FROM PUBLIC, anon, authenticated') !== -1);
    assert.ok(sql.indexOf('GRANT SELECT, INSERT ON TABLE public.affiliates TO service_role') !== -1);
    assert.ok(sql.indexOf('GRANT SELECT, INSERT ON TABLE public.affiliate_clicks TO service_role') !== -1);
    assert.ok(sql.indexOf('CREATE POLICY') === -1);
    assert.ok(sql.indexOf('TO anon') === -1);
    assert.ok(sql.indexOf('TO authenticated') === -1);
    const route = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'affiliate-links.js'),
      'utf8',
    );
    assert.ok(route.indexOf("require('../clients/supabase')") !== -1);
    assert.ok(route.indexOf('anon') === -1);
    const client = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'clients', 'supabase.js'),
      'utf8',
    );
    assert.ok(client.indexOf('supabaseServiceRoleKey') !== -1);
    assert.ok(client.indexOf('SUPABASE_ANON_KEY') === -1);
  }

  process.stdout.write('unit-affiliate-redirect: ok\n');
})().catch(function (err) {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
