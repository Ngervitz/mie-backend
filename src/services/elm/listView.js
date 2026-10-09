'use strict';

/**
 * ELM cell for any JANUS list (Preaprobados, Rechazados). Read-only.
 *
 * With a process the cell shows the commercial state (src/services/elm/classification.js):
 * "Preaprobado ELM" = S2 referred (derivado a ventas, never a granted loan), "Otorgado ELM" only
 * with disbursed_at, "Rechazado ELM" only with definitive evidence; uncertain / technical
 * results are "pendiente de revisión". The raw ELM postback status is kept as extra info.
 *
 * Without a process: "Enviar a ELM" is offered only where the caller allows it (Rechazados);
 * it is enabled only when the send readiness (transport + confirmed config) is complete and
 * the solicitud passes eligibility. Otherwise it is shown disabled or not offered.
 */

const { CODES } = require('./constants');
const { readElmConfig } = require('./config');
const { evaluateElmEligibility } = require('./eligibility');
const { classifyElmProcess, readPostReferralRejectionStatuses } = require('./classification');

const SEND_PENDING_HINT = 'Integración ELM pendiente de habilitación';

function isExpired(leaseIso, nowMs) {
  if (!leaseIso) return false;
  const t = Date.parse(String(leaseIso));
  return Number.isFinite(t) && t < nowMs;
}

function effective(status, leaseIso, nowMs) {
  return status === 'in_flight' && isExpired(leaseIso, nowMs) ? 'unknown' : status;
}

/** Blockers that only mean "ELM configuration not loaded yet". */
function isConfigPendingBlocker(code) {
  return code === CODES.ACTIVITY_TYPE_MAPPING_MISSING;
}

function noAction() {
  return { show: false, enabled: false, reason: null, blockers: [], hint: null };
}

/**
 * @param {{
 *   process: object|null,
 *   czId?: number,
 *   eligibility?: { eligible: boolean, blockers: Array<{ code: string }> }|null,
 *   nowMs: number,
 *   postReferralRejectionStatuses?: readonly string[],
 *   projectedEstado?: number|null,
 *   allowSend?: boolean,
 *   sendReadiness?: { ready: boolean, reasons: string[] }|null,
 * }} input
 */
function computeElmCell(input) {
  const p = input && input.process ? input.process : null;
  const nowMs = input && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();

  if (p) {
    const c = classifyElmProcess(p, {
      nowMs: nowMs,
      postReferralRejectionStatuses: input.postReferralRejectionStatuses || [],
      projectedEstado: input.projectedEstado,
    });
    const showDetail = c.state === 'rejected' || c.state === 'review' || c.state === 'closed';
    return {
      kind: c.state,
      label: showDetail ? c.detail_label : c.label,
      state: c.state,
      detail: c.detail,
      detail_label: c.detail_label,
      stage: c.stage,
      process_id: p.id || null,
      cz_solicitud_id: p.cz_solicitud_id != null ? Number(p.cz_solicitud_id) : null,
      trigger_origin: p.trigger_origin || null,
      granted_elm: Boolean(p.disbursed_at),
      referred_at: p.referred_at || null,
      provider_status: p.provider_status || null,
      provider_status_at: p.provider_status_at || null,
      disbursed_at: p.disbursed_at || null,
      s1_status: effective(p.s1_status, p.s1_lease_expires_at, nowMs),
      s2_status: effective(p.s2_status, p.s2_lease_expires_at, nowMs),
      action: noAction(),
    };
  }

  const blockers = (input && input.eligibility && input.eligibility.blockers) || [];
  const codes = blockers.map(function (b) {
    return b.code;
  });
  const hard = codes.filter(function (c) {
    return !isConfigPendingBlocker(c);
  });
  const czId = input ? Number(input.czId) : NaN;
  const common = {
    state: null,
    detail: null,
    detail_label: null,
    stage: null,
    process_id: null,
    cz_solicitud_id: Number.isSafeInteger(czId) && czId > 0 ? czId : null,
    trigger_origin: null,
    granted_elm: false,
    referred_at: null,
    provider_status: null,
    provider_status_at: null,
    disbursed_at: null,
    s1_status: null,
    s2_status: null,
  };
  if (!input || !input.eligibility || hard.length) {
    return Object.assign(
      {
        kind: 'not_sendable',
        label: 'No enviable',
        action: {
          show: false,
          enabled: false,
          reason: hard[0] || CODES.SOLICITUD_NOT_FOUND,
          blockers: codes,
          hint: null,
        },
      },
      common,
    );
  }
  const allowSend = input.allowSend === true;
  const readiness = input.sendReadiness || null;
  const ready = Boolean(readiness && readiness.ready === true);
  const enabled = allowSend && ready && input.eligibility.eligible === true && !codes.length;
  let reasons = [];
  if (!enabled) {
    const notReady = !ready
      ? (readiness && readiness.reasons && readiness.reasons.length
        ? readiness.reasons
        : [CODES.SEND_DISABLED])
      : [];
    reasons = Array.from(new Set(notReady.concat(codes)));
    if (!reasons.length) reasons = [CODES.SEND_DISABLED];
  }
  const reason = enabled ? null : reasons[0];
  return Object.assign(
    {
      kind: 'not_sent',
      label: 'Sin enviar',
      action: {
        show: allowSend,
        enabled: enabled,
        reason: reason,
        reasons: reasons,
        blockers: codes,
        hint: enabled ? null : SEND_PENDING_HINT,
      },
    },
    common,
  );
}

