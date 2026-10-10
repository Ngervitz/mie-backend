'use strict';

/**
 * Provider fallback (Fase 3A) constants.
 * Mirrors CHECK constraints in migrations/20261008_provider_fallback_requests.sql.
 */

const PROVIDER = 'elm';

const EXEC = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
});

const OUTCOME = Object.freeze({
  PENDING: 'pending',
  REFERRED: 'referred',
  ALREADY_REFERRED: 'already_referred',
  REJECTED: 'rejected',
  NOT_ELIGIBLE: 'not_eligible',
  MANUAL_REVIEW: 'manual_review',
});

const FINAL_OUTCOMES = Object.freeze([
  OUTCOME.REFERRED,
  OUTCOME.ALREADY_REFERRED,
  OUTCOME.REJECTED,
  OUTCOME.NOT_ELIGIBLE,
  OUTCOME.MANUAL_REVIEW,
]);

const DELIVERY = Object.freeze({
  NOT_READY: 'not_ready',
  PENDING: 'pending',
  ACKED: 'acked',
});

const ACK_STATUS = Object.freeze({
  ACKED: 'acked',
  ALREADY_ACKED: 'already_acked',
  NOT_FOUND: 'not_found',
  NOT_FINAL: 'not_final',
  OUTCOME_MISMATCH: 'outcome_mismatch',
});

/** reason_code values set by the worker (ELM eligibility codes are also used verbatim). */
const REASONS = Object.freeze({
  ELM_S1_REJECTED: 'elm_s1_rejected',
  ELM_S2_REJECTED: 'elm_s2_rejected',
  ELM_S2_REFERRED: 'elm_s2_referred',
  ELM_S1_UNKNOWN: 'elm_s1_unknown',
  ELM_S2_UNKNOWN: 'elm_s2_unknown',
  /** technical_error whose error code is not proven side-effect free → never resent. */
  ELM_S1_TECHNICAL_ERROR_RETRY_UNSAFE: 'elm_s1_technical_error_retry_unsafe',
  ELM_S2_TECHNICAL_ERROR_RETRY_UNSAFE: 'elm_s2_technical_error_retry_unsafe',
  ELM_S1_TECHNICAL_ERROR_RETRIES_EXHAUSTED: 'elm_s1_technical_error_retries_exhausted',
  ELM_S2_TECHNICAL_ERROR_RETRIES_EXHAUSTED: 'elm_s2_technical_error_retries_exhausted',
  ELM_CONFIG_INCOMPLETE: 'elm_config_incomplete',
  CI_PRIOR_UNKNOWN: 'ci_prior_unknown',
  /** Another solicitud of the CI has an unresolved S2 referral → already_referred, no send. */
  CI_ACTIVE_REFERRAL: 'ci_active_referral',
  CI_OPEN_ELM_PROCESS: 'ci_open_elm_process',
  /** C1: the CI already had an effective ELM send this calendar month (America/Montevideo). */
  CI_MONTHLY_QUOTA_USED: 'ci_monthly_quota_used',
  /** C1: second consecutive ELM "BCU error" (after the automatic 24 h retry) → manual review. */
  ELM_S1_BCU_ERROR_REPEATED: 'elm_s1_bcu_error_repeated',
  /** C1: ELM negative answer not confirmed as a definitive rejection (e.g. "Aprobado sin canal"). */
  ELM_S1_REJECTION_NOT_DEFINITIVE: 'elm_s1_rejection_not_definitive',
  ELM_S2_REJECTION_NOT_DEFINITIVE: 'elm_s2_rejection_not_definitive',
  /** S1 "Repetido. Aprobado": already approved by another ELM channel. Never a rejection (no CZ 3). */
  ELM_S1_DUPLICATE_OTHER_CHANNEL: 'elm_s1_duplicate_other_channel',
  /** C1: a rejected / not_eligible decision without a definitive reason (safety net). */
  REJECTION_NOT_CONFIRMED: 'rejection_not_confirmed',
  NOT_STARTED_EXHAUSTED: 'not_started_attempts_exhausted',
  UNEXPECTED_STATE: 'unexpected_state',
});

