'use strict';

/**
 * Stage B: S1 unknown is not one situation. `unknown` never means «ELM did not receive».
 *
 *   definitive_reject  documented S1 commercial rejection (SERVICE1_NEGATIVE), possibly stored
 *                      as unknown / undocumented.
 *   tech_not_processed S1 failed before the RESTlet ran (401/403 + auth-rejected). Proven
 *                      not received. Existing retry (elm_manual_retry_s1) only for janus_manual.
 *   uncertain          timeout, lost/unparseable body, undocumented text, received technical
 *                      error. ELM may have processed it. No resend until reconciled.
 *   pre_send_block     nothing left the process (config, CI lock, other-solicitud blocker).
 */

const { S1, S2, PRE_RECEPTION_ERROR_CODES, PRE_RECEPTION_HTTP_STATUSES } = require('../elm/constants');
const { isService1Negative } = require('../elm/client');

const S1_SUBCLASS = Object.freeze({
  DEFINITIVE_REJECT: 'definitive_reject',
  TECH_NOT_PROCESSED: 'tech_not_processed',
  UNCERTAIN: 'uncertain',
  PRE_SEND_BLOCK: 'pre_send_block',
});

const S1_SUBCLASS_LABELS = Object.freeze({
  definitive_reject: 'Rechazo comercial definitivo de ELM',
  tech_not_processed: 'Error técnico: ELM no llegó a procesar',
  uncertain: 'Requiere conciliación con ELM',
  pre_send_block: 'Bloqueo previo al envío',
});

const PRE_SEND_REASONS = Object.freeze([
  'elm_config_incomplete',
  'ci_prior_unknown',
  'ci_open_elm_process',
  'ci_active_referral',
  'ci_monthly_quota_used',
  'not_started_attempts_exhausted',
]);

const S1_UNKNOWN_REASONS = Object.freeze([
  'elm_s1_unknown',
  'elm_s1_technical_error_retry_unsafe',
  'elm_s1_technical_error_retries_exhausted',
  'elm_s1_rejection_not_definitive',
  'elm_response_undocumented',
  'elm_http_timeout',
]);

function isPreReceptionFailure(input) {
  const src = input || {};
  return (
    src.s1_status === S1.TECHNICAL_ERROR &&
    PRE_RECEPTION_ERROR_CODES.indexOf(src.s1_error_code) !== -1 &&
    PRE_RECEPTION_HTTP_STATUSES.indexOf(Number(src.s1_http_status)) !== -1 &&
    (src.s2_status === S2.NOT_STARTED || !src.s2_status) &&
    !src.ops_resolved_at
  );
}

function existingRetryApplies(input) {
  return isPreReceptionFailure(input) && srcTrigger(input) !== 'cz_automatic';
}

function srcTrigger(input) {
  return input && input.trigger_origin ? String(input.trigger_origin) : null;
}

function isS1UnknownLike(input) {
  const src = input || {};
  const reason = src.reason_code || null;
  const s1 = src.s1_status || null;
  if (PRE_SEND_REASONS.indexOf(reason) !== -1) return true;
  if (S1_UNKNOWN_REASONS.indexOf(reason) !== -1) return true;
  return s1 === S1.UNKNOWN || s1 === S1.TECHNICAL_ERROR;
}

function classifyS1Unknown(input) {
  const src = input || {};
  const reason = src.reason_code || null;
  if (PRE_SEND_REASONS.indexOf(reason) !== -1) return S1_SUBCLASS.PRE_SEND_BLOCK;
  if (isService1Negative(src.s1_result_message)) return S1_SUBCLASS.DEFINITIVE_REJECT;
  if (isPreReceptionFailure(src)) return S1_SUBCLASS.TECH_NOT_PROCESSED;
  if (src.s1_status === S1.NOT_STARTED && !src.s1_started_at) return S1_SUBCLASS.PRE_SEND_BLOCK;
  return S1_SUBCLASS.UNCERTAIN;
}

function projectedEstadoOf(input) {
  const n = Number(input && input.projected_estado);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function reviewVersionOf(input) {
  const n = Number(input && input.review_version);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function s1AttemptsOf(input) {
  const n = Number(input && input.s1_attempts);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Only the actions that are safe for this solicitud. Empty for uncertain / pre-send.
 * Retry is offered only when the existing elm_manual_retry_s1 path applies.
 * Close is offered only with definitive S1 text and an open review case in CZ 14.
 */
function actionsForS1Unknown(input) {
  const src = input || {};
  const subclass = classifyS1Unknown(src);
  const actions = [];
  if (subclass === S1_SUBCLASS.DEFINITIVE_REJECT) {
    const reviewId = src.review_id || null;
    const version = reviewVersionOf(src);
    const projected = projectedEstadoOf(src);
    if (reviewId && version != null && projected === 14) {
      actions.push({
        id: 'close_reject',
        label: 'Cerrar como rechazado',
        explanation:
          'Registra en Credizona el rechazo comercial definitivo que ELM ya respondió (' +
          String(src.s1_result_message).trim() +
          '). Pasa la solicitud de revisión (14) a rechazado (3). No llama a ELM ni reenvía.',
        requires_confirm: true,
        requires_note: true,
        review_id: reviewId,
        expected_version: version,
        process_id: src.process_id || src.elm_process_id || null,
        expected_updated_at: src.process_updated_at || src.version || null,
      });
    }
  } else if (subclass === S1_SUBCLASS.TECH_NOT_PROCESSED && existingRetryApplies(src)) {
    const attempts = s1AttemptsOf(src);
    if (attempts != null) {
      actions.push({
        id: 'retry_s1',
        label: 'Reintentar S1',
        explanation:
          'Reenvía el mismo paso 1 del proceso existente. ELM rechazó la autenticación ' +
          '(HTTP ' +
          String(src.s1_http_status) +
          ') antes de ejecutar el RESTlet, así que no recibió la solicitud. ' +
          'No crea otra solicitud. Respeta bloqueos de CI, idempotencia y el conteo de intentos.',
        requires_confirm: true,
        requires_note: false,
        process_id: src.process_id || src.elm_process_id || null,
        expected_attempts: attempts,
      });
    }
  }
  return {
    subclass: subclass,
    subclass_label: S1_SUBCLASS_LABELS[subclass],
    actions: actions,
  };
}

module.exports = {
  S1_SUBCLASS,
  S1_SUBCLASS_LABELS,
  PRE_SEND_REASONS,
  isS1UnknownLike,
  isPreReceptionFailure,
  existingRetryApplies,
  classifyS1Unknown,
  actionsForS1Unknown,
};
