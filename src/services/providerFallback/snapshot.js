'use strict';

/**
 * Start request → frozen applicant snapshot (pure).
 *
 * Only shape/format is validated here. Business eligibility (missing fields, mappings, CDV
 * granted, …) stays in the ELM orchestrator so it is decided in one place.
 * Unknown keys are dropped, so the snapshot hash only depends on the fields JANUS uses.
 * V1 excludes API-originated solicitudes: from_api must be sent and must be false.
 * cz_estado_id (current CZ estado at start) is required and must be 12 (C1: CZ moves the
 * CDV-rejected solicitud to "evaluando alternativa" before calling start; never 3 first).
 */

const crypto = require('crypto');
const stringify = require('json-stable-stringify');
const { CZ_ESTADO } = require('./constants');

const SNAPSHOT_VERSION = 1;
const CI_RE = /^[0-9]{1,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TEXT_LIMITS = Object.freeze({
  nombre: 200,
  apellido: 200,
  relacion_laboral: 100,
  celular: 32,
  email: 254,
});

function positiveSafeInt(raw) {
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** null/'' → null; non-string or too long → undefined (invalid). */
function optionalText(raw, max) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s) return null;
  return s.length <= max ? s : undefined;
}

function parseApplicant(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_applicant' };

  const ciText = raw.ci == null ? '' : String(raw.ci).trim();
  if (!CI_RE.test(ciText) || Number(ciText) <= 0) return { error: 'invalid_ci' };

  const out = { ci: String(Number(ciText)) };
  for (const key of Object.keys(TEXT_LIMITS)) {
    const v = optionalText(raw[key], TEXT_LIMITS[key]);
    if (v === undefined) return { error: 'invalid_' + key };
    out[key] = v;
  }

  const dob = optionalText(raw.fecha_nacimiento, 10);
  if (dob === undefined || (dob !== null && !DATE_RE.test(dob))) {
    return { error: 'invalid_fecha_nacimiento' };
  }
  out.fecha_nacimiento = dob;

  if (raw.salario == null || raw.salario === '') {
    out.salario = null;
  } else {
    const n = typeof raw.salario === 'number' ? raw.salario : Number(String(raw.salario).trim());
    if (typeof raw.salario === 'boolean' || !Number.isFinite(n) || n < 0) {
      return { error: 'invalid_salario' };
    }
    out.salario = n;
  }
  return { value: out };
}

/**
 * @param {unknown} body
 * @returns {{ error: string } | { value: { czSolicitudId: number, ci: number, snapshot: object, snapshotHash: string } }}
 */
function parseStartBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_body' };

  const czSolicitudId = positiveSafeInt(body.cz_solicitud_id);
  if (czSolicitudId == null) return { error: 'invalid_cz_solicitud_id' };

  if (typeof body.from_api !== 'boolean') return { error: 'invalid_from_api' };
  if (body.from_api === true) return { error: 'from_api_excluded' };

  const lrw = optionalText(body.lrw_id, 100);
  if (lrw === undefined) return { error: 'invalid_lrw_id' };
  const jt = optionalText(body.jt, 200);
  if (jt === undefined) return { error: 'invalid_jt' };
  const czEstadoId = positiveSafeInt(body.cz_estado_id);
  if (czEstadoId == null) return { error: 'invalid_cz_estado_id' };
  if (czEstadoId !== CZ_ESTADO.EVALUATING) return { error: 'cz_estado_not_evaluating' };

  const applicant = parseApplicant(body.applicant);
  if (applicant.error) return { error: applicant.error };

  const snapshot = {
    v: SNAPSHOT_VERSION,
    cz_solicitud_id: czSolicitudId,
    from_api: false,
    lrw_id: lrw,
    jt: jt,
    cz_estado_id: czEstadoId,
    applicant: applicant.value,
  };
  return {
    value: {
      czSolicitudId: czSolicitudId,
      ci: Number(applicant.value.ci),
      snapshot: snapshot,
      snapshotHash: hashSnapshot(snapshot),
    },
  };
}

function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(stringify(snapshot), 'utf8').digest('hex');
}

/** Snapshot → the solicitud row shape the ELM orchestrator/payload builders consume. */
function snapshotToSolicitud(snapshot) {
  const s = snapshot || {};
  const a = s.applicant || {};
  return {
    cz_id: s.cz_solicitud_id,
    ci: a.ci != null ? Number(a.ci) : null,
    nombre: a.nombre,
    apellido: a.apellido,
    email: a.email,
    celular: a.celular,
    salario: a.salario,
    fecha_nacimiento: a.fecha_nacimiento,
    relacion_laboral: a.relacion_laboral,
    lrw_id: s.lrw_id,
    solicitudes_estados_id: s.cz_estado_id,
  };
}

module.exports = {
  SNAPSHOT_VERSION,
  parseStartBody,
  hashSnapshot,
  snapshotToSolicitud,
};
