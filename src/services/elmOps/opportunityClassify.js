'use strict';

/**
 * Commercial labels for the C1/ELM opportunities table (stage A, read-only).
 * Operators never see s1_status / unknown / worker_error as the primary text.
 * Technical fields stay on the item for the detail drawer.
 */

const {
  S1_SUBCLASS,
  S1_SUBCLASS_LABELS,
  isS1UnknownLike,
  classifyS1Unknown,
  actionsForS1Unknown,
} = require('./s1UnknownClassify');

const SITUATIONS = Object.freeze({
  COMPLETE_SEND: 'complete_send',
  CLOSE_REJECT: 'close_reject',
  RECONCILE: 'reconcile',
  TECH_NOT_PROCESSED: 'tech_not_processed',
  NEEDS_DATA: 'needs_data',
  WAITING_OTHER: 'waiting_other',
  IN_EVALUATION: 'in_evaluation',
  FOLLOWUP: 'followup',
  GRANTED: 'granted',
  RECOVERABLE: 'recoverable',
});

const SITUATION_LABELS = Object.freeze({
  complete_send: 'Completar envío a ELM',
  close_reject: 'Cerrar rechazo ELM',
  reconcile: 'Requiere conciliación con ELM',
  tech_not_processed: 'Error técnico no procesado',
  needs_data: 'Requiere datos',
  waiting_other: 'Esperando otra solicitud',
  in_evaluation: 'En evaluación',
  followup: 'En seguimiento comercial',
  granted: 'Préstamo otorgado',
  recoverable: 'Recuperable',
});

const NEXT_STEP_LABELS = Object.freeze({
  retry_s2: 'Reenviar paso 2',
  admin_provider_resend: 'Reenvío completo S1+S2 (autorizado ELM)',
  resume_s2: 'Enviar paso 2 (después de corregir el celular)',
  close_reject: 'Cerrar como rechazo ELM',
  retry_s1: 'Reintentar el mismo paso 1',
  reconcile: 'Conciliar con ELM · sin reenvío',
  wait_data: 'Completar datos · sin envío',
  wait_other: 'Ver la otra solicitud de esta CI',
  wait_eval: 'Esperar evaluación',
  followup: 'Consultar seguimiento',
  granted: 'Ver otorgamiento',
  none: 'Ver detalle',
});

/**
 * Deploy of C1 classification + cellphone SQL (20261016183202). Cases older than
 * this are «pendientes históricos»; newer ones are «posteriores a correcciones».
 * The cutover is a label only: it does not mean later errors are resolved.
 */
const CORRECTION_CUTOVER_AT = '2026-10-16T18:32:02.000Z';
const CORRECTION_CUTOVER_MS = Date.parse(CORRECTION_CUTOVER_AT);

/** UX flag for the transitory Gestión ELM tab. APIs stay if this is false. */
const GESTION_TAB_ENABLED = true;

const VINTAGE = Object.freeze({
  HISTORICAL: 'historical',
  POST_CORRECTION: 'post_correction',
});

const VINTAGE_LABELS = Object.freeze({
  historical: 'Pendiente histórico',
  post_correction: 'Posterior a correcciones',
});

const LANES = Object.freeze({
  ATTENTION: 'attention',
  FOLLOWUP: 'followup',
});

const LANE_LABELS = Object.freeze({
  attention: 'Requiere gestión',
  followup: 'Seguimiento (no es un error)',
});

const REASON_LABELS = Object.freeze({
  elm_s2_unknown: 'El paso 1 llegó a ELM; el paso 2 no quedó registrado',
  elm_s2_technical_error_retry_unsafe: 'El paso 2 falló por un error técnico de ELM',
  elm_s2_technical_error_retries_exhausted: 'El paso 2 agotó los reintentos técnicos',
  elm_s1_unknown: 'Resultado S1 no clasificado de forma segura: no se asume que ELM no recibió',
  definitive_reject: 'ELM respondió un rechazo comercial definitivo',
  tech_not_processed: 'El envío S1 falló antes de que ELM ejecutara el RESTlet',
  uncertain: 'No sabemos si ELM recibió o procesó la solicitud',
  pre_send_block: 'El envío no salió: hay un bloqueo previo',
  elm_config_incomplete: 'Falta el tipo de actividad laboral (OTR) para armar el envío',
  ci_prior_unknown: 'Otra solicitud de la misma persona bloquea este envío',
  elm_mobilephone_invalid: 'ELM ya tiene el paso 1; el celular local es inválido y el paso 2 no salió',
  elm_mobilephone_needs_correction: 'Hay que corregir el celular antes de enviar el paso 2',
  queued: 'La solicitud está en cola del envío automático',
  in_evaluation: 'ELM todavía está evaluando',
  referred: 'Derivada a ELM · seguimiento comercial',
  granted: 'ELM informó el préstamo otorgado',
});

