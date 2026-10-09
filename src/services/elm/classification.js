'use strict';

/**
 * Commercial reading of one elm_lead_processes row (read-only, pure).
 *
 * Technical states stay as persisted (s1_status / s2_status / referred / disbursed_at); this
 * module only derives the label dashboards, KPIs and surveys use:
 *
 *   granted        disbursed_at (postback "Convertido" or audited provider_loan_disbursed)
 *   rejected       definitive evidence only: S1 answer in SERVICE1_NEGATIVE, S2 answer in
 *                  DEFINITIVE_S2_REJECTION_RESULTS, a post-referral postback status configured in
 *                  ELM_POST_REFERRAL_REJECTION_STATUSES, ops provider_closed_no_loan, or CZ 3
 *                  projected for an automatic process
 *   referred       S2 referred ("Preaprobado ELM": derivado a ventas, NOT a granted loan)
 *   in_evaluation  S1 in flight, S1 favorable waiting for S2, S2 in flight
 *   review         unknown / technical_error / negative answer not confirmed as definitive
 *   closed         ops closure that is neither a rejection nor a loan (withdrew, not received...)
 *
 * Unknown answers and unconfigured postback statuses never become a rejection (fail safe).
 */

const { S1, S2 } = require('./constants');
const { SERVICE1_NEGATIVE } = require('./client');
const { normalizeProviderStatus } = require('./providerStatus');
const { DEFINITIVE_S2_REJECTION_RESULTS } = require('../providerFallback/constants');

const COMMERCIAL = Object.freeze({
  IN_EVALUATION: 'in_evaluation',
  REFERRED: 'referred',
  GRANTED: 'granted',
  REJECTED: 'rejected',
  REVIEW: 'review',
  CLOSED: 'closed',
});

const COMMERCIAL_LABELS = Object.freeze({
  in_evaluation: 'En evaluación ELM',
  referred: 'Preaprobado ELM',
  granted: 'Otorgado ELM',
  rejected: 'Rechazado ELM',
  review: 'Pendiente de revisión ELM',
  closed: 'Cerrado ELM sin préstamo',
});

const DETAIL_LABELS = Object.freeze({
  disbursed: 'Otorgado ELM',
  cz_granted: 'Otorgado ELM',
  s2_referred: 'Preaprobado ELM (derivado a ventas)',
  cz_referred: 'Preaprobado ELM (derivado a ventas)',
  s1_negative: 'Rechazado ELM (S1)',
  s2_definitive: 'Rechazado ELM (S2)',
  post_referral_status: 'Rechazado ELM (posterior a la derivación)',
  ops_closed_no_loan: 'Rechazado ELM (cerrado sin préstamo)',
  cz_rejected: 'Rechazado ELM',
  s1_in_flight: 'En evaluación ELM (S1 en curso)',
  s1_eligible_pending_s2: 'En evaluación ELM (S1 favorable, S2 pendiente)',
  s2_in_flight: 'En evaluación ELM (S2 en curso)',
  not_started: 'En evaluación ELM',
  cz_evaluating: 'En evaluación ELM',
  s1_unknown: 'Resultado incierto ELM (S1)',
  s2_unknown: 'Resultado incierto ELM (S2)',
  s1_technical_error: 'Error técnico ELM (S1)',
  s2_technical_error: 'Error técnico ELM (S2)',
  s1_rejection_not_definitive: 'Respuesta negativa ELM (S1) sin confirmar',
  s2_rejection_not_definitive: 'Respuesta negativa ELM (S2) sin confirmar',
  cz_review: 'Pendiente de revisión ELM',
  ops_customer_withdrew: 'Cerrado ELM: el cliente desistió',
  ops_provider_confirmed_not_received: 'Cerrado ELM: ELM no recibió el lead',
  ops_provider_confirmed_no_referral: 'Cerrado ELM: sin derivación',
  ops_other: 'Cerrado ELM (ver nota)',
  cz_already_referred: 'Derivación vigente en otra solicitud',
});

/**
 * Automatic processes: the estado JANUS projects to CZ completes the process reading. It may lag
 * a later postback, so it never downgrades a grant, and 13/15 only settle open readings.
 */
const STATE_BY_PROJECTED_ESTADO = Object.freeze({
  3: { state: COMMERCIAL.REJECTED, detail: 'cz_rejected' },
  13: { state: COMMERCIAL.REFERRED, detail: 'cz_referred' },
  15: { state: COMMERCIAL.CLOSED, detail: 'cz_already_referred' },
  16: { state: COMMERCIAL.GRANTED, detail: 'cz_granted' },
});

function isExpired(leaseIso, nowMs) {
  if (!leaseIso) return false;
  const t = Date.parse(String(leaseIso));
  return Number.isFinite(t) && t < nowMs;
}

function effective(status, leaseIso, nowMs) {
  return status === 'in_flight' && isExpired(leaseIso, nowMs) ? 'unknown' : status;
}

function textIn(list, raw) {
  return typeof raw === 'string' && list.includes(raw.trim());
}

