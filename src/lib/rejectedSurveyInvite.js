'use strict';

/**
 * Rechazados → Encuesta email invite (Stage 2B) — pure helpers.
 * No I/O.
 */

const {
  EMAIL_PURPOSES,
  assertValidEmailPurpose,
} = require('../services/email-campaigns/purposes');

const REJECTED_ESTADO_ID = 3;

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function nullableTrimmedText(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * Lightweight email shape check (not full RFC).
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidEmail(raw) {
  const s = nullableTrimmedText(raw);
  if (!s) return false;
  const lower = s.toLowerCase();
  const at = lower.indexOf('@');
  if (at < 1) return false;
  const domain = lower.slice(at + 1);
  if (!domain || domain.indexOf('.') < 1) return false;
  if (/\s/.test(s)) return false;
  return true;
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidLrwId(raw) {
  const s = nullableTrimmedText(raw);
  return Boolean(s);
}

function tsMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

/**
 * Last rejection (estado 3) per CI.
 * Rule: fechahora_src DESC, tie cz_historico_id DESC.
 *
 * @param {Array<{ cz_historico_id?: unknown, cz_solicitud_id?: unknown, fechahora_src?: unknown, solicitudes_estados_id?: unknown }>} estadoRows
 * @param {Array<{ cz_id?: unknown, ci?: unknown }>} solicitudRows
 * @returns {Map<number, { ci: number, cz_solicitud_id: number, cz_historico_id: number, fechahora_src: string|null }>}
 */
function resolveLastRejectionByCi(estadoRows, solicitudRows) {
  const solById = new Map();
  for (let i = 0; i < (solicitudRows || []).length; i += 1) {
    const s = solicitudRows[i];
    const id = Number(s && s.cz_id);
    if (!Number.isFinite(id)) continue;
    solById.set(id, s);
  }

  /** @type {Map<number, { ci: number, cz_solicitud_id: number, cz_historico_id: number, fechahora_src: string|null }>} */
  const byCi = new Map();

  for (let i = 0; i < (estadoRows || []).length; i += 1) {
    const e = estadoRows[i];
    if (Number(e && e.solicitudes_estados_id) !== REJECTED_ESTADO_ID) continue;
    const solId = Number(e && e.cz_solicitud_id);
    const sol = Number.isFinite(solId) ? solById.get(solId) : null;
    const ci = sol && sol.ci != null ? Number(sol.ci) : null;
    if (ci == null || !Number.isSafeInteger(ci)) continue;

    const histId = Number(e.cz_historico_id);
    const t = tsMs(e.fechahora_src);
    const prev = byCi.get(ci);
    if (!prev) {
      byCi.set(ci, {
        ci: ci,
        cz_solicitud_id: solId,
        cz_historico_id: Number.isFinite(histId) ? histId : 0,
        fechahora_src: e.fechahora_src != null ? String(e.fechahora_src) : null,
      });
      continue;
    }
    const pt = tsMs(prev.fechahora_src);
    const tSafe = t == null ? -1 : t;
    const ptSafe = pt == null ? -1 : pt;
    if (
      tSafe > ptSafe ||
      (tSafe === ptSafe &&
        (Number.isFinite(histId) ? histId : 0) > prev.cz_historico_id)
    ) {
      byCi.set(ci, {
        ci: ci,
        cz_solicitud_id: solId,
        cz_historico_id: Number.isFinite(histId) ? histId : 0,
        fechahora_src: e.fechahora_src != null ? String(e.fechahora_src) : null,
      });
    }
  }

  return byCi;
}

const PURPOSE = EMAIL_PURPOSES.RECHAZADOS_SURVEY_INVITE;
const SURVEY_BASE =
  'https://www.credizona.com.uy/solicitudes/sinoferta?lrw=';
const NOMBRE_FALLBACK = 'Cliente';
const MISSING_TEMPLATE_PREFIX = 'missing_required_template_var:';
/** Must match processor ERROR_SUPPRESSED / Stage 2A send-time reason. */
const ERROR_SUPPRESSED = 'email_suppressed';

const REASONS = Object.freeze({
  ELIGIBLE: 'eligible',
  NO_CURRENT_REJECTION: 'no_current_rejection',
  EPISODE_CI_MISMATCH: 'episode_ci_mismatch',
  MISSING_EMAIL: 'missing_email',
  MISSING_LRW: 'missing_lrw',
  SURVEY_ALREADY_COMPLETED: 'survey_already_completed',
  EMAIL_SUPPRESSED: 'email_suppressed',
  ALREADY_PENDING: 'already_pending',
  ALREADY_SENT: 'already_sent',
  PRIOR_ATTEMPT_BLOCKS: 'prior_attempt_blocks',
  CAMPAIGN_NOT_CONFIGURED: 'campaign_not_configured',
  PUBLIC_BASE_URL_MISSING: 'public_base_url_missing',
});

/**
 * Episode-scoped unit key (campaign = STEP, cz_solicitud_id = episode).
 * @param {number|string} campaignId
 * @param {number|string} czSolicitudId
 * @returns {string}
 */
function buildSurveyInviteIdempotencyKey(campaignId, czSolicitudId) {
  assertValidEmailPurpose(PURPOSE);
  if (czSolicitudId == null || String(czSolicitudId).trim() === '') {
    throw new Error('cz_solicitud_id required for survey invite idempotency key');
  }
  return (
    PURPOSE +
    ':campaign:' +
    String(campaignId) +
    ':cz:' +
    String(czSolicitudId)
  );
}

/**
 * @param {unknown} lrwId
 * @returns {string}
 */
function buildSurveyUrl(lrwId) {
  const lrw = nullableTrimmedText(lrwId);
  if (!lrw) throw new Error('lrw_id required for survey URL');
  return SURVEY_BASE + encodeURIComponent(lrw);
}

/**
 * @param {unknown} nombre
 * @returns {string}
 */
function resolveInviteNombre(nombre) {
  const n = nullableTrimmedText(nombre);
  return n || NOMBRE_FALLBACK;
}

/**
 * Mask email for UI (no full local-part).
 * @param {unknown} email
 * @returns {string|null}
 */
function maskEmail(email) {
  const e = nullableTrimmedText(email);
  if (!e || e.indexOf('@') < 1) return null;
  const at = e.indexOf('@');
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const shown = local.length <= 1 ? '*' : local[0] + '***';
  return shown + '@' + domain;
}

/**
 * @param {object|null|undefined} recipient
 * @returns {{
 *   reason: string,
 *   repairable: boolean,
 * }|null}
 */
function classifyPriorRecipient(recipient) {
  if (!recipient) return null;
  const status = String(recipient.status || '');
  const err =
    recipient.error_reason != null ? String(recipient.error_reason) : '';

  if (status === 'queued') {
    return { reason: REASONS.ALREADY_PENDING, repairable: false };
  }
  if (status === 'sent') {
    return { reason: REASONS.ALREADY_SENT, repairable: false };
  }
  if (status === 'bounced') {
    return { reason: REASONS.PRIOR_ATTEMPT_BLOCKS, repairable: false };
  }
  if (status === 'failed') {
    if (err === ERROR_SUPPRESSED || err === 'email_suppressed') {
      return { reason: REASONS.PRIOR_ATTEMPT_BLOCKS, repairable: false };
    }
    if (err.indexOf(MISSING_TEMPLATE_PREFIX) === 0) {
      return { reason: REASONS.ELIGIBLE, repairable: true };
    }
    // Provider / UNKNOWN — block new attempt
    return { reason: REASONS.PRIOR_ATTEMPT_BLOCKS, repairable: false };
  }
  return { reason: REASONS.PRIOR_ATTEMPT_BLOCKS, repairable: false };
}

/**
 * Pure eligibility given already-resolved Janus snapshot for one CI.
 *
 * @param {{
 *   ci: number,
 *   campaignId: string|number|null,
 *   publicBaseUrlConfigured: boolean,
 *   lastRejection: { cz_solicitud_id: number }|null,
 *   solicitud: { cz_id?: unknown, email?: unknown, lrw_id?: unknown, nombre?: unknown }|null,
 *   hasEncuesta: boolean,
 *   isSuppressed: boolean,
 *   priorRecipient: object|null,
 * }} input
 */
function evaluateRejectedSurveyInviteEligibility(input) {
  const ci = input.ci;
  if (ci == null || !Number.isSafeInteger(Number(ci))) {
    return {
      reason: REASONS.NO_CURRENT_REJECTION,
      eligible: false,
      ci: null,
      email_masked: null,
      repairable: false,
      prior_recipient_id: null,
      cz_solicitud_id: null,
      email: null,
      lrw_id: null,
      nombre: null,
    };
  }

  if (input.campaignId == null || String(input.campaignId).trim() === '') {
    return baseResult(ci, REASONS.CAMPAIGN_NOT_CONFIGURED, false);
  }

  if (!input.publicBaseUrlConfigured) {
    return baseResult(ci, REASONS.PUBLIC_BASE_URL_MISSING, false);
  }

  if (!input.lastRejection || input.lastRejection.cz_solicitud_id == null) {
    return baseResult(ci, REASONS.NO_CURRENT_REJECTION, false);
  }

  const sol = input.solicitud;
  if (!sol) {
    return baseResult(ci, REASONS.NO_CURRENT_REJECTION, false);
  }

  const email = nullableTrimmedText(sol.email);
  if (!isValidEmail(email)) {
    return Object.assign(baseResult(ci, REASONS.MISSING_EMAIL, false), {
      cz_solicitud_id: Number(input.lastRejection.cz_solicitud_id),
    });
  }

  const lrw = nullableTrimmedText(sol.lrw_id);
  if (!isValidLrwId(lrw)) {
    return Object.assign(baseResult(ci, REASONS.MISSING_LRW, false), {
      cz_solicitud_id: Number(input.lastRejection.cz_solicitud_id),
      email: email,
      email_masked: maskEmail(email),
    });
  }

  if (input.hasEncuesta) {
    return Object.assign(baseResult(ci, REASONS.SURVEY_ALREADY_COMPLETED, false), {
      cz_solicitud_id: Number(input.lastRejection.cz_solicitud_id),
      email: email,
      email_masked: maskEmail(email),
      lrw_id: lrw,
    });
  }

  if (input.isSuppressed) {
    return Object.assign(baseResult(ci, REASONS.EMAIL_SUPPRESSED, false), {
      cz_solicitud_id: Number(input.lastRejection.cz_solicitud_id),
      email: email,
      email_masked: maskEmail(email),
      lrw_id: lrw,
    });
  }

  const prior = classifyPriorRecipient(input.priorRecipient || null);
  if (prior && prior.reason !== REASONS.ELIGIBLE) {
    return Object.assign(baseResult(ci, prior.reason, false), {
      cz_solicitud_id: Number(input.lastRejection.cz_solicitud_id),
      email: email,
      email_masked: maskEmail(email),
      lrw_id: lrw,
      nombre: resolveInviteNombre(sol.nombre),
      prior_recipient_id:
        input.priorRecipient && input.priorRecipient.id != null
          ? input.priorRecipient.id
          : null,
      repairable: false,
    });
  }

  const nombre = resolveInviteNombre(sol.nombre);
  return {
    reason: REASONS.ELIGIBLE,
    eligible: true,
    ci: ci,
    cz_solicitud_id: Number(input.lastRejection.cz_solicitud_id),
    email: email,
    email_masked: maskEmail(email),
    lrw_id: lrw,
    nombre: nombre,
    repairable: Boolean(prior && prior.repairable),
    prior_recipient_id:
      prior && prior.repairable && input.priorRecipient
        ? input.priorRecipient.id
        : null,
  };
}

function baseResult(ci, reason, eligible) {
  return {
    reason: reason,
    eligible: eligible,
    ci: ci,
    email_masked: null,
    repairable: false,
    prior_recipient_id: null,
    cz_solicitud_id: null,
    email: null,
    lrw_id: null,
    nombre: null,
  };
}

/**
 * @param {object[]} estadoRows
 * @param {object[]} solicitudRows
 * @param {number} ci
 */
function resolveCurrentLastRejectionForCi(estadoRows, solicitudRows, ci) {
  const sols = (solicitudRows || []).map(function (s) {
    return { cz_id: s.cz_id, ci: s.ci };
  });
  const map = resolveLastRejectionByCi(estadoRows || [], sols);
  return map.get(Number(ci)) || null;
}

module.exports = {
  PURPOSE,
  SURVEY_BASE,
  NOMBRE_FALLBACK,
  MISSING_TEMPLATE_PREFIX,
  REASONS,
  REJECTED_ESTADO_ID,
  buildSurveyInviteIdempotencyKey,
  buildSurveyUrl,
  resolveInviteNombre,
  maskEmail,
  classifyPriorRecipient,
  evaluateRejectedSurveyInviteEligibility,
  resolveLastRejectionByCi,
  resolveCurrentLastRejectionForCi,
  isValidEmail,
  isValidLrwId,
  nullableTrimmedText,
};
