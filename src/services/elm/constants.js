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
  INVALID_CZ_ID: 'elm_invalid_cz_id',
  INVALID_CONTEXT: 'elm_invalid_context',
  TRIGGER_ORIGIN_NOT_ENABLED: 'elm_trigger_origin_not_enabled',
  MANUAL_REQUIRES_USER: 'elm_manual_trigger_requires_user',
  SOLICITUD_NOT_FOUND: 'elm_solicitud_not_found',
  CDV_GRANTED: 'elm_cdv_granted',
  PROCESS_EXISTS: 'elm_process_exists',
  PROCESS_NOT_FOUND: 'elm_process_not_found',
  MISSING_REQUIRED_FIELDS: 'elm_missing_required_fields',
  ACTIVITY_TYPE_MAPPING_MISSING: 'elm_activity_type_mapping_missing',
  SOURCE_BRAND_INDETERMINATE: 'elm_source_brand_indeterminate',
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
  PERSIST_FAILED: 'elm_persist_failed',
  LATE_RESULT_DISCARDED: 'elm_late_result_discarded',
  LEASE_EXPIRED: 'elm_in_flight_lease_expired',
});

module.exports = {
  S1,
  S2,
  TRIGGER_ORIGINS,
  ENABLED_TRIGGER_ORIGINS,
  OUTCOME,
  CODES,
};
