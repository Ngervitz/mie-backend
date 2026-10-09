'use strict';

/**
 * ELM (Préstamos En La Mano / MANDAZY) shared constants.
 * Mirrors CHECK constraints in migrations/20261007_elm_lead_processes.sql.
 *
 * S1 eligible ≠ referred. S2 referred = handed to ELM sales; ≠ granted, ≠ disbursed.
 */

const S1 = Object.freeze({
  NOT_STARTED: 'not_started',
  IN_FLIGHT: 'in_flight',
  ELIGIBLE: 'eligible',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown',
  TECHNICAL_ERROR: 'technical_error',
});

const S2 = Object.freeze({
  NOT_STARTED: 'not_started',
  IN_FLIGHT: 'in_flight',
  REFERRED: 'referred',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown',
  TECHNICAL_ERROR: 'technical_error',
});

const TRIGGER_ORIGINS = Object.freeze([
  'janus_manual',
  'janus_batch',
  'cz_automatic',
]);

/** Only janus_manual is wired in Fase 1A. */
const ENABLED_TRIGGER_ORIGINS = Object.freeze(['janus_manual']);

/**
 * Value sent as `source` in S1 and S2 for every lead (decision Fase 3B). The commercial origin
 * of the lead (SMS base / organic) is tracked separately in elm_lead_processes.commercial_origin
 * and never sent. Real sends stay disabled until ELM confirms this value.
 */
const ELM_SOURCE = 'copanel';

/** Normalized outcome returned by an ELM client call (transport-agnostic). */
const OUTCOME = Object.freeze({
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
  UNKNOWN: 'unknown',
  TECHNICAL_ERROR: 'technical_error',
  NOT_SENT: 'not_sent',
});

