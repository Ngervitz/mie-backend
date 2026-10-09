'use strict';

/**
 * ELM client boundary: NetSuite RESTlets S1/S2, OAuth 1.0 TBA with HMAC-SHA256 (oauth.js).
 *
 * createElmClient() returns the DISABLED client (zero network I/O, every call → not_sent /
 * elm_send_disabled) unless ELM_CLIENT_ENABLED=true AND the transport config (URLs + four
 * credentials, env only) is complete and valid. Default: disabled.
 *
 * Transport rules:
 *   - exactly one POST per call; the client never retries and never follows redirects;
 *   - classification only from the documented `result` texts of a 2xx JSON body;
 *   - 401/403 = NetSuite rejected the authentication before running the RESTlet →
 *     technical_error (elm_http_auth_rejected);
 *   - timeout, network error, other non-2xx, unreadable/unparseable/undocumented body → unknown
 *     (the request may have been processed);
 *   - nothing is logged here; errorDetail never contains URLs, headers, credentials or body.
 *
 *   client.enabled: boolean
 *   client.disabledReason: string|null
 *   client.service1(payload) / client.service2(payload) → Promise<ElmCallResult>
 *
 *   ElmCallResult = {
 *     sent: boolean,              // request may have left the process
 *     outcome: 'positive'|'negative'|'unknown'|'technical_error'|'not_sent',
 *     httpStatus: number|null,
 *     resultMessage: string|null, // ELM response.result text
 *     responseBody: object|null,  // parsed body; persisted only after redactSecrets
 *     latencyMs: number|null,
 *     errorCode: string|null,
 *     errorDetail: string|null,   // never credentials/headers
 *   }
 *
 *   technical_error = explicit ELM answer that is NOT a credit decision (e.g. "BCU error").
 *                     Never a rejection. Retried only by the orchestrator, only for error codes
 *                     configured as proven side-effect free (ELM_RETRY_SAFE_ERROR_CODES).
 *   unknown         = ELM may or may not have processed it (timeout after send, lost or
 *                     unparseable response). Never retried automatically.
 *   A transport must never retry by itself.
 */

const crypto = require('crypto');
const { OUTCOME, CODES } = require('./constants');
const { readElmConfig, readElmTransportConfig } = require('./config');
const { buildAuthorizationHeader } = require('./oauth');
const { redactSecretText } = require('./redact');

/** Documented in "Especificación Técnica: API En la Mano" (Bloque A). Exact match only. */
const SERVICE1_POSITIVE = Object.freeze(['Listo para recibir datos en servicio 2']);
const SERVICE1_NEGATIVE = Object.freeze([
  'Blacklist',
  'SCORE BAJO',
  'BCU',
  'Repetido. rechazado',
  'No hay oferta',
]);
/** Explicit non-credit answers: result text → errorCode stored with technical_error. */
const SERVICE1_TECHNICAL = Object.freeze({
  'BCU error': CODES.PROVIDER_BCU_ERROR,
});
const SERVICE2_POSITIVE = Object.freeze(['Lead Aprobado correctamente']);
const SERVICE2_NEGATIVE = Object.freeze([
  'Aprobado sin canal',
  'Telefono no válido',
  'Lead no existe',
  'Documento no válido',
]);

const NO_TECHNICAL = Object.freeze({});

/** @returns {{ outcome: string, errorCode: string|null }} */
function classifyResponse(text, positives, negatives, technical) {
  if (typeof text !== 'string') return { outcome: OUTCOME.UNKNOWN, errorCode: null };
  const s = text.trim();
  if (positives.includes(s)) return { outcome: OUTCOME.POSITIVE, errorCode: null };
  if (negatives.includes(s)) return { outcome: OUTCOME.NEGATIVE, errorCode: null };
  if (Object.prototype.hasOwnProperty.call(technical, s)) {
    return { outcome: OUTCOME.TECHNICAL_ERROR, errorCode: technical[s] };
  }
  return { outcome: OUTCOME.UNKNOWN, errorCode: null };
}

/** Undocumented text → unknown (never treated as success or rejection). */
function classifyService1Response(text) {
  return classifyResponse(text, SERVICE1_POSITIVE, SERVICE1_NEGATIVE, SERVICE1_TECHNICAL);
}

function classifyService2Response(text) {
  return classifyResponse(text, SERVICE2_POSITIVE, SERVICE2_NEGATIVE, NO_TECHNICAL);
}

function classifyService1Result(text) {
  return classifyService1Response(text).outcome;
}

function classifyService2Result(text) {
  return classifyService2Response(text).outcome;
}

function notSentResult() {
  return {
    sent: false,
    outcome: OUTCOME.NOT_SENT,
    httpStatus: null,
    resultMessage: null,
    responseBody: null,
    latencyMs: null,
    errorCode: CODES.SEND_DISABLED,
    errorDetail: null,
  };
}

/**
 * @param {string} [reason]
 * @param {string[]} [configIssues] variable NAMES only
 */
function createDisabledElmClient(reason, configIssues) {
  return Object.freeze({
    enabled: false,
    disabledReason: reason || CODES.TRANSPORT_NOT_IMPLEMENTED,
    configIssues: Object.freeze((configIssues || []).slice()),
    service1: async function service1() {
      return notSentResult();
    },
    service2: async function service2() {
      return notSentResult();
    },
  });
}

const NETWORK_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/;

