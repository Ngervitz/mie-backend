'use strict';

/**
 * ELM postback processing. Mandatory order (the route authenticates BEFORE calling this):
 *   authenticateElmPostback (route) → parse/validate → persist event → exact match by
 *   cz_solicitud_id → apply (elm_postback_resolve_event)
 * A request that does not authenticate never reaches this module: nothing is stored.
 *
 * Not tied to Preaprobados or any caller: it resolves a status against elm_lead_processes,
 * whatever triggered the ELM process (JANUS manual, batch, rejected-CDV flow, ...).
 *
 * Every authenticated POST is stored as an event (no dedupe: ELM sends no event id). The
 * effect on the process is applied by elm_postback_resolve_event, which re-checks identity
 * and compatibility under row locks and is idempotent.
 *
 * CI never selects a process. When received it is normalized (normalizeElmCi) and compared
 * against the matched process as an audit control; a mismatch → unmatched, no mutation.
 *
 * Identity/status fields documented by ELM (Fabián): internal_id (= cz_solicitud_id, sent in S2
 * as TrackingId), cedula, estado. Only these are read.
 */

const { CODES, POSTBACK_PROCESSING, MATCH_METHODS, S2 } = require('./constants');
const { classifyProviderStatus } = require('./providerStatus');
const { redactSecrets } = require('./redact');
const defaultLogger = require('../../lib/logger');

const FIELD_KEYS = Object.freeze({
  status: ['estado'],
  ci: ['cedula'],
  czSolicitudId: ['internal_id'],
  providerExternalId: ['provider_external_id', 'providerExternalId'],
  eventAt: ['event_at', 'eventAt'],
});

/**
 * Undocumented keys that could carry the same value (e.g. TrackingId echoed back). Never read
 * alone: present without the documented field → invalid (undocumented field); present with a
 * different value → invalid (contradiction). Never resolved by precedence.
 */
const CROSS_CHECK_KEYS = Object.freeze({
  status: ['status'],
  ci: ['docNumber', 'ci'],
  czSolicitudId: ['TrackingId', 'trackingId', 'tracking_id', 'cz_solicitud_id', 'czSolicitudId'],
});

const MAX_PAYLOAD_JSON_CHARS = 16000;
const MAX_TEXT = 200;
const MAX_FUTURE_EVENT_MS = 10 * 60 * 1000;

function pick(body, keys) {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(body, k) && body[k] != null && body[k] !== '') {
      return body[k];
    }
  }
  return undefined;
}

/**
 * Every alias present must normalize to the same value; disagreeing aliases are never resolved
 * by precedence. @returns {{ present: boolean, value: unknown, conflict: boolean }}
 */
function pickConsistent(body, keys, normalize) {
  let present = false;
  let value = null;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(body, k) || body[k] == null || body[k] === '') {
      continue;
    }
    const v = normalize(body[k]);
    if (!present) {
      present = true;
      value = v;
    } else if (v !== value) {
      return { present: true, value: null, conflict: true };
    }
  }
  return { present: present, value: value, conflict: false };
}

function positiveSafeInt(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * CI comparison key: digits of the document as sent in S1/S2 docNumber. Dots, spaces and
 * hyphens are formatting only ("1.234.567-8" = "12345678" = 12345678). Anything else → null.
 * Used on BOTH sides (received CI and process CI, which may come as bigint text).
 * @param {unknown} raw
 * @returns {number|null}
 */
function normalizeElmCi(raw) {
  if (typeof raw === 'number') return positiveSafeInt(raw);
  if (typeof raw === 'bigint') return positiveSafeInt(String(raw));
  if (typeof raw !== 'string') return null;
  return positiveSafeInt(raw.replace(/[.\s-]/g, ''));
}

function shortText(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s ? s.slice(0, MAX_TEXT) : null;
}

/**
 * Credentials are stripped by key and by text pattern; oversized bodies are replaced by a
 * marker (the extracted fields are kept in their own columns). Headers are never stored.
 * @param {unknown} body
 */
function sanitizePostbackPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const clean = redactSecrets(body);
  let json;
  try {
    json = JSON.stringify(clean);
  } catch (_) {
    return { _unserializable: true };
  }
  if (json.length > MAX_PAYLOAD_JSON_CHARS) {
    return { _truncated: true, _json_chars: json.length };
  }
  return clean;
}

