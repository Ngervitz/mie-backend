'use strict';

/**
 * Mi Deuda Stage 2 — Mi Plan debt-management opt-in export contract (pure, no I/O).
 *
 * Mi Plan is the source of truth of the opt-in; JANUS keeps an immutable operational copy.
 * The export carries only the authorized snapshot D (already filtered by Mi Plan: no
 * cancelada / pagada / draft debts). `creditor_raw` is the counterparty DECLARED by the user,
 * not necessarily the current legal creditor.
 *
 * Any contract violation throws MiplanOptinPayloadError: the sync run fails and nothing from
 * that page is acknowledged to Mi Plan (it is re-exported on the next pull). Optional debt
 * fields never reject a debt: invalid numbers keep their raw.
 */

const crypto = require('crypto');
const { normalizeCi } = require('./rejectedOps');
const {
  CREDITOR_KEY_VERSION,
  CREDITOR_SOURCES,
  resolveCreditor,
} = require('./creditorCatalog');

const EXPORT_CONTRACT_VERSION = 'miplan_debt_optin_export_v1';
const OPTIN_SCOPE = 'debt_management_interest';
const OPTIN_CONTRACT_VERSION = 'debt_management_opt_in_v1';
const OPTIN_SOURCE = 'miplan_v2';

const OPTIN_STATE = Object.freeze({
  OPTED_IN: 'opted_in',
  WITHDRAWN: 'withdrawn',
});

const CI_RESOLUTION = Object.freeze({
  RESOLVED: 'resolved',
  UNRESOLVABLE: 'unresolvable',
});

/** Why an event has no CI (reconciliation input; mirrors the DB CHECK). */
const CI_UNRESOLVED_REASON = Object.freeze({
  NO_TOKEN_HASH: 'NO_TOKEN_HASH',
  TOKEN_NOT_FOUND: 'TOKEN_NOT_FOUND',
  TOKEN_NOT_CONSUMED: 'TOKEN_NOT_CONSUMED',
  TOKEN_WITHOUT_CI: 'TOKEN_WITHOUT_CI',
});

/** ACK statuses: only durable ingest outcomes can be acknowledged to Mi Plan. */
const ACK_STATUS = Object.freeze({
  INSERTED: 'inserted',
  ALREADY_INGESTED: 'already_ingested',
});

/** UUIDv5 namespace for declared_debt_id. FROZEN: changing it re-identifies every debt. */
const DECLARED_DEBT_UUID_NAMESPACE = '11fda672-dde3-4d71-bb76-1ad75ae30764';

const MAX_DEBTS_PER_EVENT = 200;
const MAX_TEXT_LENGTH = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const CONSENT_TEXT_VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TIMESTAMPTZ_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const PLAIN_AMOUNT_RE = /^\d+([.,]\d{1,2})?$/;

class MiplanOptinPayloadError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MiplanOptinPayloadError';
    this.code = 'MIPLAN_OPTIN_PAYLOAD_INVALID';
    this.details = details || null;
  }
}

function fail(message, details) {
  throw new MiplanOptinPayloadError(message, details);
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function uuidV5(namespace, name) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20, 32)
  );
}

/**
 * JANUS declared debt identity: one per (opt-in event, position in snapshot D).
 * @param {string} eventId
 * @param {number} position
 */
function declaredDebtId(eventId, position) {
  if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) fail('declaredDebtId: invalid event_id');
  if (!Number.isSafeInteger(position) || position < 0) fail('declaredDebtId: invalid position');
  return uuidV5(DECLARED_DEBT_UUID_NAMESPACE, eventId.toLowerCase() + ':' + position);
}

/**
 * Defensive amount coercion. Accepts finite non-negative numbers and plain numeric strings
 * ("15000", "15000.5", "15000,50"). Anything else → value null, raw preserved.
 * "15.000" is NOT accepted (thousands vs decimal is ambiguous).
 * @returns {{ value: number|null, raw: string|null }}
 */
function coerceAmount(v) {
  if (v == null) return { value: null, raw: null };
  if (typeof v === 'number') {
    if (Number.isFinite(v) && v >= 0) return { value: v, raw: String(v) };
    return { value: null, raw: String(v) };
  }
  if (typeof v === 'string') {
    const raw = v.slice(0, MAX_TEXT_LENGTH);
    const s = v.trim();
    if (s === '') return { value: null, raw: raw === '' ? null : raw };
    if (PLAIN_AMOUNT_RE.test(s)) {
      const n = Number(s.replace(',', '.'));
      if (Number.isFinite(n)) return { value: n, raw: raw };
    }
    return { value: null, raw: raw };
  }
  if (typeof v === 'boolean') return { value: null, raw: String(v) };
  return { value: null, raw: null };
}

