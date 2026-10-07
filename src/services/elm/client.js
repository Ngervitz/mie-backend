'use strict';

/**
 * ELM client boundary.
 *
 * Fase 1A: NO transport exists. createElmClient() always returns the disabled client:
 * no OAuth, no signing, no URLs, no credentials, ZERO network I/O. Every call resolves to
 * { sent: false, outcome: 'not_sent', errorCode: 'elm_send_disabled' }.
 *
 * Contract for a future transport (OAuth 1.0 HMAC-SHA256 per ELM spec), once ELM provides
 * URLs/credentials and the response envelope:
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
 *   technical_error = ELM certainly did not process the request.
 *   unknown         = ELM may or may not have processed it (timeout after send, lost or
 *                     unparseable response). Never retried automatically.
 *   A transport must never retry by itself.
 */

const { OUTCOME, CODES } = require('./constants');

/** Documented in "Especificación Técnica: API En la Mano" (Bloque A). Exact match only. */
const SERVICE1_POSITIVE = Object.freeze(['Listo para recibir datos en servicio 2']);
const SERVICE1_NEGATIVE = Object.freeze([
  'Blacklist',
  'SCORE BAJO',
  'BCU',
  'BCU error',
  'Repetido. rechazado',
  'No hay oferta',
]);
const SERVICE2_POSITIVE = Object.freeze(['Lead Aprobado correctamente']);
const SERVICE2_NEGATIVE = Object.freeze([
  'Aprobado sin canal',
  'Telefono no válido',
  'Lead no existe',
  'Documento no válido',
]);

function classifyResult(text, positives, negatives) {
  if (typeof text !== 'string') return OUTCOME.UNKNOWN;
  const s = text.trim();
  if (positives.includes(s)) return OUTCOME.POSITIVE;
  if (negatives.includes(s)) return OUTCOME.NEGATIVE;
  return OUTCOME.UNKNOWN;
}

/** Undocumented text → unknown (never treated as success or rejection). */
function classifyService1Result(text) {
  return classifyResult(text, SERVICE1_POSITIVE, SERVICE1_NEGATIVE);
}

function classifyService2Result(text) {
  return classifyResult(text, SERVICE2_POSITIVE, SERVICE2_NEGATIVE);
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
 */
function createDisabledElmClient(reason) {
  return Object.freeze({
    enabled: false,
    disabledReason: reason || CODES.TRANSPORT_NOT_IMPLEMENTED,
    service1: async function service1() {
      return notSentResult();
    },
    service2: async function service2() {
      return notSentResult();
    },
  });
}

/** Fase 1A: always disabled (no transport implemented). */
function createElmClient() {
  return createDisabledElmClient(CODES.TRANSPORT_NOT_IMPLEMENTED);
}

module.exports = {
  SERVICE1_POSITIVE,
  SERVICE1_NEGATIVE,
  SERVICE2_POSITIVE,
  SERVICE2_NEGATIVE,
  classifyService1Result,
  classifyService2Result,
  createDisabledElmClient,
  createElmClient,
};