/**
 * @param {unknown} body
 * @param {number} nowMs
 * @returns {{ invalidCode: string|null, fields: {
 *   rawStatus: string|null, normalizedStatus: string|null, grantedElm: boolean,
 *   ci: number|null, czSolicitudId: number|null, providerExternalId: string|null,
 *   providerEventAt: string|null } }}
 */
function parseElmPostback(body, nowMs) {
  const fields = {
    rawStatus: null,
    normalizedStatus: null,
    grantedElm: false,
    ci: null,
    czSolicitudId: null,
    providerExternalId: null,
    providerEventAt: null,
  };
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { invalidCode: CODES.POSTBACK_BODY_INVALID, fields: fields };
  }

  const status = classifyProviderStatus(pick(body, FIELD_KEYS.status));
  fields.rawStatus = shortText(status.raw);
  fields.normalizedStatus = status.normalized ? status.normalized.slice(0, MAX_TEXT) : null;
  fields.grantedElm = status.grantedElm;
  fields.providerExternalId = shortText(pick(body, FIELD_KEYS.providerExternalId));

  const ciPick = pickConsistent(body, FIELD_KEYS.ci, normalizeElmCi);
  fields.ci = ciPick.value;
  const czPick = pickConsistent(body, FIELD_KEYS.czSolicitudId, positiveSafeInt);
  fields.czSolicitudId = czPick.value;
  const statusCheck = crossCheck(body, CROSS_CHECK_KEYS.status, status.raw != null, status.normalized, normalizedStatusOf);
  const ciCheck = crossCheck(body, CROSS_CHECK_KEYS.ci, ciPick.present, fields.ci, normalizeElmCi);
  const czCheck = crossCheck(body, CROSS_CHECK_KEYS.czSolicitudId, czPick.present, fields.czSolicitudId, positiveSafeInt);
  const rawAt = pick(body, FIELD_KEYS.eventAt);
  let eventAtInvalid = false;
  if (rawAt !== undefined) {
    const t = typeof rawAt === 'string' ? Date.parse(rawAt) : NaN;
    if (Number.isFinite(t) && t <= nowMs + MAX_FUTURE_EVENT_MS) {
      fields.providerEventAt = new Date(t).toISOString();
    } else {
      eventAtInvalid = true;
    }
  }

  let invalidCode = null;
  if (statusCheck === 'undocumented' || ciCheck === 'undocumented' || czCheck === 'undocumented') {
    invalidCode = CODES.POSTBACK_UNDOCUMENTED_FIELD;
  } else if (!status.raw) invalidCode = CODES.POSTBACK_STATUS_MISSING;
  else if (!status.known) invalidCode = CODES.POSTBACK_STATUS_UNKNOWN;
  else if (statusCheck === 'conflict') invalidCode = CODES.POSTBACK_STATUS_UNKNOWN;
  else if ((czPick.present && fields.czSolicitudId == null) || czCheck === 'conflict') {
    invalidCode = CODES.POSTBACK_CZ_ID_INVALID;
  } else if ((ciPick.present && fields.ci == null) || ciCheck === 'conflict') {
    invalidCode = CODES.POSTBACK_CI_INVALID;
  } else if (eventAtInvalid) invalidCode = CODES.POSTBACK_EVENT_AT_INVALID;
  return { invalidCode: invalidCode, fields: fields };
}

function normalizedStatusOf(raw) {
  return classifyProviderStatus(raw).normalized;
}

/**
 * @returns {'absent'|'undocumented'|'conflict'|'consistent'}
 */
function crossCheck(body, keys, documentedPresent, documentedValue, normalize) {
  let seen = false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(body, k) || body[k] == null || body[k] === '') continue;
    seen = true;
    if (!documentedPresent) return 'undocumented';
    const v = normalize(body[k]);
    if (v == null || documentedValue == null || v !== documentedValue) return 'conflict';
  }
  return seen ? 'consistent' : 'absent';
}

/**
 * A process may receive a postback only if S2 was initiated and ended referred, or ended
 * unknown (S2 sent, answer lost/late). Never: S2 not_started, in_flight, rejected,
 * technical_error. Same rule is enforced again in elm_postback_resolve_event.
 */
function isPostbackCompatible(process) {
  return Boolean(
    process &&
      process.s2_started_at &&
      (process.s2_status === S2.REFERRED || process.s2_status === S2.UNKNOWN),
  );
}

