'use strict';

/**
 * Offline checks for the ELM NetSuite transport (OAuth 1.0 HMAC-SHA256), S1/S2 payloads with
 * TrackingId, and postback association by internal_id.
 *
 * NO network: every non-loopback socket and the global fetch are blocked and counted. The real
 * client is exercised only through an injected fake fetch. All credentials/URLs below are FAKE
 * placeholders (account 1234567_SB1 does not belong to ELM).
 *
 * Run: node scripts/unit-elm-transport.js
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: { port: 3000, nodeEnv: 'test', supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'test' },
};
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from(table) {
      throw new Error('unexpected supabase access in test: ' + table);
    },
    rpc(name) {
      throw new Error('unexpected supabase rpc in test: ' + name);
    },
  },
};

// ---------------------------------------------------------------------------
// Network guard
// ---------------------------------------------------------------------------
const externalNet = [];
function guard(mod, name) {
  mod[name] = function blocked() {
    externalNet.push(name);
    throw new Error('external network blocked in test: ' + name);
  };
}
guard(http, 'request');
guard(http, 'get');
guard(https, 'request');
guard(https, 'get');
guard(net, 'connect');
guard(net, 'createConnection');
guard(tls, 'connect');
globalThis.fetch = async function blockedFetch() {
  externalNet.push('fetch');
  throw new Error('fetch blocked in test');
};

const captured = [];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);

const { S1, S2, CODES, OUTCOME, ELM_SOURCE } = require('../src/services/elm/constants');
const { readElmConfig, readElmTransportConfig } = require('../src/services/elm/config');
const { SERVICE1_KEYS, SERVICE2_KEYS, buildService1Payload, buildService2Payload } = require('../src/services/elm/payload');
const oauth = require('../src/services/elm/oauth');
const { createElmClient } = require('../src/services/elm/client');
const { createElmOrchestrator } = require('../src/services/elm/orchestrator');
const { parseElmPostback, createElmPostbackProcessor, FIELD_KEYS } = require('../src/services/elm/postback');

const URL_S1 = 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=10&deploy=1';
const URL_S2 = 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=11&deploy=1';
const FAKE = {
  consumerKey: 'fake-consumer-key-0001',
  consumerSecret: 'fake-consumer-secret-0002',
  tokenId: 'fake-token-id-0003',
  tokenSecret: 'fake-token-secret-0004',
};
const ENV = Object.freeze({
  ELM_CLIENT_ENABLED: 'true',
  ELM_SERVICE_1_URL: URL_S1,
  ELM_SERVICE_2_URL: URL_S2,
  ELM_CONSUMER_KEY: FAKE.consumerKey,
  ELM_CONSUMER_SECRET: FAKE.consumerSecret,
  ELM_TOKEN_ID: FAKE.tokenId,
  ELM_TOKEN_SECRET: FAKE.tokenSecret,
  ELM_HTTP_TIMEOUT_MS: '40',
  ELM_ACTIVITY_TYPE_MAP_JSON: '{"EPR":"TEST_ACTIVITY_EPR"}',
  ELM_DATE_OF_BIRTH_FORMAT: 'D/M/YYYY',
  ELM_MOBILE_PHONE_FORMAT: 'uy_local_0',
});
const SECRET_VALUES = [FAKE.consumerKey, FAKE.consumerSecret, FAKE.tokenId, FAKE.tokenSecret];
const PII = ['12345678', 'Ana', 'Prueba', 'ana@example.test', '099123456', '59899123456'];

function envWith(over) {
  const e = Object.assign({}, ENV, over);
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

function solicitudFixture() {
  return {
    cz_id: 1001,
    ci: 12345678,
    nombre: 'Ana',
    apellido: 'Prueba',
    email: 'ana@example.test',
    celular: '59899123456',
    salario: 30000,
    fecha_nacimiento: '1991-07-10',
    relacion_laboral: 'EPR',
    lrw_id: 'LRW-1',
    solicitudes_estados_id: 8,
  };
}

/** Scripted fake fetch: each step is {status, body} | {throws} | 'hang' | {status, bodyThrows}. */
function fakeFetch(steps) {
  const calls = [];
  async function f(url, init) {
    calls.push({ url: url, init: init });
    const step = typeof steps === 'function' ? steps(url, init, calls.length) : steps[calls.length - 1];
    if (step === 'hang') {
      return new Promise(function (_resolve, reject) {
        init.signal.addEventListener('abort', function () {
          const e = new Error('This operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    if (step && step.throws) throw step.throws;
    return {
      status: step.status,
      text: async function () {
        if (step.bodyThrows) throw step.bodyThrows;
        return typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
      },
    };
  }
  f.calls = calls;
  return f;
}

const ok = (result) => ({ status: 200, body: { result: result } });

function createFakeRepo(now) {
  const rows = new Map();
  const calls = [];
  const iso = () => new Date(now()).toISOString();
  let seq = 0;
  const byId = (id) => [...rows.values()].find((r) => r.id === id) || null;
  return {
    rows,
    calls,
    async loadSolicitudContext(czId) {
      calls.push('loadSolicitudContext');
      return { solicitud: czId === 1001 ? solicitudFixture() : null, grantedRow: null };
    },
    async resolveBaseLabel() {
      return 'BASE_TEST';
    },
    async getProcessByCzId(czId) {
      calls.push('getProcessByCzId:' + czId);
      const r = rows.get(czId);
      return r ? Object.assign({}, r) : null;
    },
    async claimProcess(a) {
      if (rows.has(a.czSolicitudId)) return { claimed: false, process: Object.assign({}, rows.get(a.czSolicitudId)) };
      seq += 1;
      const row = {
        id: 'proc-' + seq,
        cz_solicitud_id: a.czSolicitudId,
        ci: a.ci,
        source_brand: a.sourceBrand,
        trigger_origin: a.triggerOrigin,
        s1_status: S1.IN_FLIGHT,
        s1_request: a.s1Request,
        s1_started_at: iso(),
        s1_lease_expires_at: new Date(now() + a.leaseSeconds * 1000).toISOString(),
        s2_status: S2.NOT_STARTED,
        referred_at: null,
      };
      rows.set(a.czSolicitudId, row);
      return { claimed: true, process: Object.assign({}, row) };
    },
    async finishS1(id, r) {
      const row = byId(id);
      if (!row || row.s1_status !== S1.IN_FLIGHT) return null;
      Object.assign(row, {
        s1_status: r.status, s1_response: r.response, s1_http_status: r.httpStatus,
        s1_result_message: r.resultMessage, s1_error_code: r.errorCode, s1_error_detail: r.errorDetail,
        s1_lease_expires_at: null,
      });
      return Object.assign({}, row);
    },
    async beginS2(czId, req, leaseSeconds) {
      const row = rows.get(czId);
      if (!row || row.s1_status !== S1.ELIGIBLE || row.s2_status !== S2.NOT_STARTED) return null;
      Object.assign(row, {
        s2_status: S2.IN_FLIGHT, s2_request: req, s2_started_at: iso(),
        s2_lease_expires_at: new Date(now() + leaseSeconds * 1000).toISOString(),
      });
      return Object.assign({}, row);
    },
    async finishS2(id, r) {
      const row = byId(id);
      if (!row || row.s2_status !== S2.IN_FLIGHT) return null;
      Object.assign(row, {
        s2_status: r.status, s2_response: r.response, s2_http_status: r.httpStatus,
        s2_result_message: r.resultMessage, s2_error_code: r.errorCode, s2_error_detail: r.errorDetail,
        s2_lease_expires_at: null, referred_at: r.status === S2.REFERRED ? iso() : null,
      });
      return Object.assign({}, row);
    },
    async expireStaleInFlight(czId) {
      return rows.get(czId) ? Object.assign({}, rows.get(czId)) : null;
    },
  };
}

const MANUAL = { triggerOrigin: 'janus_manual', triggeredByUserId: 'user-admin-1' };

function capturingLogger() {
  const lines = [];
  const rec = (level) => (msg, meta) => lines.push(level + ' ' + msg + ' ' + JSON.stringify(meta || {}));
  return { lines, info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function orchestratorWith(fetchImpl, envOver) {
  const env = envWith(envOver || {});
  let t = Date.parse('2026-10-08T12:00:00Z');
  const now = () => t;
  const repo = createFakeRepo(now);
  const logger = capturingLogger();
  const client = createElmClient({ env: env, fetchImpl: fetchImpl });
  const orch = createElmOrchestrator({ repository: repo, client: client, config: readElmConfig(env), logger: logger, now: now });
  return { orch, repo, logger, client };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function bodyOf(call) {
  return JSON.parse(call.init.body);
}

// ---------------------------------------------------------------------------

test('1-3 payloads: S1 without TrackingId, S2 TrackingId = cz_solicitud_id, source copanel in both', async () => {
  const config = readElmConfig(ENV);
  const s1 = buildService1Payload({ czId: 1001, solicitud: solicitudFixture(), config: config });
  assert.ok(s1.ok);
  assert.ok(!('TrackingId' in s1.payload));
  assert.ok(!SERVICE1_KEYS.includes('TrackingId'));
  assert.deepStrictEqual(Object.keys(s1.payload).sort(), SERVICE1_KEYS.slice().sort());
  assert.strictEqual(s1.payload.source, 'copanel');
  const s2 = buildService2Payload({ ci: 12345678, czId: 1001, solicitud: solicitudFixture(), config: config });
  assert.ok(s2.ok);
  assert.strictEqual(s2.payload.TrackingId, '1001');
  assert.strictEqual(s2.payload.source, 'copanel');
  assert.deepStrictEqual(Object.keys(s2.payload).sort(), SERVICE2_KEYS.slice().sort());
  assert.strictEqual(ELM_SOURCE, 'copanel');

  const f = fakeFetch([ok('Listo para recibir datos en servicio 2'), ok('Lead Aprobado correctamente')]);
  const { orch, repo } = orchestratorWith(f);
  assert.strictEqual((await orch.evaluateElm(1001, MANUAL)).ok, true);
  assert.strictEqual((await orch.referElm(1001, MANUAL)).ok, true);
  assert.strictEqual(f.calls.length, 2);
  assert.strictEqual(f.calls[0].url, URL_S1);
  assert.strictEqual(f.calls[1].url, URL_S2);
  const sent1 = bodyOf(f.calls[0]);
  const sent2 = bodyOf(f.calls[1]);
  assert.ok(!('TrackingId' in sent1), 'S1 sent without TrackingId');
  assert.strictEqual(sent2.TrackingId, '1001', 'S2 sent with TrackingId = cz_solicitud_id');
  assert.strictEqual(sent1.source, 'copanel');
  assert.strictEqual(sent2.source, 'copanel');
  assert.strictEqual(sent2.docNumber, sent1.docNumber);
  assert.deepStrictEqual(repo.rows.get(1001).s2_request, sent2, 'frozen request = sent request');
  assert.strictEqual(repo.rows.get(1001).s2_status, S2.REFERRED);
});

test('4 OAuth: RFC 3986 encoding, published base-string/signature vectors, HMAC-SHA256, NetSuite header', async () => {
  // Percent-encoding vectors (RFC 3986 unreserved set; !'()* must be encoded).
  assert.strictEqual(oauth.percentEncode('Ladies + Gentlemen'), 'Ladies%20%2B%20Gentlemen');
  assert.strictEqual(oauth.percentEncode('An encoded string!'), 'An%20encoded%20string%21');
  assert.strictEqual(oauth.percentEncode('Dogs, Cats & Mice'), 'Dogs%2C%20Cats%20%26%20Mice');
  assert.strictEqual(oauth.percentEncode('\u2603'), '%E2%98%83');
  assert.strictEqual(oauth.percentEncode("-._~*'()"), "-._~%2A%27%28%29");

  // OAuth Core 1.0 Appendix A.5.1/A.5.2: published base string and signature.
  const base = oauth.signatureBaseString('GET', 'http://photos.example.net/photos?file=vacation.jpg&size=original', {
    oauth_consumer_key: 'dpf43f3p2l4k3l03',
    oauth_token: 'nnch734d00sl2jdk',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1191242096',
    oauth_nonce: 'kllo9940pd9333jh',
    oauth_version: '1.0',
  });
  assert.strictEqual(
    base,
    'GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal',
  );
  const key = oauth.signingKey('kd94hf93k423kf44', 'pfkkdhi9sl3r4s00');
  assert.strictEqual(crypto.createHmac('sha1', key).update(base).digest('base64'), 'tR3+Ty81lMeYAr/Fid0kMTYa/WM=');

  // RFC 4231 test case 2 (HMAC-SHA256 primitive).
  assert.strictEqual(
    Buffer.from(oauth.hmacSha256Base64('what do ya want for nothing?', 'Jefe'), 'base64').toString('hex'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );

  // NetSuite-shaped vector; signature computed independently with OpenSSL
  // (openssl dgst -sha256 -hmac '<key>' -binary | base64).
  const nsParams = {
    oauth_consumer_key: 'test-consumer-key',
    oauth_token: 'test-token-id',
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: '1700000000',
    oauth_nonce: 'abc123nonce',
    oauth_version: '1.0',
  };
  const nsBase = oauth.signatureBaseString('POST', URL_S1.replace('script=10', 'script=10'), nsParams);
  assert.strictEqual(
    nsBase,
    'POST&https%3A%2F%2F1234567-sb1.restlets.api.netsuite.com%2Fapp%2Fsite%2Fhosting%2Frestlet.nl&deploy%3D1%26oauth_consumer_key%3Dtest-consumer-key%26oauth_nonce%3Dabc123nonce%26oauth_signature_method%3DHMAC-SHA256%26oauth_timestamp%3D1700000000%26oauth_token%3Dtest-token-id%26oauth_version%3D1.0%26script%3D10',
    'query params (script, deploy) signed; realm and body never signed',
  );
  const nsKey = oauth.signingKey('test consumer/secret', 'test token+secret');
  assert.strictEqual(nsKey, 'test%20consumer%2Fsecret&test%20token%2Bsecret');
  assert.strictEqual(oauth.hmacSha256Base64(nsBase, nsKey), 'w1ua2pq/suu4vP0MzDEwK4hE2x0y0IXDZczSGNwAL60=');

  const header = oauth.buildAuthorizationHeader({
    method: 'POST',
    url: URL_S1,
    realm: '1234567_SB1',
    consumerKey: 'test-consumer-key',
    consumerSecret: 'test consumer/secret',
    tokenId: 'test-token-id',
    tokenSecret: 'test token+secret',
    nonce: 'abc123nonce',
    timestamp: 1700000000,
  });
  assert.strictEqual(
    header,
    'OAuth realm="1234567_SB1", oauth_consumer_key="test-consumer-key", oauth_token="test-token-id", ' +
      'oauth_signature_method="HMAC-SHA256", oauth_timestamp="1700000000", oauth_nonce="abc123nonce", ' +
      'oauth_version="1.0", oauth_signature="w1ua2pq%2Fsuu4vP0MzDEwK4hE2x0y0IXDZczSGNwAL60%3D"',
  );
  assert.ok(!header.includes('secret'), 'secrets never in the header');

  // realm = NetSuite account id from the RESTlet host.
  assert.strictEqual(oauth.realmFromRestletUrl(URL_S1), '1234567_SB1');
  assert.strictEqual(oauth.realmFromRestletUrl('https://7654321.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1&deploy=1'), '7654321');
  assert.strictEqual(oauth.realmFromRestletUrl('https://evil.example.com/restlet.nl'), null);
  assert.strictEqual(oauth.splitUrl('https://A.Restlets.Api.Netsuite.com:443/x?y=1').baseUri, 'https://a.restlets.api.netsuite.com/x');

  // Live client: fresh nonce per call, timestamp in seconds, body not part of the signature.
  const f = fakeFetch([ok('SCORE BAJO'), ok('SCORE BAJO')]);
  const client = createElmClient({ env: ENV, fetchImpl: f, now: () => 1700000000123 });
  await client.service1({ docNumber: '1', source: 'copanel' });
  await client.service1({ docNumber: '2', source: 'copanel' });
  const h1 = f.calls[0].init.headers.Authorization;
  const h2 = f.calls[1].init.headers.Authorization;
  assert.match(h1, /^OAuth realm="1234567_SB1", oauth_consumer_key="fake-consumer-key-0001", oauth_token="fake-token-id-0003", oauth_signature_method="HMAC-SHA256", oauth_timestamp="1700000000", oauth_nonce="[0-9a-f]{32}", oauth_version="1\.0", oauth_signature="[^"]+"$/);
  assert.notStrictEqual(/oauth_nonce="([^"]+)"/.exec(h1)[1], /oauth_nonce="([^"]+)"/.exec(h2)[1], 'unique nonce');
  assert.ok(!h1.includes(FAKE.consumerSecret) && !h1.includes(FAKE.tokenSecret));
  assert.strictEqual(f.calls[0].init.method, 'POST');
  assert.strictEqual(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.strictEqual(f.calls[0].init.redirect, 'manual');
  // Re-derive the signature for the first call independently from the header fields.
  const fields = Object.fromEntries([...h1.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2])]));
  const reBase = oauth.signatureBaseString('POST', URL_S1, {
    oauth_consumer_key: fields.oauth_consumer_key,
    oauth_token: fields.oauth_token,
    oauth_signature_method: fields.oauth_signature_method,
    oauth_timestamp: fields.oauth_timestamp,
    oauth_nonce: fields.oauth_nonce,
    oauth_version: fields.oauth_version,
  });
  const expected = crypto
    .createHmac('sha256', encodeURIComponent(FAKE.consumerSecret) + '&' + encodeURIComponent(FAKE.tokenSecret))
    .update(reBase)
    .digest('base64');
  assert.strictEqual(fields.oauth_signature, expected);
});

test('5 incomplete/invalid configuration → disabled, variable names only, zero calls', async () => {
  const f = fakeFetch(() => ok('SCORE BAJO'));
  const required = ['ELM_SERVICE_1_URL', 'ELM_SERVICE_2_URL', 'ELM_CONSUMER_KEY', 'ELM_CONSUMER_SECRET', 'ELM_TOKEN_ID', 'ELM_TOKEN_SECRET'];
  for (const name of required) {
    const c = createElmClient({ env: envWith({ [name]: undefined }), fetchImpl: f });
    assert.strictEqual(c.enabled, false, name);
    assert.strictEqual(c.disabledReason, CODES.TRANSPORT_CONFIG_INCOMPLETE);
    assert.deepStrictEqual([...c.configIssues], [name]);
    const r = await c.service1({ docNumber: '1' });
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.outcome, OUTCOME.NOT_SENT);
    const blank = createElmClient({ env: envWith({ [name]: '   ' }), fetchImpl: f });
    assert.deepStrictEqual([...blank.configIssues], [name]);
  }
  const bad = [
    [{ ELM_SERVICE_1_URL: URL_S1.replace('https:', 'http:') }, 'ELM_SERVICE_1_URL'],
    [{ ELM_SERVICE_1_URL: 'https://example.com/app/site/hosting/restlet.nl?script=10&deploy=1' }, 'ELM_SERVICE_1_URL'],
    [{ ELM_SERVICE_2_URL: URL_S2.replace('&deploy=1', '') }, 'ELM_SERVICE_2_URL'],
    [{ ELM_SERVICE_2_URL: URL_S2.replace('/restlet.nl', '/other') }, 'ELM_SERVICE_2_URL'],
    [{ ELM_SERVICE_2_URL: 'not a url' }, 'ELM_SERVICE_2_URL'],
    [{ ELM_SERVICE_2_URL: URL_S2.replace('1234567-sb1', '7654321') }, 'ELM_SERVICE_URLS_ACCOUNT_MISMATCH'],
    [{ ELM_TOKEN_SECRET: 'has space' }, 'ELM_TOKEN_SECRET'],
  ];
  for (const [over, name] of bad) {
    const c = createElmClient({ env: envWith(over), fetchImpl: f });
    assert.strictEqual(c.enabled, false);
    assert.deepStrictEqual([...c.configIssues], [name]);
  }
  const t = readElmTransportConfig(ENV);
  assert.strictEqual(t.ready, true);
  assert.strictEqual(t.realm, '1234567_SB1');
  const serialized = JSON.stringify(t) + JSON.stringify(Object.keys(t));
  for (const s of SECRET_VALUES) assert.ok(!serialized.includes(s), 'credentials not serializable');
  const incomplete = readElmTransportConfig(envWith({ ELM_TOKEN_ID: undefined }));
  assert.strictEqual(incomplete.credentials, undefined);
  assert.strictEqual(incomplete.service1Url, null);

  const { orch, repo } = orchestratorWith(f, { ELM_CONSUMER_SECRET: undefined });
  const out = await orch.evaluateElm(1001, MANUAL);
  assert.strictEqual(out.code, CODES.SEND_DISABLED);
  assert.strictEqual(out.reason, CODES.TRANSPORT_CONFIG_INCOMPLETE);
  assert.strictEqual(repo.rows.size, 0, 'nothing claimed');
  assert.strictEqual(f.calls.length, 0);
});

test('6 S1/S2 documented success and rejection texts; BCU error technical; auth 401 technical', async () => {
  const cases = [
    ['service1', ok('Listo para recibir datos en servicio 2'), OUTCOME.POSITIVE, null],
    ['service1', ok('SCORE BAJO'), OUTCOME.NEGATIVE, null],
    ['service1', ok('Blacklist'), OUTCOME.NEGATIVE, null],
    ['service1', ok('BCU'), OUTCOME.NEGATIVE, null],
    ['service1', ok('Repetido. rechazado'), OUTCOME.NEGATIVE, null],
    ['service1', { status: 200, body: { success: false, result: 'Repetido. Rechazado', docNumber: '1' } }, OUTCOME.NEGATIVE, null],
    ['service1', ok('Repetido - Rechazado'), OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service1', { status: 200, body: { success: true, result: 'Repetido. Aprobado', docNumber: '1' } }, OUTCOME.DUPLICATE_OTHER_CHANNEL, CODES.S1_DUPLICATE_OTHER_CHANNEL],
    ['service1', ok('REPETIDO. APROBADO'), OUTCOME.DUPLICATE_OTHER_CHANNEL, CODES.S1_DUPLICATE_OTHER_CHANNEL],
    ['service1', ok('Repetido.Aprobado'), OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service2', ok('Repetido. Aprobado'), OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service1', ok('listo para recibir datos en servicio 2'), OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service1', ok('BCU ERROR'), OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service2', ok('aprobado sin canal'), OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service1', ok('No hay oferta'), OUTCOME.NEGATIVE, null],
    ['service1', { status: 200, body: { success: false, result: 'Mocasist', docNumber: '1' } }, OUTCOME.NEGATIVE, null],
    ['service1', ok('MOCASIST'), OUTCOME.NEGATIVE, null],
    ['service1', ok('Mocasist.'), OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service2', ok('Mocasist'), OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service1', ok('BCU error'), OUTCOME.TECHNICAL_ERROR, CODES.PROVIDER_BCU_ERROR],
    ['service2', ok('Lead Aprobado correctamente'), OUTCOME.POSITIVE, null],
    ['service2', ok('Aprobado sin canal'), OUTCOME.NEGATIVE, null],
    ['service2', ok('Telefono no válido'), OUTCOME.NEGATIVE, null],
    ['service2', ok('Lead no existe'), OUTCOME.NEGATIVE, null],
    ['service2', ok('Documento no válido'), OUTCOME.NEGATIVE, null],
    ['service1', ok('Algo nuevo'), OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service2', { status: 200, body: 'not json' }, OUTCOME.UNKNOWN, CODES.RESPONSE_UNPARSEABLE],
    ['service1', { status: 200, body: { success: true } }, OUTCOME.UNKNOWN, CODES.RESPONSE_UNDOCUMENTED],
    ['service1', { status: 401, body: { error: { code: 'INVALID_LOGIN_ATTEMPT' } } }, OUTCOME.TECHNICAL_ERROR, CODES.HTTP_AUTH_REJECTED],
    ['service2', { status: 403, body: '' }, OUTCOME.TECHNICAL_ERROR, CODES.HTTP_AUTH_REJECTED],
    ['service1', { status: 500, body: { result: 'Listo para recibir datos en servicio 2' } }, OUTCOME.UNKNOWN, CODES.HTTP_ERROR],
    ['service2', { status: 302, body: '' }, OUTCOME.UNKNOWN, CODES.HTTP_ERROR],
    ['service1', { status: 400, body: { result: 'SCORE BAJO' } }, OUTCOME.UNKNOWN, CODES.HTTP_ERROR],
  ];
  for (const [svc, step, outcome, code] of cases) {
    const f = fakeFetch([step]);
    const r = await createElmClient({ env: ENV, fetchImpl: f })[svc]({ docNumber: '1' });
    assert.strictEqual(r.outcome, outcome, svc + ' ' + JSON.stringify(step));
    assert.strictEqual(r.errorCode, code, svc + ' ' + JSON.stringify(step));
    assert.strictEqual(r.sent, true);
    assert.strictEqual(r.httpStatus, step.status);
    assert.strictEqual(f.calls.length, 1, 'exactly one request, never retried by the client');
  }

  // Orchestrator mapping: rejection ≠ technical_error ≠ unknown.
  const rej = orchestratorWith(fakeFetch([ok('No hay oferta')]));
  await rej.orch.evaluateElm(1001, MANUAL);
  assert.strictEqual(rej.repo.rows.get(1001).s1_status, S1.REJECTED);
  const dup = orchestratorWith(fakeFetch([{ status: 200, body: { success: false, result: 'Repetido. Rechazado' } }]));
  await dup.orch.evaluateElm(1001, MANUAL);
  assert.strictEqual(dup.repo.rows.get(1001).s1_status, S1.REJECTED);
  assert.strictEqual(dup.repo.rows.get(1001).s1_result_message, 'Repetido. Rechazado', 'original text kept');
  const moca = orchestratorWith(fakeFetch([{ status: 200, body: { success: false, result: 'Mocasist' } }]));
  await moca.orch.evaluateElm(1001, MANUAL);
  assert.strictEqual(moca.repo.rows.get(1001).s1_status, S1.REJECTED);
  assert.strictEqual(moca.repo.rows.get(1001).s1_error_code, null);
  assert.strictEqual(moca.repo.rows.get(1001).s1_result_message, 'Mocasist', 'original text kept');
  assert.strictEqual(moca.repo.rows.get(1001).s2_status, S2.NOT_STARTED, 'no S2 after a rejection');
  const repApprovedBody = { success: true, result: 'Repetido. Aprobado', docNumber: '1' };
  const repApprovedFetch = fakeFetch([{ status: 200, body: repApprovedBody }]);
  const repApproved = orchestratorWith(repApprovedFetch);
  const sent = await repApproved.orch.sendElm(1001, MANUAL);
  assert.strictEqual(sent.ok, true);
  assert.strictEqual(sent.stage, 's1', 'the single "Enviar a ELM" action stops after S1');
  assert.strictEqual(sent.s2_blocked, undefined);
  const refer = await repApproved.orch.referElm(1001, MANUAL);
  assert.strictEqual(refer.code, CODES.S1_NOT_ELIGIBLE, 'S2 cannot be started by hand either');
  const ra = repApproved.repo.rows.get(1001);
  assert.strictEqual(ra.s1_status, S1.REJECTED, 'terminal S1 (not eligible), never unknown');
  assert.strictEqual(ra.s1_error_code, CODES.S1_DUPLICATE_OTHER_CHANNEL);
  assert.strictEqual(ra.s1_result_message, 'Repetido. Aprobado', 'original text kept');
  assert.deepStrictEqual(ra.s1_response, repApprovedBody, 'original response kept');
  assert.strictEqual(ra.s2_status, S2.NOT_STARTED, 'no S2 after "Repetido. Aprobado"');
  assert.strictEqual(repApprovedFetch.calls.length, 1, 'only the S1 request, S2 never called');
  const favorableFetch = fakeFetch([ok('Listo para recibir datos en servicio 2'), ok('Lead Aprobado correctamente')]);
  const favorable = orchestratorWith(favorableFetch);
  const fav = await favorable.orch.sendElm(1001, MANUAL);
  assert.strictEqual(fav.ok, true);
  assert.strictEqual(fav.stage, 's2', 'documented favorable S1 still continues to S2');
  assert.strictEqual(favorable.repo.rows.get(1001).s1_status, S1.ELIGIBLE);
  assert.strictEqual(favorable.repo.rows.get(1001).s2_status, S2.REFERRED);
  assert.strictEqual(favorableFetch.calls.length, 2);
  const tech = orchestratorWith(fakeFetch([ok('BCU error')]));
  await tech.orch.evaluateElm(1001, MANUAL);
  assert.strictEqual(tech.repo.rows.get(1001).s1_status, S1.TECHNICAL_ERROR);
  assert.strictEqual(tech.repo.rows.get(1001).s1_error_code, CODES.PROVIDER_BCU_ERROR);
  const s2rej = orchestratorWith(fakeFetch([ok('Listo para recibir datos en servicio 2'), ok('Telefono no válido')]));
  await s2rej.orch.evaluateElm(1001, MANUAL);
  await s2rej.orch.referElm(1001, MANUAL);
  assert.strictEqual(s2rej.repo.rows.get(1001).s2_status, S2.REJECTED);
  assert.strictEqual(s2rej.repo.rows.get(1001).referred_at, null);
});

test('6b impossible or absent date of birth → blocked before transport, zero requests', async () => {
  for (const dob of ['0174-12-16', '0001-03-31', '0088-04-08', null]) {
    const f = fakeFetch([ok('Listo para recibir datos en servicio 2')]);
    const o = orchestratorWith(f);
    o.repo.loadSolicitudContext = async () => ({
      solicitud: Object.assign(solicitudFixture(), { fecha_nacimiento: dob }),
      grantedRow: null,
    });
    const r = await o.orch.evaluateElm(1001, MANUAL);
    assert.strictEqual(r.ok, false, String(dob));
    assert.strictEqual(r.code, CODES.DATE_OF_BIRTH_INVALID, String(dob));
    assert.strictEqual(f.calls.length, 0, 'no ELM request for ' + dob);
    assert.strictEqual(o.repo.rows.size, 0, 'no process for ' + dob);
  }
});

test('7 timeout / network error / unreadable body → unknown, one request, never retried', async () => {
  const hang = fakeFetch(['hang']);
  const t0 = Date.now();
  const r = await createElmClient({ env: ENV, fetchImpl: hang }).service2({ docNumber: '1' });
  assert.ok(Date.now() - t0 < 2000);
  assert.strictEqual(r.outcome, OUTCOME.UNKNOWN);
  assert.strictEqual(r.errorCode, CODES.HTTP_TIMEOUT);
  assert.strictEqual(r.sent, true);
  assert.strictEqual(hang.calls.length, 1);

  const netErr = new TypeError('fetch failed for ' + URL_S1);
  netErr.cause = { code: 'ECONNRESET', message: 'socket hang up ' + URL_S1 };
  const n = fakeFetch([{ throws: netErr }]);
  const rn = await createElmClient({ env: ENV, fetchImpl: n }).service1({ docNumber: '1' });
  assert.strictEqual(rn.outcome, OUTCOME.UNKNOWN);
  assert.strictEqual(rn.errorCode, CODES.TRANSPORT_ERROR);
  assert.strictEqual(rn.errorDetail, 'ECONNRESET', 'no URL/message in error detail');

  const rb = await createElmClient({ env: ENV, fetchImpl: fakeFetch([{ status: 200, bodyThrows: new Error('terminated') }]) }).service1({});
  assert.strictEqual(rb.outcome, OUTCOME.UNKNOWN);
  assert.strictEqual(rb.errorCode, CODES.RESPONSE_READ_FAILED);

  // Orchestrator: S2 timeout → unknown, no second request, referElm again does not resend.
  const f = fakeFetch([ok('Listo para recibir datos en servicio 2'), 'hang']);
  const { orch, repo } = orchestratorWith(f);
  await orch.evaluateElm(1001, MANUAL);
  await orch.referElm(1001, MANUAL);
  const row = repo.rows.get(1001);
  assert.strictEqual(row.s2_status, S2.UNKNOWN);
  assert.strictEqual(row.s2_error_code, CODES.HTTP_TIMEOUT);
  const again = await orch.referElm(1001, MANUAL);
  assert.strictEqual(again.code, CODES.S2_ALREADY_STARTED);
  const again1 = await orch.evaluateElm(1001, MANUAL);
  assert.strictEqual(again1.code, CODES.PROCESS_EXISTS);
  assert.strictEqual(f.calls.length, 2, 'uncertain result never resent');
});

test('8 postback: associated only by documented internal_id; TrackingId never read alone; contradictions invalid', async () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.deepStrictEqual(FIELD_KEYS.czSolicitudId, ['internal_id']);
  assert.deepStrictEqual(FIELD_KEYS.ci, ['cedula']);
  assert.deepStrictEqual(FIELD_KEYS.status, ['estado']);
  const okp = parseElmPostback({ estado: 'Convertido', internal_id: '1001', cedula: '1.234.567-8' }, now);
  assert.strictEqual(okp.invalidCode, null);
  assert.strictEqual(okp.fields.czSolicitudId, 1001);
  assert.strictEqual(okp.fields.ci, 12345678);
  const echoed = parseElmPostback({ estado: 'Convertido', internal_id: 1001, TrackingId: '1001' }, now);
  assert.strictEqual(echoed.invalidCode, null, 'TrackingId equal to internal_id is consistent');
  assert.strictEqual(
    parseElmPostback({ estado: 'Convertido', internal_id: '1001', TrackingId: '1002' }, now).invalidCode,
    CODES.POSTBACK_CZ_ID_INVALID,
  );
  assert.strictEqual(parseElmPostback({ estado: 'Convertido', TrackingId: '1001' }, now).invalidCode, CODES.POSTBACK_UNDOCUMENTED_FIELD);
  assert.strictEqual(parseElmPostback({ estado: 'Convertido', cz_solicitud_id: 1001 }, now).invalidCode, CODES.POSTBACK_UNDOCUMENTED_FIELD);
  assert.strictEqual(parseElmPostback({ status: 'Convertido', internal_id: '1001' }, now).invalidCode, CODES.POSTBACK_UNDOCUMENTED_FIELD);
  assert.strictEqual(
    parseElmPostback({ estado: 'Convertido', internal_id: '1001', cedula: '12345678', docNumber: '87654321' }, now).invalidCode,
    CODES.POSTBACK_CI_INVALID,
  );
  assert.strictEqual(
    parseElmPostback({ estado: 'Convertido', status: 'Rechazado', internal_id: '1001' }, now).invalidCode,
    CODES.POSTBACK_STATUS_UNKNOWN,
  );

  // Processor: exact lookup by internal_id, never the CZ mirror, never by CI.
  const lookups = [];
  const events = [];
  const repo = {
    async recordPostbackEvent(e) {
      events.push(e);
      return { id: 'ev-' + events.length, processing_status: 'received' };
    },
    async getProcessByCzId(czId) {
      lookups.push(czId);
      return czId === 1001 ? { id: 'proc-1', cz_solicitud_id: 1001, ci: '12345678', s2_status: 'referred', s2_started_at: '2026-10-08T00:00:00Z' } : null;
    },
    async resolvePostbackEvent(a) {
      return { id: a.eventId, processing_status: a.processId ? 'applied' : a.unresolvedStatus, match_method: a.matchMethod, error_code: a.errorCode, matched_cz_solicitud_id: a.processId ? 1001 : null };
    },
    async loadSolicitudContext() {
      throw new Error('mirror must not be read');
    },
  };
  const silent = { info() {}, warn() {}, error() {} };
  const proc = createElmPostbackProcessor({ repository: repo, logger: silent, now: () => now });
  const applied = await proc.processElmPostback({ estado: 'Convertido', internal_id: '1001', cedula: '12345678' });
  assert.strictEqual(applied.event.processing_status, 'applied');
  assert.strictEqual(applied.event.match_method, 'cz_solicitud_id');
  const ciOnly = await proc.processElmPostback({ estado: 'Convertido', cedula: '12345678' });
  assert.strictEqual(ciOnly.event.processing_status, 'unmatched');
  const tracking = await proc.processElmPostback({ estado: 'Convertido', TrackingId: '1001' });
  assert.strictEqual(tracking.event.processing_status, 'invalid');
  assert.deepStrictEqual(lookups, [1001], 'only the internal_id lookup happened');
});

test('9 flags off: no external calls even with complete config; default client disabled', async () => {
  const f = fakeFetch(() => ok('Listo para recibir datos en servicio 2'));
  for (const flag of [undefined, '', 'false', '1', 'yes', 'TRUE ']) {
    const c = createElmClient({ env: envWith({ ELM_CLIENT_ENABLED: flag }), fetchImpl: f });
    const expectEnabled = flag === 'TRUE ';
    assert.strictEqual(c.enabled, expectEnabled, 'flag ' + JSON.stringify(flag));
    if (!expectEnabled) {
      assert.strictEqual(c.disabledReason, CODES.CLIENT_DISABLED);
      await c.service1({});
      await c.service2({});
    }
  }
  assert.strictEqual(f.calls.length, 0);
  const { orch, repo } = orchestratorWith(f, { ELM_CLIENT_ENABLED: undefined });
  assert.strictEqual((await orch.evaluateElm(1001, MANUAL)).reason, CODES.CLIENT_DISABLED);
  assert.strictEqual((await orch.referElm(1001, MANUAL)).code, CODES.SEND_DISABLED);
  assert.strictEqual(repo.rows.size, 0);
  assert.strictEqual(f.calls.length, 0);
  const dflt = createElmClient();
  assert.strictEqual(dflt.enabled, false, 'process.env has no ELM flag in tests');
  await dflt.service1({});
  assert.strictEqual(externalNet.length, 0);
});

test('logs and persisted rows carry no credentials, Authorization, URLs or applicant PII', async () => {
  const f = fakeFetch([
    { status: 200, body: { result: 'Listo para recibir datos en servicio 2', echo: 'oauth_token=' + FAKE.tokenId } },
    { status: 401, body: { error: { message: 'Invalid login attempt for ' + FAKE.consumerKey } } },
  ]);
  const { orch, repo, logger } = orchestratorWith(f);
  await orch.evaluateElm(1001, MANUAL);
  await orch.referElm(1001, MANUAL);
  const row = repo.rows.get(1001);
  assert.strictEqual(row.s2_status, S2.TECHNICAL_ERROR);
  assert.strictEqual(row.s2_error_code, CODES.HTTP_AUTH_REJECTED);
  const logs = logger.lines.join('\n') + captured.join('');
  for (const s of SECRET_VALUES.concat(PII, ['Authorization', 'oauth_signature', 'restlets.api.netsuite.com'])) {
    assert.ok(!logs.includes(s), 'log leaks ' + s);
  }
  const persisted = JSON.stringify([row.s1_response, row.s1_result_message, row.s1_error_detail, row.s2_response, row.s2_result_message, row.s2_error_detail]);
  assert.ok(!persisted.includes(FAKE.tokenId), 'echoed oauth_token redacted');
  assert.ok(!persisted.includes('restlets.api.netsuite.com'));
  for (const call of f.calls) {
    assert.ok(!JSON.stringify(bodyOf(call)).match(/secret|token|oauth/i), 'request body has no credentials');
  }
});

(async () => {
  let passed = 0;
  process.stdout.write = function (chunk) {
    captured.push(String(chunk));
    return true;
  };
  process.stderr.write = function (chunk) {
    captured.push(String(chunk));
    return true;
  };
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      failures.push(['ok', t.name]);
    } catch (err) {
      failures.push(['FAIL', t.name, err && err.stack ? err.stack : String(err)]);
    }
  }
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  for (const [s, name, stack] of failures) {
    console.log(s + ' - ' + name);
    if (stack) console.log(stack);
  }
  if (passed !== tests.length) process.exitCode = 1;
  console.log('unit-elm-transport: ' + passed + '/' + tests.length + ' checks passed; external network attempts: ' + externalNet.length);
})();
