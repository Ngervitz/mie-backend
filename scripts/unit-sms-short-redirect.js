'use strict';

/**
 * node scripts/unit-sms-short-redirect.js
 */

const assert = require('assert');

const IMPACT_LOOKUP_TIMEOUT_MS = 500;
const TOKEN = 'abcdefghijABCDEFGHIJ12';
const IMPACT_ID = '11111111-1111-4111-8111-111111111111';
const DEST =
  'https://cz.uy/oferta?utm_source=sms&utm_medium=sms&utm_campaign=camp-1#go';

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
            eq: function (column, value) {
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
  const individual = createMock({
    shortLookup: function () {
      return shortRow(DEST, IMPACT_ID);
    },
    impactLookup: function () {
      return Promise.resolve({
        data: { tracking_token: TOKEN },
        error: null,
      });
    },
  });
  installSupabase(individual);
  const individualRes = await requestShort('AbC234');
  await flush();
  assert.strictEqual(individualRes.statusCode, 302);
  const individualLoc = new URL(individualRes.headers.Location);
  assert.strictEqual(individualLoc.searchParams.get('jt'), TOKEN);
  assert.strictEqual(individualLoc.searchParams.get('utm_source'), 'sms');
  assert.strictEqual(individualLoc.searchParams.get('utm_medium'), 'sms');
  assert.strictEqual(individualLoc.searchParams.get('utm_campaign'), 'camp-1');
  assert.strictEqual(individualLoc.hash, '#go');
  assert.strictEqual(individual.calls.inserts.length, 1);
  assert.strictEqual(individual.calls.rpc.length, 0);
  assert.strictEqual(individual.calls.inserts[0].source, 'janus');
  assert.strictEqual(individual.calls.inserts[0].event_name, 'click');
  assert.strictEqual(individual.calls.inserts[0].impact_id, IMPACT_ID);
  assert.ok(individual.calls.inserts[0].external_event_id);

  const second = await requestShort('AbC234');
  await flush();
  assert.strictEqual(second.statusCode, 302);
  assert.strictEqual(individual.calls.inserts.length, 2);
  assert.notStrictEqual(
    individual.calls.inserts[0].external_event_id,
    individual.calls.inserts[1].external_event_id,
  );

  const insertFail = createMock({
    shortLookup: function () {
      return shortRow(DEST, IMPACT_ID);
    },
    impactLookup: function () {
      return Promise.resolve({
        data: { tracking_token: TOKEN },
        error: null,
      });
    },
    insertError: { message: 'insert failed', code: '57014' },
  });
  installSupabase(insertFail);
  const insertFailRes = await requestShort('AbC234');
  await flush();
  assert.strictEqual(insertFailRes.statusCode, 302);
  assert.ok(new URL(insertFailRes.headers.Location).searchParams.get('jt'));
  assert.strictEqual(insertFail.calls.inserts.length, 1);

  const insertThrow = createMock({
    shortLookup: function () {
      return shortRow(DEST, IMPACT_ID);
    },
    impactLookup: function () {
      return Promise.resolve({
        data: { tracking_token: TOKEN },
        error: null,
      });
    },
    insertThrow: true,
  });
  installSupabase(insertThrow);
  const insertThrowRes = await requestShort('AbC234');
  await flush();
  assert.strictEqual(insertThrowRes.statusCode, 302);
  assert.ok(new URL(insertThrowRes.headers.Location).searchParams.get('jt'));

  const historical = createMock({
    shortLookup: function () {
      return shortRow(DEST, null);
    },
  });
  installSupabase(historical);
  const historicalRes = await requestShort('Old123');
  await flush();
  assert.strictEqual(historicalRes.statusCode, 302);
  assert.strictEqual(historicalRes.headers.Location, DEST);
  assert.strictEqual(historical.calls.rpc.length, 1);
  assert.strictEqual(
    historical.calls.rpc[0].name,
    'sms_short_link_record_click',
  );
  assert.strictEqual(historical.calls.inserts.length, 0);
  assert.strictEqual(historical.calls.impactSelects, 0);

  const preview = createMock({
    shortLookup: function () {
      return shortRow(DEST, null);
    },
  });
  installSupabase(preview);
  const previewRes = await requestShort('Prev01');
  await flush();
  assert.strictEqual(previewRes.statusCode, 302);
  assert.strictEqual(previewRes.headers.Location, DEST);
  assert.ok(!new URL(previewRes.headers.Location).searchParams.get('jt'));
  assert.strictEqual(preview.calls.rpc.length, 1);
  assert.strictEqual(preview.calls.inserts.length, 0);

  const missing = createMock({
    shortLookup: function () {
      return { data: null, error: null };
    },
  });
  installSupabase(missing);
  const missingRes = await requestShort('Nope01');
  await flush();
  assert.strictEqual(missingRes.statusCode, 404);
  assert.strictEqual(missingRes.body, 'Not found');
  assert.strictEqual(missing.calls.rpc.length, 0);
  assert.strictEqual(missing.calls.inserts.length, 0);

  const badCode = createMock();
  installSupabase(badCode);
  const badCodeRes = await requestShort('***');
  await flush();
  assert.strictEqual(badCodeRes.statusCode, 404);
  assert.strictEqual(badCode.calls.shortSelects, 0);

  const orphan = createMock({
    shortLookup: function () {
      return shortRow(DEST, IMPACT_ID);
    },
    impactLookup: function () {
      return Promise.resolve({ data: null, error: null });
    },
  });
  installSupabase(orphan);
  const orphanRes = await requestShort('AbC234');
  await flush();
  assert.strictEqual(orphanRes.statusCode, 302);
  assert.strictEqual(orphanRes.headers.Location, DEST);
  assert.strictEqual(orphan.calls.inserts.length, 0);
  assert.strictEqual(orphan.calls.rpc.length, 0);

  const badToken = createMock({
    shortLookup: function () {
      return shortRow(DEST, IMPACT_ID);
    },
    impactLookup: function () {
      return Promise.resolve({
        data: { tracking_token: 'short' },
        error: null,
      });
    },
  });
  installSupabase(badToken);
  const badTokenRes = await requestShort('AbC234');
  await flush();
  assert.strictEqual(badTokenRes.statusCode, 302);
  assert.strictEqual(badTokenRes.headers.Location, DEST);
  assert.strictEqual(badToken.calls.inserts.length, 0);
  assert.strictEqual(badToken.calls.rpc.length, 0);

  let lateReject;
  const hangingQuery = new Promise(function (_, reject) {
    lateReject = reject;
  });
  const hung = createMock({
    shortLookup: function () {
      return shortRow(DEST, IMPACT_ID);
    },
    impactLookup: function () {
      return hangingQuery;
    },
  });
  installSupabase(hung);
  const lateRejections = [];
  function onUnhandled(err) {
    lateRejections.push(err);
  }
  process.on('unhandledRejection', onUnhandled);
  const hungStarted = Date.now();
  const hungRes = await requestShort('AbC234');
  const hungElapsed = Date.now() - hungStarted;
  await flush();
  assert.strictEqual(hungRes.statusCode, 302);
  assert.strictEqual(hungRes.headers.Location, DEST);
  assert.ok(
    !new URL(hungRes.headers.Location).searchParams.get('jt'),
    'timeout must not add jt',
  );
  assert.ok(
    hungElapsed < IMPACT_LOOKUP_TIMEOUT_MS + 400,
    'timeout must 302 within budget, elapsed=' + hungElapsed,
  );
  assert.ok(
    hungElapsed >= IMPACT_LOOKUP_TIMEOUT_MS - 50,
    'timeout must wait for the budget, elapsed=' + hungElapsed,
  );
  assert.strictEqual(hung.calls.inserts.length, 0);
  assert.strictEqual(hung.calls.rpc.length, 0);
  lateReject(new Error('late supabase reject'));
  await flush();
  await new Promise(function (resolve) {
    setTimeout(resolve, 20);
  });
  process.removeListener('unhandledRejection', onUnhandled);
  assert.strictEqual(
    lateRejections.length,
    0,
    'late reject after timeout must not be unhandled',
  );

  const emptyDest = createMock({
    shortLookup: function () {
      return shortRow('   ', IMPACT_ID);
    },
  });
  installSupabase(emptyDest);
  const emptyDestRes = await requestShort('AbC234');
  await flush();
  assert.strictEqual(emptyDestRes.statusCode, 404);
  assert.strictEqual(emptyDest.calls.impactSelects, 0);

  const unparseable = createMock({
    shortLookup: function () {
      return shortRow('not-a-url', IMPACT_ID);
    },
    impactLookup: function () {
      return Promise.resolve({
        data: { tracking_token: TOKEN },
        error: null,
      });
    },
  });
  installSupabase(unparseable);
  const unparseableRes = await requestShort('AbC234');
  await flush();
  assert.strictEqual(unparseableRes.statusCode, 302);
  assert.strictEqual(unparseableRes.headers.Location, 'not-a-url');
  assert.strictEqual(unparseable.calls.inserts.length, 0);

  console.log('OK unit-sms-short-redirect');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
