'use strict';

/**
 * ELM orchestrator — reusable boundary for every caller (JANUS manual today; batch and
 * CZ automatic later). No dashboard/DOM dependency; callers pass only the solicitud id
 * and a trigger context. All data is resolved server-side.
 *
 *   evaluateElm(czSolicitudId, context)        → S1
 *   referElm(czSolicitudId, context)           → S2 (only after S1 eligible)
 *   sendElm(czSolicitudId, context)            → S1, then S2 when S1 is favorable (single button)
 *   retryElmStep(czSolicitudId, context, opts) → resend the SAME frozen request of a step in
 *                                                technical_error (DB-checked retry-safe code,
 *                                                attempt limit, expected attempt count)
 *   retrySendElm(czSolicitudId, context, opts) → operator "Reintentar ELM": resend the SAME
 *                                                frozen S1 that ELM provably never received
 *                                                (pre-reception error), then S2 like sendElm
 *   getElmStatus(czSolicitudId)                → read-only view + eligibility preview
 *
 * One process per solicitud. A lost/uncertain answer ends as unknown (in_flight lease expiry),
 * never as a second send. Only technical_error with a retry-safe code can be resent.
 *
 * context.sendOrigin (SEND_ORIGIN) is stored on the new process: required for janus_manual
 * (rechazados_manual | preaprobados_manual); the single allowed value otherwise.
 */

const {
  S1,
  S2,
  ENABLED_TRIGGER_ORIGINS,
  TRIGGER_ORIGINS,
  SEND_ORIGINS_BY_TRIGGER,
  ELM_SOURCE,
  OUTCOME,
  CODES,
} = require('./constants');
const { readElmConfig } = require('./config');
const { createElmClient } = require('./client');
const {
  buildService1Payload,
  buildService2Payload,
  parseFrozenDateOfBirth,
} = require('./payload');
const { isValidBirthDate } = require('../../lib/birthDate');
const {
  normalizeCommercialOrigin,
  evaluateElmEligibility,
  evaluateElmReferEligibility,
} = require('./eligibility');
const { redactSecrets, redactSecretText } = require('./redact');
const { computeElmCell } = require('./listView');
const { readPostReferralRejectionStatuses } = require('./classification');
const defaultLogger = require('../../lib/logger');

