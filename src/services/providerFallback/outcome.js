'use strict';

/**
 * Pure decisions for the fallback worker.
 *
 * deriveFromProcess: the ELM process row (elm_lead_processes) is the only source of truth about
 * external calls. in_flight = a call may have been sent → wait for its lease, then unknown.
 * unknown is never retried → manual_review. technical_error is retried only when its error code
 * is configured as proven side-effect free, below the attempt limit and after the backoff;
 * otherwise → manual_review with a specific reason. Never a rejection.
 * S1 "BCU error" has its own fixed policy (BCU_RETRY): wait 24 h from the error, resend the same
 * frozen request once; a second BCU error → manual_review. The job stays pending meanwhile.
 * A rejection is only final for documented ELM negative texts; others → manual_review. S1
 * "Repetido. Aprobado" (approved by another channel) is not a rejection either → manual_review.
 *
 * evaluateCiGuard: reads the other ELM processes of the same CI. It never modifies them and
 * never matches anything by CI; it only decides whether this solicitud may start a new call.
 */

const { S1, S2, CODES } = require('../elm/constants');
const { technicalRetryDelaySeconds } = require('../elm/config');
const { isService1Negative } = require('../elm/client');
const {
  OUTCOME,
  REASONS,
  CZ_ESTADO,
  CI_LOCK_BLOCK,
  BCU_RETRY,
  DEFINITIVE_S2_REJECTION_RESULTS,
} = require('./constants');

function leaseMs(iso) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

function isExpired(iso, nowMs) {
  const t = leaseMs(iso);
  return t != null && t < nowMs;
}

function effective(status, leaseIso, nowMs) {
  return status === 'in_flight' && isExpired(leaseIso, nowMs) ? 'unknown' : status;
}

function final(outcome, reasonCode, detail) {
  return { kind: 'final', outcome: outcome, reasonCode: reasonCode, detail: detail || null };
}

function waitUntil(iso) {
  return { kind: 'wait', untilMs: leaseMs(iso) };
}

const TECHNICAL_REASONS = Object.freeze({
  s1: {
    unsafe: REASONS.ELM_S1_TECHNICAL_ERROR_RETRY_UNSAFE,
    exhausted: REASONS.ELM_S1_TECHNICAL_ERROR_RETRIES_EXHAUSTED,
  },
  s2: {
    unsafe: REASONS.ELM_S2_TECHNICAL_ERROR_RETRY_UNSAFE,
    exhausted: REASONS.ELM_S2_TECHNICAL_ERROR_RETRIES_EXHAUSTED,
  },
});

/**
 * @param {'s1'|'s2'} step
 * @param {object} p
 * @param {number} nowMs
 * @param {{ safeErrorCodes: readonly string[], maxAttempts: number, backoffSeconds: number,
 *   backoffMaxSeconds: number }|null|undefined} policy
 */
function technicalDecision(step, p, nowMs, policy) {
  const errorCode = p[step + '_error_code'] || null;
  const attempts = Math.max(1, Number(p[step + '_attempts']) || 1);
  const detail = { error_code: errorCode, attempts: attempts };
  const reasons = TECHNICAL_REASONS[step];
  if (step === 's1' && errorCode === BCU_RETRY.errorCode) return bcuDecision(p, nowMs, detail);
  const safe = Boolean(policy && errorCode && (policy.safeErrorCodes || []).includes(errorCode));
  if (!safe) return final(OUTCOME.MANUAL_REVIEW, reasons.unsafe, detail);
  if (attempts >= policy.maxAttempts) return final(OUTCOME.MANUAL_REVIEW, reasons.exhausted, detail);
  const completedMs = leaseMs(p[step + '_completed_at']);
  const delayMs =
    technicalRetryDelaySeconds(attempts, {
      technicalRetryBackoffSeconds: policy.backoffSeconds,
      technicalRetryBackoffMaxSeconds: policy.backoffMaxSeconds,
    }) * 1000;
  const dueMs = (completedMs != null ? completedMs : nowMs) + delayMs;
  if (dueMs > nowMs) return { kind: 'backoff', untilMs: dueMs };
  return { kind: 'retry', step: step, expectedAttempts: attempts };
}

