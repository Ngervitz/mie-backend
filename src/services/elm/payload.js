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

const { CODES, ELM_SOURCE, MANUAL_RAW_ACTIVITY_TYPES, NOTICES } = require('./constants');
const {
  BIRTH_DATE_STATUS,
  OMITTABLE_BIRTH_DATE_STATUSES,
  isValidBirthDate,
  classifyBirthDate,
} = require('../../lib/birthDate');

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
 * Manual send decision for fecha_nacimiento. A stored date is classified as is; a null date relies
 * on fecha_nacimiento_status from the sync, because the mirror stores null for every invalid
 * value (a minor's included). Omitted only for absent / impossible / over the maximum age.
 * @param {object} solicitud cz_funnel_solicitudes row (fecha_nacimiento, fecha_nacimiento_status)
 * @param {Date} [now]
 * @returns {{ send: true } | { omit: true } | { code: string }}
 */
function manualBirthDateDecision(solicitud, now) {
  const s = solicitud || {};
  const status = text(s.fecha_nacimiento)
    ? classifyBirthDate(s.fecha_nacimiento, now)
    : s.fecha_nacimiento_status == null
      ? null
      : String(s.fecha_nacimiento_status);
  if (status === BIRTH_DATE_STATUS.VALID && text(s.fecha_nacimiento)) return { send: true };
  if (OMITTABLE_BIRTH_DATE_STATUSES.includes(status)) return { omit: true };
  if (status == null) return { code: CODES.DATE_OF_BIRTH_UNVERIFIED };
  return { code: CODES.DATE_OF_BIRTH_INVALID };
}

/**
 * activityType for a relacion_laboral: the configured mapping, or (manual only) the CZ code itself
 * when it is in MANUAL_RAW_ACTIVITY_TYPES and has no mapping.
 * @returns {{ value: string, raw: boolean } | null}
 */
function resolveActivityType(relacionRaw, map, manual) {
  const relacion = text(relacionRaw);
  if (!relacion) return null;
  const m = map || {};
  const mapped = Object.prototype.hasOwnProperty.call(m, relacion) ? text(m[relacion]) : null;
  if (mapped) return { value: mapped, raw: false };
  if (manual === true && MANUAL_RAW_ACTIVITY_TYPES.includes(relacion)) {
    return { value: relacion, raw: true };
  }
  return null;
}

/**
 * Manual sends (`manual: true`, trigger janus_manual only) take two allowances, reported in
 * `notices`: an unmapped MANUAL_RAW_ACTIVITY_TYPES code goes verbatim as activityType, and an
 * absent / impossible fecha_nacimiento (manualBirthDateDecision) leaves dateOfBirth out, never
 * replaced. An underage, future or unclassified date still blocks; the DOB format must still be
 * confirmed.
 * Every other rule is the same as the automatic circuit.
 * @param {{ czId: number, solicitud: object, config: object, now?: Date, manual?: boolean }} input
 * @returns {{ ok: true, payload: object, notices: string[] } | { ok: false, code: string }}
 */
function buildService1Payload(input) {
  const s = (input && input.solicitud) || {};
  const config = (input && input.config) || {};
  const manual = input != null && input.manual === true;
  const notices = [];
  const missing = missingRequiredFields(s).filter((f) => !(manual && f === 'fecha_nacimiento'));
  if (missing.length) return fail(CODES.MISSING_REQUIRED_FIELDS, { fields: missing });

  const czId = positiveSafeInt(input && input.czId);
  if (czId == null) return fail(CODES.INVALID_CZ_ID);

  const activity = resolveActivityType(s.relacion_laboral, config.activityTypeMap, manual);
  if (!activity) return fail(CODES.ACTIVITY_TYPE_MAPPING_MISSING);
  if (activity.raw) notices.push(NOTICES.ACTIVITY_TYPE_RAW);

  const dobFormat = config.dateOfBirthFormat || null;
  let dob = formatDateOfBirth(s.fecha_nacimiento, dobFormat, input && input.now);
  if (!dob.ok && dob.code === CODES.DATE_OF_BIRTH_INVALID && manual) {
    const decision = manualBirthDateDecision(s, input && input.now);
    if (!decision.omit) return fail(decision.code || CODES.DATE_OF_BIRTH_INVALID);
    dob = null;
    notices.push(NOTICES.DATE_OF_BIRTH_OMITTED);
  } else if (!dob.ok) {
    return dob;
  }

  const salaryNum = Number(s.salario);
  if (!Number.isFinite(salaryNum) || salaryNum <= 0) return fail(CODES.SALARY_INVALID);

  const payload = { activityType: activity.value };
  if (dob) payload.dateOfBirth = dob.value;
  payload.docNumber = String(positiveSafeInt(s.ci));
  payload.firstName = text(s.nombre);
  payload.lastName = text(s.apellido);
  payload.salary = String(salaryNum);
  payload.source = ELM_SOURCE;
  return { ok: true, payload: payload, notices: notices };
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
  manualBirthDateDecision,
  resolveActivityType,
  buildService1Payload,
  buildService2Payload,
};
