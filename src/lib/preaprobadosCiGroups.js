'use strict';

/**
 * Preaprobados — one row per CI (presentation only, pure).
 *
 * Membership and filters are exactly assembleCombinedPreaprobadosList's. The filters (period,
 * state, result, entity, search) decide which CIs are listed: those with at least one matching
 * solicitud. Each listed CI carries every Preaprobados solicitud it has, so its CDV / ELM state is
 * the CI's, the same as its detail; its date and order come from its newest matching solicitud.
 * Grouping happens before paging, so a CI is never split across pages. Rows without a CI stay alone.
 *
 * `kpis_ci` counts CIs, never solicitudes, over the same groups the list shows:
 *   preaprobados   CIs in the list
 *   aceptados_elm  CIs with an ELM member solicitud (Aceptado ELM, or later Otorgado ELM);
 *                  automatic circuit and manual sends from Preaprobados alike
 *   otorgados_cdv  CIs with a CDV-granted solicitud
 *   otorgados_elm  CIs with an ELM-granted solicitud (confirmed disbursement)
 *   pendientes     CIs without a loan granted by CDV nor ELM
 * The per-solicitud `kpis` / `kpis_elm` of the combined list are returned untouched next to it.
 */

const { RESULT_GRANTED, DEFAULT_LIMIT } = require('./preaprobadosRead');
const { PROVEEDOR, assembleCombinedPreaprobadosList } = require('./preaprobadosElmCohort');
const { COMMERCIAL } = require('../services/elm/classification');
const DUPLICATE_OTHER_CHANNEL_DETAIL = 's1_duplicate_other_channel';

const CI_MAX = 999999999;

/** Lower rank = shown first in the CI's single ELM cell. */
const ELM_FOCUS_RANK = Object.freeze({
  granted: 0,
  referred: 1,
  in_evaluation: 2,
  review: 3,
  duplicate: 4,
  rejected: 5,
  closed: 6,
  not_sent: 7,
  not_sendable: 8,
  unavailable: 9,
});
const NO_ELM_RANK = 10;

function toNum(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function tsMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

/** @returns {{ ok: true, value: number } | { ok: false }} */
function parseCiParam(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (!/^\d{1,9}$/.test(s)) return { ok: false };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > CI_MAX) return { ok: false };
  return { ok: true, value: n };
}