function parseCzId(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function blocked(code, extra) {
  return Object.assign({ ok: false, code: code }, extra || {});
}

/** elm_manual_retry_s1 refusals → result codes. */
const MANUAL_RETRY_CODES = Object.freeze({
  not_found: CODES.PROCESS_NOT_FOUND,
  stale: CODES.RETRY_STALE,
  not_pre_reception: CODES.RETRY_NOT_PRE_RECEPTION,
  attempts_exhausted: CODES.RETRY_ATTEMPTS_EXHAUSTED,
  not_allowed: CODES.RETRY_NOT_ALLOWED,
});

function blockerOf(failure) {
  return failure.fields ? { code: failure.code, fields: failure.fields } : { code: failure.code };
}

/**
 * @param {{ triggerOrigin?: string, triggeredByUserId?: string|null }} context
 * @param {readonly string[]} [enabledOrigins]
 */
function validateContext(context, enabledOrigins) {
  const enabled = enabledOrigins || ENABLED_TRIGGER_ORIGINS;
  const origin = context && context.triggerOrigin;
  if (!TRIGGER_ORIGINS.includes(origin)) return blocked(CODES.INVALID_CONTEXT);
  if (!enabled.includes(origin)) {
    return blocked(CODES.TRIGGER_ORIGIN_NOT_ENABLED);
  }
  const userId =
    context.triggeredByUserId != null ? String(context.triggeredByUserId).trim() : '';
  if (origin === 'janus_manual' && !userId) return blocked(CODES.MANUAL_REQUIRES_USER);
  return { ok: true, triggerOrigin: origin, triggeredByUserId: userId || null };
}

/** @returns {string|null} send_origin for a new process of this trigger origin */
function resolveSendOrigin(triggerOrigin, context) {
  const allowed = SEND_ORIGINS_BY_TRIGGER[triggerOrigin] || [];
  const raw = context ? context.sendOrigin : null;
  if (raw == null && allowed.length === 1) return allowed[0];
  return allowed.includes(raw) ? raw : null;
}

const S1_BY_OUTCOME = Object.freeze({
  [OUTCOME.POSITIVE]: S1.ELIGIBLE,
  [OUTCOME.NEGATIVE]: S1.REJECTED,
  [OUTCOME.DUPLICATE_OTHER_CHANNEL]: S1.REJECTED,
  [OUTCOME.UNKNOWN]: S1.UNKNOWN,
  [OUTCOME.TECHNICAL_ERROR]: S1.TECHNICAL_ERROR,
  [OUTCOME.NOT_SENT]: S1.TECHNICAL_ERROR,
});

const S2_BY_OUTCOME = Object.freeze({
  [OUTCOME.POSITIVE]: S2.REFERRED,
  [OUTCOME.NEGATIVE]: S2.REJECTED,
  [OUTCOME.UNKNOWN]: S2.UNKNOWN,
  [OUTCOME.TECHNICAL_ERROR]: S2.TECHNICAL_ERROR,
  [OUTCOME.NOT_SENT]: S2.TECHNICAL_ERROR,
});

function nonNegativeInt(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function httpStatusOrNull(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
}

/**
 * Normalize a client result into persisted step columns. Anything unexpected → unknown,
 * because the request may have been sent.
 */
function toStepResult(callResult, statusByOutcome, unknownStatus) {
  const r = callResult && typeof callResult === 'object' ? callResult : {};
  const status = statusByOutcome[r.outcome] || unknownStatus;
  const body =
    r.responseBody && typeof r.responseBody === 'object'
      ? redactSecrets(r.responseBody)
      : null;
  return {
    status: status,
    response: body,
    httpStatus: httpStatusOrNull(r.httpStatus),
    resultMessage:
      typeof r.resultMessage === 'string' ? redactSecretText(r.resultMessage) : null,
    latencyMs: nonNegativeInt(r.latencyMs),
    errorCode: typeof r.errorCode === 'string' ? r.errorCode.slice(0, 100) : null,
    errorDetail: r.errorDetail != null ? redactSecretText(r.errorDetail) : null,
  };
}

function threwResult(unknownStatus, err) {
  return {
    status: unknownStatus,
    response: null,
    httpStatus: null,
    resultMessage: null,
    latencyMs: null,
    errorCode: CODES.CLIENT_THREW,
    errorDetail: redactSecretText(err && err.message ? err.message : 'client threw'),
  };
}

function isExpired(leaseIso, nowMs) {
  if (!leaseIso) return false;
  const t = Date.parse(String(leaseIso));
  return Number.isFinite(t) && t < nowMs;
}

/** Read-side status: an expired in_flight is reported as unknown (persisted on write paths). */
function effectiveStatus(status, leaseIso, nowMs) {
  if (status === 'in_flight' && isExpired(leaseIso, nowMs)) return 'unknown';
  return status;
}

function hasExpiredInFlight(process, nowMs) {
  if (!process) return false;
  return (
    (process.s1_status === S1.IN_FLIGHT && isExpired(process.s1_lease_expires_at, nowMs)) ||
    (process.s2_status === S2.IN_FLIGHT && isExpired(process.s2_lease_expires_at, nowMs))
  );
}

/**
 * Browser-safe projection: no request/response bodies (PII), no error details.
 * @param {object|null} p
 * @param {number} nowMs
 */
function toProcessView(p, nowMs) {
  if (!p) return null;
  return {
    id: p.id,
    cz_solicitud_id: p.cz_solicitud_id,
    trigger_origin: p.trigger_origin,
    send_origin: p.send_origin || null,
    source_brand: p.source_brand,
    commercial_origin: p.commercial_origin || null,
    created_at: p.created_at || null,
    updated_at: p.updated_at || null,
    s1: {
      status: p.s1_status,
      effective_status: effectiveStatus(p.s1_status, p.s1_lease_expires_at, nowMs),
      result_message: p.s1_result_message || null,
      http_status: p.s1_http_status != null ? p.s1_http_status : null,
      started_at: p.s1_started_at || null,
      completed_at: p.s1_completed_at || null,
      latency_ms: p.s1_latency_ms != null ? p.s1_latency_ms : null,
      error_code: p.s1_error_code || null,
      attempts: p.s1_attempts != null ? p.s1_attempts : null,
    },
    s2: {
      status: p.s2_status,
      effective_status: effectiveStatus(p.s2_status, p.s2_lease_expires_at, nowMs),
      result_message: p.s2_result_message || null,
      http_status: p.s2_http_status != null ? p.s2_http_status : null,
      started_at: p.s2_started_at || null,
      completed_at: p.s2_completed_at || null,
      latency_ms: p.s2_latency_ms != null ? p.s2_latency_ms : null,
      error_code: p.s2_error_code || null,
      attempts: p.s2_attempts != null ? p.s2_attempts : null,
    },
    ops_resolution: p.ops_resolved_at
      ? { code: p.ops_resolution_code || null, resolved_at: p.ops_resolved_at }
      : null,
    referred_at: p.referred_at || null,
    provider_status: p.provider_status || null,
    provider_status_at: p.provider_status_at || null,
    disbursed_at: p.disbursed_at || null,
    disbursed_amount: p.disbursed_amount != null ? Number(p.disbursed_amount) : null,
    granted_elm: Boolean(p.disbursed_at),
    last_postback_at: p.last_postback_at || null,
  };
}

/**
 * cz_automatic callers pass the applicant snapshot CZ sent at start (`context.solicitud`, same
 * shape as a cz_funnel_solicitudes row, incl. solicitudes_estados_id = estado CZ reported).
 * The automatic flow never reads the mirror: a solicitud just created in CZ may not be synced,
 * and CDV GRANTED is judged on the estado CZ sent. Other origins read the mirror.
 *
 * @param {{
 *   repository?: object,
 *   client?: object,
 *   config?: object,
 *   logger?: object,
 *   now?: () => number,
 *   enabledTriggerOrigins?: readonly string[],
 * }} [deps]
 */
function createElmOrchestrator(deps) {
  const d = deps || {};
  const repo = d.repository || require('./repository').createElmRepository();
  const client = d.client || createElmClient();
  const config = d.config || readElmConfig();
  const logger = d.logger || defaultLogger;
  const now = d.now || Date.now;
  const enabledTriggerOrigins = d.enabledTriggerOrigins || ENABLED_TRIGGER_ORIGINS;
  const postReferralStatuses =
    d.postReferralRejectionStatuses || readPostReferralRejectionStatuses();

  function snapshotOf(ctx, context) {
    if (ctx.triggerOrigin !== 'cz_automatic') return null;
    const s = context && context.solicitud;
    return s && typeof s === 'object' ? s : null;
  }

  async function loadContext(czId, ctx, context) {
    if (ctx.triggerOrigin === 'cz_automatic') {
      return { solicitud: snapshotOf(ctx, context), grantedRow: null };
    }
    return repo.loadSolicitudContext(czId);
  }

  function jtOf(ctx, context) {
    if (ctx.triggerOrigin !== 'cz_automatic') return null;
    return context && typeof context.jt === 'string' ? context.jt : null;
  }

  /** Tracking only: a failure or an organic lead (no base) yields null, never a blocker. */
  async function commercialOriginOf(czId, ctx, context) {
    try {
      return normalizeCommercialOrigin(await repo.resolveBaseLabel(czId, jtOf(ctx, context)));
    } catch (_) {
      logger.warn('elm commercial origin unresolved', { cz_solicitud_id: czId });
      return null;
    }
  }

  function sendGate() {
    if (client && client.enabled === true) return null;
    return blocked(CODES.SEND_DISABLED, {
      reason: (client && client.disabledReason) || CODES.TRANSPORT_NOT_IMPLEMENTED,
    });
  }

  /**
   * Re-check of the frozen S1 dateOfBirth before any S1 resend: requests frozen before the
   * date-of-birth validation may hold impossible dates. Age reference = s1_started_at, so a
   * valid request never becomes invalid by aging between attempts.
   * @returns {string|null} blocking code, or null when the frozen date is valid
   */
  function frozenS1BirthDateBlock(process) {
    const format = config && config.dateOfBirthFormat;
    if (!format) return CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED;
    const request = process && process.s1_request;
    const ymd = parseFrozenDateOfBirth(request && request.dateOfBirth, format);
    const refMs = Date.parse((process && (process.s1_started_at || process.created_at)) || '');
    const ref = new Date(Number.isFinite(refMs) ? refMs : now());
    return ymd && isValidBirthDate(ymd, ref) ? null : CODES.DATE_OF_BIRTH_INVALID;
  }

  /**
   * The row already left in_flight (lease expired → unknown) before this result could be
   * stored. The process is NOT changed; the result is kept in elm_late_results for manual
   * reconciliation (best effort). Only codes are logged: no response body, result text or PII.
   */
  async function logLateResult(processId, czId, step, result, triggerOrigin) {
    logger.warn('elm late result discarded', {
      cz_solicitud_id: czId,
      step: step,
      late_status: result.status,
      late_error_code: result.errorCode,
      late_http_status: result.httpStatus,
      trigger_origin: triggerOrigin,
    });
    if (typeof repo.recordLateResult !== 'function') return;
    try {
      await repo.recordLateResult({
        processId: processId,
        czSolicitudId: czId,
        step: step,
        result: result,
        triggerOrigin: triggerOrigin,
      });
    } catch (_) {
      logger.error('elm late result record failed', { cz_solicitud_id: czId, step: step });
    }
  }

  async function expireIfStale(czId, process) {
    if (!hasExpiredInFlight(process, now())) return process;
    const updated = await repo.expireStaleInFlight(czId);
    logger.warn('elm in_flight lease expired → unknown', { cz_solicitud_id: czId });
    return updated || process;
  }

  async function evaluateElm(czSolicitudId, context) {
    const czId = parseCzId(czSolicitudId);
    if (czId == null) return blocked(CODES.INVALID_CZ_ID);
    const ctx = validateContext(context, enabledTriggerOrigins);
    if (!ctx.ok) return ctx;
    const sendOrigin = resolveSendOrigin(ctx.triggerOrigin, context);
    if (!sendOrigin) return blocked(CODES.INVALID_SEND_ORIGIN);

    const gate = sendGate();
    if (gate) return gate;

    const { solicitud, grantedRow } = await loadContext(czId, ctx, context);
    const evaluatedAt = new Date(now());
    const elig = evaluateElmEligibility({
      czId: czId,
      solicitud: solicitud,
      grantedRow: grantedRow,
      config: config,
      now: evaluatedAt,
    });
    if (!elig.eligible) {
      return blocked(elig.blockers[0].code, { blockers: elig.blockers });
    }

    const built = buildService1Payload({
      czId: czId,
      solicitud: solicitud,
      config: config,
      now: evaluatedAt,
    });
    if (!built.ok) return blocked(built.code, { blockers: [blockerOf(built)] });

    const claim = await repo.claimProcess({
      czSolicitudId: czId,
      ci: Number(solicitud.ci),
      sourceBrand: ELM_SOURCE,
      commercialOrigin: await commercialOriginOf(czId, ctx, context),
      triggerOrigin: ctx.triggerOrigin,
      triggeredByUserId: ctx.triggeredByUserId,
      sendOrigin: sendOrigin,
      czEstadoIdAtStart:
        solicitud.solicitudes_estados_id != null
          ? Number(solicitud.solicitudes_estados_id)
          : null,
      lrwIdAtStart: solicitud.lrw_id != null ? String(solicitud.lrw_id) : null,
      s1Request: built.payload,
      leaseSeconds: config.inFlightLeaseSeconds,
    });
    if (!claim.claimed && claim.blocked) {
      return blocked(CODES.CI_LOCK_BLOCKED, { lock: claim.blocked });
    }
    if (!claim.claimed) {
      const existing = await expireIfStale(czId, claim.process);
      return blocked(CODES.PROCESS_EXISTS, { process: toProcessView(existing, now()) });
    }

    return runStep('s1', claim.process.id, czId, built.payload, ctx);
  }

  /** Calls ELM once for a step already persisted as in_flight and stores the result. */
  async function runStep(stepName, processId, czId, payload, ctx) {
    const isS1 = stepName === 's1';
    let step;
    try {
      step = isS1
        ? toStepResult(await client.service1(payload), S1_BY_OUTCOME, S1.UNKNOWN)
        : toStepResult(await client.service2(payload), S2_BY_OUTCOME, S2.UNKNOWN);
    } catch (err) {
      step = threwResult(isS1 ? S1.UNKNOWN : S2.UNKNOWN, err);
    }

    let finished;
    try {
      finished = isS1 ? await repo.finishS1(processId, step) : await repo.finishS2(processId, step);
    } catch (err) {
      logger.error('elm finish ' + stepName + ' persist failed', {
        cz_solicitud_id: czId,
        status: step.status,
      });
      return blocked(CODES.PERSIST_FAILED);
    }
    if (!finished) {
      await logLateResult(processId, czId, stepName, step, ctx.triggerOrigin);
      return blocked(CODES.LATE_RESULT_DISCARDED, { step: stepName });
    }
    logger.info('elm ' + stepName + ' finished', {
      cz_solicitud_id: czId,
      status: step.status,
      error_code: step.errorCode,
      trigger_origin: ctx.triggerOrigin,
    });
    return { ok: true, process: toProcessView(finished, now()) };
  }

  async function referElm(czSolicitudId, context) {
    const czId = parseCzId(czSolicitudId);
    if (czId == null) return blocked(CODES.INVALID_CZ_ID);
    const ctx = validateContext(context, enabledTriggerOrigins);
    if (!ctx.ok) return ctx;

    const gate = sendGate();
    if (gate) return gate;

    let process = await repo.getProcessByCzId(czId);
    if (!process) return blocked(CODES.PROCESS_NOT_FOUND);
    process = await expireIfStale(czId, process);
    if (process.s1_status !== S1.ELIGIBLE) {
      return blocked(CODES.S1_NOT_ELIGIBLE, { process: toProcessView(process, now()) });
    }
    if (process.s2_status !== S2.NOT_STARTED) {
      return blocked(CODES.S2_ALREADY_STARTED, { process: toProcessView(process, now()) });
    }

    const { solicitud, grantedRow } = await loadContext(czId, ctx, context);
    const elig = evaluateElmReferEligibility({
      czId: czId,
      solicitud: solicitud,
      grantedRow: grantedRow,
      process: process,
    });
    if (!elig.eligible) {
      return blocked(elig.blockers[0].code, { blockers: elig.blockers });
    }

    const built = buildService2Payload({
      ci: process.ci,
      czId: process.cz_solicitud_id,
      solicitud: solicitud,
      config: config,
    });
    if (!built.ok) return blocked(built.code, { blockers: [blockerOf(built)] });

    const begun = await repo.beginS2(czId, built.payload, config.inFlightLeaseSeconds);
    if (!begun) return blocked(CODES.S2_NOT_STARTABLE);

    return runStep('s2', begun.id, czId, built.payload, ctx);
  }

  /**
   * Resend the frozen request of a step in technical_error. The DB (elm_retry_step) re-checks
   * under row lock: still technical_error, attempts == expectedAttempts < max, stored error code
   * in the retry-safe list, process not manually resolved. Anything else → RETRY_NOT_ALLOWED and
   * nothing is sent. CDV GRANTED is re-checked first (same context rules as S1/S2).
   *
   * @param {{ step: 's1'|'s2', expectedAttempts: number }} opts
   */
  async function retryElmStep(czSolicitudId, context, opts) {
    const czId = parseCzId(czSolicitudId);
    if (czId == null) return blocked(CODES.INVALID_CZ_ID);
    const ctx = validateContext(context, enabledTriggerOrigins);
    if (!ctx.ok) return ctx;
    const stepName = opts && opts.step;
    const expected = Number(opts && opts.expectedAttempts);
    if ((stepName !== 's1' && stepName !== 's2') || !Number.isInteger(expected) || expected < 1) {
      return blocked(CODES.INVALID_CONTEXT);
    }

    const gate = sendGate();
    if (gate) return gate;

    const { solicitud, grantedRow } = await loadContext(czId, ctx, context);
    const elig = evaluateElmReferEligibility({
      czId: czId,
      solicitud: solicitud,
      grantedRow: grantedRow,
      process: null,
    });
    if (!elig.eligible) {
      return blocked(elig.blockers[0].code, { blockers: elig.blockers });
    }

    if (stepName === 's1') {
      const current = await repo.getProcessByCzId(czId);
      const dobBlock = current ? frozenS1BirthDateBlock(current) : null;
      if (dobBlock) return blocked(dobBlock, { blockers: [{ code: dobBlock }] });
    }

    const row = await repo.retryStep({
      czSolicitudId: czId,
      step: stepName,
      expectedAttempts: expected,
      maxAttempts: config.technicalRetryMaxAttempts,
      retrySafeErrorCodes: config.retrySafeErrorCodes,
      leaseSeconds: config.inFlightLeaseSeconds,
    });
    if (!row) return blocked(CODES.RETRY_NOT_ALLOWED);
    const payload = stepName === 's1' ? row.s1_request : row.s2_request;
    logger.info('elm technical retry started', {
      cz_solicitud_id: czId,
      step: stepName,
      attempt: stepName === 's1' ? row.s1_attempts : row.s2_attempts,
      trigger_origin: ctx.triggerOrigin,
    });
    return runStep(stepName, row.id, czId, payload, ctx);
  }

  /**
   * Operator "Reintentar ELM" (janus_manual only). elm_manual_retry_s1 re-checks in one
   * transaction that ELM never received the lead, the expected attempt count, the attempt limit
   * and the CI lock (same rules as a first send), archives the failed attempt and puts the SAME
   * process back in S1 in_flight. Then the frozen S1 request is sent once and, when favorable,
   * S2 follows as in sendElm. Never used by the automatic path.
   *
   * @param {{ expectedAttempts: number }} opts s1_attempts the operator saw
   */
  async function retrySendElm(czSolicitudId, context, opts) {
    const czId = parseCzId(czSolicitudId);
    if (czId == null) return blocked(CODES.INVALID_CZ_ID, { stage: 's1' });
    const ctx = validateContext(context, enabledTriggerOrigins);
    if (!ctx.ok) return Object.assign({ stage: 's1' }, ctx);
    if (ctx.triggerOrigin !== 'janus_manual') return blocked(CODES.INVALID_CONTEXT, { stage: 's1' });
    const expected = Number(opts && opts.expectedAttempts);
    if (!Number.isInteger(expected) || expected < 1) return blocked(CODES.INVALID_CONTEXT, { stage: 's1' });

    const gate = sendGate();
    if (gate) return Object.assign({ stage: 's1' }, gate);

    const process = await repo.getProcessByCzId(czId);
    if (!process) return blocked(CODES.PROCESS_NOT_FOUND, { stage: 's1' });
    const { solicitud, grantedRow } = await loadContext(czId, ctx, context);
    const elig = evaluateElmReferEligibility({
      czId: czId,
      solicitud: solicitud,
      grantedRow: grantedRow,
      process: process,
    });
    if (!elig.eligible) {
      return blocked(elig.blockers[0].code, { stage: 's1', blockers: elig.blockers });
    }
    const dobBlock = frozenS1BirthDateBlock(process);
    if (dobBlock) return blocked(dobBlock, { stage: 's1', blockers: [{ code: dobBlock }] });

    const out = await repo.manualRetryS1({
      czSolicitudId: czId,
      expectedAttempts: expected,
      maxAttempts: config.technicalRetryMaxAttempts,
      leaseSeconds: config.inFlightLeaseSeconds,
      actorUserId: ctx.triggeredByUserId,
    });
    if (out.status === 'blocked') {
      return blocked(CODES.CI_LOCK_BLOCKED, { stage: 's1', lock: out.lock || null });
    }
    if (out.status !== 'retried' || !out.process) {
      return blocked(MANUAL_RETRY_CODES[out.status] || CODES.RETRY_NOT_ALLOWED, {
        stage: 's1',
        reason: out.reason || null,
      });
    }
    logger.info('elm manual retry started', {
      cz_solicitud_id: czId,
      step: 's1',
      attempt: out.process.s1_attempts,
      lock_status: out.lock ? out.lock.status : null,
      trigger_origin: ctx.triggerOrigin,
    });

    const s1 = await runStep('s1', out.process.id, czId, out.process.s1_request, ctx);
    if (!s1.ok) return Object.assign({ stage: 's1' }, s1);
    const view = s1.process;
    if (view.s1.effective_status !== S1.ELIGIBLE || view.s2.effective_status !== S2.NOT_STARTED) {
      return { ok: true, stage: 's1', process: view };
    }
    const s2 = await referElm(czId, context);
    if (s2.ok) return { ok: true, stage: 's2', process: s2.process };
    return { ok: true, stage: 's1', process: view, s2_blocked: { code: s2.code } };
  }

  /**
   * Whether a real send could run now: transport enabled and every ELM format/mapping the
   * payload needs confirmed in config. Per-solicitud blockers are checked by eligibility.
   * @returns {{ ready: boolean, reasons: string[] }}
   */
  function getSendReadiness() {
    const reasons = [];
    if (!client || client.enabled !== true) {
      reasons.push((client && client.disabledReason) || CODES.SEND_DISABLED);
    }
    const map = (config && config.activityTypeMap) || {};
    if (!Object.keys(map).length) reasons.push(CODES.ACTIVITY_TYPE_MAPPING_MISSING);
    if (!config || !config.dateOfBirthFormat) reasons.push(CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED);
    if (!config || !config.mobilePhoneFormat) reasons.push(CODES.MOBILEPHONE_FORMAT_UNCONFIRMED);
    return { ready: reasons.length === 0, reasons: reasons };
  }

  /**
   * Single operator action: S1, and S2 right after when S1 is favorable. Also resumes a process
   * left with S1 favorable and S2 not started. Every guard of evaluateElm/referElm applies
   * (send gate, eligibility, CI lock, one process per solicitud, atomic S2 start).
   * S1 favorable with S2 blocked → ok with `s2_blocked` (S1 stays persisted; the next press
   * resumes S2). Later ELM updates arrive by postback; nothing here polls ELM.
   */
  async function sendElm(czSolicitudId, context) {
    const s1 = await evaluateElm(czSolicitudId, context);
    const resumable =
      !s1.ok &&
      s1.code === CODES.PROCESS_EXISTS &&
      s1.process &&
      s1.process.s1.effective_status === S1.ELIGIBLE &&
      s1.process.s2.effective_status === S2.NOT_STARTED;
    if (!s1.ok && !resumable) return Object.assign({ stage: 's1' }, s1);

    const view = s1.process;
    if (view.s1.effective_status !== S1.ELIGIBLE || view.s2.effective_status !== S2.NOT_STARTED) {
      return { ok: true, stage: 's1', process: view };
    }

    const s2 = await referElm(czSolicitudId, context);
    if (s2.ok) return { ok: true, stage: 's2', process: s2.process };
    if (s1.ok) {
      return { ok: true, stage: 's1', process: view, s2_blocked: { code: s2.code } };
    }
    return Object.assign({ stage: 's2' }, s2, { process: s2.process || view });
  }

  /** Read-only. Never writes (expired in_flight is shown as effective unknown). */
  async function getElmStatus(czSolicitudId) {
    const czId = parseCzId(czSolicitudId);
    if (czId == null) return blocked(CODES.INVALID_CZ_ID);
    const process = await repo.getProcessByCzId(czId);
    const { solicitud, grantedRow } = await repo.loadSolicitudContext(czId);
    const elig = evaluateElmEligibility({
      czId: czId,
      solicitud: solicitud,
      grantedRow: grantedRow,
      existingProcess: process,
      config: config,
      now: new Date(now()),
    });
    let lastPostbackMatchMethod = null;
    if (process && process.last_postback_event_id && repo.getPostbackEvent) {
      try {
        const ev = await repo.getPostbackEvent(process.last_postback_event_id);
        lastPostbackMatchMethod = (ev && ev.match_method) || null;
      } catch (_) {
        lastPostbackMatchMethod = null;
      }
    }
    let projectedEstado = null;
    if (
      process &&
      process.trigger_origin === 'cz_automatic' &&
      typeof repo.getProjectedEstadosByCzIds === 'function'
    ) {
      try {
        const m = await repo.getProjectedEstadosByCzIds([czId]);
        projectedEstado = m.has(czId) ? m.get(czId) : null;
      } catch (_) {
        projectedEstado = null;
      }
    }
    return {
      ok: true,
      data: {
        cz_solicitud_id: czId,
        send_enabled: client.enabled === true,
        send_disabled_reason:
          client.enabled === true
            ? null
            : client.disabledReason || CODES.TRANSPORT_NOT_IMPLEMENTED,
        process: toProcessView(process, now()),
        eligibility: elig,
        cell: computeElmCell({
          process: process,
          eligibility: elig,
          nowMs: now(),
          postReferralRejectionStatuses: postReferralStatuses,
          projectedEstado: projectedEstado,
        }),
        last_postback_match_method: lastPostbackMatchMethod,
        send_readiness: getSendReadiness(),
      },
    };
  }

  return { evaluateElm, referElm, sendElm, retryElmStep, retrySendElm, getElmStatus, getSendReadiness };
}

module.exports = {
  createElmOrchestrator,
  validateContext,
  toStepResult,
  toProcessView,
  effectiveStatus,
  S1_BY_OUTCOME,
  S2_BY_OUTCOME,
};
