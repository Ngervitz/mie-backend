'use strict';

/**
 * ELM callback-invite V1 — pure helpers.
 * One-shot DIRECTED campaign for 7 authorized solicitudes. No I/O.
 */

const { EMAIL_PURPOSES } = require('../services/email-campaigns/purposes');
const { TRACKING_TOKEN_RE } = require('./emailClickTracking');

const PURPOSE = EMAIL_PURPOSES.ELM_CALLBACK_INVITE;
const EVENT_NAME = 'callback_confirmed';
const EVENT_SOURCE = 'janus';
const NOMBRE_FALLBACK = 'Cliente';

const AUTHORIZED_CASES = Object.freeze([
  Object.freeze({ ci: '47690694', cz_solicitud_id: 1362 }),
  Object.freeze({ ci: '29108021', cz_solicitud_id: 1168 }),
  Object.freeze({ ci: '54120325', cz_solicitud_id: 2692 }),
  Object.freeze({ ci: '18165244', cz_solicitud_id: 1912 }),
  Object.freeze({ ci: '42163727', cz_solicitud_id: 1262 }),
  Object.freeze({ ci: '39316028', cz_solicitud_id: 1199 }),
  Object.freeze({ ci: '49698187', cz_solicitud_id: 2716 }),
]);

/** Explicitly excluded: ELM marked Gestionado. Not in AUTHORIZED_CASES. */
const EXCLUDED_CASES = Object.freeze([
  Object.freeze({ ci: '64198417', cz_solicitud_id: 1375 }),
]);

/**
 * Prepared in-memory correction. Source of the typo: cz_funnel_solicitudes.email
 * (synced from CZ). Do not UPDATE production from this module.
 */
const PREPARED_EMAIL_CORRECTIONS = Object.freeze([
  Object.freeze({
    ci: '49698187',
    cz_solicitud_id: 2716,
    from_domain: 'gmail.cm',
    to_domain: 'gmail.com',
    source: 'cz_funnel_solicitudes.email',
  }),
]);

const TEMPLATE_SUBJECT = '¿Querés retomar tu solicitud de préstamo?';

const TEMPLATE_BODY_HTML =
  '<p>Hola {{nombre}},</p>' +
  '<p>Hace unos días iniciaste una solicitud de préstamo en Credizona.</p>' +
  '<p>Si todavía estás interesado, podemos contactarte para ayudarte a continuar con la gestión.</p>' +
  '<p style="margin:24px 0;">' +
  '<a href="{{callback_url}}" style="display:inline-block;background:#1a365d;color:#ffffff;' +
  'text-decoration:none;padding:12px 20px;border-radius:4px;font-weight:700;">' +
  'QUIERO QUE ME LLAMEN</a></p>' +
  '<p>Solo tenés que hacer clic y confirmar que querés recibir una llamada.</p>' +
  '<p>Saludos,<br>Equipo Credizona</p>' +
  '<p style="font-size:12px;color:#555;">Si no querés recibir más emails de Credizona, ' +
  'podés darte de baja <a href="{{unsubscribe_url}}">aquí</a>.</p>';

const REASONS = Object.freeze({
  QUEUED: 'queued',
  ALREADY_PENDING: 'already_pending',
  ALREADY_SENT: 'already_sent',
  PRIOR_ATTEMPT_BLOCKS: 'prior_attempt_blocks',
  NOT_AUTHORIZED: 'not_authorized',
  CI_MISMATCH: 'ci_mismatch',
  MISSING_EMAIL: 'missing_email',
  INVALID_EMAIL: 'invalid_email',
  EMAIL_SUPPRESSED: 'email_suppressed',
  SUPPRESSIONS_UNAVAILABLE: 'suppressions_unavailable',
  CAMPAIGN_NOT_DIRECTED: 'campaign_not_directed',
  CAMPAIGN_NOT_CONFIGURED: 'campaign_not_configured',
  PUBLIC_BASE_URL_MISSING: 'public_base_url_missing',
  FOREIGN_RECIPIENTS: 'foreign_recipients',
});

