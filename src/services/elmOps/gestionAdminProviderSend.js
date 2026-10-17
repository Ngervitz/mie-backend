'use strict';

/**
 * Gestión ELM: elm_admin_provider_resend + continue S1/S2 transport (no claim).
 */

const { CODES } = require('../elm/constants');
const { readElmConfig } = require('../elm/config');
const { buildService1Payload } = require('../elm/payload');
const { evaluateElmReferEligibility } = require('../elm/eligibility');
const { ADMIN_PROVIDER_RESEND_CODES } = require('../elm/orchestrator');
const { outcomeOf, statusFor, respondWithCell } = require('../../lib/elmManualSend');

function mapAdminRpc(out) {
  if (out.status === 'blocked') {
    return { ok: false, code: CODES.CI_LOCK_BLOCKED, lock: out.lock || null, stage: 's1' };
  }
  if (out.status === 'ready' && out.process) {
    return { ok: true, process: out.process };
  }
  const reason = out.reason || null;
  if (out.status === 'not_allowed' && reason === 'duplicate_provider_reference') {
    return { ok: false, code: CODES.ADMIN_PROVIDER_DUPLICATE_REFERENCE, stage: 's1', reason: reason };
  }
  return {
    ok: false,
    code: ADMIN_PROVIDER_RESEND_CODES[out.status] || CODES.ADMIN_PROVIDER_RESEND_NOT_ALLOWED,
    stage: 's1',
    reason: reason,
  };
}

/**
 * @param {{
 *   orchestrator: { continueSendAfterProviderResend: Function, getSendReadiness: Function },
 *   elmRepository: { loadSolicitudContext: Function, adminProviderResend: Function },
 *   listView: { cellsForCzIds: Function },
 * }} deps
 * @param {{ czSolicitudId: number, actorUserId: string, providerReference: string, expectedUpdatedAt: string }} input
 */
async function runAdminProviderResend(deps, input) {
  const czId = Number(input.czSolicitudId);
  const config = readElmConfig();
  const ctx = await deps.elmRepository.loadSolicitudContext(czId);
  const elig = evaluateElmReferEligibility({
    czId: czId,
    solicitud: ctx.solicitud,
    grantedRow: ctx.grantedRow,
    process: null,
  });
  if (!elig.eligible) {
    return {
      status: 422,
      body: {
        ok: false,
        code: elig.blockers[0].code,
        outcome: outcomeOf(null),
        cz_solicitud_id: czId,
      },
    };
  }
  const built = buildService1Payload({
    czId: czId,
    solicitud: ctx.solicitud,
    config: config,
  });
  if (!built.ok) {
    return {
      status: 422,
      body: {
        ok: false,
        code: built.code,
        outcome: outcomeOf(null),
        cz_solicitud_id: czId,
      },
    };
  }
  const rpcOut = await deps.elmRepository.adminProviderResend({
    czSolicitudId: czId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    providerReference: input.providerReference,
    s1Request: built.payload,
    leaseSeconds: config.inFlightLeaseSeconds,
    actorUserId: input.actorUserId,
  });
  const prep = mapAdminRpc(rpcOut);
  if (!prep.ok) {
    return {
      status: statusFor(prep),
      body: Object.assign(
        {
          ok: false,
          outcome: outcomeOf(null),
          cz_solicitud_id: czId,
        },
        prep,
      ),
    };
  }
  const sendOut = await deps.orchestrator.continueSendAfterProviderResend(czId, {
    triggerOrigin: 'janus_manual',
    triggeredByUserId: input.actorUserId,
  });
  return respondWithCell(deps, czId, sendOut);
}

module.exports = { runAdminProviderResend, mapAdminRpc };