function result(outcome, fields) {
  return Object.assign(
    {
      sent: true,
      outcome: outcome,
      httpStatus: null,
      resultMessage: null,
      responseBody: null,
      latencyMs: null,
      errorCode: null,
      errorDetail: null,
    },
    fields,
  );
}

/** Error name / Node error code only: messages can carry URLs. */
function errorDetailOf(err) {
  const cause = err && err.cause;
  const code = (cause && cause.code) || (err && err.code);
  if (typeof code === 'string' && NETWORK_ERROR_CODE_RE.test(code)) return code;
  return err && typeof err.name === 'string' ? err.name.slice(0, 40) : 'Error';
}

/**
 * Real transport. Only built by createElmClient when enabled and the config is ready.
 * @param {{
 *   transport: ReturnType<typeof readElmTransportConfig>,
 *   timeoutMs: number,
 *   fetchImpl: typeof fetch,
 *   now?: () => number,
 *   nonce?: () => string,
 * }} deps
 */
function createNetSuiteElmClient(deps) {
  const t = deps.transport;
  const creds = t.credentials;
  const fetchImpl = deps.fetchImpl;
  const now = deps.now || Date.now;
  const nonce = deps.nonce || function () {
    return crypto.randomBytes(16).toString('hex');
  };
  const timeoutMs = deps.timeoutMs;
  const knownSecrets = [creds.consumerKey, creds.consumerSecret, creds.tokenId, creds.tokenSecret];

  async function call(url, payload, classify) {
    const authorization = buildAuthorizationHeader({
      method: 'POST',
      url: url,
      realm: t.realm,
      consumerKey: creds.consumerKey,
      consumerSecret: creds.consumerSecret,
      tokenId: creds.tokenId,
      tokenSecret: creds.tokenSecret,
      nonce: nonce(),
      timestamp: Math.floor(now() / 1000),
    });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const started = now();
    const latency = function () {
      return Math.max(0, now() - started);
    };

    let res;
    let text;
    try {
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err) {
        return result(OUTCOME.UNKNOWN, {
          latencyMs: latency(),
          errorCode: timedOut ? CODES.HTTP_TIMEOUT : CODES.TRANSPORT_ERROR,
          errorDetail: errorDetailOf(err),
        });
      }
      try {
        text = await res.text();
      } catch (err) {
        return result(OUTCOME.UNKNOWN, {
          httpStatus: res.status,
          latencyMs: latency(),
          errorCode: timedOut ? CODES.HTTP_TIMEOUT : CODES.RESPONSE_READ_FAILED,
          errorDetail: errorDetailOf(err),
        });
      }
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = null;
    }
    const base = {
      httpStatus: res.status,
      latencyMs: latency(),
      responseBody: body && typeof body === 'object' && !Array.isArray(body) ? body : null,
    };
    if (res.status === 401 || res.status === 403) {
      return result(OUTCOME.TECHNICAL_ERROR, Object.assign(base, { errorCode: CODES.HTTP_AUTH_REJECTED }));
    }
    if (res.status < 200 || res.status > 299) {
      return result(OUTCOME.UNKNOWN, Object.assign(base, { errorCode: CODES.HTTP_ERROR }));
    }
    if (!base.responseBody) {
      return result(OUTCOME.UNKNOWN, Object.assign(base, { errorCode: CODES.RESPONSE_UNPARSEABLE }));
    }
    const message = typeof base.responseBody.result === 'string' ? base.responseBody.result : null;
    const c = classify(message);
    return result(
      c.outcome,
      Object.assign(base, {
        resultMessage: message != null ? redactSecretText(message, 200, knownSecrets) : null,
        errorCode: c.outcome === OUTCOME.UNKNOWN ? CODES.RESPONSE_UNDOCUMENTED : c.errorCode,
      }),
    );
  }

  return Object.freeze({
    enabled: true,
    disabledReason: null,
    configIssues: Object.freeze([]),
    service1: function service1(payload) {
      return call(t.service1Url, payload, classifyService1Response);
    },
    service2: function service2(payload) {
      return call(t.service2Url, payload, classifyService2Response);
    },
  });
}

/**
 * Disabled unless ELM_CLIENT_ENABLED=true and the transport config is complete/valid.
 * @param {{ env?: object, fetchImpl?: typeof fetch, now?: () => number, nonce?: () => string }} [options]
 */
function createElmClient(options) {
  const o = options || {};
  const env = o.env || process.env;
  const transport = readElmTransportConfig(env);
  if (!transport.clientEnabled) return createDisabledElmClient(CODES.CLIENT_DISABLED);
  if (!transport.ready) {
    return createDisabledElmClient(
      CODES.TRANSPORT_CONFIG_INCOMPLETE,
      transport.missing.concat(transport.invalid),
    );
  }
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return createDisabledElmClient(CODES.TRANSPORT_NOT_IMPLEMENTED);
  return createNetSuiteElmClient({
    transport: transport,
    timeoutMs: readElmConfig(env).httpTimeoutMs,
    fetchImpl: fetchImpl,
    now: o.now,
    nonce: o.nonce,
  });
}

module.exports = {
  SERVICE1_POSITIVE,
  SERVICE1_NEGATIVE,
  SERVICE1_TECHNICAL,
  SERVICE2_POSITIVE,
  SERVICE2_NEGATIVE,
  classifyService1Response,
  classifyService2Response,
  classifyService1Result,
  classifyService2Result,
  createDisabledElmClient,
  createNetSuiteElmClient,
  createElmClient,
};
