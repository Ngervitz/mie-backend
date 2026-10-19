'use strict';

/**
 * ELM request payload builders (pure; no transport, no I/O).
 *
 * Input row = cz_funnel_solicitudes. salario / relacion_laboral belong to the solicitud;
 * nombre, apellido, fecha_nacimiento, celular, email come from CZ `usuarios` (current person
 * data, not a per-solicitud snapshot). The built payload is what gets frozen in the process row.
 *
 * Fail closed when ELM has not confirmed a mapping/format (see config.js).
 * `source` is always ELM_SOURCE; the lead's commercial origin is never sent.
 * Confirmed by ELM: S1 carries NO TrackingId; S2 carries TrackingId = cz_solicitud_id (the id
 * ELM returns as postback internal_id).
 */

const { CODES, ELM_SOURCE, CONFIRMED_ACTIVITY_TYPES } = require('./constants');

const SERVICE1_KEYS = Object.freeze([
  'activityType',
  'dateOfBirth',
  'docNumber',
  'firstName',
  'lastName',
  'salary',
  'source',
]);

const SERVICE2_KEYS = Object.freeze([
  'docNumber',
  'mobilephone',
  'email',
  'source',
  'TrackingId',
]);

function text(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

function positiveSafeInt(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function fail(code, extra) {
  return Object.assign({ ok: false, code: code }, extra || {});
}

/**
 * ELM activityType for a CZ relacion_laboral code. Confirmed codes (OTR → otro) win over the
 * env map; every other code still requires ELM_ACTIVITY_TYPE_MAP_JSON.
 * @param {unknown} relacion
 * @param {{ activityTypeMap?: Record<string, string> }|null|undefined} config
 * @returns {string|null}
 */
function resolveActivityType(relacion, config) {
  const key = text(relacion);
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(CONFIRMED_ACTIVITY_TYPES, key)) {
    return CONFIRMED_ACTIVITY_TYPES[key];
  }
  const map = (config && config.activityTypeMap) || {};
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
  return text(map[key]);
}

/**
 * @param {unknown} raw YYYY-MM-DD (cz_funnel_solicitudes.fecha_nacimiento)
 * @param {string|null} format
 */
function formatDateOfBirth(raw, format) {
  if (!format) return fail(CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw == null ? '' : raw).trim());
  if (!m) return fail(CODES.DATE_OF_BIRTH_INVALID);
  const y = m[1];
  const mm = m[2];
  const dd = m[3];
  const d = String(Number(dd));
  const mo = String(Number(mm));
  switch (format) {
    case 'D/M/YYYY':
      return { ok: true, value: d + '/' + mo + '/' + y };
    case 'DD/MM/YYYY':
      return { ok: true, value: dd + '/' + mm + '/' + y };
    case 'M/D/YYYY':
      return { ok: true, value: mo + '/' + d + '/' + y };
    case 'MM/DD/YYYY':
      return { ok: true, value: mm + '/' + dd + '/' + y };
    case 'YYYY-MM-DD':
      return { ok: true, value: y + '-' + mm + '-' + dd };
    default:
      return fail(CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED);
  }
}

const UY_MOBILE_E164 = /^5989\d{7}$/;

/**
 * Unequivocal UY-mobile digits (5989 + 7). Does not invent or drop digits.
 * Safe forms only, aligned with Credizona `limpiarCelular` for mobiles:
 * already 5989xxxxxxx, international 00 prefix, local 09xxxxxxx, 8 digits starting with 9.
 * 7-digit numbers, landlines (2/4), extra digits: not normalized.
 * @param {unknown} raw
 * @returns {string|null} 5989 + 7 digits, or null
 */
function normalizeUyMobileDigits(raw) {
  let digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (UY_MOBILE_E164.test(digits)) return digits;
  if (/^09\d{7}$/.test(digits)) return '598' + digits.slice(1);
  if (/^9\d{7}$/.test(digits)) return '598' + digits;
  return null;
}

/**
 * @param {unknown} raw
 * @returns {{ status: 'empty', digits: string } | { status: 'ok', digits: string, e164: string }
 *   | { status: 'invalid', digits: string }}
 */
function inspectMobilePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return { status: 'empty', digits: '' };
  const e164 = normalizeUyMobileDigits(raw);
  if (e164) return { status: 'ok', digits: digits, e164: e164 };
  return { status: 'invalid', digits: digits };
}

/**
 * Operator exception for two Gestión ELM solicitudes. S1 does not carry the phone.
 * S2 still requires a confirmed UY mobile and never rewrites the stored number.
 */
const S1_INVALID_PHONE_ALLOWED_CZ = Object.freeze([2049, 2056]);

function s1AllowsInvalidPhone(czId) {
  const n = Number(czId);
  return S1_INVALID_PHONE_ALLOWED_CZ.indexOf(n) !== -1;
}

