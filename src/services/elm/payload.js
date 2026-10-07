'use strict';

/**
 * ELM request payload builders (pure; no transport, no I/O).
 *
 * Input row = cz_funnel_solicitudes. salario / relacion_laboral belong to the solicitud;
 * nombre, apellido, fecha_nacimiento, celular, email come from CZ `usuarios` (current person
 * data, not a per-solicitud snapshot). The built payload is what gets frozen in the process row.
 *
 * Fail closed when ELM has not confirmed a mapping/format (see config.js).
 */

const { CODES } = require('./constants');

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

/**
 * CZ stores celular as 598XXXXXXXX (limpiarCelular). Only UY mobiles (5989 + 7 digits) accepted.
 * @param {unknown} raw
 * @param {string|null} format
 */
function formatMobilePhone(raw, format) {
  if (!format) return fail(CODES.MOBILEPHONE_FORMAT_UNCONFIRMED);
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!/^5989\d{7}$/.test(digits)) return fail(CODES.MOBILEPHONE_INVALID);
  if (format === 'uy_local_0') return { ok: true, value: '0' + digits.slice(3) };
  if (format === 'uy_598') return { ok: true, value: digits };
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
 * @param {{ solicitud: object, sourceBrand: string, config: object }} input
 * @returns {{ ok: true, payload: object } | { ok: false, code: string }}
 */
function buildService1Payload(input) {
  const s = (input && input.solicitud) || {};
  const config = (input && input.config) || {};
  const missing = missingRequiredFields(s);
  if (missing.length) return fail(CODES.MISSING_REQUIRED_FIELDS, { fields: missing });

  const source = text(input && input.sourceBrand);
  if (!source) return fail(CODES.SOURCE_BRAND_INDETERMINATE);

  const relacion = text(s.relacion_laboral);
  const map = config.activityTypeMap || {};
  const activityType = Object.prototype.hasOwnProperty.call(map, relacion)
    ? text(map[relacion])
    : null;
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
      source: source,
    },
  };
}

/**
 * docNumber/source come from the frozen process (same as S1), contact from the solicitud row.
 * @param {{ ci: unknown, solicitud: object, sourceBrand: string, config: object }} input
 */
function buildService2Payload(input) {
  const s = (input && input.solicitud) || {};
  const config = (input && input.config) || {};
  const ci = positiveSafeInt(input && input.ci);
  const missing = [];
  if (ci == null) missing.push('ci');
  if (!text(s.celular)) missing.push('celular');
  if (!text(s.email)) missing.push('email');
  if (missing.length) return fail(CODES.MISSING_REQUIRED_FIELDS, { fields: missing });

  const source = text(input && input.sourceBrand);
  if (!source) return fail(CODES.SOURCE_BRAND_INDETERMINATE);

  const phone = formatMobilePhone(s.celular, config.mobilePhoneFormat || null);
  if (!phone.ok) return phone;

  return {
    ok: true,
    payload: {
      docNumber: String(ci),
      mobilephone: phone.value,
      email: text(s.email),
      source: source,
    },
  };
}

module.exports = {
  SERVICE1_KEYS,
  SERVICE2_KEYS,
  formatDateOfBirth,
  formatMobilePhone,
  missingRequiredFields,
  buildService1Payload,
  buildService2Payload,
};