/** Primitive → trimmed text (max length); objects/arrays/empty → null. */
function coerceText(v) {
  if (v == null) return null;
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
  const s = String(v).trim();
  if (s === '') return null;
  return s.slice(0, MAX_TEXT_LENGTH);
}

/** Declared counterparty text: acreedor_raw when non-blank, else acreedor. Never trimmed. */
function pickCreditorRaw(debt) {
  const raw = debt.acreedor_raw;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.slice(0, MAX_TEXT_LENGTH);
  const fallback = debt.acreedor;
  if (typeof fallback === 'string' && fallback.trim() !== '') return fallback.slice(0, MAX_TEXT_LENGTH);
  return null;
}

function requireUuid(v, field, ctx) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) fail('invalid ' + field, ctx);
  return v.toLowerCase();
}

function optionalUuid(v, field, ctx) {
  if (v == null) return null;
  return requireUuid(v, field, ctx);
}

/**
 * Validate one exported event and normalize it (debts keep only allowlisted fields).
 * @param {unknown} ev
 */
function validateExportEvent(ev) {
  if (!isPlainObject(ev)) fail('event must be an object');
  const eventId = requireUuid(ev.event_id, 'event_id');
  const ctx = { event_id: eventId };
  const journeyId = requireUuid(ev.journey_id, 'journey_id', ctx);
  if (!Number.isSafeInteger(ev.seq) || ev.seq < 1) fail('invalid seq', ctx);
  if (ev.state !== OPTIN_STATE.OPTED_IN && ev.state !== OPTIN_STATE.WITHDRAWN) fail('invalid state', ctx);
  if (ev.scope !== OPTIN_SCOPE) fail('invalid scope', ctx);
  if (ev.contract_version !== OPTIN_CONTRACT_VERSION) fail('invalid contract_version', ctx);
  if (ev.source !== OPTIN_SOURCE) fail('invalid source', ctx);
  if (ev.consent_text_version != null &&
      (typeof ev.consent_text_version !== 'string' || !CONSENT_TEXT_VERSION_RE.test(ev.consent_text_version))) {
    fail('invalid consent_text_version', ctx);
  }
  if (typeof ev.created_at !== 'string' || !TIMESTAMPTZ_RE.test(ev.created_at) ||
      Number.isNaN(Date.parse(ev.created_at))) {
    fail('invalid created_at', ctx);
  }
  const originEvaluationId = requireUuid(ev.origin_evaluation_id, 'origin_evaluation_id', ctx);
  const originDiagnosisId = optionalUuid(ev.origin_diagnosis_id, 'origin_diagnosis_id', ctx);
  const snapshotDiagnosisId = requireUuid(ev.snapshot_diagnosis_id, 'snapshot_diagnosis_id', ctx);
  if (originDiagnosisId != null && originDiagnosisId !== snapshotDiagnosisId) {
    fail('snapshot_diagnosis_id must equal origin_diagnosis_id when present', ctx);
  }
  let tokenHash = null;
  if (ev.handoff_token_hash != null) {
    if (typeof ev.handoff_token_hash !== 'string' || !SHA256_HEX_RE.test(ev.handoff_token_hash)) {
      fail('invalid handoff_token_hash', ctx);
    }
    tokenHash = ev.handoff_token_hash;
  }

  let debts = [];
  let excludedCount = null;
  if (ev.state === OPTIN_STATE.OPTED_IN) {
    if (!Number.isSafeInteger(ev.excluded_count) || ev.excluded_count < 0) fail('invalid excluded_count', ctx);
    excludedCount = ev.excluded_count;
    if (!Array.isArray(ev.debts)) fail('opted_in event requires debts[]', ctx);
    if (ev.debts.length > MAX_DEBTS_PER_EVENT) fail('too many debts', ctx);
    const seen = new Set();
    debts = ev.debts.map(function (d) {
      if (!isPlainObject(d)) fail('debt must be an object', ctx);
      if (!Number.isSafeInteger(d.position) || d.position < 0) fail('invalid debt position', ctx);
      if (seen.has(d.position)) fail('duplicate debt position', ctx);
      seen.add(d.position);
      if (d.situacion_ui === 'pagada' || d.cancelada === true || d._is_draft_add === true) {
        fail('export contains a debt outside the authorized snapshot', ctx);
      }
      return {
        position: d.position,
        client_debt_id: coerceText(d.client_debt_id),
        tipo: coerceText(d.tipo),
        creditor_raw: pickCreditorRaw(d),
        miplan_acreedor_display: coerceText(d.acreedor_display),
        miplan_acreedor_normalizado: coerceText(d.acreedor_normalizado),
        monto: coerceAmount(d.monto),
        pago: coerceAmount(d.pago),
        pago_mensual_actual: coerceAmount(d.pago_mensual_actual),
        situacion_ui: coerceText(d.situacion_ui),
        estado: coerceText(d.estado),
        atraso_tiempo: coerceText(d.atraso_tiempo),
        atraso_tiempo_aprox: coerceText(d.atraso_tiempo_aprox),
        ultimo_pago_declarado: coerceAmount(d.ultimo_pago_declarado),
        debt_confidence: coerceText(d.debt_confidence),
      };
    });
    debts.sort(function (a, b) {
      return a.position - b.position;
    });
  } else {
    if (ev.debts != null && !(Array.isArray(ev.debts) && ev.debts.length === 0)) {
      fail('withdrawn event must not carry debts', ctx);
    }
    if (ev.excluded_count != null) fail('withdrawn event must not carry excluded_count', ctx);
  }

  return {
    event_id: eventId,
    journey_id: journeyId,
    seq: ev.seq,
    state: ev.state,
    scope: ev.scope,
    contract_version: ev.contract_version,
    source: ev.source,
    consent_text_version: ev.consent_text_version == null ? null : ev.consent_text_version,
    created_at: ev.created_at,
    origin_evaluation_id: originEvaluationId,
    origin_diagnosis_id: originDiagnosisId,
    snapshot_diagnosis_id: snapshotDiagnosisId,
    handoff_token_hash: tokenHash,
    excluded_count: excludedCount,
    debts: debts,
  };
}

