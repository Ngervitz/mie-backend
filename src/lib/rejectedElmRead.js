'use strict';

/**
 * ELM on Rechazados (read-only).
 *
 * Rechazados stays one row per CI. The row's ELM summary is about the row's solicitud (latest
 * rejection) and also lists ELM processes on other solicitudes of the same CI. Exclusivity with
 * Preaprobados is per solicitud: a solicitud ever in estado 3 never joins the ELM cohort, so
 * manual sends stay here with their ELM state and never move to Preaprobados.
 *
 * A CI with an ELM process that is not definitively closed (in evaluation, review, referred,
 * granted), an automatic solicitud still open in CZ or a queued fallback request has
 * `ci_active`: no new send is offered for it (the CI lock enforces the same server-side).
 */

const { computeElmCell } = require('../services/elm/listView');
const { readPostReferralRejectionStatuses } = require('../services/elm/classification');
const { readElmRowsByCis, computeElmSurveyBlocks } = require('./rejectedSurveyInviteElmGate');

const CI_ACTIVE_REASON = 'elm_ci_active';
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

/**
 * Adds `elm` to each Rechazados list row (needs `ci`, `cz_solicitud_id`). Fail-soft: on error
 * every row gets `{ available: false }` and the list still renders.
 * @param {object[]} rows
 * @param {{ repository?: object, now?: () => number, postReferralRejectionStatuses?: string[], logger?: object }} [deps]
 * @returns {Promise<boolean>} available
 */
async function attachElmToRejectedRows(rows, deps) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return true;
  const d = deps || {};
  try {
    const repo = d.repository || require('../services/elm/repository').createElmRepository();
    const processes = await repo.listAllProcesses();
    const automaticIds = processes
      .filter(function (p) {
        return p.trigger_origin === 'cz_automatic';
      })
      .map(function (p) {
        return Number(p.cz_solicitud_id);
      });
    const projected = automaticIds.length
      ? await repo.getProjectedEstadosByCzIds(automaticIds)
      : new Map();
    const states = [];
    for (const p of processes) {
      const czId = Number(p.cz_solicitud_id);
      if (projected.has(czId)) {
        states.push({ cz_solicitud_id: czId, ci: p.ci, projected_estado: projected.get(czId) });
      }
    }
    const processesByCi = groupByCi(processes);
    const statesByCi = groupByCi(states);
    const nowMs = (d.now || Date.now)();
    const postReferral = d.postReferralRejectionStatuses || readPostReferralRejectionStatuses();
    for (const row of list) {
      const ci = Number(row.ci);
      const own = processesByCi.get(ci);
      if (!own) {
        row.elm = { available: true, cell: null, other_processes: [], ci_active: null };
        continue;
      }
      const focusId = Number(row.cz_solicitud_id);
      const s = summarizeCiElm({
        ci: ci,
        focusCzIds: [focusId],
        processes: own,
        states: statesByCi.get(ci) || [],
        nowMs: nowMs,
        postReferralRejectionStatuses: postReferral,
      });
      row.elm = {
        available: true,
        cell: s.cells.get(focusId) || null,
        other_processes: s.other_processes,
        ci_active: s.ci_active,
      };
    }
    return true;
  } catch (err) {
    if (d.logger) {
      d.logger.warn('rechazados elm unavailable', {
        error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      });
    }
    for (const row of list) row.elm = { available: false };
    return false;
  }
}

/** Not-sent cells of a CI with an active ELM process: shown, never enabled. */
function holdSendForActiveCi(cell, ciActive) {
  if (!ciActive || !cell || cell.kind !== 'not_sent' || !cell.action || !cell.action.show) {
    return cell;
  }
  return Object.assign({}, cell, {
    action: Object.assign({}, cell.action, {
      enabled: false,
      reason: CI_ACTIVE_REASON,
      hint: CI_ACTIVE_HINT,
    }),
  });
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
    const rejectedIds = Array.from(
      new Set(
        (detail.rejections || [])
          .map(function (r) {
            return Number(r.cz_solicitud_id);
          })
          .filter(function (n) {
            return Number.isSafeInteger(n) && n > 0;
          }),
      ),
    );
    const readiness = d.sendReadiness();
    const rows = await (d.readRows || readElmRowsByCis)(supabase, [ci]);
    const s = summarizeCiElm({
      ci: ci,
      focusCzIds: rejectedIds,
      processes: rows.processes,
      states: rows.states,
      openRequests: rows.openRequests,
      nowMs: (d.now || Date.now)(),
      postReferralRejectionStatuses:
        d.postReferralRejectionStatuses || readPostReferralRejectionStatuses(),
    });
    const cells = await d.listView.cellsForCzIds(rejectedIds, { allowSend: true });
    return {
      available: true,
      send_readiness: readiness,
      ci_active: s.ci_active,
      solicitudes: rejectedIds.map(function (id) {
        return { cz_solicitud_id: id, cell: holdSendForActiveCi(cells.get(id) || null, s.ci_active) };
      }),
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
  holdSendForActiveCi,
  loadRejectedDetailElm,
};
