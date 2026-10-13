'use strict';

/**
 * "Enviar a ELM" from Preaprobados. Manual only (operator decision); no CDV → ELM automation.
 *
 * Membership = the CDV cohort (solicitud ever in CZ estado 8, historical or current, exactly
 * preaprobadosRead's rule). The send is the shared manual path (elmManualSend.js), the same one
 * Rechazados uses: readiness, CI resend guard, eligibility (CDV GRANTED blocks), DB CI lock,
 * one process per solicitud. ELM-only cohort rows already have their process, so they are never
 * sent again.
 *
 * List side: the not-sent cells (listView, allowSend) are held by the same CI rule as the send
 * endpoint (rejectedElmResendGuard), so the button says why before the click.
 */

const { fetchPreaprobadosDetailBundle } = require('./preaprobadosRead');
const { sendManualToElm } = require('./elmManualSend');
const { holdSend } = require('./rejectedElmRead');
const { HOLD, evaluateCiResendHold, readElmSendRowsByCis } = require('./rejectedElmResendGuard');
const { readPostReferralRejectionStatuses } = require('../services/elm/classification');

const NOT_IN_PREAPROBADOS = 'elm_solicitud_not_in_preaprobados';

/** `{ ci }` when the solicitud is in the CDV cohort; otherwise the 404 answer. */
async function loadPreaprobadoMember(supabase, czId) {
  const bundle = await fetchPreaprobadosDetailBundle(supabase, czId);
  if (!bundle.ok) {
    return { status: 404, body: { ok: false, code: NOT_IN_PREAPROBADOS, cz_solicitud_id: czId } };
  }
  return { ci: bundle.solicitud && bundle.solicitud.ci };
}

/**
 * @param {{
 *   orchestrator: { sendElm: Function, getSendReadiness: Function },
 *   listView: { cellsForCzIds: Function },
 *   loadMember: (czId: number) => Promise<{ ci: unknown } | { status: number, body: object }>,
 *   loadCiResendHold: (ci: number, czId: number) => Promise<object|null>,
 * }} deps
 * @param {{ czSolicitudId: unknown, actorUserId: string }} input
 */
async function sendPreaprobadoToElm(deps, input) {
  return sendManualToElm(deps, {
    czSolicitudId: input.czSolicitudId,
    actorUserId: input.actorUserId,
    resolveMember: deps.loadMember,
  });
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
  loadPreaprobadoMember,
  sendPreaprobadoToElm,
  attachPreaprobadosElmSendHolds,
};