/**
 * Exact cz_solicitud_id only. No id → unmatched (never resolved by CI). Received CI is an
 * audit control: compared after normalizeElmCi on both sides; mismatch → unmatched.
 * @returns {Promise<{ process: object|null, matchMethod: string|null, errorCode: string|null }>}
 */
async function matchPostbackProcess(fields, repo) {
  if (fields.czSolicitudId == null) {
    return { process: null, matchMethod: null, errorCode: CODES.POSTBACK_CZ_ID_MISSING };
  }
  const method = MATCH_METHODS.CZ_SOLICITUD_ID;
  const p = await repo.getProcessByCzId(fields.czSolicitudId);
  if (!p) return { process: null, matchMethod: method, errorCode: CODES.POSTBACK_CZ_ID_NOT_FOUND };
  if (fields.ci != null && normalizeElmCi(p.ci) !== fields.ci) {
    return { process: null, matchMethod: method, errorCode: CODES.POSTBACK_CI_MISMATCH };
  }
  if (!isPostbackCompatible(p)) {
    return { process: null, matchMethod: method, errorCode: CODES.POSTBACK_PROCESS_NOT_COMPATIBLE };
  }
  return { process: p, matchMethod: method, errorCode: null };
}

function eventView(ev) {
  return {
    event_id: ev.id,
    processing_status: ev.processing_status,
    match_method: ev.match_method || null,
    error_code: ev.error_code || null,
  };
}

/**
 * @param {{ repository?: object, logger?: object, now?: () => number }} [deps]
 */
function createElmPostbackProcessor(deps) {
  const d = deps || {};
  const repo = d.repository || require('./repository').createElmRepository();
  const logger = d.logger || defaultLogger;
  const now = d.now || Date.now;

  /**
   * @param {unknown} body already-authenticated request body
   * @returns {Promise<{ ok: true, event: object } | { ok: false, code: string, event?: object }>}
   */
  async function processElmPostback(body) {
    const parsed = parseElmPostback(body, now());
    const f = parsed.fields;

    let recorded;
    try {
      recorded = await repo.recordPostbackEvent({
        rawStatus: f.rawStatus,
        normalizedStatus: f.normalizedStatus,
        ci: f.ci,
        providerExternalId: f.providerExternalId,
        receivedCzSolicitudId: f.czSolicitudId,
        providerEventAt: f.providerEventAt,
        payload: sanitizePostbackPayload(body),
      });
    } catch (_) {
      logger.error('elm postback record failed', { invalid_code: parsed.invalidCode });
      return { ok: false, code: CODES.POSTBACK_PERSIST_FAILED };
    }

    let resolved;
    try {
      if (parsed.invalidCode) {
        resolved = await repo.resolvePostbackEvent({
          eventId: recorded.id,
          processId: null,
          matchMethod: null,
          unresolvedStatus: POSTBACK_PROCESSING.INVALID,
          errorCode: parsed.invalidCode,
        });
      } else {
        const m = await matchPostbackProcess(f, repo);
        resolved = await repo.resolvePostbackEvent({
          eventId: recorded.id,
          processId: m.process ? m.process.id : null,
          matchMethod: m.matchMethod,
          unresolvedStatus: m.process ? null : POSTBACK_PROCESSING.UNMATCHED,
          errorCode: m.process ? null : m.errorCode,
        });
      }
    } catch (_) {
      logger.error('elm postback resolve failed', { event_id: recorded.id });
      return { ok: false, code: CODES.POSTBACK_PERSIST_FAILED, event: eventView(recorded) };
    }

    logger.info('elm postback processed', {
      event_id: resolved.id,
      processing_status: resolved.processing_status,
      match_method: resolved.match_method || null,
      error_code: resolved.error_code || null,
      cz_solicitud_id: resolved.matched_cz_solicitud_id || null,
    });
    return { ok: true, event: eventView(resolved) };
  }

  return { processElmPostback };
}

module.exports = {
  FIELD_KEYS,
  CROSS_CHECK_KEYS,
  MAX_PAYLOAD_JSON_CHARS,
  parseElmPostback,
  sanitizePostbackPayload,
  normalizeElmCi,
  isPostbackCompatible,
  matchPostbackProcess,
  createElmPostbackProcessor,
};