/**
 * Only UY mobiles (5989 + 7 digits), after safe normalization. Invalid applicant numbers
 * are `elm_mobilephone_needs_correction` (never a commercial rejection). Unconfirmed
 * serialization format stays a JANUS config blocker.
 * @param {unknown} raw
 * @param {string|null} format
 */
function formatMobilePhone(raw, format) {
  if (!format) return fail(CODES.MOBILEPHONE_FORMAT_UNCONFIRMED);
  const phone = inspectMobilePhone(raw);
  if (phone.status !== 'ok') return fail(CODES.MOBILEPHONE_NEEDS_CORRECTION);
  if (format === 'uy_local_0') return { ok: true, value: '0' + phone.e164.slice(3) };
  if (format === 'uy_598') return { ok: true, value: phone.e164 };
  return fail(CODES.MOBILEPHONE_FORMAT_UNCONFIRMED);
}

/** Required solicitud fields for S1 (+ contact presence so S2 is not impossible upfront). */
function missingRequiredFields(solicitud) {
  const s = solicitud || {};
  const missing = [];
  if (positiveSafeInt(s.ci) == null) missing.push('ci');
  if (!text(s.nombre)) missing.push('nombre');
  if (!text(s.apellido)) missing.push('apellido');
  if (!text(s.fecha_nacimiento)) missing.push('fecha_nacimiento');
  if (s.salario == null || s.salario === '') missing.push('salario');
  if (!text(s.relacion_laboral)) missing.push('relacion_laboral');
  if (!text(s.celular)) missing.push('celular');
  if (!text(s.email)) missing.push('email');
  return missing;
}

/**
 * @param {{ czId: number, solicitud: object, config: object }} input
 * @returns {{ ok: true, payload: object } | { ok: false, code: string }}
 */
function buildService1Payload(input) {
  const s = (input && input.solicitud) || {};
  const config = (input && input.config) || {};
  const missing = missingRequiredFields(s);
  if (missing.length) return fail(CODES.MISSING_REQUIRED_FIELDS, { fields: missing });

  const phone = inspectMobilePhone(s.celular);
  if (phone.status === 'invalid' && !s1AllowsInvalidPhone(input && input.czId)) {
    return fail(CODES.MOBILEPHONE_NEEDS_CORRECTION);
  }

  const czId = positiveSafeInt(input && input.czId);
  if (czId == null) return fail(CODES.INVALID_CZ_ID);

  const activityType = resolveActivityType(s.relacion_laboral, config);
  if (!activityType) return fail(CODES.ACTIVITY_TYPE_MAPPING_MISSING);

  const dob = formatDateOfBirth(s.fecha_nacimiento, config.dateOfBirthFormat || null);
  if (!dob.ok) return dob;

  const salaryNum = Number(s.salario);
  if (!Number.isFinite(salaryNum) || salaryNum <= 0) return fail(CODES.SALARY_INVALID);

  return {
    ok: true,
    payload: {
      activityType: activityType,
      dateOfBirth: dob.value,
      docNumber: String(positiveSafeInt(s.ci)),
      firstName: text(s.nombre),
      lastName: text(s.apellido),
      salary: String(salaryNum),
      source: ELM_SOURCE,
    },
  };
}

/**
 * docNumber comes from the frozen process (same as S1), contact from the solicitud row.
 * @param {{ ci: unknown, czId: unknown, solicitud: object, config: object }} input
 */
function buildService2Payload(input) {
  const s = (input && input.solicitud) || {};
  const config = (input && input.config) || {};
  const czId = positiveSafeInt(input && input.czId);
  if (czId == null) return fail(CODES.INVALID_CZ_ID);
  const ci = positiveSafeInt(input && input.ci);
  const missing = [];
  if (ci == null) missing.push('ci');
  if (!text(s.celular)) missing.push('celular');
  if (!text(s.email)) missing.push('email');
  if (missing.length) return fail(CODES.MISSING_REQUIRED_FIELDS, { fields: missing });

  const phone = formatMobilePhone(s.celular, config.mobilePhoneFormat || null);
  if (!phone.ok) return phone;

  return {
    ok: true,
    payload: {
      docNumber: String(ci),
      mobilephone: phone.value,
      email: text(s.email),
      source: ELM_SOURCE,
      TrackingId: String(czId),
    },
  };
}

module.exports = {
  SERVICE1_KEYS,
  SERVICE2_KEYS,
  formatDateOfBirth,
  formatMobilePhone,
  normalizeUyMobileDigits,
  inspectMobilePhone,
  s1AllowsInvalidPhone,
  missingRequiredFields,
  resolveActivityType,
  buildService1Payload,
  buildService2Payload,
};