function floorHours(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function situationLabel(id) {
  return SITUATION_LABELS[id] || 'Seguimiento ELM';
}

function nextStepLabel(key) {
  return NEXT_STEP_LABELS[key] || NEXT_STEP_LABELS.none;
}

function reasonLabel(code) {
  return REASON_LABELS[code] || null;
}

function vintageOf(since) {
  const t = Date.parse(String(since || ''));
  if (!Number.isFinite(t) || t < CORRECTION_CUTOVER_MS) return VINTAGE.HISTORICAL;
  return VINTAGE.POST_CORRECTION;
}

function laneOf(situation) {
  if (situation === SITUATIONS.FOLLOWUP || situation === SITUATIONS.GRANTED) {
    return LANES.FOLLOWUP;
  }
  return LANES.ATTENTION;
}

function lastElmText(input) {
  if (input.granted_elm) return input.provider_status || 'Otorgado ELM';
  if (input.s2_result_message) return String(input.s2_result_message);
  if (input.s1_result_message) return String(input.s1_result_message);
  if (input.provider_status) return String(input.provider_status);
  if (input.followup_label) return String(input.followup_label);
  if (input.last_event && input.last_event.status) return String(input.last_event.status);
  if (input.last_event && input.last_event.type) return String(input.last_event.type);
  return '—';
}

/**
 * @param {object} input merged bag from followup / review / referral / recoverable reads
 * @returns {object} operator row
 */
function classifyOpportunity(input) {
  const src = input || {};
  const s1 = src.s1_status || null;
  const s2 = src.s2_status || null;
  const reason = src.reason_code || null;
  const projected = src.projected_estado != null ? Number(src.projected_estado) : null;
  let situation = SITUATIONS.IN_EVALUATION;
  let nextKey = 'wait_eval';
  let motiveCode = reason || src.followup_kind || 'in_evaluation';

  if (src.recoverable === true) {
    situation = SITUATIONS.RECOVERABLE;
    nextKey = 'resume_s2';
    motiveCode = reason || 'elm_mobilephone_invalid';
  } else if (src.granted_elm === true) {
    situation = SITUATIONS.GRANTED;
    nextKey = 'granted';
    motiveCode = 'granted';
  } else if (projected === 13 || s2 === 'referred' || src.followup_kind === 'referred') {
    situation = SITUATIONS.FOLLOWUP;
    nextKey = 'followup';
    motiveCode = 'referred';
  } else if (
    s1 === 'eligible' &&
    (s2 === 'unknown' || reason === 'elm_s2_unknown')
  ) {
    situation = SITUATIONS.COMPLETE_SEND;
    nextKey = 'admin_provider_resend';
    motiveCode = reason || 'elm_s2_unknown';
  } else if (
    s1 === 'eligible' &&
    (s2 === 'technical_error' || (reason && String(reason).indexOf('elm_s2_technical') === 0))
  ) {
    situation = SITUATIONS.COMPLETE_SEND;
    nextKey = 'retry_s2';
    motiveCode = reason || 'elm_s2_technical_error_retry_unsafe';
  } else if (reason === 'ci_prior_unknown') {
    situation = SITUATIONS.WAITING_OTHER;
    nextKey = 'wait_other';
  } else if (reason === 'elm_config_incomplete') {
    situation = SITUATIONS.NEEDS_DATA;
    nextKey = 'wait_data';
  } else if (isS1UnknownLike(src) || (s1 === 'unknown' && (s2 === 'not_started' || !s2))) {
    const sub = classifyS1Unknown(src);
    if (sub === S1_SUBCLASS.DEFINITIVE_REJECT) {
      situation = SITUATIONS.CLOSE_REJECT;
      nextKey = 'close_reject';
      motiveCode = 'definitive_reject';
    } else if (sub === S1_SUBCLASS.TECH_NOT_PROCESSED) {
      situation = SITUATIONS.TECH_NOT_PROCESSED;
      nextKey = 'retry_s1';
      motiveCode = 'tech_not_processed';
    } else if (sub === S1_SUBCLASS.PRE_SEND_BLOCK) {
      situation = reason === 'ci_prior_unknown' ? SITUATIONS.WAITING_OTHER : SITUATIONS.NEEDS_DATA;
      nextKey = reason === 'ci_prior_unknown' ? 'wait_other' : 'wait_data';
      motiveCode = 'pre_send_block';
    } else {
      situation = SITUATIONS.RECONCILE;
      nextKey = 'reconcile';
      motiveCode = 'uncertain';
    }
  } else if (src.followup_kind === 'queued' || src.followup_kind === 'in_evaluation') {
    situation = SITUATIONS.IN_EVALUATION;
    nextKey = 'wait_eval';
    motiveCode = src.followup_kind === 'queued' ? 'queued' : 'in_evaluation';
  }

  const s1Decision =
    isS1UnknownLike(src) || (s1 === 'unknown' && (s2 === 'not_started' || !s2))
      ? actionsForS1Unknown(src)
      : null;
  if (s1Decision && situation === SITUATIONS.TECH_NOT_PROCESSED && !s1Decision.actions.length) {
    nextKey = 'reconcile';
  }

  const since = src.since || src.created_at || src.referred_at || src.started_at || null;
  const vintage = vintageOf(since);
  const lane = laneOf(situation);
  return {
    cz_solicitud_id: Number(src.cz_solicitud_id),
    ci: src.ci != null ? String(src.ci) : null,
    financier: 'ELM',
    situation: situation,
    situation_label: situationLabel(situation),
    s1_subclass: s1Decision ? s1Decision.subclass : null,
    s1_subclass_label: s1Decision ? s1Decision.subclass_label : null,
    vintage: vintage,
    vintage_label: VINTAGE_LABELS[vintage],
    lane: lane,
    lane_label: LANE_LABELS[lane],
    attention: lane === LANES.ATTENTION,
    reason_code: motiveCode,
    reason_label:
      (s1Decision && S1_SUBCLASS_LABELS[s1Decision.subclass]) ||
      reasonLabel(motiveCode) ||
      src.followup_label ||
      situationLabel(situation),
    since: since,
    age_hours: floorHours(src.age_hours),
    last_elm: lastElmText(src),
    next_step: nextStepLabel(nextKey),
    next_step_key: nextKey,
    allowed_actions: s1Decision ? s1Decision.actions : [],
    dashboard: src.dashboard || 'preaprobados',
    related_cz_solicitud_id:
      src.related_cz_solicitud_id != null ? Number(src.related_cz_solicitud_id) : null,
    technical: {
      s1_status: s1,
      s2_status: s2,
      s1_result_message: src.s1_result_message || null,
      s1_error_code: src.s1_error_code || null,
      s1_http_status: src.s1_http_status != null ? Number(src.s1_http_status) : null,
      s1_attempts: src.s1_attempts != null ? Number(src.s1_attempts) : null,
      projected_estado: projected,
      followup_kind: src.followup_kind || null,
      review_reason: reason,
      provider_status: src.provider_status || null,
      granted_elm: src.granted_elm === true,
      process_id: src.process_id || src.elm_process_id || null,
      process_updated_at: src.process_updated_at || src.version || null,
      review_id: src.review_id || null,
      review_version: src.review_version != null ? Number(src.review_version) : null,
      trigger_origin: src.trigger_origin || null,
      last_event: src.last_event || null,
    },
  };
}

function matchesCiQuery(item, raw) {
  const q = String(raw || '').replace(/\D/g, '');
  if (!q) return true;
  const ci = String((item && item.ci) || '').replace(/\D/g, '');
  const cz = String((item && item.cz_solicitud_id) || '');
  return ci.indexOf(q) !== -1 || cz.indexOf(q) !== -1;
}

function filterOpportunities(items, query) {
  const q = query || {};
  const situation = q.situation && SITUATION_LABELS[q.situation] ? q.situation : '';
  const vintage = q.vintage && VINTAGE_LABELS[q.vintage] ? q.vintage : '';
  const lane = q.lane && LANE_LABELS[q.lane] ? q.lane : '';
  return (items || []).filter(function (item) {
    if (situation && item.situation !== situation) return false;
    if (vintage && item.vintage !== vintage) return false;
    if (lane && item.lane !== lane) return false;
    return matchesCiQuery(item, q.ci);
  });
}

function situationOptions() {
  return Object.keys(SITUATION_LABELS).map(function (id) {
    return { id: id, label: SITUATION_LABELS[id] };
  });
}

function vintageOptions() {
  return Object.keys(VINTAGE_LABELS).map(function (id) {
    return { id: id, label: VINTAGE_LABELS[id] };
  });
}

function laneOptions() {
  return Object.keys(LANE_LABELS).map(function (id) {
    return { id: id, label: LANE_LABELS[id] };
  });
}

module.exports = {
  SITUATIONS,
  SITUATION_LABELS,
  NEXT_STEP_LABELS,
  REASON_LABELS,
  VINTAGE,
  VINTAGE_LABELS,
  LANES,
  LANE_LABELS,
  CORRECTION_CUTOVER_AT,
  GESTION_TAB_ENABLED,
  S1_SUBCLASS,
  S1_SUBCLASS_LABELS,
  classifyOpportunity,
  filterOpportunities,
  matchesCiQuery,
  situationOptions,
  vintageOptions,
  laneOptions,
  vintageOf,
  floorHours,
};
