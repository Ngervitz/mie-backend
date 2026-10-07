'use strict';

/**
 * ELM provider statuses (postback). raw text is always kept; normalization only removes
 * differences of spacing, casing and accents so the same status compares equal. No business
 * categories are derived here, with one exception: "Convertido" = loan granted/disbursed
 * = GRANTED ELM. No other status means GRANTED.
 */

const ELM_PROVIDER_STATUSES = Object.freeze([
  'Rechazado',
  'Aprobado',
  'Pendiente de Evaluación',
  'Latente',
  'Gestionado',
  'Pendiente de Doc',
  'En validación',
  'Sin respuesta',
  'Desiste',
  'Revisión',
  'Convertido',
  'Repetido - Rechazado',
  'Repetido - Aprobado',
  'Error BCU',
  'No hay Informacion en BCU',
  'No cumple Requisitos',
  'Pendiente Evaluacion - Sin Respuesta',
  'Calificado para Call Center',
  'Rechazado por Asesor',
  'Calificados',
  'Mocasist',
  'Lista Negra',
  'Error BCU - Equifax',
  'Inicial',
]);

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeProviderStatus(raw) {
  if (raw == null) return null;
  const s = String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*-\s*/g, ' - ')
    .toLowerCase();
  return s || null;
}

/** Must match the literal used by elm_postback_resolve_event in the 1B migration. */
const GRANTED_NORMALIZED_STATUS = normalizeProviderStatus('Convertido');

const CANONICAL_BY_NORMALIZED = new Map(
  ELM_PROVIDER_STATUSES.map(function (s) {
    return [normalizeProviderStatus(s), s];
  }),
);

/**
 * @param {unknown} raw
 * @returns {{ raw: string|null, normalized: string|null, canonical: string|null, known: boolean, grantedElm: boolean }}
 */
function classifyProviderStatus(raw) {
  const rawText = raw == null ? null : String(raw).trim() || null;
  const normalized = normalizeProviderStatus(rawText);
  const canonical = normalized ? CANONICAL_BY_NORMALIZED.get(normalized) || null : null;
  return {
    raw: rawText,
    normalized: normalized,
    canonical: canonical,
    known: canonical != null,
    grantedElm: normalized != null && normalized === GRANTED_NORMALIZED_STATUS,
  };
}

function isGrantedElmStatus(raw) {
  return classifyProviderStatus(raw).grantedElm;
}

module.exports = {
  ELM_PROVIDER_STATUSES,
  GRANTED_NORMALIZED_STATUS,
  normalizeProviderStatus,
  classifyProviderStatus,
  isGrantedElmStatus,
};
