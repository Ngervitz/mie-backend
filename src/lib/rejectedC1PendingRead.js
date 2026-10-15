'use strict';

/**
 * C1 solicitudes with open projected CZ estado (12 / 14 / 15) for Rechazados «Pendientes ELM».
 * Not part of rejectedUniverseByCi (estado 3 only). No survey / BCU / outreach assembly here.
 */

const { OUTCOME } = require('../services/providerFallback/constants');

/** Query ?status= for the Pendientes ELM filter (not an ops_status). */
const C1_PENDING_LIST_STATUS = 'c1_pending_elm';

const C1_PENDING_PROJECTED_ESTADOS = Object.freeze([12, 14, 15]);

const PROJECTED_ESTADO_LABELS = Object.freeze({
  12: 'Evaluando alternativa (12)',
  14: 'Alternativa en revisión (14)',
  15: 'Derivación vigente en otra solicitud (15)',
});

const PAGE_SIZE = 1000;

const SOLICITUD_SELECT = 'cz_id, ci, nombre, apellido, fecha_reg, solicitudes_estados_id, updated_at_src';

const FALLBACK_SELECT =
  'cz_solicitud_id, outcome, reason_code, exec_status, finalized_at, created_at';

const REVIEW_SELECT =
  'id, fallback_request_id, cz_solicitud_id, ci, reason_code, status, created_at';

function rpcError(name, error) {
  return new Error(name + ' failed: ' + String((error && error.message) || error));
}