/**
 * Validate a whole page of pending (unacked) events. Duplicate event_id inside one page is a
 * violation. Delivery is pending/ACK: the page carries no cursor.
 * @param {unknown} body
 * @returns {{ events: object[], has_more: boolean }}
 */
function validateExportPage(body) {
  if (!isPlainObject(body)) fail('export body must be an object');
  if (body.contract_version !== EXPORT_CONTRACT_VERSION) {
    fail('unsupported export contract_version');
  }
  if (!Array.isArray(body.events)) fail('events must be an array');
  if (typeof body.has_more !== 'boolean') fail('has_more must be boolean');
  if (body.has_more && body.events.length === 0) fail('has_more requires events');
  const seen = new Set();
  const events = body.events.map(function (ev) {
    const out = validateExportEvent(ev);
    if (seen.has(out.event_id)) fail('duplicate event_id in page', { event_id: out.event_id });
    seen.add(out.event_id);
    return out;
  });
  return { events: events, has_more: body.has_more };
}

/**
 * CI resolution from the handoff token row looked up by token_hash. Only a consumed token
 * with a valid positive CI resolves; anything else → unresolvable (identity is never invented).
 * @param {{ id: string, status: string, ci: unknown }|null} tokenRow
 */
function resolveCiFromToken(tokenRow) {
  if (!tokenRow || tokenRow.id == null) {
    return { handoff_token_id: null, ci: null, ci_resolution: CI_RESOLUTION.UNRESOLVABLE };
  }
  const ci = normalizeCi(tokenRow.ci);
  if (tokenRow.status !== 'consumed' || ci == null || ci <= 0) {
    return { handoff_token_id: String(tokenRow.id), ci: null, ci_resolution: CI_RESOLUTION.UNRESOLVABLE };
  }
  return { handoff_token_id: String(tokenRow.id), ci: ci, ci_resolution: CI_RESOLUTION.RESOLVED };
}

/**
 * Reason an event has no CI, from its handoff hash and the token row (null = not found).
 * @param {string|null} handoffTokenHash
 * @param {{ id: string, status: string, ci: unknown }|null} tokenRow
 * @returns {string|null} null when the token resolves a CI
 */
function ciUnresolvedReason(handoffTokenHash, tokenRow) {
  if (handoffTokenHash == null) return CI_UNRESOLVED_REASON.NO_TOKEN_HASH;
  if (!tokenRow || tokenRow.id == null) return CI_UNRESOLVED_REASON.TOKEN_NOT_FOUND;
  if (tokenRow.status !== 'consumed') return CI_UNRESOLVED_REASON.TOKEN_NOT_CONSUMED;
  if (resolveCiFromToken(tokenRow).ci_resolution === CI_RESOLUTION.RESOLVED) return null;
  return CI_UNRESOLVED_REASON.TOKEN_WITHOUT_CI;
}

/**
 * resolveCiFromToken + the reconciliation reason for an exported event. The token row passed
 * must be the one looked up by event.handoff_token_hash (never another identity source).
 * @param {{ handoff_token_hash: string|null }} event validated export event
 * @param {{ id: string, status: string, ci: unknown }|null} tokenRow
 */
