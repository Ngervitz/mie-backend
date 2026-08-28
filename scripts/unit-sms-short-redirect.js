'use strict';

/**
 * node scripts/unit-sms-short-redirect.js
 */

const assert = require('assert');

const TOKEN = 'abcdefghijABCDEFGHIJ12';
const IMPACT_ID = '11111111-1111-4111-8111-111111111111';
const DEST_WITHOUT_JT =
  'https://cz.uy/oferta?utm_source=sms&utm_medium=sms&utm_campaign=camp-1#go';
const DEST_WITH_JT =
  'https://cz.uy/oferta?utm_source=sms&utm_medium=sms&utm_campaign=camp-1&jt=' +
  TOKEN +
  '#go';

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

const router = require('../src/routes/sms-short-links');

function createMock(options) {
  const opts = options || {};
  const calls = {
    rpc: [],
    inserts: [],
    shortSelects: 0,
    impactSelects: 0,
  };

  return {
    calls: calls,
    from: function (table) {
      return {
        select: function () {
          return {
            eq: function (_column, value) {
              return {
                maybeSingle: function () {
                  if (table === 'sms_short_links') {
                    calls.shortSelects += 1;
                    if (typeof opts.shortLookup === 'function') {
                      return Promise.resolve(opts.shortLookup(value));
                    }
                    return Promise.resolve({ data: null, error: null });
                  }
                  if (table === 'marketing_impacts') {
                    calls.impactSelects += 1;
                    if (typeof opts.impactLookup === 'function') {
                      return opts.impactLookup(value);
                    }
                    return Promise.resolve({ data: null, error: null });
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
            return Promise.reject(new Error('insert failed'));
          }
          if (opts.insertError) {
            return Promise.resolve({ data: null, error: opts.insertError });
          }
          return Promise.resolve({ data: [row], error: null });
        },
      };
    },
    rpc: function (name, args) {
      calls.rpc.push({ name: name, args: args });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function requestShort(code) {
  return new Promise(function (resolve, reject) {
    const req = {
      method: 'GET',
      url: '/s/' + code,
      params: { short_code: code },
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
      },
      redirect: function (statusCode, location) {
        this.statusCode = statusCode;
        this.headers.Location = location;
        resolve(this);
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

function flush() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

function shortRow(dest, impactId) {
  return {
    data: {
      destination_url: dest,
      impact_id: impactId == null ? null : impactId,
    },
    error: null,
  };
}

(async function run() {
  // -------------------------------------------------------------------------
  // TEST A: Nuevo individual con jt persistido en destination_url
  // -------------------------------------------------------------------------
  {
    const mock = createMock({
      shortLookup: function () {
        return shortRow(DEST_WITH_JT, IMPACT_ID);
      },
      impactLookup: function () {
        assert.fail('must not call marketing_impacts when destination_url already has jt');
      },
    });
    installSupabase(mock);
    const res = await requestShort('New001');
    await flush();
    assert.strictEqual(res.statusCode, 302);
    const loc = new URL(res.headers.Location);
    assert.strictEqual(loc.searchParams.get('jt'), TOKEN);
    assert.strictEqual(loc.searchParams.get('utm_campaign'), 'camp-1');
    assert.strictEqual(mock.calls.shortSelects, 1);
    assert.strictEqual(mock.calls.impactSelects, 0, 'zero queries to marketing_impacts');
    assert.strictEqual(mock.calls.inserts.length, 1, 'records click event');
    assert.strictEqual(mock.calls.inserts[0].impact_id, IMPACT_ID);
    assert.strictEqual(mock.calls.inserts[0].event_name, 'click');
    assert.strictEqual(mock.calls.rpc.length, 0);
  }

  // -------------------------------------------------------------------------
  // TEST B: Individual pre-fix (sin jt) con lookup de fallback exitoso
  // -------------------------------------------------------------------------
  {
    const mock = createMock({
      shortLookup: function () {
        return shortRow(DEST_WITHOUT_JT, IMPACT_ID);
      },
      impactLookup: function () {
        return Promise.resolve({
          data: { tracking_token: TOKEN },
          error: null,
        });
      },
    });
    installSupabase(mock);
    const res = await requestShort('PreFix1');
    await flush();
    assert.strictEqual(res.statusCode, 302);
    const loc = new URL(res.headers.Location);
    assert.strictEqual(loc.searchParams.get('jt'), TOKEN);
    assert.strictEqual(mock.calls.shortSelects, 1);
    assert.strictEqual(mock.calls.impactSelects, 1, 'used fallback lookup');
    assert.strictEqual(mock.calls.inserts.length, 1);
    assert.strictEqual(mock.calls.inserts[0].impact_id, IMPACT_ID);
  }

  // -------------------------------------------------------------------------
  // TEST C: Legacy real (impact_id null)
  // -------------------------------------------------------------------------
  {
    const mock = createMock({
      shortLookup: function () {
        return shortRow(DEST_WITHOUT_JT, null);
      },
    });
    installSupabase(mock);
    const res = await requestShort('Old123');
    await flush();
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location, DEST_WITHOUT_JT);
    assert.strictEqual(mock.calls.impactSelects, 0);
    assert.strictEqual(mock.calls.inserts.length, 0);
    assert.strictEqual(mock.calls.rpc.length, 1);
    assert.strictEqual(mock.calls.rpc[0].name, 'sms_short_link_record_click');
    assert.strictEqual(mock.calls.rpc[0].args.p_short_code, 'Old123');
  }

  // -------------------------------------------------------------------------
  // TEST D: Error o throw en recordImpactClick no afecta redirect ni arroja unhandled
  // -------------------------------------------------------------------------
  {
    const mock = createMock({
      shortLookup: function () {
        return shortRow(DEST_WITH_JT, IMPACT_ID);
      },
      insertThrow: true,
    });
    installSupabase(mock);
    const res = await requestShort('New002');
    await flush();
    assert.strictEqual(res.statusCode, 302);
    assert.ok(new URL(res.headers.Location).searchParams.get('jt'));
  }

  // -------------------------------------------------------------------------
  // TEST E: Regresión específica del Canary (u3f3uf)
  // -------------------------------------------------------------------------
  {
    const canaryDest =
      'https://www.credizona.com.uy/solicitudes?utm_source=sms&utm_medium=sms&utm_campaign=a5651b31-11a7-4814-85d9-db37c3418da2';
    const canaryImpactId = '8d8a4f18-f467-4bea-b65a-7383fc88f382';
    const canaryToken = '6Z8SFfuCLKLE_Gc7l-Ze_Q';

    const mock = createMock({
      shortLookup: function (code) {
        if (code === 'u3f3uf') {
          return shortRow(canaryDest, canaryImpactId);
        }
        return { data: null, error: null };
      },
      impactLookup: function (id) {
        if (id === canaryImpactId) {
          return Promise.resolve({
            data: { tracking_token: canaryToken },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
    });
    installSupabase(mock);
    const res = await requestShort('u3f3uf');
    await flush();
    assert.strictEqual(res.statusCode, 302);
    const loc = new URL(res.headers.Location);
    assert.strictEqual(loc.searchParams.get('jt'), canaryToken);
    assert.strictEqual(
      loc.searchParams.get('utm_campaign'),
      'a5651b31-11a7-4814-85d9-db37c3418da2',
    );
    assert.strictEqual(mock.calls.inserts.length, 1);
    assert.strictEqual(mock.calls.inserts[0].impact_id, canaryImpactId);
    assert.strictEqual(mock.calls.inserts[0].event_name, 'click');
  }

  // -------------------------------------------------------------------------
  // TEST F: Pre-Fix con Lookup Fallido -> Redirige y AÚN ASÍ registra click
  // -------------------------------------------------------------------------
  {
    const mock = createMock({
      shortLookup: function () {
        return shortRow(DEST_WITHOUT_JT, IMPACT_ID);
      },
      impactLookup: function () {
        return Promise.reject(new Error('PostgREST connection timeout'));
      },
    });
    installSupabase(mock);
    const res = await requestShort('PreFixFail');
    await flush();
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location, DEST_WITHOUT_JT);
    assert.ok(!new URL(res.headers.Location).searchParams.get('jt'));
    assert.strictEqual(mock.calls.inserts.length, 1, 'click event MUST be inserted even if token lookup failed');
    assert.strictEqual(mock.calls.inserts[0].impact_id, IMPACT_ID);
    assert.strictEqual(mock.calls.rpc.length, 0, 'must not call recordHistoricalClick');
  }

  // -------------------------------------------------------------------------
  // TEST Extra: 404 para short code no existente
  // -------------------------------------------------------------------------
  {
    const mock = createMock({
      shortLookup: function () {
        return { data: null, error: null };
      },
    });
    installSupabase(mock);
    const res = await requestShort('Nope404');
    await flush();
    assert.strictEqual(res.statusCode, 404);
  }

  console.log('OK unit-sms-short-redirect (All cases A–F passed)');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