function result(state, detail, stage) {
  return {
    state: state,
    label: COMMERCIAL_LABELS[state],
    detail: detail,
    detail_label: DETAIL_LABELS[detail] || COMMERCIAL_LABELS[state],
    stage: stage || null,
  };
}

/** Classification from the process row alone. */
function fromProcess(p, opts) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const postReferral = Array.isArray(opts.postReferralRejectionStatuses)
    ? opts.postReferralRejectionStatuses
    : [];

  if (p.disbursed_at) return result(COMMERCIAL.GRANTED, 'disbursed', 'post_referral');

  if (p.ops_resolved_at) {
    if (p.ops_resolution_code === 'provider_closed_no_loan') {
      return result(COMMERCIAL.REJECTED, 'ops_closed_no_loan', 'post_referral');
    }
    const detail = 'ops_' + String(p.ops_resolution_code || 'other');
    return result(COMMERCIAL.CLOSED, DETAIL_LABELS[detail] ? detail : 'ops_other', null);
  }

  const s1 = effective(p.s1_status, p.s1_lease_expires_at, nowMs);
  const s2 = effective(p.s2_status, p.s2_lease_expires_at, nowMs);

  if (s2 === S2.REFERRED) {
    const norm = normalizeProviderStatus(p.provider_status);
    if (norm && postReferral.includes(norm)) {
      return result(COMMERCIAL.REJECTED, 'post_referral_status', 'post_referral');
    }
    return result(COMMERCIAL.REFERRED, 's2_referred', 's2');
  }
  if (s2 === S2.REJECTED) {
    return textIn(DEFINITIVE_S2_REJECTION_RESULTS, p.s2_result_message)
      ? result(COMMERCIAL.REJECTED, 's2_definitive', 's2')
      : result(COMMERCIAL.REVIEW, 's2_rejection_not_definitive', 's2');
  }
  if (s2 === S2.UNKNOWN) return result(COMMERCIAL.REVIEW, 's2_unknown', 's2');
  if (s2 === S2.TECHNICAL_ERROR) return result(COMMERCIAL.REVIEW, 's2_technical_error', 's2');
  if (s2 === S2.IN_FLIGHT) return result(COMMERCIAL.IN_EVALUATION, 's2_in_flight', 's2');

  if (s1 === S1.REJECTED) {
    return textIn(SERVICE1_NEGATIVE, p.s1_result_message)
      ? result(COMMERCIAL.REJECTED, 's1_negative', 's1')
      : result(COMMERCIAL.REVIEW, 's1_rejection_not_definitive', 's1');
  }
  if (s1 === S1.UNKNOWN) return result(COMMERCIAL.REVIEW, 's1_unknown', 's1');
  if (s1 === S1.TECHNICAL_ERROR) return result(COMMERCIAL.REVIEW, 's1_technical_error', 's1');
  if (s1 === S1.IN_FLIGHT) return result(COMMERCIAL.IN_EVALUATION, 's1_in_flight', 's1');
  if (s1 === S1.ELIGIBLE) return result(COMMERCIAL.IN_EVALUATION, 's1_eligible_pending_s2', 's1');
  if (s1 === S1.NOT_STARTED) return result(COMMERCIAL.IN_EVALUATION, 'not_started', null);
  return result(COMMERCIAL.REVIEW, 's1_unknown', 's1');
}

/**
 * @param {object} p elm_lead_processes row (list projection is enough)
 * @param {{
 *   nowMs?: number,
 *   postReferralRejectionStatuses?: readonly string[],  normalized (providerFallback config)
 *   projectedEstado?: number|null,                       provider_cz_state for cz_automatic
 * }} [options]
 */
function classifyElmProcess(p, options) {
  if (!p) return null;
  const opts = options || {};
  const base = fromProcess(p, opts);
  const projected = Number(opts.projectedEstado);
  const cz = p.trigger_origin === 'cz_automatic' ? STATE_BY_PROJECTED_ESTADO[projected] : null;
  if (!cz || cz.state === base.state || base.state === COMMERCIAL.GRANTED) return base;
  const open = base.state === COMMERCIAL.IN_EVALUATION || base.state === COMMERCIAL.REVIEW;
  if (cz.state === COMMERCIAL.GRANTED || cz.state === COMMERCIAL.REJECTED || open) {
    return result(cz.state, cz.detail, base.stage);
  }
  return base;
}

/** True when a survey invite must wait (or never happen) because of this ELM process. */
function blocksSurveyInvite(classification) {
  if (!classification) return false;
  return (
    classification.state !== COMMERCIAL.REJECTED && classification.state !== COMMERCIAL.CLOSED
  );
}

function readPostReferralRejectionStatuses() {
  try {
    return require('../providerFallback/config').readProviderFallbackConfig()
      .postReferralRejectionStatuses;
  } catch (_) {
    return [];
  }
}

module.exports = {
  COMMERCIAL,
  COMMERCIAL_LABELS,
  DETAIL_LABELS,
  STATE_BY_PROJECTED_ESTADO,
  classifyElmProcess,
  blocksSurveyInvite,
  readPostReferralRejectionStatuses,
};