function nullableTrimmedText(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

function normalizeCi(raw) {
  const s = nullableTrimmedText(raw);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  return digits || null;
}

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

function authorizedCzIds() {
  return AUTHORIZED_CASES.map(function (c) {
    return c.cz_solicitud_id;
  });
}

function authorizedByCzId() {
  const map = new Map();
  for (let i = 0; i < AUTHORIZED_CASES.length; i += 1) {
    map.set(AUTHORIZED_CASES[i].cz_solicitud_id, AUTHORIZED_CASES[i]);
  }
  return map;
}

function isAuthorizedPair(ciRaw, czRaw) {
  const ci = normalizeCi(ciRaw);
  const cz = Number(czRaw);
  if (!ci || !Number.isSafeInteger(cz)) return false;
  const expected = authorizedByCzId().get(cz);
  return Boolean(expected && expected.ci === ci);
}

function isExcludedPair(ciRaw, czRaw) {
  const ci = normalizeCi(ciRaw);
  const cz = Number(czRaw);
  for (let i = 0; i < EXCLUDED_CASES.length; i += 1) {
    if (EXCLUDED_CASES[i].cz_solicitud_id === cz && EXCLUDED_CASES[i].ci === ci) {
      return true;
    }
  }
  return false;
}

/**
 * Replace gmail.cm → gmail.com for the prepared CI only. Local-part unchanged.
 * @returns {{ email: string, corrected: boolean, source: string|null }}
 */
function applyPreparedEmailCorrection(ciRaw, czRaw, emailRaw) {
  const email = nullableTrimmedText(emailRaw);
  if (!email) return { email: '', corrected: false, source: null };
  const ci = normalizeCi(ciRaw);
  const cz = Number(czRaw);
  for (let i = 0; i < PREPARED_EMAIL_CORRECTIONS.length; i += 1) {
    const rule = PREPARED_EMAIL_CORRECTIONS[i];
    if (rule.ci !== ci || rule.cz_solicitud_id !== cz) continue;
    const at = email.lastIndexOf('@');
    if (at < 1) continue;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1).toLowerCase();
    if (domain === rule.from_domain) {
      return {
        email: local + '@' + rule.to_domain,
        corrected: true,
        source: rule.source,
      };
    }
  }
  return { email: email, corrected: false, source: null };
}

function buildIdempotencyKey(campaignId, czSolicitudId) {
  return PURPOSE + ':campaign:' + String(campaignId) + ':cz:' + String(czSolicitudId);
}

function buildCallbackConfirmUrl(trackingToken, publicBaseUrl) {
  const token = String(trackingToken || '').trim();
  if (!TRACKING_TOKEN_RE.test(token)) {
    throw new Error('invalid tracking_token for callback URL');
  }
  const base = String(publicBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) {
    throw new Error('EMAIL_PUBLIC_BASE_URL is not configured');
  }
  return base + '/email/callback/' + encodeURIComponent(token);
}

function callbackEventExternalId(impactId) {
  return EVENT_NAME + ':' + String(impactId);
}

function resolveNombre(raw) {
  const s = nullableTrimmedText(raw);
  return s || NOMBRE_FALLBACK;
}

function maskEmail(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.indexOf('@');
  if (at < 1) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const keep = local.slice(0, Math.min(2, local.length));
  return keep + '***@' + domain;
}

/**
 * Overlay callback request onto an ElmOps row. Does not change ELM/CZ state.
 * @param {object} item
 * @param {{ phone?: string|null, confirmed_at?: string|null }|null|undefined} callback
 */
function applyCallbackFields(item, callback) {
  const row = item || {};
  if (!callback) {
    row.callback_requested = false;
    row.callback_phone = null;
    row.callback_confirmed_at = null;
    return row;
  }
  row.callback_requested = true;
  row.callback_phone = callback.phone != null && String(callback.phone).trim() !== ''
    ? String(callback.phone).trim()
    : null;
  row.callback_confirmed_at =
    callback.confirmed_at != null ? String(callback.confirmed_at) : null;
  return row;
}

module.exports = {
  PURPOSE,
  EVENT_NAME,
  EVENT_SOURCE,
  NOMBRE_FALLBACK,
  AUTHORIZED_CASES,
  EXCLUDED_CASES,
  PREPARED_EMAIL_CORRECTIONS,
  TEMPLATE_SUBJECT,
  TEMPLATE_BODY_HTML,
  REASONS,
  TRACKING_TOKEN_RE,
  nullableTrimmedText,
  normalizeCi,
  isValidEmail,
  authorizedCzIds,
  authorizedByCzId,
  isAuthorizedPair,
  isExcludedPair,
  applyPreparedEmailCorrection,
  buildIdempotencyKey,
  buildCallbackConfirmUrl,
  callbackEventExternalId,
  resolveNombre,
  maskEmail,
  applyCallbackFields,
};