/** BCU_RETRY: same solicitud / request / lock; elm_retry_step enforces the same 24 h and limit. */
function bcuDecision(p, nowMs, detail) {
  if (detail.attempts >= BCU_RETRY.maxAttempts) {
    return final(OUTCOME.MANUAL_REVIEW, REASONS.ELM_S1_BCU_ERROR_REPEATED, detail);
  }
  const completedMs = leaseMs(p.s1_completed_at);
  if (completedMs == null) return final(OUTCOME.MANUAL_REVIEW, REASONS.UNEXPECTED_STATE, detail);
  const dueMs = completedMs + BCU_RETRY.delaySeconds * 1000;
  if (dueMs > nowMs) return { kind: 'backoff', untilMs: dueMs };
  return { kind: 'retry', step: 's1', expectedAttempts: detail.attempts };
}

/**
 * @param {object} p elm_lead_processes row
 * @param {number} nowMs
 * @param {object} [retryPolicy] config.technicalRetry; absent → no technical retry at all
 * @returns {{ kind: 'final', outcome: string, reasonCode: string, detail: object|null }
 *   | { kind: 'wait', untilMs: number|null } | { kind: 'expire' } | { kind: 'refer' }
 *   | { kind: 'backoff', untilMs: number } | { kind: 'retry', step: string, expectedAttempts: number }}
 */
function deriveFromProcess(p, nowMs, retryPolicy) {
  if (p.s1_status === S1.IN_FLIGHT) {
    return isExpired(p.s1_lease_expires_at, nowMs) ? { kind: 'expire' } : waitUntil(p.s1_lease_expires_at);
  }
  if (p.s1_status === S1.UNKNOWN) return final(OUTCOME.MANUAL_REVIEW, REASONS.ELM_S1_UNKNOWN);
  if (p.s1_status === S1.TECHNICAL_ERROR) return technicalDecision('s1', p, nowMs, retryPolicy);
  if (p.s1_status === S1.REJECTED) {
    if (p.s1_error_code === CODES.S1_DUPLICATE_OTHER_CHANNEL) {
      return final(OUTCOME.MANUAL_REVIEW, REASONS.ELM_S1_DUPLICATE_OTHER_CHANNEL, {
        result_message: p.s1_result_message || null,
      });
    }
    return isService1Negative(p.s1_result_message)
      ? final(OUTCOME.REJECTED, REASONS.ELM_S1_REJECTED)
      : final(OUTCOME.MANUAL_REVIEW, REASONS.ELM_S1_REJECTION_NOT_DEFINITIVE, {
          result_message: p.s1_result_message || null,
        });
  }
  if (p.s1_status !== S1.ELIGIBLE) {
    return final(OUTCOME.MANUAL_REVIEW, REASONS.UNEXPECTED_STATE, { s1_status: p.s1_status });
  }

  switch (p.s2_status) {
    case S2.NOT_STARTED:
      return { kind: 'refer' };
    case S2.IN_FLIGHT:
      return isExpired(p.s2_lease_expires_at, nowMs) ? { kind: 'expire' } : waitUntil(p.s2_lease_expires_at);
    case S2.REFERRED:
      return final(OUTCOME.REFERRED, REASONS.ELM_S2_REFERRED);
    case S2.REJECTED:
      return DEFINITIVE_S2_REJECTION_RESULTS.includes(p.s2_result_message)
        ? final(OUTCOME.REJECTED, REASONS.ELM_S2_REJECTED)
        : final(OUTCOME.MANUAL_REVIEW, REASONS.ELM_S2_REJECTION_NOT_DEFINITIVE, {
            result_message: p.s2_result_message || null,
          });
    case S2.UNKNOWN:
      return final(OUTCOME.MANUAL_REVIEW, REASONS.ELM_S2_UNKNOWN);
    case S2.TECHNICAL_ERROR:
      return technicalDecision('s2', p, nowMs, retryPolicy);
    default:
      return final(OUTCOME.MANUAL_REVIEW, REASONS.UNEXPECTED_STATE, { s2_status: p.s2_status });
  }
}

/**
 * Rules (Fase 3B + C1). Processes closed by an audited manual resolution (ops_resolved_at) are
 * ignored. A referral that ended (ELM GRANTED / Convertido, or projected CZ estado 3 / 16) no
 * longer counts as an active / uncertain referral; an uncertain S1 still blocks until resolved.
 * A GRANTED loan only closes its own solicitud: it never blocks later solicitudes of the CI.
 *  1. another process of the CI is unknown (persisted or lease expired) → manual_review;
 *  2. another process of the CI is in_flight (lease valid) → wait for it;
 *  3. another process of the CI has an S2 referral → already_referred (nothing is sent), whatever
 *     the provider status (no automatic expiry of an active referral);
 *  4. another process of the CI is S1 eligible waiting for S2 → manual_review.
 * The monthly send limit is enforced afterwards by elm_ci_lock_acquire (DB, atomic per CI).
 *
 * @param {object[]} processes elm_lead_processes rows with the same CI
 * @param {number} selfCzId
 * @param {number} nowMs
 * @returns {{ kind: 'proceed' }
 *   | { kind: 'final', outcome: string, reasonCode: string, detail: object|null, relatedCzId: number }
 *   | { kind: 'wait', untilMs: number|null, relatedCzId: number }}
 */