function validCi(raw) {
  const n = toNum(raw);
  return n != null && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function hasName(row) {
  return Boolean(row && (row.nombre || row.apellido));
}

function isCdvMember(row) {
  return row.proveedor === PROVEEDOR.CDV || row.proveedor === PROVEEDOR.BOTH;
}

function isElmMember(row) {
  return row.proveedor === PROVEEDOR.ELM || row.proveedor === PROVEEDOR.BOTH;
}

function groupProveedor(solicitudes) {
  const cdv = solicitudes.some(isCdvMember);
  const elm = solicitudes.some(function (s) {
    return Boolean(s.elm_member);
  });
  if (cdv && elm) return PROVEEDOR.BOTH;
  return cdv ? PROVEEDOR.CDV : PROVEEDOR.ELM;
}

function memberRank(member) {
  if (!member) return NO_ELM_RANK;
  return member.state === COMMERCIAL.GRANTED ? ELM_FOCUS_RANK.granted : ELM_FOCUS_RANK.referred;
}

/** Rank of a solicitud's ELM cell (listView), falling back to its ELM membership. */
function elmRank(row) {
  const cell = row && row.elm;
  if (cell && cell.kind !== 'unavailable') {
    if (cell.granted_elm === true || cell.state === COMMERCIAL.GRANTED) return ELM_FOCUS_RANK.granted;
    if (cell.detail === DUPLICATE_OTHER_CHANNEL_DETAIL) return ELM_FOCUS_RANK.duplicate;
    const key = cell.state || cell.kind;
    if (Object.prototype.hasOwnProperty.call(ELM_FOCUS_RANK, key)) return ELM_FOCUS_RANK[key];
  }
  const fromMember = memberRank(row && row.elm_member);
  if (fromMember !== NO_ELM_RANK) return fromMember;
  return cell ? ELM_FOCUS_RANK.unavailable : NO_ELM_RANK;
}

/**
 * Solicitud whose ELM state the CI row shows: the most advanced one (granted, accepted, in
 * evaluation, review, duplicate, rejected, closed, then not sent). Ties keep the newest.
 * @param {object[]} solicitudes newest first
 * @returns {number|null}
 */
function pickElmFocusCzId(solicitudes) {
  let best = null;
  let bestRank = Infinity;
  for (const s of solicitudes || []) {
    const r = elmRank(s);
    if (r < bestRank) {
      best = s;
      bestRank = r;
    }
  }
  return best ? toNum(best.cz_id) : null;
}

function summarizeGroup(ci, solicitudes, matched) {
  const shown = matched && matched.length ? matched : solicitudes;
  const latest = shown[0];
  const named = solicitudes.find(hasName) || latest;
  const cdvGranted = solicitudes.filter(function (s) {
    return isCdvMember(s) && s.resultado === RESULT_GRANTED;
  });
  let monto = null;
  for (const s of cdvGranted) {
    if (s.monto_otorgado != null) monto = (monto || 0) + Number(s.monto_otorgado);
  }
  const members = solicitudes
    .map(function (s) {
      return s.elm_member;
    })
    .filter(Boolean);
  let elmState = null;
  if (members.some(function (m) { return m.state === COMMERCIAL.GRANTED; })) {
    elmState = COMMERCIAL.GRANTED;
  } else if (members.length) {
    elmState = COMMERCIAL.REFERRED;
  }
  return {
    ci: ci,
    cz_id: toNum(latest.cz_id),
    cohort_entered_at: latest.cohort_entered_at || null,
    nombre: named.nombre || null,
    apellido: named.apellido || null,
    proveedor: groupProveedor(solicitudes),
    cdv_status: cdvGranted.length
      ? RESULT_GRANTED
      : solicitudes.some(isCdvMember)
        ? 'sin_resultado'
        : null,
    cdv_granted_cz_ids: cdvGranted.map(function (s) {
      return toNum(s.cz_id);
    }),
    monto_otorgado: monto != null ? Math.round(monto * 100) / 100 : null,
    elm_member_state: elmState,
    elm_focus_cz_id: pickElmFocusCzId(solicitudes),
    solicitudes_count: solicitudes.length,
    matched_cz_ids: shown.map(function (s) {
      return toNum(s.cz_id);
    }),
    solicitudes: solicitudes,
  };
}

function groupKey(row) {
  const ci = validCi(row.ci);
  return ci != null ? 'ci:' + ci : 'cz:' + row.cz_id;
}

function newestFirst(a, b) {
  const am = tsMs(a.cohort_entered_at);
  const bm = tsMs(b.cohort_entered_at);
  if (am !== bm) {
    if (am == null) return 1;
    if (bm == null) return -1;
    return bm - am;
  }
  return Number(b.cz_id) - Number(a.cz_id);
}

/**
 * @param {object[]} rows solicitud rows that matched the filters, newest first
 *   (assembleCombinedPreaprobadosList order); they decide which CIs are listed and in what order
 * @param {object[]} [allRows] every Preaprobados solicitud row (no filters); a listed CI carries all
 *   of its own. Defaults to `rows`.
 * @returns {object[]} one group per CI, ordered by its newest matching solicitud
 */
function groupRowsByCi(rows, allRows) {
  const byKey = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    const key = groupKey(row);
    if (!byKey.has(key)) byKey.set(key, { ci: validCi(row.ci), matched: [], solicitudes: [] });
    byKey.get(key).matched.push(row);
  }
  const source = allRows || rows || [];
  for (const row of source) {
    if (!row) continue;
    const g = byKey.get(groupKey(row));
    if (g) g.solicitudes.push(row);
  }
  const out = [];
  for (const g of byKey.values()) {
    if (allRows) {
      const seen = new Set(g.solicitudes.map((s) => Number(s.cz_id)));
      for (const m of g.matched) if (!seen.has(Number(m.cz_id))) g.solicitudes.push(m);
    }
    g.matched.sort(newestFirst);
    g.solicitudes.sort(newestFirst);
    out.push(summarizeGroup(g.ci, g.solicitudes, g.matched));
  }
  return out;
}

