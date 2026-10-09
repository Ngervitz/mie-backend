'use strict';

/**
 * ELM cell for any JANUS list (Preaprobados is only the first caller). Read-only.
 *
 * Precedence: GRANTED ELM (disbursed_at, shown "Otorgado") → ELM provider status text →
 * S2 referred ("Enviado") → JANUS technical S1/S2 state → never sent.
 * "Enviado"/referred is NOT granted. Only disbursed_at (set by "Convertido") is GRANTED ELM.
 *
 * Never sent: the future "Enviar a ELM" action is always disabled until the transport is
 * enabled. It is shown (disabled) when the only blockers are pending configuration; when the
 * solicitud is known not sendable it is not offered.
 */

const { S1, S2, CODES } = require('./constants');
const { readElmConfig } = require('./config');
const { evaluateElmEligibility } = require('./eligibility');

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

const TECHNICAL_LABELS = Object.freeze({
  in_flight: 'En curso',
  s1_eligible: 'Evaluado, sin enviar',
  s1_rejected: 'No elegible (S1)',
  s2_rejected: 'No derivado (S2)',
  unknown: 'Resultado incierto',
  technical_error: 'Error técnico',
});

function technicalKind(s1, s2) {
  if (s1 === S1.IN_FLIGHT || s2 === S2.IN_FLIGHT) return 'in_flight';
  if (s2 === S2.REJECTED) return 's2_rejected';
  if (s2 === S2.UNKNOWN) return 'unknown';
  if (s2 === S2.TECHNICAL_ERROR) return 'technical_error';
  if (s1 === S1.REJECTED) return 's1_rejected';
  if (s1 === S1.UNKNOWN) return 'unknown';
  if (s1 === S1.TECHNICAL_ERROR) return 'technical_error';
  if (s1 === S1.ELIGIBLE) return 's1_eligible';
  return 'unknown';
}

function noAction() {
  return { show: false, enabled: false, reason: null, blockers: [], hint: null };
}

/**
 * @param {{
 *   process: object|null,
 *   eligibility?: { eligible: boolean, blockers: Array<{ code: string }> }|null,
 *   nowMs: number,
 * }} input
 */
function computeElmCell(input) {
  const p = input && input.process ? input.process : null;
  const nowMs = input && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();

  if (p) {
    const s1 = effective(p.s1_status, p.s1_lease_expires_at, nowMs);
    const s2 = effective(p.s2_status, p.s2_lease_expires_at, nowMs);
    const base = {
      granted_elm: Boolean(p.disbursed_at),
      provider_status: p.provider_status || null,
      provider_status_at: p.provider_status_at || null,
      disbursed_at: p.disbursed_at || null,
      s1_status: s1,
      s2_status: s2,
      action: noAction(),
    };
    if (p.disbursed_at) return Object.assign({ kind: 'granted', label: 'Otorgado' }, base);
    if (p.provider_status) {
      return Object.assign({ kind: 'provider_status', label: String(p.provider_status) }, base);
    }
    if (s2 === S2.REFERRED) return Object.assign({ kind: 'referred', label: 'Enviado' }, base);
    const kind = technicalKind(s1, s2);
    return Object.assign({ kind: kind, label: TECHNICAL_LABELS[kind] }, base);
  }

  const blockers = (input && input.eligibility && input.eligibility.blockers) || [];
  const codes = blockers.map(function (b) {
    return b.code;
  });
  const hard = codes.filter(function (c) {
    return !isConfigPendingBlocker(c);
  });
  const common = {
    granted_elm: false,
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
  return Object.assign(
    {
      kind: 'not_sent',
      label: 'Sin enviar',
      action: {
        show: true,
        enabled: false,
        reason: CODES.SEND_DISABLED,
        blockers: codes,
        hint: SEND_PENDING_HINT,
      },
    },
    common,
  );
}

function unavailableCell() {
  return {
    kind: 'unavailable',
    label: 'No disponible',
    granted_elm: false,
    provider_status: null,
    provider_status_at: null,
    disbursed_at: null,
    s1_status: null,
    s2_status: null,
    action: noAction(),
  };
}

/**
 * Batched: a constant number of queries per page (processes, then solicitud context only for
 * ids without process), never one query per row.
 * @param {{ repository?: object, config?: object, now?: () => number }} [deps]
 */
function createElmListView(deps) {
  const d = deps || {};
  const repo = d.repository || require('./repository').createElmRepository();
  const config = d.config || readElmConfig();
  const now = d.now || Date.now;

  /** @returns {Promise<Map<number, object>>} cz_id → cell */
  async function cellsForCzIds(czIds) {
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
    const missing = ids.filter(function (id) {
      return !processes.has(id);
    });
    let contexts = new Map();
    if (missing.length) {
      contexts = await repo.loadSolicitudContexts(missing);
    }

    for (const id of ids) {
      const process = processes.get(id) || null;
      if (process) {
        out.set(id, computeElmCell({ process: process, nowMs: nowMs }));
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
          eligibility: eligibility,
          nowMs: nowMs,
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
 */
async function attachElmCells(rows, listView, logger) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;
  let cells = null;
  try {
    cells = await listView.cellsForCzIds(
      list.map(function (r) {
        return r.cz_id;
      }),
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
