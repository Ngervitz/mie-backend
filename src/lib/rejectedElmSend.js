'use strict';

/**
 * "Enviar a ELM" from Rechazados: one action, S1 then S2 automatically when S1 is favorable
 * (orchestrator.sendElm). Validation, authorization (requireElmAction), idempotency
 * (one process per solicitud) and the CI lock are the existing ones. Before them, the CI's other
 * solicitudes are checked with rejectedElmResendGuard (the same rule the list and detail show):
 * vigente process, send in progress, monthly quota and ELM's 30-day duplicate window; an
 * unreadable history blocks. A solicitud with its own process skips that check and reaches the
 * orchestrator as before (elm_process_exists or S2 resume).
 *
 * "Reintentar ELM" (retryRejectedElm) uses the same gates, with the CI's other solicitudes still
 * evaluated for the solicitud's own process, then orchestrator.retrySendElm (same process, only
 * when ELM provably never received the lead).
 *
 * The outcome is read back from the persisted process (refreshed cell), so the UI shows what is
 * stored: S1 rejected, S1 duplicate approved by another channel, S2 referred ("Preaprobado ELM",
 * never a granted loan), pending, technical error / ambiguous (review), grant, or not sent
 * (blocked with a code).
 */

const { CODES, SEND_ORIGIN } = require('../services/elm/constants');
const { DUPLICATE_OTHER_CHANNEL_DETAIL } = require('../services/elm/classification');
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
  DUPLICATE_OTHER_CHANNEL: 'duplicate_other_channel',
  BLOCKED: 'blocked',
});

const NOT_IN_REJECTIONS = 'elm_solicitud_not_in_rejections';
const SEND_NOT_READY = 'elm_send_not_ready';
const HISTORY_UNVERIFIABLE = 'elm_ci_history_unverifiable';

const RETRY_REFUSAL_CODES = Object.freeze([
  CODES.RETRY_STALE,
  CODES.RETRY_NOT_PRE_RECEPTION,
  CODES.RETRY_ATTEMPTS_EXHAUSTED,
  CODES.RETRY_NOT_ALLOWED,
]);

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
      return cell.detail === DUPLICATE_OTHER_CHANNEL_DETAIL ? OUTCOMES.DUPLICATE_OTHER_CHANNEL : OUTCOMES.CLOSED;
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

/** Membership → send readiness → CI resend guard. Returns the blocking answer, or null. */
async function preflight(deps, input, czId, holdOpts) {
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
  let hold;
  try {
    hold = holdOpts
      ? await deps.loadCiResendHold(input.ci, czId, holdOpts)
      : await deps.loadCiResendHold(input.ci, czId);
  } catch (_) {
    hold = { reason: HISTORY_UNVERIFIABLE, related_cz_solicitud_id: null, until: null };
  }
  if (hold) {
    return {
      status: hold.reason === HISTORY_UNVERIFIABLE ? 503 : 409,
      body: {
        ok: false,
        code: hold.reason,
        related_cz_solicitud_id: hold.related_cz_solicitud_id,
        until: hold.until,
        outcome: OUTCOMES.BLOCKED,
        cz_solicitud_id: czId,
      },
    };
  }
  return null;
}

/** Answer from the persisted process (refreshed cell), for send and retry alike. */
async function respondWithCell(deps, czId, out) {
  const cells = await deps.listView.cellsForCzIds([czId], { allowSend: true });
  const cell = cells.get(czId) || null;
  const hasProcess = Boolean(cell && cell.state);
  let status = 200;
  if (!out.ok) status = RETRY_REFUSAL_CODES.includes(out.code) ? 409 : statusFor(out);
  return {
    status: status,
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

/**
 * @param {{
 *   orchestrator: { sendElm: Function, getSendReadiness: Function },
 *   listView: { cellsForCzIds: Function },
 *   loadRejectedCzIds: (ci: number) => Promise<number[]|null>,
 *   loadCiResendHold: (ci: number, czId: number) => Promise<object|null>,
 *   sendOrigin?: string,   server wiring only (Preaprobados); default rechazados_manual
 * }} deps
 * @param {{ ci: number, czSolicitudId: unknown, actorUserId: string }} input
 * @returns {Promise<{ status: number, body: object }>}
 */
async function sendRejectedToElm(deps, input) {
  const czId = parseCzId(input.czSolicitudId);
  if (czId == null) {
    return { status: 400, body: { ok: false, code: CODES.INVALID_CZ_ID } };
  }
  const blocked = await preflight(deps, input, czId, null);
  if (blocked) return blocked;

  const out = await deps.orchestrator.sendElm(czId, {
    triggerOrigin: 'janus_manual',
    triggeredByUserId: input.actorUserId,
    sendOrigin: deps.sendOrigin || SEND_ORIGIN.RECHAZADOS_MANUAL,
  });
  return respondWithCell(deps, czId, out);
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
  const czId = parseCzId(input.czSolicitudId);
  if (czId == null) {
    return { status: 400, body: { ok: false, code: CODES.INVALID_CZ_ID } };
  }
  const expected = Number(input.expectedAttempts);
  if (!Number.isInteger(expected) || expected < 1) {
    return { status: 400, body: { ok: false, code: CODES.INVALID_CONTEXT, cz_solicitud_id: czId } };
  }
  const blocked = await preflight(deps, input, czId, { retryOwnProcess: true });
  if (blocked) return blocked;

  const out = await deps.orchestrator.retrySendElm(
    czId,
    { triggerOrigin: 'janus_manual', triggeredByUserId: input.actorUserId },
    { expectedAttempts: expected },
  );
  return respondWithCell(deps, czId, out);
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
