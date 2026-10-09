'use strict';

/**
 * ELM on Rechazados (read side; the send itself is rejectedElmSend.js).
 *
 * Rechazados stays one row per CI. The row's ELM summary is about the row's solicitud (latest
 * rejection) and also lists ELM processes on other solicitudes of the same CI. Exclusivity with
 * Preaprobados is per solicitud: a solicitud ever in estado 3 never joins the ELM cohort, so
 * manual sends stay here with their ELM state and never move to Preaprobados.
 *
 * `ci_active` (survey-gate meaning: any ELM process not definitively closed, granted included) is
 * informative. Whether a new solicitud of the CI can be sent is `send.hold`, from
 * rejectedElmResendGuard (same rule as the send endpoint): the ELM history stays visible and the
 * button is offered next to it when another rejected solicitud is eligible.
 */

const { computeElmCell } = require('../services/elm/listView');
const { readPostReferralRejectionStatuses } = require('../services/elm/classification');
const { computeElmSurveyBlocks } = require('./rejectedSurveyInviteElmGate');
const { HOLD, evaluateCiResendHold, readElmSendRowsByCis } = require('./rejectedElmResendGuard');

const CI_ACTIVE_REASON = HOLD.ACTIVE;
const CI_ACTIVE_HINT = 'Hay un proceso ELM vigente para esta CI';

function processSummary(p, cell) {
  return {
    cz_solicitud_id: Number(p.cz_solicitud_id),
    process_id: p.id || null,
    trigger_origin: p.trigger_origin || null,
    created_at: p.created_at || null,
    state: cell.state,
    label: cell.label,
    detail: cell.detail,
  };
}

function byCreatedDesc(a, b) {
  return String(b.created_at || '').localeCompare(String(a.created_at || ''));
}

/**
 * Pure: per-CI ELM view from the CI's ELM rows.
 * @param {{
 *   ci: number,
 *   focusCzIds?: number[],
 *   processes: object[],
 *   states?: object[],
 *   openRequests?: object[],
 *   nowMs: number,
 *   postReferralRejectionStatuses?: readonly string[],
 * }} input
 */
function summarizeCiElm(input) {
  const ci = Number(input.ci);
  const projected = new Map();
  for (const s of input.states || []) {
    projected.set(Number(s.cz_solicitud_id), Number(s.projected_estado));
  }
  const postReferral = input.postReferralRejectionStatuses || [];
  const focus = new Set((input.focusCzIds || []).map(Number));
  const cells = new Map();
  const others = [];
  for (const p of input.processes || []) {
    if (Number(p.ci) !== ci) continue;
    const czId = Number(p.cz_solicitud_id);
    const cell = computeElmCell({
      process: p,
      nowMs: input.nowMs,
      postReferralRejectionStatuses: postReferral,
      projectedEstado:
        p.trigger_origin === 'cz_automatic' && projected.has(czId) ? projected.get(czId) : null,
    });
    if (focus.has(czId)) cells.set(czId, cell);
    else others.push(processSummary(p, cell));
  }
  others.sort(byCreatedDesc);
  const blocks = computeElmSurveyBlocks({
    processes: (input.processes || []).filter(function (p) {
      return Number(p.ci) === ci;
    }),
    states: (input.states || []).filter(function (s) {
      return Number(s.ci) === ci;
    }),
    openRequests: (input.openRequests || []).filter(function (r) {
      return Number(r.ci) === ci;
    }),
    nowMs: input.nowMs,
    postReferralRejectionStatuses: postReferral,
  });
  return { cells: cells, other_processes: others, ci_active: blocks.get(ci) || null };
}

function groupByCi(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const ci = Number(r.ci);
    if (!map.has(ci)) map.set(ci, []);
    map.get(ci).push(r);
  }
  return map;
}