function resolveCiForEvent(event, tokenRow) {
  const hash = event.handoff_token_hash == null ? null : event.handoff_token_hash;
  const base = resolveCiFromToken(hash == null ? null : tokenRow);
  if (base.ci_resolution === CI_RESOLUTION.RESOLVED) return base;
  return Object.assign({}, base, { ci_unresolved_reason: ciUnresolvedReason(hash, tokenRow) });
}

function unresolvedReasonFor(event, ciResolution) {
  if (ciResolution.ci_unresolved_reason) return ciResolution.ci_unresolved_reason;
  if (event.handoff_token_hash == null) return CI_UNRESOLVED_REASON.NO_TOKEN_HASH;
  if (ciResolution.handoff_token_id == null) return CI_UNRESOLVED_REASON.TOKEN_NOT_FOUND;
  fail('ci_unresolved_reason required (use resolveCiForEvent)', { event_id: event.event_id });
  return null;
}

/**
 * Build the ingest RPC payload: event + debts with the creditor identity resolved NOW
 * (source miplan_declared only). This resolution is the immutable ingestion snapshot.
 *
 * @param {ReturnType<typeof validateExportEvent>} event
 * @param {ReturnType<typeof resolveCiFromToken>} ciResolution
 * @param {object} resolver buildCreditorResolver output
 */
function buildIngestPayload(event, ciResolution, resolver) {
  const debts = event.debts.map(function (d) {
    const r = resolveCreditor(resolver, CREDITOR_SOURCES.MIPLAN_DECLARED, d.creditor_raw);
    return {
      declared_debt_id: declaredDebtId(event.event_id, d.position),
      position: d.position,
      client_debt_id: d.client_debt_id,
      tipo: d.tipo,
      creditor_raw: d.creditor_raw,
      miplan_acreedor_display: d.miplan_acreedor_display,
      miplan_acreedor_normalizado: d.miplan_acreedor_normalizado,
      creditor_normalized_key: r.normalized_key,
      creditor_key_version: CREDITOR_KEY_VERSION,
      ingestion_resolution: r.resolution,
      ingestion_creditor_id: r.creditor_id,
      ingestion_alias_id: r.alias_id,
      monto: d.monto.value,
      monto_raw: d.monto.raw,
      pago: d.pago.value,
      pago_raw: d.pago.raw,
      pago_mensual_actual: d.pago_mensual_actual.value,
      pago_mensual_actual_raw: d.pago_mensual_actual.raw,
      situacion_ui: d.situacion_ui,
      estado: d.estado,
      atraso_tiempo: d.atraso_tiempo,
      atraso_tiempo_aprox: d.atraso_tiempo_aprox,
      ultimo_pago_declarado: d.ultimo_pago_declarado.value,
      ultimo_pago_declarado_raw: d.ultimo_pago_declarado.raw,
      debt_confidence: d.debt_confidence,
    };
  });
  const reconciliation = ciResolution.ci_resolution === CI_RESOLUTION.UNRESOLVABLE
    ? { handoff_token_hash: event.handoff_token_hash, ci_unresolved_reason: unresolvedReasonFor(event, ciResolution) }
    : {};
  return {
    payload_version: EXPORT_CONTRACT_VERSION,
    event: Object.assign({
      event_id: event.event_id,
      journey_id: event.journey_id,
      seq: event.seq,
      state: event.state,
      scope: event.scope,
      contract_version: event.contract_version,
      source: event.source,
      consent_text_version: event.consent_text_version,
      origin_evaluation_id: event.origin_evaluation_id,
      origin_diagnosis_id: event.origin_diagnosis_id,
      snapshot_diagnosis_id: event.snapshot_diagnosis_id,
      miplan_created_at: event.created_at,
      excluded_count: event.excluded_count,
      handoff_token_id: ciResolution.handoff_token_id,
      ci: ciResolution.ci,
      ci_resolution: ciResolution.ci_resolution,
    }, reconciliation),
    debts: debts,
  };
}

module.exports = {
  EXPORT_CONTRACT_VERSION,
  OPTIN_SCOPE,
  OPTIN_CONTRACT_VERSION,
  OPTIN_SOURCE,
  OPTIN_STATE,
  CI_RESOLUTION,
  CI_UNRESOLVED_REASON,
  ACK_STATUS,
  DECLARED_DEBT_UUID_NAMESPACE,
  MAX_DEBTS_PER_EVENT,
  MiplanOptinPayloadError,
  uuidV5,
  declaredDebtId,
  coerceAmount,
  coerceText,
  pickCreditorRaw,
  validateExportEvent,
  validateExportPage,
  resolveCiFromToken,
  ciUnresolvedReason,
  resolveCiForEvent,
  buildIngestPayload,
};
