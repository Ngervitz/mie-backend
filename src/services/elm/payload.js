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

const { CODES, ELM_SOURCE } = require('./constants');
const { isValidBirthDate } = require('../../lib/birthDate');

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
 * @param {unknown} raw YYYY-MM-DD (cz_funnel_solicitudes.fecha_nacimiento)
 * @param {string|null} format
 * @param {Date} [now] age reference (birthDate.js)
 */
function formatDateOfBirth(raw, format, now) {
  if (!format) return fail(CODES.DATE_OF_BIRTH_FORMAT_UNCONFIRMED);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw == null ? '' : raw).trim());
  if (!m || !isValidBirthDate(m[0], now)) return fail(CODES.DATE_OF_BIRTH_INVALID);
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
 * Inverse of formatDateOfBirth: frozen S1 dateOfBirth → "YYYY-MM-DD", or null when it does not
 * match the format.
 * @param {unknown} value
 * @param {string|null} format
 * @returns {string|null}
 */
function parseFrozenDateOfBirth(value, format) {
  const s = String(value == null ? '' : value).trim();
  const ymd = (y, mo, d) => y + '-' + mo.padStart(2, '0') + '-' + d.padStart(2, '0');
  let m;
  switch (format) {
    case 'D/M/YYYY':
    case 'DD/MM/YYYY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      return m ? ymd(m[3], m[2], m[1]) : null;
    case 'M/D/YYYY':
    case 'MM/DD/YYYY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      return m ? ymd(m[3], m[1], m[2]) : null;
    case 'YYYY-MM-DD':
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    default:
      return null;
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
 * @param {{ czId: number, solicitud: object, config: object, now?: Date }} input
 * @returns {{ ok: true, payload: object } | { ok: false, code: string }}
 */
function buildService1Payload(input) {
  const s = (input && input.solicitud) || {};
  const config = (input && input.config) || {};
  const missing = missingRequiredFields(s);
  if (missing.length) return fail(CODES.MISSING_REQUIRED_FIELDS, { fields: missing });

  const czId = positiveSafeInt(input && input.czId);
  if (czId == null) return fail(CODES.INVALID_CZ_ID);

  const relacion = text(s.relacion_laboral);
  const map = config.activityTypeMap || {};
  const activityType = Object.prototype.hasOwnProperty.call(map, relacion)
    ? text(map[relacion])
    : null;
  if (!activityType) return fail(CODES.ACTIVITY_TYPE_MAPPING_MISSING);

  const dob = formatDateOfBirth(
    s.fecha_nacimiento,
    config.dateOfBirthFormat || null,
    input && input.now,
  );
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
  parseFrozenDateOfBirth,
  formatMobilePhone,
  missingRequiredFields,
  buildService1Payload,
  buildService2Payload,
};