function validCzId(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** `[{ cz_solicitud_id, rejected_at }]`, one per solicitud, input order kept (newest first). */
function uniqueRejected(list) {
  const seen = new Set();
  const out = [];
  for (const r of list || []) {
    const id = validCzId(r && r.cz_solicitud_id);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    out.push({ cz_solicitud_id: id, rejected_at: (r.rejected_at || r.fechahora_src) || null });
  }
  return out;
}

/**
 * Not-sent cells while the CI is held (rejectedElmResendGuard): shown, never enabled. The hold
 * reason goes first; readiness / eligibility reasons are kept after it.
 */
function holdSend(cell, hold) {
  if (!hold || !cell || cell.kind !== 'not_sent' || !cell.action || !cell.action.show) {
    return cell;
  }
  const previous = Array.isArray(cell.action.reasons) ? cell.action.reasons : [];
  return Object.assign({}, cell, {
    action: Object.assign({}, cell.action, {
      enabled: false,
      reason: hold.reason,
      reasons: [hold.reason].concat(
        previous.filter(function (r) {
          return r !== hold.reason;
        }),
      ),
      hint: hold.reason === CI_ACTIVE_REASON ? CI_ACTIVE_HINT : cell.action.hint,
      hold: hold,
    }),
  });
}

/** Not-sent cells of a CI with an active ELM process: shown, never enabled. */
function holdSendForActiveCi(cell, ciActive) {
  return holdSend(cell, ciActive ? { reason: CI_ACTIVE_REASON, related_cz_solicitud_id: null, until: null } : null);
}

/**
 * Pure, shared by the Rechazados list and detail: per rejected solicitud cell (send held while
 * the CI is held by rejectedElmResendGuard) and which solicitud "Enviar a ELM" targets. Only
 * solicitudes without their own ELM process can be candidates. The target is set only when
 * exactly one solicitud can be sent; with several, `needs_selection` asks the operator to pick
 * one explicitly (the send endpoint always receives an explicit cz_solicitud_id).
 * @param {{ rejected: Array<{ cz_solicitud_id: number, rejected_at?: string|null }>,
 *   cells: Map<number, object>, hold: object|null }} input
 */
function resolveRejectedSend(input) {
  const cells = (input && input.cells) || new Map();
  const ciHold = (input && input.hold) || null;
  const solicitudes = [];
  const candidates = [];
  let notSendable = null;
  for (const r of uniqueRejected(input && input.rejected)) {
    const cell = holdSend(cells.get(r.cz_solicitud_id) || null, ciHold);
    solicitudes.push({ cz_solicitud_id: r.cz_solicitud_id, rejected_at: r.rejected_at, cell: cell });
    if (!cell) continue;
    if (cell.kind === 'not_sent' && cell.action && cell.action.show === true) {
      candidates.push({
        cz_solicitud_id: r.cz_solicitud_id,
        rejected_at: r.rejected_at,
        enabled: cell.action.enabled === true,
        reason: cell.action.reason || null,
        reasons: cell.action.reasons || (cell.action.reason ? [cell.action.reason] : []),
        hint: cell.action.hint || null,
        until: (cell.action.hold && cell.action.hold.until) || null,
      });
    } else if (cell.kind === 'not_sendable' && !notSendable) {
      notSendable = {
        cz_solicitud_id: r.cz_solicitud_id,
        reason: (cell.action && cell.action.reason) || null,
      };
    }
  }
  const enabled = candidates.filter(function (c) {
    return c.enabled;
  });
  return {
    solicitudes: solicitudes,
    send: {
      available: true,
      candidates: candidates,
      selectable_cz_ids: enabled.map(function (c) {
        return c.cz_solicitud_id;
      }),
      target_cz_id: enabled.length === 1 ? enabled[0].cz_solicitud_id : null,
      needs_selection: enabled.length > 1,
      not_sendable: candidates.length ? null : notSendable,
      hold: ciHold,
    },
  };
}

function ciHoldOf(ci, rows, nowMs, postReferral) {
  return evaluateCiResendHold({
    ci: ci,
    czSolicitudId: null,
    processes: rows.processes,
    states: rows.states,
    openRequests: rows.openRequests,
    locks: rows.locks,
    nowMs: nowMs,
    postReferralRejectionStatuses: postReferral,
  });
}

/**
 * Adds `elm` to each Rechazados list row (needs `ci`, `cz_solicitud_id`, `rejected_solicitudes`).
 * Same reads and send resolution as the detail (`loadRejectedDetailElm`). Fail-soft: if the ELM
 * rows cannot be read every row gets `{ available: false }`; if only the send evaluation fails,
 * the state is still shown and `send` is `{ available: false }`.
 * @param {object[]} rows
 * @param {{ supabase?: object, listView?: object, readRows?: Function, now?: () => number,
 *   postReferralRejectionStatuses?: string[], logger?: object }} [deps]
 * @returns {Promise<boolean>} available
 */
async function attachElmToRejectedRows(rows, deps) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return true;
  const d = deps || {};
  const warn = function (msg, err) {
    if (d.logger) {
      d.logger.warn(msg, {
        error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      });
    }
  };
  const rejectedByRow = list.map(function (row) {
    const own = uniqueRejected(row.rejected_solicitudes);
    return own.length
      ? own
      : uniqueRejected([{ cz_solicitud_id: row.cz_solicitud_id, rejected_at: row.rejected_at }]);
  });
  let elmRows;
  try {
    const cis = Array.from(
      new Set(
        list
          .map(function (row) {
            return Number(row.ci);
          })
          .filter(Number.isSafeInteger),
      ),
    );
    elmRows = await (d.readRows || readElmSendRowsByCis)(d.supabase, cis);
  } catch (err) {
    warn('rechazados elm unavailable', err);
    for (const row of list) row.elm = { available: false };
    return false;
  }
  let cells = null;
  if (d.listView) {
    try {
      const allIds = [];
      for (const rej of rejectedByRow) {
        for (const r of rej) allIds.push(r.cz_solicitud_id);
      }
      cells = await d.listView.cellsForCzIds(allIds, { allowSend: true });
    } catch (err) {
      warn('rechazados elm send view unavailable', err);
    }
  }
  const processesByCi = groupByCi(elmRows.processes);
  const statesByCi = groupByCi(elmRows.states);
  const requestsByCi = groupByCi(elmRows.openRequests);
  const locksByCi = Array.isArray(elmRows.locks) ? groupByCi(elmRows.locks) : null;
  const nowMs = (d.now || Date.now)();
  const postReferral = d.postReferralRejectionStatuses || readPostReferralRejectionStatuses();
  list.forEach(function (row, i) {
    const ci = Number(row.ci);
    const focusId = validCzId(row.cz_solicitud_id);
    const own = {
      processes: processesByCi.get(ci) || [],
      states: statesByCi.get(ci) || [],
      openRequests: requestsByCi.get(ci) || [],
      locks: locksByCi ? locksByCi.get(ci) || [] : undefined,
    };
    const s = summarizeCiElm({
      ci: ci,
      focusCzIds: focusId ? [focusId] : [],
      processes: own.processes,
      states: own.states,
      openRequests: own.openRequests,
      nowMs: nowMs,
      postReferralRejectionStatuses: postReferral,
    });
    row.elm = {
      available: true,
      cell: (focusId && s.cells.get(focusId)) || null,
      other_processes: s.other_processes,
      ci_active: s.ci_active,
      send: cells
        ? resolveRejectedSend({
            rejected: rejectedByRow[i],
            cells: cells,
            hold: ciHoldOf(ci, own, nowMs, postReferral),
          }).send
        : { available: false },
    };
  });
  return true;
}

