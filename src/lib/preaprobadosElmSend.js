'use strict';

/**
 * "Enviar a ELM" from Preaprobados. Manual only (one operator click per solicitud); no CDV → ELM
 * automation and no batch.
 *
 * Membership = the CDV cohort (solicitud ever in CZ estado 8, historical or current), exactly
 * preaprobadosRead's rule. After membership the send IS the Rechazados manual send
 * (rejectedElmSend.sendRejectedToElm), unchanged: send readiness, CI resend guard (vigente process,
 * send in progress, monthly quota, ELM's 30-day duplicate window; an unreadable history blocks),
 * then orchestrator.sendElm (eligibility incl. CDV GRANTED and date of birth, DB CI lock, one
 * process per solicitud), and the answer read back from the persisted process. Its own membership
 * step is satisfied with the solicitud already checked here.
 *
 * List side: offered "Enviar a ELM" cells are held by the same CI rule as the send endpoint
 * (rejectedElmResendGuard + rejectedElmRead.holdSend), so the button says why before the click.
 */

const { fetchPreaprobadosDetailBundle } = require('./preaprobadosRead');
const { holdSend } = require('./rejectedElmRead');
const { HOLD, evaluateCiResendHold, readElmSendRowsByCis } = require('./rejectedElmResendGuard');
const { readPostReferralRejectionStatuses } = require('../services/elm/classification');
const { CODES } = require('../services/elm/constants');

const NOT_IN_PREAPROBADOS = 'elm_solicitud_not_in_preaprobados';
const SEND_NOT_READY = 'elm_send_not_ready';
const BLOCKED = 'blocked';

/**
 * rejectedElmSend requires routes/preaprobadosElm (statusFor), which requires this module: loaded
 * on first use so neither side ever sees a half-initialized export.
 */
function rejectedSend() {
  return require('./rejectedElmSend');
}

function parseCzId(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function blocked(status, code, czId, extra) {
  return {
    status: status,
    body: Object.assign({ ok: false, code: code, outcome: BLOCKED, cz_solicitud_id: czId }, extra || {}),
  };
}

/** `{ ci }` when the solicitud is in the CDV cohort; otherwise the blocking answer. */
async function loadPreaprobadoMember(supabase, czId) {
  const bundle = await fetchPreaprobadosDetailBundle(supabase, czId);
  if (!bundle.ok) {
    if (bundle.reason === 'invalid_cz_id') return blocked(400, CODES.INVALID_CZ_ID, czId);
    return blocked(404, NOT_IN_PREAPROBADOS, czId);
  }
  return { ci: bundle.solicitud ? bundle.solicitud.ci : null };
}

/**
 * @param {{
 *   orchestrator: { sendElm: Function, getSendReadiness: Function },
 *   listView: { cellsForCzIds: Function },
 *   loadMember: (czId: number) => Promise<{ ci: unknown } | { status: number, body: object }>,
 *   loadCiResendHold: (ci: number, czId: number) => Promise<object|null>,
 * }} deps
 * @param {{ czSolicitudId: unknown, actorUserId: string }} input
 * @returns {Promise<{ status: number, body: object }>}
 */
async function sendPreaprobadoToElm(deps, input) {
  const czId = parseCzId(input.czSolicitudId);
  if (czId == null) return { status: 400, body: { ok: false, code: CODES.INVALID_CZ_ID } };

  const readiness = deps.orchestrator.getSendReadiness();
  if (!readiness.ready) {
    return blocked(503, SEND_NOT_READY, czId, { reasons: readiness.reasons });
  }

  const member = await deps.loadMember(czId);
  if (!member) return blocked(404, NOT_IN_PREAPROBADOS, czId);
  if (member.status) return member;
  const ci = Number(member.ci);
  if (!Number.isSafeInteger(ci) || ci <= 0) {
    return blocked(422, CODES.MISSING_REQUIRED_FIELDS, czId, { fields: ['ci'] });
  }

  return rejectedSend().sendRejectedToElm(
    {
      orchestrator: deps.orchestrator,
      listView: deps.listView,
      loadRejectedCzIds: async function () {
        return [czId];
      },
      loadCiResendHold: deps.loadCiResendHold,
    },
    { ci: ci, czSolicitudId: czId, actorUserId: input.actorUserId },
  );
}

function isOfferedSend(cell) {
  return Boolean(cell && cell.kind === 'not_sent' && cell.action && cell.action.show === true);
}

/**
 * Holds the offered "Enviar a ELM" of each row (needs `cz_id`, `ci`, `elm` from attachElmCells)
 * with the CI rule of the send endpoint. Cells with a process are left as they are. If the ELM
 * history cannot be read the offered buttons are held as unverifiable (fail closed).
 * @param {object[]} rows
 * @param {{ supabase?: object, readRows?: Function, now?: () => number,
 *   postReferralRejectionStatuses?: string[], logger?: object }} [deps]
 */
async function attachPreaprobadosElmSendHolds(rows, deps) {
  const list = Array.isArray(rows) ? rows : [];
  const targets = list.filter(function (r) {
    return isOfferedSend(r && r.elm);
  });
  if (!targets.length) return list;
  const d = deps || {};
  const cis = Array.from(
    new Set(
      targets
        .map(function (r) {
          return Number(r.ci);
        })
        .filter(function (n) {
          return Number.isSafeInteger(n) && n > 0;
        }),
    ),
  );
  let elmRows = null;
  if (cis.length) {
    try {
      elmRows = await (d.readRows || readElmSendRowsByCis)(d.supabase, cis);
    } catch (err) {
      if (d.logger) {
        d.logger.warn('preaprobados elm send holds unavailable', {
          error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
        });
      }
    }
  }
  const nowMs = (d.now || Date.now)();
  const postReferral = d.postReferralRejectionStatuses || readPostReferralRejectionStatuses();
  for (const row of targets) {
    const ci = Number(row.ci);
    const hold =
      elmRows && Number.isSafeInteger(ci) && ci > 0
        ? evaluateCiResendHold({
            ci: ci,
            czSolicitudId: Number(row.cz_id),
            processes: elmRows.processes,
            states: elmRows.states,
            openRequests: elmRows.openRequests,
            locks: elmRows.locks,
            nowMs: nowMs,
            postReferralRejectionStatuses: postReferral,
          })
        : { reason: HOLD.UNVERIFIABLE, related_cz_solicitud_id: null, until: null };
    row.elm = holdSend(row.elm, hold);
  }
  return list;
}

module.exports = {
  NOT_IN_PREAPROBADOS,
  SEND_NOT_READY,
  loadPreaprobadoMember,
  sendPreaprobadoToElm,
  attachPreaprobadosElmSendHolds,
};