/** Recomputes the ELM focus once the solicitudes carry their ELM cell (attachElmCells). */
function refreshElmFocus(groups) {
  for (const g of groups || []) g.elm_focus_cz_id = pickElmFocusCzId(g.solicitudes);
  return groups;
}

/** KPIs by CI over the listed groups (see module doc). */
function ciKpis(groups) {
  const k = {
    preaprobados: 0,
    aceptados_elm: 0,
    otorgados_cdv: 0,
    otorgados_elm: 0,
    pendientes: 0,
    solicitudes: 0,
  };
  for (const g of groups || []) {
    const cdvGranted = g.cdv_status === RESULT_GRANTED;
    const elmGranted = g.elm_member_state === COMMERCIAL.GRANTED;
    k.preaprobados += 1;
    k.solicitudes += g.solicitudes_count;
    if (g.elm_member_state) k.aceptados_elm += 1;
    if (cdvGranted) k.otorgados_cdv += 1;
    if (elmGranted) k.otorgados_elm += 1;
    if (!cdvGranted && !elmGranted) k.pendientes += 1;
  }
  return k;
}

const LIST_FILTERS = ['from', 'to', 'estado', 'resultadoCdv', 'resultadoElm', 'proveedor', 'q'];

/**
 * Combined list (unchanged membership and filters) grouped by CI, then paged by CI.
 * @param {object} input assembleCombinedPreaprobadosList input, plus optional `ci` (only that CI)
 */
function assembleGroupedPreaprobadosList(input) {
  const limit = input.limit != null ? Number(input.limit) : DEFAULT_LIMIT;
  const offset = input.offset != null ? Number(input.offset) : 0;
  const all = { limit: Number.MAX_SAFE_INTEGER, offset: 0 };
  const combined = assembleCombinedPreaprobadosList(Object.assign({}, input, all));
  const unfiltered = {};
  for (const k of LIST_FILTERS) unfiltered[k] = null;
  const everyRow = LIST_FILTERS.some(function (k) {
    return input[k] != null && input[k] !== '';
  })
    ? assembleCombinedPreaprobadosList(Object.assign({}, input, all, unfiltered)).rows
    : combined.rows;
  let groups = groupRowsByCi(combined.rows, everyRow);
  if (input.ci != null) {
    const ci = Number(input.ci);
    groups = groups.filter(function (g) {
      return g.ci === ci;
    });
  }
  return {
    cohort: combined.cohort,
    kpis: combined.kpis,
    kpis_elm: combined.kpis_elm,
    kpis_ci: ciKpis(groups),
    rows: groups.slice(offset, offset + limit),
    total: groups.length,
    total_solicitudes: groups.reduce(function (n, g) {
      return n + g.solicitudes_count;
    }, 0),
    limit: limit,
    offset: offset,
  };
}

/** Solicitud rows of the given groups (shared objects: cells attached to them land in the groups). */
function solicitudesOf(groups) {
  const out = [];
  for (const g of groups || []) out.push(...g.solicitudes);
  return out;
}

module.exports = {
  ELM_FOCUS_RANK,
  parseCiParam,
  pickElmFocusCzId,
  groupRowsByCi,
  refreshElmFocus,
  ciKpis,
  assembleGroupedPreaprobadosList,
  solicitudesOf,
};