function toNum(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function nonemptyText(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

function cmpTsDescNullsLast(a, b) {
  const ta = a == null || a === '' ? null : Date.parse(String(a));
  const tb = b == null || b === '' ? null : Date.parse(String(b));
  if (ta == null && tb == null) return 0;
  if (ta == null) return 1;
  if (tb == null) return -1;
  if (tb > ta) return 1;
  if (tb < ta) return -1;
  return 0;
}

function projectedEstadoLabel(estado) {
  const n = Number(estado);
  return PROJECTED_ESTADO_LABELS[n] || 'Estado CZ ' + String(estado);
}

function reviewReasonLabel(row, fallback) {
  if (nonemptyText(row && row.reason_code)) return row.reason_code;
  if (fallback && nonemptyText(fallback.reason_code)) return fallback.reason_code;
  return null;
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isC1PendingListStatus(raw) {
  if (raw == null) return false;
  return String(raw).trim() === C1_PENDING_LIST_STATUS;
}

/**
 * @param {{
 *   states: object[],
 *   solicitudesByCz: Map<number, object>,
 *   fallbacksByCz: Map<number, object>,
 *   reviewByCz: Map<number, object>,
 *   elmCells: Map<number, object>,
 * }} input
 * @returns {object[]}
 */
function assembleC1PendingRows(input) {
  const states = Array.isArray(input.states) ? input.states : [];
  const solicitudesByCz = input.solicitudesByCz || new Map();
  const fallbacksByCz = input.fallbacksByCz || new Map();
  const reviewByCz = input.reviewByCz || new Map();
  const elmCells = input.elmCells || new Map();

  const rows = [];
  for (const st of states) {
    const czId = toNum(st && st.cz_solicitud_id);
    const ci = toNum(st && st.ci);
    const projected = toNum(st && st.projected_estado);
    if (czId == null || !Number.isSafeInteger(czId) || czId <= 0) continue;
    if (ci == null || !Number.isSafeInteger(ci) || ci <= 0) continue;
    if (!C1_PENDING_PROJECTED_ESTADOS.includes(Number(projected))) continue;

    const sol = solicitudesByCz.get(czId) || null;
    const fallback = fallbacksByCz.get(czId) || null;
    const review = reviewByCz.get(czId) || null;
    const elmCell = elmCells.get(czId) || null;

    const pendingAt =
      (fallback && (fallback.finalized_at || fallback.created_at)) ||
      (st && st.updated_at) ||
      (sol && sol.fecha_reg) ||
      null;

    const outcome = fallback && fallback.outcome ? String(fallback.outcome) : null;
    const openReview =
      review && review.status === 'open' && review.id != null
        ? {
            case_id: review.id,
            reason_code: review.reason_code || null,
            status: review.status,
          }
        : null;

    let action = null;
    if (outcome === OUTCOME.MANUAL_REVIEW && openReview) {
      action = {
        kind: 'open_elm_ops',
        review_case_id: openReview.case_id,
      };
    }

    rows.push({
      ci: ci,
      nombre: sol ? nonemptyText(sol.nombre) : null,
      apellido: sol ? nonemptyText(sol.apellido) : null,
      cz_solicitud_id: czId,
      pending_at: pendingAt,
      projected_estado: projected,
      projected_estado_label: projectedEstadoLabel(projected),
      fallback_outcome: outcome,
      review_reason_code: reviewReasonLabel(review, fallback),
      review: openReview,
      elm: elmCell
        ? {
            state: elmCell.state || null,
            label: elmCell.label || null,
            detail: elmCell.detail || null,
            kind: elmCell.kind || null,
          }
        : null,
      action: action,
    });
  }

  rows.sort(function (a, b) {
    const t = cmpTsDescNullsLast(a.pending_at, b.pending_at);
    if (t !== 0) return t;
    return Number(b.cz_solicitud_id) - Number(a.cz_solicitud_id);
  });
  return rows;
}

async function fetchAllProjectedStates(supabase) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('provider_cz_state')
      .select('cz_solicitud_id, ci, projected_estado, updated_at')
      .in('projected_estado', C1_PENDING_PROJECTED_ESTADOS.slice())
      .order('updated_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw rpcError('provider_cz_state', error);
    const page = data || [];
    out.push.apply(out, page);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

async function fetchSolicitudesByCzIds(supabase, czIds) {
  const ids = Array.from(
    new Set(
      (czIds || [])
        .map(Number)
        .filter(function (n) {
          return Number.isSafeInteger(n) && n > 0;
        }),
    ),
  );
  const map = new Map();
  if (!ids.length) return map;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('cz_funnel_solicitudes')
      .select(SOLICITUD_SELECT)
      .in('cz_id', chunk);
    if (error) throw rpcError('cz_funnel_solicitudes', error);
    for (const row of data || []) map.set(Number(row.cz_id), row);
  }
  return map;
}

async function fetchFallbacksByCzIds(supabase, czIds) {
  const ids = Array.from(
    new Set(
      (czIds || [])
        .map(Number)
        .filter(function (n) {
          return Number.isSafeInteger(n) && n > 0;
        }),
    ),
  );
  const map = new Map();
  if (!ids.length) return map;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('provider_fallback_requests')
      .select(FALLBACK_SELECT)
      .in('cz_solicitud_id', chunk);
    if (error) throw rpcError('provider_fallback_requests', error);
    for (const row of data || []) map.set(Number(row.cz_solicitud_id), row);
  }
  return map;
}

async function fetchOpenReviewCasesByCzIds(supabase, czIds) {
  const ids = Array.from(
    new Set(
      (czIds || [])
        .map(Number)
        .filter(function (n) {
          return Number.isSafeInteger(n) && n > 0;
        }),
    ),
  );
  const map = new Map();
  if (!ids.length) return map;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('provider_review_cases')
      .select(REVIEW_SELECT)
      .eq('status', 'open')
      .in('cz_solicitud_id', chunk);
    if (error) throw rpcError('provider_review_cases', error);
    for (const row of data || []) map.set(Number(row.cz_solicitud_id), row);
  }
  return map;
}

/**
 * @param {object} supabase
 * @param {{ listView?: { cellsForCzIds: Function } }} [deps]
 */
async function loadC1PendingListRows(supabase, deps) {
  const states = await fetchAllProjectedStates(supabase);
  const czIds = states.map(function (s) {
    return Number(s.cz_solicitud_id);
  });
  const [solicitudesByCz, fallbacksByCz, reviewByCz] = await Promise.all([
    fetchSolicitudesByCzIds(supabase, czIds),
    fetchFallbacksByCzIds(supabase, czIds),
    fetchOpenReviewCasesByCzIds(supabase, czIds),
  ]);

  let elmCells = new Map();
  const listView = deps && deps.listView;
  if (listView && typeof listView.cellsForCzIds === 'function' && czIds.length) {
    try {
      elmCells = await listView.cellsForCzIds(czIds, { allowSend: false });
    } catch (_err) {
      elmCells = new Map();
    }
  }

  return assembleC1PendingRows({
    states: states,
    solicitudesByCz: solicitudesByCz,
    fallbacksByCz: fallbacksByCz,
    reviewByCz: reviewByCz,
    elmCells: elmCells,
  });
}

module.exports = {
  C1_PENDING_LIST_STATUS,
  C1_PENDING_PROJECTED_ESTADOS,
  PROJECTED_ESTADO_LABELS,
  isC1PendingListStatus,
  assembleC1PendingRows,
  loadC1PendingListRows,
  projectedEstadoLabel,
};
