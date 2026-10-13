'use strict';

/**
 * Manual "Enviar a ELM" (JANUS operator): the single send path shared by Rechazados and
 * Preaprobados. Each screen only says whether the solicitud belongs to it (`resolveMember`);
 * everything else is this path, in this order:
 *
 *   send readiness (transport + confirmed config) → screen membership → CI resend guard
 *   (rejectedElmResendGuard: vigente process, send in progress, monthly quota, ELM's 30-day
 *   duplicate window; an unreadable history blocks) → orchestrator.sendElm (S1, then S2 when S1
 *   is favorable; eligibility, DB CI lock and one process per solicitud stay its authority).
 * "Reintentar ELM" (retryManualToElm) uses the same gates and then orchestrator.retrySendElm
 * (same process, only when ELM provably never received the lead).
 *
 * Authorization (requireElmAction, admin session, never cron) is the caller's route gate.
 * The outcome is read back from the persisted process (refreshed cell), so the UI shows what is
 * stored: S1 rejected, S2 referred ("Preaprobado ELM", never a granted loan), pending, technical
 * error / ambiguous (review), grant, or not sent (blocked with a code).
 */

const { CODES } = require('../services/elm/constants');

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

const SEND_NOT_READY = 'elm_send_not_ready';
const HISTORY_UNVERIFIABLE = 'elm_ci_history_unverifiable';

const STATUS_BY_CODE = Object.freeze({
  [CODES.INVALID_CZ_ID]: 400,
  [CODES.INVALID_CONTEXT]: 400,
  [CODES.MANUAL_REQUIRES_USER]: 400,
  [CODES.TRIGGER_ORIGIN_NOT_ENABLED]: 403,
  [CODES.SEND_DISABLED]: 503,
  [CODES.SOLICITUD_NOT_FOUND]: 404,
  [CODES.PROCESS_NOT_FOUND]: 404,
  [CODES.PROCESS_EXISTS]: 409,
  [CODES.CI_LOCK_BLOCKED]: 409,
  [CODES.S1_NOT_ELIGIBLE]: 409,
  [CODES.S2_ALREADY_STARTED]: 409,
  [CODES.S2_NOT_STARTABLE]: 409,
  [CODES.LATE_RESULT_DISCARDED]: 409,
  [CODES.RETRY_STALE]: 409,
  [CODES.RETRY_NOT_PRE_RECEPTION]: 409,
  [CODES.RETRY_ATTEMPTS_EXHAUSTED]: 409,
  [CODES.RETRY_NOT_ALLOWED]: 409,
  [CODES.PERSIST_FAILED]: 500,
});

function statusFor(result) {
  if (result && result.ok) return 200;
  return STATUS_BY_CODE[result && result.code] || 422;
}

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
 * Readiness → screen membership → CI → CI resend guard. Returns `{ response }` when blocked.
 * @returns {Promise<{ response: { status: number, body: object } } | { ci: number }>}
 */
async function preflight(deps, input, czId, holdOpts) {
  const readiness = deps.orchestrator.getSendReadiness();
  if (!readiness.ready) {
    return {
      response: {
        status: 503,
        body: { ok: false, code: SEND_NOT_READY, reasons: readiness.reasons, outcome: OUTCOMES.BLOCKED },
      },
    };
  }
  const member = await input.resolveMember(czId);
  if (!member) return { response: { status: 404, body: { ok: false, error: 'No encontrado' } } };
  if (member.status) return { response: { status: member.status, body: member.body } };
  const ci = Number(member.ci);
  if (!Number.isSafeInteger(ci) || ci <= 0) {
    return {
      response: {
        status: 422,
        body: {
          ok: false,
          code: CODES.MISSING_REQUIRED_FIELDS,
          fields: ['ci'],
          outcome: OUTCOMES.BLOCKED,
          cz_solicitud_id: czId,
        },
      },
    };
  }

  let hold;
  try {
    hold = holdOpts
      ? await deps.loadCiResendHold(ci, czId, holdOpts)
      : await deps.loadCiResendHold(ci, czId);
  } catch (_) {
    hold = { reason: HISTORY_UNVERIFIABLE, related_cz_solicitud_id: null, until: null };
  }
  if (hold) {
    return {
      response: {
        status: hold.reason === HISTORY_UNVERIFIABLE ? 503 : 409,
        body: {
          ok: false,
          code: hold.reason,
          related_cz_solicitud_id: hold.related_cz_solicitud_id,
          until: hold.until,
          outcome: OUTCOMES.BLOCKED,
          cz_solicitud_id: czId,
        },
      },
    };
  }
  return { ci: ci };
}

/** Answer from the persisted process (refreshed cell), for send and retry alike. */
async function respondWithCell(deps, czId, out) {
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

/**
 * @param {{
 *   orchestrator: { sendElm: Function, getSendReadiness: Function },
 *   listView: { cellsForCzIds: Function },
 *   loadCiResendHold: (ci: number, czId: number) => Promise<object|null>,
 * }} deps
 * @param {{
 *   czSolicitudId: unknown,
 *   actorUserId: string,
 *   resolveMember: (czId: number) => Promise<{ ci: unknown } | { status: number, body: object }>,
 * }} input
 * @returns {Promise<{ status: number, body: object }>}
 */
async function sendManualToElm(deps, input) {
  const czId = parseCzId(input.czSolicitudId);
  if (czId == null) {
    return { status: 400, body: { ok: false, code: CODES.INVALID_CZ_ID } };
  }
  const pre = await preflight(deps, input, czId, null);
  if (pre.response) return pre.response;

  const out = await deps.orchestrator.sendElm(czId, {
    triggerOrigin: 'janus_manual',
    triggeredByUserId: input.actorUserId,
  });
  return respondWithCell(deps, czId, out);
}

/**
 * Manual "Reintentar ELM" of a solicitud whose S1 failed before ELM received the lead. Same
 * gates as the send (readiness, screen membership, CI guard over the CI's OTHER solicitudes);
 * the DB (elm_manual_retry_s1) decides whether this process may be retried.
 *
 * @param {{
 *   orchestrator: { retrySendElm: Function, getSendReadiness: Function },
 *   listView: { cellsForCzIds: Function },
 *   loadCiResendHold: (ci: number, czId: number, opts?: object) => Promise<object|null>,
 * }} deps
 * @param {{
 *   czSolicitudId: unknown,
 *   expectedAttempts: unknown,
 *   actorUserId: string,
 *   resolveMember: (czId: number) => Promise<{ ci: unknown } | { status: number, body: object }>,
 * }} input
 * @returns {Promise<{ status: number, body: object }>}
 */
async function retryManualToElm(deps, input) {
  const czId = parseCzId(input.czSolicitudId);
  if (czId == null) {
    return { status: 400, body: { ok: false, code: CODES.INVALID_CZ_ID } };
  }
  const expected = Number(input.expectedAttempts);
  if (!Number.isInteger(expected) || expected < 1) {
    return { status: 400, body: { ok: false, code: CODES.INVALID_CONTEXT, cz_solicitud_id: czId } };
  }
  const pre = await preflight(deps, input, czId, { retryOwnProcess: true });
  if (pre.response) return pre.response;

  const out = await deps.orchestrator.retrySendElm(
    czId,
    { triggerOrigin: 'janus_manual', triggeredByUserId: input.actorUserId },
    { expectedAttempts: expected },
  );
  return respondWithCell(deps, czId, out);
}

module.exports = {
  OUTCOMES,
  SEND_NOT_READY,
  HISTORY_UNVERIFIABLE,
  statusFor,
  outcomeOf,
  parseCzId,
  sendManualToElm,
  retryManualToElm,
};
