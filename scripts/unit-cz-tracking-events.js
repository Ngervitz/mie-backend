'use strict';

/**
 * node scripts/unit-cz-tracking-events.js
 */

const assert = require('assert');
const http = require('http');
const express = require('express');

const SECRET = 'unit-test-cz-tracking-hmac-secret-32b';
const TOKEN = 'abcdefghijABCDEFGHIJ12';
const IMPACT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_IMPACT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TOKEN = 'zzzyyyyxxxwwwwvvvvuutt';

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
  czTrackingHmacSecret: SECRET,
};
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: envExports,
};

const supabasePath = require.resolve('../src/clients/supabase');
let supabaseImpl = {
  from: function () {
    throw new Error('supabase mock not installed');
  },
};
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from: function () {
      return supabaseImpl.from.apply(supabaseImpl, arguments);
    },
  },
};

const logger = require('../src/lib/logger');
const capturedLogs = [];
['info', 'warn', 'error'].forEach(function (level) {
  const orig = logger[level];
  logger[level] = function (message, meta) {
    capturedLogs.push({ level: level, message: message, meta: meta });
    return orig(message, meta);
  };
});

const router = require('../src/routes/tracking-events');
const { signTrackingPayload } = require('../src/lib/czTrackingHmac');
const { SOURCE } = require('../src/lib/czTrackingEvents');

function createMock(options) {
  const opts = options || {};
  const impactsByToken = opts.impactsByToken || new Map();
  const events = opts.events || new Map();
  const calls = { inserts: [], impactSelects: 0, eventSelects: 0 };
  let insertN = 0;

  return {
    calls: calls,
    events: events,
    from: function (table) {
      return {
        select: function () {
          return {
            eq: function (column, value) {
              const filters = {};
              filters[column] = value;
              function maybeSingle() {
                if (table === 'marketing_impacts') {
                  calls.impactSelects += 1;
                  if (opts.impactLookupError) {
                    return Promise.resolve({
                      data: null,
                      error: opts.impactLookupError,
                    });
                  }
                  const row = impactsByToken.get(filters.tracking_token);
                  return Promise.resolve({
                    data: row || null,
                    error: null,
                  });
                }
                if (table === 'marketing_impact_events') {
                  calls.eventSelects += 1;
                  if (opts.eventSelectError) {
                    return Promise.resolve({
                      data: null,
                      error: opts.eventSelectError,
                    });
                  }
                  const key =
                    String(filters.source) +
                    '\0' +
                    String(filters.external_event_id);
                  return Promise.resolve({
                    data: events.get(key) || null,
                    error: null,
                  });
                }
                return Promise.resolve({ data: null, error: null });
              }
              return {
                eq: function (column2, value2) {
                  filters[column2] = value2;
                  return { maybeSingle: maybeSingle };
                },
                maybeSingle: maybeSingle,
              };
            },
          };
        },
        insert: function (row) {
          calls.inserts.push(Object.assign({}, row));
          insertN += 1;
          if (typeof opts.onInsert === 'function') {
            return opts.onInsert(row, events, insertN);
          }
          if (opts.insertThrow) {
            return Promise.reject(new Error('insert failed'));
          }
          const key = String(row.source) + '\0' + String(row.external_event_id);
          if (events.has(key)) {
            return Promise.resolve({
              error: { code: '23505', message: 'duplicate key' },
            });
          }
          events.set(key, Object.assign({}, row));
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

function startServer() {
  const app = express();
  app.use(
    '/tracking',
    express.json({
      limit: '4kb',
      verify: router.attachRawBody,
    }),
    router,
    router.jsonErrorHandler,
  );
  return new Promise(function (resolve) {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, port: server.address().port });
    });
  });
}

function post(port, opts) {
  const options = opts || {};
  const payload =
    options.raw != null ? options.raw : JSON.stringify(options.body || {});
  const timestamp =
    options.timestamp != null
      ? String(options.timestamp)
      : String(Math.floor(Date.now() / 1000));
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (options.omitTimestamp !== true) {
    headers['X-Janus-Timestamp'] = timestamp;
  }
  if (options.omitSignature !== true) {
    headers['X-Janus-Signature'] =
      options.signature != null
        ? options.signature
        : signTrackingPayload(
            envExports.czTrackingHmacSecret || SECRET,
            timestamp,
            payload,
          );
  }
  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders);
  }
  return fetch('http://127.0.0.1:' + port + '/tracking/events', {
    method: 'POST',
    headers: headers,
    body: payload,
  }).then(async function (res) {
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_err) {
      json = null;
    }
    return { status: res.status, json: json, text: text };
  });
}

