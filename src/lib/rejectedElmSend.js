'use strict';

/**
 * "Enviar a ELM" from Rechazados: the solicitud must be one of the CI's rejections; the send
 * itself is the shared manual path (elmManualSend.js), the same one Preaprobados uses.
 */

const {
  OUTCOMES,
  SEND_NOT_READY,
  HISTORY_UNVERIFIABLE,
  outcomeOf,
  sendManualToElm,
  retryManualToElm,
} = require('./elmManualSend');

const NOT_IN_REJECTIONS = 'elm_solicitud_not_in_rejections';

/**
 * @param {{
 *   orchestrator: { sendElm: Function, getSendReadiness: Function },
 *   listView: { cellsForCzIds: Function },
 *   loadRejectedCzIds: (ci: number) => Promise<number[]|null>,
 *   loadCiResendHold: (ci: number, czId: number) => Promise<object|null>,
 * }} deps
 * @param {{ ci: number, czSolicitudId: unknown, actorUserId: string }} input
 * @returns {Promise<{ status: number, body: object }>}
 */
async function sendRejectedToElm(deps, input) {
  return sendManualToElm(deps, {
    czSolicitudId: input.czSolicitudId,
    actorUserId: input.actorUserId,
    resolveMember: rejectedMember(deps, input.ci),
  });
}

/**
 * "Reintentar ELM" from Rechazados (pre-reception S1 failure of one of the CI's rejections).
 * @param {{
 *   orchestrator: { retrySendElm: Function, getSendReadiness: Function },
 *   listView: { cellsForCzIds: Function },
 *   loadRejectedCzIds: (ci: number) => Promise<number[]|null>,
 *   loadCiResendHold: (ci: number, czId: number, opts?: object) => Promise<object|null>,
 * }} deps
 * @param {{ ci: number, czSolicitudId: unknown, expectedAttempts: unknown, actorUserId: string }} input
 * @returns {Promise<{ status: number, body: object }>}
 */
async function retryRejectedElm(deps, input) {
  return retryManualToElm(deps, {
    czSolicitudId: input.czSolicitudId,
    expectedAttempts: input.expectedAttempts,
    actorUserId: input.actorUserId,
    resolveMember: rejectedMember(deps, input.ci),
  });
}

function rejectedMember(deps, ci) {
  return async function (czId) {
    const rejectedIds = await deps.loadRejectedCzIds(ci);
    if (!rejectedIds) return { status: 404, body: { ok: false, error: 'No encontrado' } };
    if (!rejectedIds.includes(czId)) {
      return { status: 404, body: { ok: false, code: NOT_IN_REJECTIONS } };
    }
    return { ci: ci };
  };
}

module.exports = {
  OUTCOMES,
  NOT_IN_REJECTIONS,
  SEND_NOT_READY,
  HISTORY_UNVERIFIABLE,
  outcomeOf,
  sendRejectedToElm,
  retryRejectedElm,
};
