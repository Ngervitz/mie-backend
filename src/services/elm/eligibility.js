'use strict';

/**
 * ELM eligibility (pure). Unit = the SOLICITUD (cz_id), never the CI:
 * - no "any solicitud of this CI is GRANTED → block";
 * - no "several solicitudes of the CI → use the latest".
 *
 * Does NOT assume CZ estado 8 means a CDV pre-approval (in CZ it means the CDV offer link was
 * opened, and it can be re-entered from 9/10/11). Estado is only snapshotted, never required.
 *
 * GRANTED source: cz_automatic evaluates the snapshot CZ sent at start (its estado), never the
 * mirror. Manual JANUS operations read the mirror synced from CZ MySQL (cz_funnel_*), which may
 * lag behind CZ.
 *
 * CDV "still working this lead" has no reliable signal yet (depends on observing the CDV
 * webhook with real traffic). Not automated here.
 *
 * Commercial consent for the Preaprobados manual send is a business decision, not a
 * technical gate on this path. Estado 8 is sendable and only adds a notice: CDV may
 * still be active.
 */

const { isGrantedForSolicitud, PREAPROBADOS_ESTADO_ID } = require('../../lib/preaprobadosRead');
const { CODES } = require('./constants');
const {
  missingRequiredFields,
  inspectMobilePhone,
  resolveActivityType,
  s1AllowsInvalidPhone,
} = require('./payload');

/**
 * Commercial origin for tracking only (never sent, never blocks). Base comes from the SMS touch
 * that generated the solicitud (jt → marketing_impacts → sms source_system, same resolver as the
 * CDV Sheet BASE column). No base = organic or not resolved → null.
 * @param {string|null|undefined} baseLabel
 * @returns {string|null}
 */
function normalizeCommercialOrigin(baseLabel) {
  const base = baseLabel == null ? '' : String(baseLabel).trim();
  return base ? base.slice(0, 200) : null;
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
 *   config: { activityTypeMap?: Record<string,string> },
 * }} input
 * @returns {{ eligible: boolean, blockers: Array<{ code: string, fields?: string[] }> }}
 */
function evaluateElmEligibility(input) {
  const blockers = [];
  const notices = [];
  const sol = input && input.solicitud ? input.solicitud : null;
  if (!sol) {
    return {
      eligible: false,
      blockers: [{ code: CODES.SOLICITUD_NOT_FOUND }],
      notices: [],
    };
  }
  if (Number(sol.solicitudes_estados_id) === PREAPROBADOS_ESTADO_ID) {
    notices.push('elm_cdv_possibly_active');
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

  const phone = inspectMobilePhone(sol.celular);
  let s2Withheld = null;
  if (phone.status === 'invalid') {
    if (s1AllowsInvalidPhone(input.czId)) s2Withheld = CODES.MOBILEPHONE_NEEDS_CORRECTION;
    else blockers.push({ code: CODES.MOBILEPHONE_NEEDS_CORRECTION });
  }

  const relacion =
    sol.relacion_laboral == null ? '' : String(sol.relacion_laboral).trim();
  if (relacion && !resolveActivityType(relacion, input.config)) {
    blockers.push({ code: CODES.ACTIVITY_TYPE_MAPPING_MISSING });
  }

  return { eligible: blockers.length === 0, blockers: blockers, s2_withheld: s2Withheld, notices: notices };
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
  const phone = inspectMobilePhone(sol.celular);
  if (phone.status === 'invalid') {
    blockers.push({ code: CODES.MOBILEPHONE_NEEDS_CORRECTION });
  }
  return { eligible: blockers.length === 0, blockers: blockers };
}

module.exports = {
  normalizeCommercialOrigin,
  evaluateElmEligibility,
  evaluateElmReferEligibility,
};