function validBody(overrides) {
  return Object.assign(
    {
      tracking_token: TOKEN,
      event_name: 'form_step_1',
      occurred_at: '2026-08-24T19:15:00.000Z',
      external_event_id: '11111111-aaaa-4bbb-8ccc-ddddeeeeffff',
    },
    overrides || {},
  );
}

function defaultImpacts() {
  return new Map([
    [TOKEN, { id: IMPACT_ID }],
    [OTHER_TOKEN, { id: OTHER_IMPACT_ID }],
  ]);
}

function assertNoSecretsInLogs() {
  capturedLogs.forEach(function (entry) {
    const blob = JSON.stringify(entry);
    assert.ok(!blob.includes(SECRET), 'logs must not contain HMAC secret');
    assert.ok(
      !blob.includes(TOKEN),
      'logs must not contain full tracking_token',
    );
    if (entry.meta && entry.meta.signature) {
      assert.fail('logs must not contain signature');
    }
  });
}

(async function run() {
  const { server, port } = await startServer();

  function install(mock) {
    supabaseImpl = mock;
    router.resetRateLimitForTests();
  }

  try {
    const happy = createMock({ impactsByToken: defaultImpacts() });
    install(happy);
    const created = await post(port, { body: validBody() });
    assert.strictEqual(created.status, 200);
    assert.deepStrictEqual(created.json, { ok: true, duplicate: false });
    assert.strictEqual(happy.calls.inserts.length, 1);
    assert.strictEqual(happy.calls.inserts[0].source, SOURCE);
    assert.strictEqual(happy.calls.inserts[0].source, 'credizona');
    assert.strictEqual(happy.calls.inserts[0].event_name, 'form_step_1');
    assert.strictEqual(happy.calls.inserts[0].impact_id, IMPACT_ID);
    assert.ok(!Object.prototype.hasOwnProperty.call(happy.calls.inserts[0], 'received_at'));
    assert.ok(!happy.events.values().next().value.received_at);

    const retry = await post(port, { body: validBody() });
    assert.strictEqual(retry.status, 200);
    assert.deepStrictEqual(retry.json, { ok: true, duplicate: true });
    assert.strictEqual(happy.events.size, 1);
    assert.strictEqual(happy.calls.inserts.length, 2);

    const callerControlled = createMock({ impactsByToken: defaultImpacts() });
    install(callerControlled);
    const injected = await post(port, {
      body: validBody({
        source: 'janus',
        received_at: '1999-01-01T00:00:00.000Z',
        external_event_id: '22222222-aaaa-4bbb-8ccc-ddddeeeeffff',
      }),
    });
    assert.strictEqual(injected.status, 200);
    assert.strictEqual(callerControlled.calls.inserts[0].source, 'credizona');
    assert.notStrictEqual(
      callerControlled.calls.inserts[0].received_at,
      '1999-01-01T00:00:00.000Z',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(
        callerControlled.calls.inserts[0],
        'received_at',
      ),
    );

    const otherToken = createMock({ impactsByToken: defaultImpacts() });
    install(otherToken);
    const first = await post(port, {
      body: validBody({ external_event_id: 'conflict-id-1' }),
    });
    assert.strictEqual(first.status, 200);
    const conflictToken = await post(port, {
      body: validBody({
        tracking_token: OTHER_TOKEN,
        external_event_id: 'conflict-id-1',
      }),
    });
    assert.strictEqual(conflictToken.status, 409);
    assert.deepStrictEqual(conflictToken.json, {
      error: 'external_event_id_conflict',
    });

    const otherName = createMock({ impactsByToken: defaultImpacts() });
    install(otherName);
    const named = await post(port, {
      body: validBody({ external_event_id: 'conflict-id-2' }),
    });
    assert.strictEqual(named.status, 200);
    const conflictName = await post(port, {
      body: validBody({
        event_name: 'form_step_2',
        external_event_id: 'conflict-id-2',
      }),
    });
    assert.strictEqual(conflictName.status, 409);
    assert.deepStrictEqual(conflictName.json, {
      error: 'external_event_id_conflict',
    });

    const mismatchDb = createMock({ impactsByToken: defaultImpacts() });
    install(mismatchDb);
    const firstTime = await post(port, {
      body: validBody({
        occurred_at: '2026-08-24T19:15:00.000Z',
        external_event_id: 'occurred-mismatch-1',
      }),
    });
    assert.strictEqual(firstTime.status, 200);
    const secondTime = await post(port, {
      body: validBody({
        occurred_at: '2026-08-24T20:00:00.000Z',
        external_event_id: 'occurred-mismatch-1',
      }),
    });
    assert.strictEqual(secondTime.status, 200);
    assert.deepStrictEqual(secondTime.json, { ok: true, duplicate: true });
    const stored = mismatchDb.events.get('credizona\0occurred-mismatch-1');
    assert.strictEqual(stored.occurred_at, '2026-08-24T19:15:00.000Z');

    const badSig = createMock({ impactsByToken: defaultImpacts() });
    install(badSig);
    const wrongSig = await post(port, {
      body: validBody({ external_event_id: 'hmac-1' }),
      signature: 'a'.repeat(64),
    });
    assert.strictEqual(wrongSig.status, 401);
    assert.deepStrictEqual(wrongSig.json, { error: 'unauthorized' });
    assert.strictEqual(badSig.calls.inserts.length, 0);

    const missingSig = await post(port, {
      body: validBody({ external_event_id: 'hmac-2' }),
      omitSignature: true,
    });
    assert.strictEqual(missingSig.status, 401);
    assert.deepStrictEqual(missingSig.json, { error: 'unauthorized' });

    const missingTs = await post(port, {
      body: validBody({ external_event_id: 'hmac-3' }),
      omitTimestamp: true,
    });
    assert.strictEqual(missingTs.status, 401);
    assert.deepStrictEqual(missingTs.json, { error: 'unauthorized' });

    const expired = await post(port, {
      body: validBody({ external_event_id: 'hmac-4' }),
      timestamp: String(Math.floor(Date.now() / 1000) - 400),
    });
    assert.strictEqual(expired.status, 401);
    assert.deepStrictEqual(expired.json, { error: 'unauthorized' });

    const future = await post(port, {
      body: validBody({ external_event_id: 'hmac-5' }),
      timestamp: String(Math.floor(Date.now() / 1000) + 400),
    });
    assert.strictEqual(future.status, 401);
    assert.deepStrictEqual(future.json, { error: 'unauthorized' });

    const malformed = createMock({ impactsByToken: defaultImpacts() });
    install(malformed);
    const malformedRes = await post(port, {
      body: validBody({ tracking_token: 'short' }),
    });
    assert.strictEqual(malformedRes.status, 422);
    assert.deepStrictEqual(malformedRes.json, {
      error: 'invalid_tracking_token',
    });
    assert.strictEqual(malformed.calls.inserts.length, 0);

    const missingImpact = createMock({ impactsByToken: defaultImpacts() });
    install(missingImpact);
    const missingRes = await post(port, {
      body: validBody({
        tracking_token: 'aaaaaaaaaaaaaaaaaaaaaa',
        external_event_id: 'missing-token-1',
      }),
    });
    assert.strictEqual(missingRes.status, 422);
    assert.deepStrictEqual(missingRes.json, malformedRes.json);
    assert.strictEqual(missingRes.status, malformedRes.status);
    assert.strictEqual(missingImpact.calls.inserts.length, 0);

    const step3 = createMock({ impactsByToken: defaultImpacts() });
    install(step3);
    const step3Res = await post(port, {
      body: validBody({
        event_name: 'form_step_3',
        external_event_id: 'step-3-id',
      }),
    });
    assert.strictEqual(step3Res.status, 200);
    assert.strictEqual(step3.calls.inserts[0].event_name, 'form_step_3');

    const noEvent = await post(port, {
      body: validBody({ event_name: 'application_no' }),
    });
    assert.strictEqual(noEvent.status, 400);
    assert.deepStrictEqual(noEvent.json, { error: 'invalid_event_name' });

    const successEvent = await post(port, {
      body: validBody({ event_name: 'application_success' }),
    });
    assert.strictEqual(successEvent.status, 400);
    assert.deepStrictEqual(successEvent.json, { error: 'invalid_event_name' });

    const clickEvent = await post(port, {
      body: validBody({ event_name: 'click' }),
    });
    assert.strictEqual(clickEvent.status, 400);

    const badOccurred = await post(port, {
      body: validBody({ occurred_at: 'not-a-date' }),
    });
    assert.strictEqual(badOccurred.status, 400);
    assert.deepStrictEqual(badOccurred.json, { error: 'invalid_occurred_at' });

    const badJson = await post(port, { raw: '{not json' });
    assert.strictEqual(badJson.status, 400);
    assert.deepStrictEqual(badJson.json, { error: 'invalid_body' });

    const tooBig = await post(port, {
      raw: JSON.stringify({
        tracking_token: TOKEN,
        event_name: 'form_step_1',
        occurred_at: '2026-08-24T19:15:00.000Z',
        external_event_id: 'too-big',
        padding: 'x'.repeat(5000),
      }),
    });
    assert.strictEqual(tooBig.status, 413);
    assert.deepStrictEqual(tooBig.json, { error: 'payload_too_large' });

    let releaseFirstInsert;
    const firstInsertHeld = new Promise(function (resolve) {
      releaseFirstInsert = resolve;
    });
    const concurrent = createMock({
      impactsByToken: defaultImpacts(),
      onInsert: function (row, events, n) {
        const key = String(row.source) + '\0' + String(row.external_event_id);
        if (n === 1) {
          events.set(key, Object.assign({}, row));
          return firstInsertHeld.then(function () {
            return { error: null };
          });
        }
        return Promise.resolve({
          error: { code: '23505', message: 'duplicate key' },
        });
      },
    });
    install(concurrent);
    const concurrentBody = validBody({
      external_event_id: 'concurrent-id-1',
    });
    const p1 = post(port, { body: concurrentBody });
    const p2 = post(port, { body: concurrentBody });
    await new Promise(function (resolve) {
      setTimeout(resolve, 40);
    });
    releaseFirstInsert();
    const concurrentResults = await Promise.all([p1, p2]);
    concurrentResults.forEach(function (r) {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, true);
    });
    const duplicateFlags = concurrentResults
      .map(function (r) {
        return r.json.duplicate;
      })
      .sort();
    assert.deepStrictEqual(duplicateFlags, [false, true]);
    assert.strictEqual(concurrent.events.size, 1);

    const transient = createMock({
      impactsByToken: defaultImpacts(),
      insertThrow: true,
    });
    install(transient);
    const transientRes = await post(port, {
      body: validBody({ external_event_id: 'transient-1' }),
    });
    assert.strictEqual(transientRes.status, 503);
    assert.deepStrictEqual(transientRes.json, { error: 'unavailable' });

    const lookupFail = createMock({
      impactsByToken: defaultImpacts(),
      impactLookupError: { message: 'timeout', status: 500 },
    });
    install(lookupFail);
    const lookupFailRes = await post(port, {
      body: validBody({ external_event_id: 'lookup-fail-1' }),
    });
    assert.strictEqual(lookupFailRes.status, 503);

    envExports.czTrackingHmacSecret = null;
    const noSecret = await post(port, {
      body: validBody({ external_event_id: 'no-secret-1' }),
      signature: 'b'.repeat(64),
    });
    assert.strictEqual(noSecret.status, 503);
    assert.deepStrictEqual(noSecret.json, { error: 'unavailable' });
    envExports.czTrackingHmacSecret = SECRET;

    assertNoSecretsInLogs();

    console.log('OK unit-cz-tracking-events');
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