const CODES = Object.freeze({
  SEND_DISABLED: 'elm_send_disabled',
  TRANSPORT_NOT_IMPLEMENTED: 'elm_transport_not_implemented',
  CLIENT_DISABLED: 'elm_client_disabled',
  TRANSPORT_CONFIG_INCOMPLETE: 'elm_transport_config_incomplete',
  HTTP_TIMEOUT: 'elm_http_timeout',
  TRANSPORT_ERROR: 'elm_transport_error',
  HTTP_AUTH_REJECTED: 'elm_http_auth_rejected',
  HTTP_ERROR: 'elm_http_error',
  RESPONSE_READ_FAILED: 'elm_response_read_failed',
  RESPONSE_UNPARSEABLE: 'elm_response_unparseable',
  RESPONSE_UNDOCUMENTED: 'elm_response_undocumented',
  INVALID_CZ_ID: 'elm_invalid_cz_id',
  INVALID_CONTEXT: 'elm_invalid_context',
  TRIGGER_ORIGIN_NOT_ENABLED: 'elm_trigger_origin_not_enabled',
  MANUAL_REQUIRES_USER: 'elm_manual_trigger_requires_user',
  SOLICITUD_NOT_FOUND: 'elm_solicitud_not_found',
  CDV_GRANTED: 'elm_cdv_granted',
  PROCESS_EXISTS: 'elm_process_exists',
  /** elm_claim_process refused the CI lock (monthly quota, active referral, send in progress...). */
  CI_LOCK_BLOCKED: 'elm_ci_lock_blocked',
  PROCESS_NOT_FOUND: 'elm_process_not_found',
  MISSING_REQUIRED_FIELDS: 'elm_missing_required_fields',
  ACTIVITY_TYPE_MAPPING_MISSING: 'elm_activity_type_mapping_missing',
  DATE_OF_BIRTH_FORMAT_UNCONFIRMED: 'elm_date_of_birth_format_unconfirmed',
  DATE_OF_BIRTH_INVALID: 'elm_date_of_birth_invalid',
  MOBILEPHONE_FORMAT_UNCONFIRMED: 'elm_mobilephone_format_unconfirmed',
  MOBILEPHONE_INVALID: 'elm_mobilephone_invalid',
  SALARY_INVALID: 'elm_salary_invalid',
  S1_NOT_ELIGIBLE: 'elm_s1_not_eligible',
  S2_ALREADY_STARTED: 'elm_s2_already_started',
  S2_NOT_STARTABLE: 'elm_s2_not_startable',
  CI_MISMATCH: 'elm_ci_mismatch',
  CLIENT_THREW: 'elm_client_threw',
  PROVIDER_BCU_ERROR: 'elm_provider_bcu_error',
  RETRY_NOT_ALLOWED: 'elm_retry_not_allowed',
  /** Manual retry (elm_manual_retry_s1): the attempt count changed since the operator saw it. */
  RETRY_STALE: 'elm_retry_stale',
  /** Manual retry: ELM may have received the lead (or S1 is not a pre-reception failure). */
  RETRY_NOT_PRE_RECEPTION: 'elm_retry_not_pre_reception',
  RETRY_ATTEMPTS_EXHAUSTED: 'elm_retry_attempts_exhausted',
  PERSIST_FAILED: 'elm_persist_failed',
  LATE_RESULT_DISCARDED: 'elm_late_result_discarded',
  LEASE_EXPIRED: 'elm_in_flight_lease_expired',
  POSTBACK_AUTH_NOT_CONFIGURED: 'elm_postback_auth_not_configured',
  POSTBACK_UNAUTHORIZED: 'elm_postback_unauthorized',
  POSTBACK_BODY_INVALID: 'elm_postback_body_invalid',
  POSTBACK_BODY_TOO_LARGE: 'elm_postback_body_too_large',
  POSTBACK_STATUS_MISSING: 'elm_postback_status_missing',
  POSTBACK_STATUS_UNKNOWN: 'elm_postback_status_unknown',
  POSTBACK_CZ_ID_INVALID: 'elm_postback_cz_id_invalid',
  POSTBACK_UNDOCUMENTED_FIELD: 'elm_postback_undocumented_field',
  POSTBACK_CI_INVALID: 'elm_postback_ci_invalid',
  POSTBACK_EVENT_AT_INVALID: 'elm_postback_event_at_invalid',
  POSTBACK_CZ_ID_MISSING: 'elm_postback_cz_id_missing',
  POSTBACK_CZ_ID_NOT_FOUND: 'elm_postback_cz_id_not_found',
  POSTBACK_CI_MISMATCH: 'elm_postback_ci_mismatch',
  POSTBACK_PROCESS_NOT_COMPATIBLE: 'elm_postback_process_not_compatible',
  POSTBACK_PERSIST_FAILED: 'elm_postback_persist_failed',
});

/**
 * Mirrors public.elm_pre_reception_error_codes() and the HTTP check of elm_manual_retry_s1
 * (NetSuite rejected the authentication before the RESTlet ran). Display only: the DB decides.
 */
const PRE_RECEPTION_ERROR_CODES = Object.freeze([CODES.HTTP_AUTH_REJECTED]);
const PRE_RECEPTION_HTTP_STATUSES = Object.freeze([401, 403]);

/** Mirrors elm_postback_events.processing_status (migrations/20261007_elm_postback_events.sql). */
const POSTBACK_PROCESSING = Object.freeze({
  RECEIVED: 'received',
  APPLIED: 'applied',
  STALE: 'stale',
  IGNORED_GRANTED: 'ignored_granted',
  UNMATCHED: 'unmatched',
  INVALID: 'invalid',
});

/** Only exact cz_solicitud_id matches. CI is an audit control, never a matching method. */
const MATCH_METHODS = Object.freeze({
  CZ_SOLICITUD_ID: 'cz_solicitud_id',
});

module.exports = {
  S1,
  S2,
  TRIGGER_ORIGINS,
  ENABLED_TRIGGER_ORIGINS,
  ELM_SOURCE,
  OUTCOME,
  CODES,
  PRE_RECEPTION_ERROR_CODES,
  PRE_RECEPTION_HTTP_STATUSES,
  POSTBACK_PROCESSING,
  MATCH_METHODS,
};
