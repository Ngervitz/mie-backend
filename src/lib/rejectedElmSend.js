'use strict';

/**
 * "Enviar a ELM" from Rechazados: one action, S1 then S2 automatically when S1 is favorable
 * (orchestrator.sendElm). Validation, authorization (requireElmAction), idempotency
 * (one process per solicitud) and the CI lock are the existing ones.
 *
 * The outcome is read back from the persisted process (refreshed cell), so the UI shows what is
 * stored: S1 rejected, S2 referred ("Preaprobado ELM", never a granted loan), pending, technical
 * error / ambiguous (review), grant, or not sent (blocked with a code).
 */

const { CODES } = require('../services/elm/constants');
const { statusFor } = require('../routes/preaprobadosElm');

const OUTCOMES = Object.freeze({
  S1_REJECTED: 's1_rejected',
  REJECTED: 'rejected',
  REFERRED: 'referred',
  GRANTED: 'granted',
  PENDING: 'pending',
  TECHNICAL_ERROR: 'technical_error',
  REVIEW: 'review',
  CLOSED: 'closed',
  BLOCKED: 'blocked',
});

const NOT_IN_REJECTIONS = 'elm_solicitud_not_in_rejections';
const SEND_NOT_READY = 'elm_send_not_ready';

function outcomeOf(cell) {
  if (!cell || !cell.state) return OUTCOMES.BLOCKED;
  switch (cell.state) {
    case 'rejected':
      return cell.stage === 's1' ? OUTCOMES.S1_REJECTED : OUTCOMES.REJECTED;
    case 'referred':
      return OUTCOMES.REFERRED;
    case 'granted':
      return OUTCOMES.GRANTED;
    case 'in_evaluation':
      return OUTCOMES.PENDING;
    case 'closed':
      return OUTCOMES.CLOSED;
    default:
      return /technical_error/.test(String(cell.detail || ''))
        ? OUTCOMES.TECHNICAL_ERROR
        : OUTCOMES.REVIEW;
  }
}

function parseCzId(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * @param {{
 *   orchestrator: { sendElm: Function, getSendReadiness: Function },
 *   listView: { cellsForCzIds: Function },
 *   loadRejectedCzIds: (ci: number) => Promise<number[]|null>,
 * }} deps
 * @param {{ ci: number, czSolicitudId: unknown, actorUserId: string }} input
 * @returns {Promise<{ status: number, body: object }>}
 */
async function sendRejectedToElm(deps, input) {
  const czId = parseCzId(input.czSolicitudId);
  if (czId == null) {
    return { status: 400, body: { ok: false, code: CODES.INVALID_CZ_ID } };
  }
  const rejectedIds = await deps.loadRejectedCzIds(input.ci);
  if (!rejectedIds) return { status: 404, body: { ok: false, error: 'No encontrado' } };
  if (!rejectedIds.includes(czId)) {
    return { status: 404, body: { ok: false, code: NOT_IN_REJECTIONS } };
  }
  const readiness = deps.orchestrator.getSendReadiness();
  if (!readiness.ready) {
    return {
      status: 503,
      body: { ok: false, code: SEND_NOT_READY, reasons: readiness.reasons, outcome: OUTCOMES.BLOCKED },
    };
  }

  const out = await deps.orchestrator.sendElm(czId, {
    triggerOrigin: 'janus_manual',
    triggeredByUserId: input.actorUserId,
  });
  const cells = await deps.listView.cellsForCzIds([czId], { allowSend: true });
  const cell = cells.get(czId) || null;
  const hasProcess = Boolean(cell && cell.state);
  return {
    status: out.ok ? 200 : statusFor(out),
    body: {
      ok: out.ok === true,
      code: out.ok ? null : out.code || null,
      stage: out.stage || null,
      s2_blocked: out.s2_blocked || null,
      outcome: out.ok || hasProcess ? outcomeOf(cell) : OUTCOMES.BLOCKED,
      cz_solicitud_id: czId,
      cell: cell,
    },
  };
}

module.exports = {
  OUTCOMES,
  NOT_IN_REJECTIONS,
  SEND_NOT_READY,
  outcomeOf,
  sendRejectedToElm,
};
