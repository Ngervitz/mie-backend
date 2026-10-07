'use strict';

/**
 * ELM eligibility (pure). Unit = the SOLICITUD (cz_id), never the CI:
 * - no "any solicitud of this CI is GRANTED → block";
 * - no "several solicitudes of the CI → use the latest".
 *
 * Does NOT assume CZ estado 8 means a CDV pre-approval (in CZ it means the CDV offer link was
 * opened, and it can be re-entered from 9/10/11). Estado is only snapshotted, never required.
 *
 * GRANTED consistency: JANUS reads a mirror synced from CZ MySQL (cz_funnel_*). A GRANTED that
 * CZ already has may not be visible here yet. That is a known risk to resolve BEFORE enabling
 * real sends; it does not block Fase 1A because ELM send is OFF.
 *
 * CDV "still working this lead" has no reliable signal yet (depends on observing the CDV
 * webhook with real traffic). Not automated here.
 *
 * Consent: enabling real sends requires reviewing the applicable consent (incl. historical
 * leads) first. Out of scope for this technical check.
 */

const { isGrantedForSolicitud } = require('../../lib/preaprobadosRead');
const { CODES } = require('./constants');
const { missingRequiredFields } = require('./payload');

/**
 * Provenance base → brand. Base comes from the SMS touch that generated the solicitud
 * (jt → marketing_impacts → sms_messages/sms_contacts.source_system, same resolver as the CDV
 * Sheet BASE column). No base (organic) or unmapped base → indeterminate (fail closed).
 *
 * @param {string|null|undefined} baseLabel
 * @param {{ sourceBrandByBase?: Record<string,string> }} config
 * @returns {{ ok: true, brand: string, base: string } | { ok: false, code: string, base: string|null, reason: string }}
 */
function resolveSourceBrand(baseLabel, config) {
  const base = baseLabel == null ? '' : String(baseLabel).trim();
  if (!base) {
    return {
      ok: false,
      code: CODES.SOURCE_BRAND_INDETERMINATE,
      base: null,
      reason: 'no_provenance_base',
    };
  }
  const map = (config && config.sourceBrandByBase) || {};
  const brand = Object.prototype.hasOwnProperty.call(map, base)
    ? String(map[base]).trim()
    : '';
  if (!brand) {
    return {
      ok: false,
      code: CODES.SOURCE_BRAND_INDETERMINATE,
      base: base,
      reason: 'base_not_mapped',
    };
  }
  return { ok: true, brand: brand, base: base };
}

/**
 * S1 eligibility. Collects every blocker (UI preview needs all of them).
 * `existingProcess` is only passed by read paths; the write path relies on the atomic claim.
 *
 * @param {{
 *   czId: number,
 *   solicitud: object|null,
 *   grantedRow: object|null,
 *   existingProcess?: object|null,
 *   sourceBrand: { ok: boolean, code?: string },
 *   config: { activityTypeMap?: Record<string,string> },
 * }} input
 * @returns {{ eligible: boolean, blockers: Array<{ code: string, fields?: string[] }> }}
 */
function evaluateElmEligibility(input) {
  const blockers = [];
  const sol = input && input.solicitud ? input.solicitud : null;
  if (!sol) {
    return {
      eligible: false,
      blockers: [{ code: CODES.SOLICITUD_NOT_FOUND }],
    };
  }

  const grantedByCzId = new Map();
  if (input.grantedRow) grantedByCzId.set(Number(input.czId), input.grantedRow);
  if (isGrantedForSolicitud(Number(input.czId), grantedByCzId, sol)) {
    blockers.push({ code: CODES.CDV_GRANTED });
  }

  if (input.existingProcess) blockers.push({ code: CODES.PROCESS_EXISTS });

  const missing = missingRequiredFields(sol);
  if (missing.length) {
    blockers.push({ code: CODES.MISSING_REQUIRED_FIELDS, fields: missing });
  }

  const relacion =
    sol.relacion_laboral == null ? '' : String(sol.relacion_laboral).trim();
  const map = (input.config && input.config.activityTypeMap) || {};
  if (
    relacion &&
    !(Object.prototype.hasOwnProperty.call(map, relacion) && String(map[relacion]).trim())
  ) {
    blockers.push({ code: CODES.ACTIVITY_TYPE_MAPPING_MISSING });
  }

  if (!input.sourceBrand || input.sourceBrand.ok !== true) {
    blockers.push({ code: CODES.SOURCE_BRAND_INDETERMINATE });
  }

  return { eligible: blockers.length === 0, blockers: blockers };
}

/**
 * S2 precondition re-check on the solicitud (process state is enforced by the DB claim).
 * @param {{ czId: number, solicitud: object|null, grantedRow: object|null, process: object }} input
 */
function evaluateElmReferEligibility(input) {
  const sol = input && input.solicitud ? input.solicitud : null;
  if (!sol) return { eligible: false, blockers: [{ code: CODES.SOLICITUD_NOT_FOUND }] };
  const blockers = [];
  const grantedByCzId = new Map();
  if (input.grantedRow) grantedByCzId.set(Number(input.czId), input.grantedRow);
  if (isGrantedForSolicitud(Number(input.czId), grantedByCzId, sol)) {
    blockers.push({ code: CODES.CDV_GRANTED });
  }
  if (input.process && Number(sol.ci) !== Number(input.process.ci)) {
    blockers.push({ code: CODES.CI_MISMATCH });
  }
  return { eligible: blockers.length === 0, blockers: blockers };
}

module.exports = {
  resolveSourceBrand,
  evaluateElmEligibility,
  evaluateElmReferEligibility,
};