function evaluateCiGuard(processes, selfCzId, nowMs) {
  const sameCi = (processes || [])
    .filter(function (p) {
      return p && Number(p.cz_solicitud_id) !== Number(selfCzId);
    })
    .sort(function (a, b) {
      return Number(a.cz_solicitud_id) - Number(b.cz_solicitud_id);
    });
  const others = sameCi.filter(function (p) {
    return !p.ops_resolved_at;
  });
  function closedInCz(p) {
    const estado = Number(p.cz_projected_estado);
    return Boolean(p.disbursed_at) || estado === CZ_ESTADO.REJECTED || estado === CZ_ESTADO.CONVERTED;
  }

  function withRelated(decision, p) {
    return Object.assign(decision, { relatedCzId: Number(p.cz_solicitud_id) });
  }

  for (const p of others) {
    if (
      effective(p.s1_status, p.s1_lease_expires_at, nowMs) === S1.UNKNOWN ||
      (effective(p.s2_status, p.s2_lease_expires_at, nowMs) === S2.UNKNOWN && !closedInCz(p))
    ) {
      return withRelated(final(OUTCOME.MANUAL_REVIEW, REASONS.CI_PRIOR_UNKNOWN), p);
    }
  }
  for (const p of others) {
    if (p.s1_status === S1.IN_FLIGHT) return withRelated(waitUntil(p.s1_lease_expires_at), p);
    if (p.s2_status === S2.IN_FLIGHT) return withRelated(waitUntil(p.s2_lease_expires_at), p);
  }
  for (const p of others) {
    if (p.s2_status !== S2.REFERRED || closedInCz(p)) continue;
    return withRelated(
      final(OUTCOME.ALREADY_REFERRED, REASONS.CI_ACTIVE_REFERRAL, {
        referred_at: p.referred_at || null,
        provider_status: p.provider_status || null,
      }),
      p,
    );
  }
  for (const p of others) {
    if (p.s1_status === S1.ELIGIBLE && p.s2_status === S2.NOT_STARTED) {
      return withRelated(final(OUTCOME.MANUAL_REVIEW, REASONS.CI_OPEN_ELM_PROCESS), p);
    }
  }
  return { kind: 'proceed' };
}

/**
 * Orchestrator blocked codes where ELM was never called and the applicant data can never be
 * sent to ELM (the CDV rejection stands): definitive (DEFINITIVE_REJECTION_REASONS).
 */
const NOT_ELIGIBLE_CODES = Object.freeze([
  CODES.MISSING_REQUIRED_FIELDS,
  CODES.DATE_OF_BIRTH_INVALID,
  CODES.MOBILEPHONE_INVALID,
  CODES.SALARY_INVALID,
]);

/** Inconsistent data (not a rejection): solicitud missing, CDV granted it, CI changed. */
const MANUAL_REVIEW_CODES = Object.freeze([
  CODES.SOLICITUD_NOT_FOUND,
  CODES.CDV_GRANTED,
  CODES.CI_MISMATCH,
]);

/** JANUS configuration not confirmed with ELM yet: not an applicant rejection. */
const CONFIG_CODES = Object.freeze([
  CODES.ACTIVITY_TYPE_MAPPING_MISSING,
  CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED,
  CODES.MOBILEPHONE_FORMAT_UNCONFIRMED,
]);

/** Gates that run before any claim: proven that no external call started. */
const NOT_STARTED_CODES = Object.freeze([
  CODES.SEND_DISABLED,
  CODES.TRIGGER_ORIGIN_NOT_ENABLED,
  CODES.INVALID_CONTEXT,
  CODES.MANUAL_REQUIRES_USER,
]);

/** Process changed under us (another caller / stale read): reload and derive again. */
const RELOAD_CODES = Object.freeze([
  CODES.PROCESS_EXISTS,
  CODES.PROCESS_NOT_FOUND,
  CODES.S1_NOT_ELIGIBLE,
  CODES.S2_ALREADY_STARTED,
  CODES.S2_NOT_STARTABLE,
  CODES.LATE_RESULT_DISCARDED,
  CODES.RETRY_NOT_ALLOWED,
]);