/**
 * ELM block of GET /rechazados/:ci. One cell per rejected solicitud (with the "Enviar a ELM"
 * action), plus processes on other solicitudes of the CI. Fail-soft.
 * @param {object} supabase
 * @param {{ ci: number, rejections: Array<{ cz_solicitud_id: number }> }} detail
 * @param {{ listView: object, sendReadiness: () => object, now?: () => number,
 *   postReferralRejectionStatuses?: string[], readRows?: Function, logger?: object }} deps
 */
async function loadRejectedDetailElm(supabase, detail, deps) {
  const d = deps || {};
  try {
    const ci = Number(detail.ci);
    const rejected = uniqueRejected(detail.rejections);
    const rejectedIds = rejected.map(function (r) {
      return r.cz_solicitud_id;
    });
    const readiness = d.sendReadiness();
    const rows = await (d.readRows || readElmSendRowsByCis)(supabase, [ci]);
    const nowMs = (d.now || Date.now)();
    const postReferral = d.postReferralRejectionStatuses || readPostReferralRejectionStatuses();
    const s = summarizeCiElm({
      ci: ci,
      focusCzIds: rejectedIds,
      processes: rows.processes,
      states: rows.states,
      openRequests: rows.openRequests,
      nowMs: nowMs,
      postReferralRejectionStatuses: postReferral,
    });
    const cells = await d.listView.cellsForCzIds(rejectedIds, { allowSend: true });
    const resolved = resolveRejectedSend({
      rejected: rejected,
      cells: cells,
      hold: ciHoldOf(ci, rows, nowMs, postReferral),
    });
    return {
      available: true,
      send_readiness: readiness,
      ci_active: s.ci_active,
      solicitudes: resolved.solicitudes,
      send: resolved.send,
      other_processes: s.other_processes,
    };
  } catch (err) {
    if (d.logger) {
      d.logger.warn('rechazados detail elm unavailable', {
        error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      });
    }
    return { available: false };
  }
}

module.exports = {
  CI_ACTIVE_REASON,
  CI_ACTIVE_HINT,
  summarizeCiElm,
  attachElmToRejectedRows,
  holdSend,
  holdSendForActiveCi,
  resolveRejectedSend,
  loadRejectedDetailElm,
};