function unavailableCell() {
  return {
    kind: 'unavailable',
    label: 'No disponible',
    state: null,
    detail: null,
    detail_label: null,
    stage: null,
    process_id: null,
    cz_solicitud_id: null,
    trigger_origin: null,
    granted_elm: false,
    referred_at: null,
    provider_status: null,
    provider_status_at: null,
    disbursed_at: null,
    s1_status: null,
    s2_status: null,
    action: noAction(),
  };
}

/**
 * Batched: a constant number of queries per page (processes, C1 projected estado only when
 * there are automatic processes, then solicitud context only for ids without process).
 * @param {{
 *   repository?: object,
 *   config?: object,
 *   now?: () => number,
 *   postReferralRejectionStatuses?: readonly string[],
 *   sendReadiness?: () => { ready: boolean, reasons: string[] },
 * }} [deps]
 */
function createElmListView(deps) {
  const d = deps || {};
  const repo = d.repository || require('./repository').createElmRepository();
  const config = d.config || readElmConfig();
  const now = d.now || Date.now;
  const postReferral = d.postReferralRejectionStatuses || readPostReferralRejectionStatuses();
  const sendReadiness = d.sendReadiness || null;

  /**
   * @param {number[]} czIds
   * @param {{ allowSend?: boolean }} [opts] allowSend defaults to false (only Rechazados offers it)
   * @returns {Promise<Map<number, object>>} cz_id → cell
   */
  async function cellsForCzIds(czIds, opts) {
    const allowSend = Boolean(opts && opts.allowSend === true);
    const ids = Array.from(
      new Set(
        (czIds || [])
          .map(Number)
          .filter(function (n) {
            return Number.isSafeInteger(n) && n > 0;
          }),
      ),
    );
    const out = new Map();
    if (!ids.length) return out;
    const nowMs = now();

    const processes = await repo.getProcessesByCzIds(ids);
    const automaticIds = [];
    for (const p of processes.values()) {
      if (p.trigger_origin === 'cz_automatic') automaticIds.push(Number(p.cz_solicitud_id));
    }
    let projected = new Map();
    if (automaticIds.length && typeof repo.getProjectedEstadosByCzIds === 'function') {
      projected = await repo.getProjectedEstadosByCzIds(automaticIds);
    }
    const missing = ids.filter(function (id) {
      return !processes.has(id);
    });
    let contexts = new Map();
    if (missing.length) {
      contexts = await repo.loadSolicitudContexts(missing);
    }
    const readiness = allowSend && sendReadiness ? sendReadiness() : null;

    for (const id of ids) {
      const process = processes.get(id) || null;
      if (process) {
        out.set(
          id,
          computeElmCell({
            process: process,
            nowMs: nowMs,
            postReferralRejectionStatuses: postReferral,
            projectedEstado: projected.has(id) ? projected.get(id) : null,
          }),
        );
        continue;
      }
      const ctx = contexts.get(id) || { solicitud: null, grantedRow: null };
      const eligibility = evaluateElmEligibility({
        czId: id,
        solicitud: ctx.solicitud,
        grantedRow: ctx.grantedRow,
        config: config,
      });
      out.set(
        id,
        computeElmCell({
          process: null,
          czId: id,
          eligibility: eligibility,
          nowMs: nowMs,
          allowSend: allowSend,
          sendReadiness: readiness,
        }),
      );
    }
    return out;
  }

  return { cellsForCzIds };
}

/**
 * Adds `elm` to each row (rows need `cz_id`). Never fails the caller's list: on any error
 * (e.g. ELM tables not reachable) every row gets the "unavailable" cell.
 * @param {object[]} rows
 * @param {{ cellsForCzIds: Function }} listView
 * @param {{ warn: Function }} [logger]
 * @param {{ allowSend?: boolean }} [opts]
 */
async function attachElmCells(rows, listView, logger, opts) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;
  let cells = null;
  try {
    cells = await listView.cellsForCzIds(
      list.map(function (r) {
        return r.cz_id;
      }),
      opts,
    );
  } catch (err) {
    if (logger) {
      logger.warn('elm list cells unavailable', {
        error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      });
    }
  }
  for (const row of list) {
    row.elm = (cells && cells.get(Number(row.cz_id))) || unavailableCell();
  }
  return list;
}

module.exports = {
  SEND_PENDING_HINT,
  computeElmCell,
  unavailableCell,
  isConfigPendingBlocker,
  createElmListView,
  attachElmCells,
};