/**
 * @param {{ code: string, blockers?: Array<{ code: string, fields?: string[] }>, lock?: object }} res
 * @returns {{ kind: 'final', outcome: string, reasonCode: string, detail: object|null }
 *   | { kind: 'wait', untilMs: null, relatedCzId: number|null }
 *   | { kind: 'not_started', code: string } | { kind: 'reload' } | { kind: 'persist_failed' }}
 */
function classifyBlocked(res) {
  const code = res && res.code;
  if (code === CODES.CI_LOCK_BLOCKED) {
    const d = decideCiLock(Object.assign({ status: 'blocked' }, res.lock || {}));
    return d.kind === 'proceed' ? { kind: 'reload' } : d;
  }
  const blockers = Array.isArray(res && res.blockers) && res.blockers.length
    ? res.blockers
    : [{ code: code }];
  const inconsistent = blockers.find(function (b) {
    return MANUAL_REVIEW_CODES.includes(b.code);
  });
  if (inconsistent) {
    return final(OUTCOME.MANUAL_REVIEW, inconsistent.code, { blockers: blockers });
  }
  const dataBlocker = blockers.find(function (b) {
    return NOT_ELIGIBLE_CODES.includes(b.code);
  });
  if (dataBlocker) {
    return final(OUTCOME.NOT_ELIGIBLE, dataBlocker.code, { blockers: blockers });
  }
  if (blockers.some(function (b) { return CONFIG_CODES.includes(b.code); })) {
    return final(OUTCOME.MANUAL_REVIEW, REASONS.ELM_CONFIG_INCOMPLETE, { blockers: blockers });
  }
  if (NOT_STARTED_CODES.includes(code)) return { kind: 'not_started', code: code };
  if (RELOAD_CODES.includes(code)) return { kind: 'reload' };
  if (code === CODES.PERSIST_FAILED) return { kind: 'persist_failed' };
  return final(OUTCOME.MANUAL_REVIEW, REASONS.UNEXPECTED_STATE, { code: code || null });
}

/**
 * Maps elm_ci_lock_acquire / a blocked elm_claim_process to a worker decision. Another solicitud
 * of the CI that was CDV rejected in the same month is never resent: active referral →
 * already_referred (15); closed evaluation this month → not_eligible (3).
 * @param {{ status: string, block?: string, related_cz_solicitud_id?: number|string|null,
 *   month_key?: string, detail?: string }} res
 * @returns {{ kind: 'proceed' } | { kind: 'wait', untilMs: null, relatedCzId: number|null }
 *   | { kind: 'final', outcome: string, reasonCode: string, detail: object|null, relatedCzId: number|null }}
 */
function decideCiLock(res) {
  const status = res && res.status;
  if (status === 'acquired' || status === 'held') return { kind: 'proceed' };
  const related = res && res.related_cz_solicitud_id != null ? Number(res.related_cz_solicitud_id) : null;
  function out(decision) {
    return Object.assign(decision, { relatedCzId: related });
  }
  if (status !== 'blocked') {
    return out(final(OUTCOME.MANUAL_REVIEW, REASONS.UNEXPECTED_STATE, { ci_lock_status: status || null }));
  }
  switch (res.block) {
    case CI_LOCK_BLOCK.SEND_IN_PROGRESS:
      return out({ kind: 'wait', untilMs: null });
    case CI_LOCK_BLOCK.ACTIVE_REFERRAL:
      return out(final(OUTCOME.ALREADY_REFERRED, REASONS.CI_ACTIVE_REFERRAL, { ci_lock: res.block }));
    case CI_LOCK_BLOCK.UNCERTAIN:
      return out(final(OUTCOME.MANUAL_REVIEW, REASONS.CI_PRIOR_UNKNOWN, { ci_lock: res.block }));
    case CI_LOCK_BLOCK.MONTHLY_QUOTA_USED:
      return out(final(OUTCOME.NOT_ELIGIBLE, REASONS.CI_MONTHLY_QUOTA_USED, {
        ci_lock: res.block,
        month_key: res.month_key || null,
      }));
    default:
      return out(final(OUTCOME.MANUAL_REVIEW, REASONS.UNEXPECTED_STATE, { ci_lock: res.block || null }));
  }
}

module.exports = {
  deriveFromProcess,
  technicalDecision,
  evaluateCiGuard,
  decideCiLock,
  classifyBlocked,
  NOT_ELIGIBLE_CODES,
  MANUAL_REVIEW_CODES,
  CONFIG_CODES,
  NOT_STARTED_CODES,
};