/** last_defer_reason values (prefix "not_started:" = proven that no external call started). */
const DEFER = Object.freeze({
  ELM_IN_FLIGHT: 'elm_in_flight',
  CI_OTHER_IN_FLIGHT: 'ci_other_in_flight',
  /** C1: another solicitud of the CI holds the monthly send reservation. */
  CI_SEND_IN_PROGRESS: 'ci_send_in_progress',
  TECHNICAL_RETRY_BACKOFF: 'elm_technical_retry_backoff',
  PERSIST_FAILED: 'elm_persist_failed',
  WORKER_ERROR: 'worker_error',
  LOOP_LIMIT: 'loop_limit',
  NOT_STARTED_PREFIX: 'not_started:',
});

/** Mirrors provider_review_cases.priority (migrations/20261009_elm_phase3b_operations.sql). */
const REVIEW_PRIORITIES = Object.freeze(['urgent', 'high', 'normal', 'low']);

/**
 * C1 CZ estados (migrations/20261010_provider_fallback_c1_events.sql). Proposed ids: they do
 * NOT exist yet in Credizona (Constantes::EstadosSolicitud / solicitudes_estados stop at 11).
 */
const CZ_ESTADO = Object.freeze({
  REJECTED: 3,
  EVALUATING: 12,
  REFERRED_TO_SALES: 13,
  MANUAL_REVIEW: 14,
  REFERRAL_IN_OTHER_SOLICITUD: 15,
  CONVERTED: 16,
});

/** provider_cz_events.event_type */
const CZ_EVENT_TYPES = Object.freeze([
  'outcome',
  'late.rejected',
  'late.granted',
  'review.resolved',
  'referral.resolved',
]);

/** provider_cz_event_ack p_result */
const CZ_ACK_RESULTS = Object.freeze(['applied', 'not_applied', 'ignored']);

/** provider_review_resolve p_cz_outcome */
const REVIEW_CZ_OUTCOMES = Object.freeze(['referred', 'rejected', 'granted', 'none']);

/** elm_resolve_process p_cz_outcome (active referral projected 13 → 3 / 16) */
const PROCESS_CZ_OUTCOMES = Object.freeze(['rejected', 'granted', 'none']);

/**
 * Mirrors provider_fallback_definitive_rejection_reasons() (C1): the only reasons that may end
 * as rejected / not_eligible (CZ estado 3). Anything else goes to manual_review.
 */
const DEFINITIVE_REJECTION_REASONS = Object.freeze([
  'elm_s1_rejected',
  'elm_s2_rejected',
  'ci_monthly_quota_used',
  'elm_missing_required_fields',
  'elm_date_of_birth_invalid',
  'elm_mobilephone_invalid',
  'elm_salary_invalid',
]);

/** ELM Servicio 2 negative texts that are a definitive rejection (invalid applicant data). */
const DEFINITIVE_S2_REJECTION_RESULTS = Object.freeze(['Telefono no válido', 'Documento no válido']);

/**
 * ELM S1 "BCU error" (client.js SERVICE1_TECHNICAL → elm_provider_bcu_error). Fixed policy,
 * mirrored by elm_retry_step: one automatic retry of the same request 24 h after the error.
 */
const BCU_RETRY = Object.freeze({
  errorCode: 'elm_provider_bcu_error',
  delaySeconds: 24 * 3600,
  maxAttempts: 2,
});

/** elm_ci_lock_acquire / elm_claim_process blocked kinds */
const CI_LOCK_BLOCK = Object.freeze({
  ACTIVE_REFERRAL: 'active_referral',
  UNCERTAIN: 'uncertain',
  SEND_IN_PROGRESS: 'send_in_progress',
  MONTHLY_QUOTA_USED: 'monthly_quota_used',
});

module.exports = {
  CZ_ESTADO,
  CZ_EVENT_TYPES,
  CZ_ACK_RESULTS,
  REVIEW_CZ_OUTCOMES,
  PROCESS_CZ_OUTCOMES,
  DEFINITIVE_REJECTION_REASONS,
  DEFINITIVE_S2_REJECTION_RESULTS,
  BCU_RETRY,
  CI_LOCK_BLOCK,
  PROVIDER,
  EXEC,
  OUTCOME,
  FINAL_OUTCOMES,
  DELIVERY,
  ACK_STATUS,
  REASONS,
  DEFER,
  REVIEW_PRIORITIES,
};
