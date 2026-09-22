'use strict';

/**
 * Preaprobados CZ/CDV V1 — read helpers (observation only).
 *
 * Universe: solicitud (cz_id) that EVER reached solicitudes_estados_id = 8.
 * GRANTED: cz_funnel_granted_loans row and/or current estado 11.
 * Sin resultado: in cohort AND NOT GRANTED (presentation bucket only).
 */

const PREAPROBADOS_ESTADO_ID = 8;
const GRANTED_ESTADO_ID = 11;
const RESULT_GRANTED = 'granted';
const RESULT_SIN_RESULTADO = 'sin_resultado';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const PAGE_SIZE = 1000;
const IN_CHUNK = 200;

const ALLOWED_RESULTADOS = Object.freeze([
  RESULT_GRANTED,
  RESULT_SIN_RESULTADO,
]);

function tsMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
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

function cmpAscNullsLastMs(aMs, bMs) {
  if (aMs == null && bMs == null) return 0;
  if (aMs == null) return 1;
  if (bMs == null) return -1;
  if (aMs < bMs) return -1;
  if (aMs > bMs) return 1;
  return 0;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: string|null } | { ok: false }}
 */
function parseResultadoQuery(raw) {
  if (raw == null) return { ok: true, value: null };
  const s = String(raw).trim().toLowerCase();
  if (s === '' || s === 'all' || s === 'todos') return { ok: true, value: null };
  if (s === 'granted' || s === 'otorgado') return { ok: true, value: RESULT_GRANTED };
  if (
    s === 'sin_resultado' ||
    s === 'sin-resultado' ||
    s === 'sinresultado'
  ) {
    return { ok: true, value: RESULT_SIN_RESULTADO };
  }
  return { ok: false };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: number|null } | { ok: false }}
 */
function parseEstadoQuery(raw) {
  if (raw == null || String(raw).trim() === '') return { ok: true, value: null };
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 11) return { ok: false };
  return { ok: true, value: n };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: string|null } | { ok: false }}
 */
function parseIsoQuery(raw) {
  if (raw == null || String(raw).trim() === '') return { ok: true, value: null };
  const s = String(raw).trim();
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return { ok: false };
  return { ok: true, value: new Date(ms).toISOString() };
}

/**
 * @param {unknown} limitRaw
 * @param {unknown} offsetRaw
 */
function parsePagination(limitRaw, offsetRaw) {
  let limit = DEFAULT_LIMIT;
  if (limitRaw != null && String(limitRaw).trim() !== '') {
    const n = Number(String(limitRaw).trim());
    if (!Number.isInteger(n) || n < 1) return { ok: false };
    limit = Math.min(n, MAX_LIMIT);
  }
  let offset = 0;
  if (offsetRaw != null && String(offsetRaw).trim() !== '') {
    const n = Number(String(offsetRaw).trim());
    if (!Number.isInteger(n) || n < 0) return { ok: false };
    offset = n;
  }
  return { ok: true, limit: limit, offset: offset };
}

/**
 * Cohort membership: historico estado 8 UNION current solicitud estado 8.
 * cohort_entered_at = MIN(fechahora_src) for estado 8; fallback fecha_reg.
 *
 * @param {object[]} estado8Rows
 * @param {object[]} currentEstado8Solicitudes
 * @returns {Map<number, { cohort_entered_at: string|null, from_historico: boolean }>}
 */
function buildCohortByCzId(estado8Rows, currentEstado8Solicitudes) {
  const map = new Map();

  const hist = Array.isArray(estado8Rows) ? estado8Rows : [];
  for (let i = 0; i < hist.length; i += 1) {
    const e = hist[i];
    if (Number(e && e.solicitudes_estados_id) !== PREAPROBADOS_ESTADO_ID) {
      continue;
    }
    const czId = toNum(e && e.cz_solicitud_id);
    if (czId == null || !Number.isSafeInteger(czId)) continue;
    const enteredMs = tsMs(e && e.fechahora_src);
    const prev = map.get(czId);
    if (!prev) {
      map.set(czId, {
        cohort_entered_at:
          enteredMs != null ? new Date(enteredMs).toISOString() : null,
        from_historico: true,
        _enteredMs: enteredMs,
      });
      continue;
    }
    if (enteredMs == null) continue;
    if (prev._enteredMs == null || enteredMs < prev._enteredMs) {
      prev.cohort_entered_at = new Date(enteredMs).toISOString();
      prev._enteredMs = enteredMs;
      prev.from_historico = true;
    }
  }

  const sols = Array.isArray(currentEstado8Solicitudes)
    ? currentEstado8Solicitudes
    : [];
  for (let i = 0; i < sols.length; i += 1) {
    const sol = sols[i];
    if (Number(sol && sol.solicitudes_estados_id) !== PREAPROBADOS_ESTADO_ID) {
      continue;
    }
    const czId = toNum(sol && sol.cz_id);
    if (czId == null || !Number.isSafeInteger(czId)) continue;
    if (map.has(czId)) continue;
    const fallbackMs = tsMs(sol && sol.fecha_reg);
    map.set(czId, {
      cohort_entered_at:
        fallbackMs != null ? new Date(fallbackMs).toISOString() : null,
      from_historico: false,
      _enteredMs: fallbackMs,
    });
  }

  for (const entry of map.values()) {
    delete entry._enteredMs;
  }
  return map;
}

/**
 * @param {number} czId
 * @param {Map<number, object>} grantedByCzId
 * @param {object|null} sol
 */
function isGrantedForSolicitud(czId, grantedByCzId, sol) {
  if (grantedByCzId && grantedByCzId.has(czId)) return true;
  if (Number(sol && sol.solicitudes_estados_id) === GRANTED_ESTADO_ID) {
    return true;
  }
  return false;
}

/**
 * Latest historico row matching current estado → estado text label if present.
 * @param {object[]} historicoRows
 * @returns {Map<number, string|null>}
 */
function currentEstadoLabelByCzId(historicoRows, solicitudRows) {
  const currentByCz = new Map();
  const sols = Array.isArray(solicitudRows) ? solicitudRows : [];
  for (let i = 0; i < sols.length; i += 1) {
    const czId = toNum(sols[i] && sols[i].cz_id);
    if (czId == null) continue;
    currentByCz.set(czId, toNum(sols[i].solicitudes_estados_id));
  }

  const best = new Map();
  const rows = Array.isArray(historicoRows) ? historicoRows : [];
  for (let i = 0; i < rows.length; i += 1) {
    const e = rows[i];
    const czId = toNum(e && e.cz_solicitud_id);
    if (czId == null) continue;
    const want = currentByCz.get(czId);
    if (want == null) continue;
    if (Number(e.solicitudes_estados_id) !== want) continue;
    const label = nonemptyText(e.estado);
    if (!label) continue;
    const ms = tsMs(e.fechahora_src);
    const hid = toNum(e.cz_historico_id) || 0;
    const prev = best.get(czId);
    if (!prev) {
      best.set(czId, { label: label, ms: ms, hid: hid });
      continue;
    }
    const prevMs = prev.ms;
    if (ms != null && (prevMs == null || ms > prevMs)) {
      best.set(czId, { label: label, ms: ms, hid: hid });
      continue;
    }
    if (ms === prevMs && hid > prev.hid) {
      best.set(czId, { label: label, ms: ms, hid: hid });
    }
  }

  const out = new Map();
  for (const [czId, v] of best.entries()) {
    out.set(czId, v.label);
  }
  return out;
}

function grantedMapFromRows(grantedRows) {
  const map = new Map();
  const rows = Array.isArray(grantedRows) ? grantedRows : [];
  for (let i = 0; i < rows.length; i += 1) {
    const g = rows[i];
    const czId = toNum(g && g.cz_id);
    if (czId == null || !Number.isSafeInteger(czId)) continue;
    map.set(czId, g);
  }
  return map;
}

function solicitudesById(rows) {
  const map = new Map();
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const czId = toNum(list[i] && list[i].cz_id);
    if (czId == null) continue;
    map.set(czId, list[i]);
  }
  return map;
}

function matchesSearch(row, qRaw) {
  const q = nonemptyText(qRaw);
  if (!q) return true;
  const needle = q.toLowerCase();
  const ci = row.ci != null ? String(row.ci) : '';
  const cz = row.cz_id != null ? String(row.cz_id) : '';
  const lrw = row.lrw_id != null ? String(row.lrw_id).toLowerCase() : '';
  const nombre = row.nombre != null ? String(row.nombre).toLowerCase() : '';
  const apellido =
    row.apellido != null ? String(row.apellido).toLowerCase() : '';
  const full = (nombre + ' ' + apellido).trim();
  if (ci === needle || ci.includes(needle)) return true;
  if (cz === needle || cz.includes(needle)) return true;
  if (lrw && lrw.includes(needle)) return true;
  if (nombre && nombre.includes(needle)) return true;
  if (apellido && apellido.includes(needle)) return true;
  if (full && full.includes(needle)) return true;
  return false;
}

function inDateRange(iso, fromIso, toIso) {
  const ms = tsMs(iso);
  if (fromIso) {
    const fromMs = tsMs(fromIso);
    if (fromMs != null && (ms == null || ms < fromMs)) return false;
  }
  if (toIso) {
    const toMs = tsMs(toIso);
    if (toMs != null && (ms == null || ms > toMs)) return false;
  }
  return true;
}

/**
 * Cohort window still open / recent — true when `to` is absent or reaches today+.
 * No maturation math; presentation flag only.
 */
function cohortInProgress(toIso, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  if (!toIso) return true;
  const toMs = tsMs(toIso);
  if (toMs == null) return true;
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  return toMs >= startOfToday.getTime();
}

function formatListRow(czId, cohortMeta, sol, grantedByCzId, estadoLabel) {
  const granted = isGrantedForSolicitud(czId, grantedByCzId, sol);
  const g = grantedByCzId.get(czId);
  let monto = null;
  if (g && g.monto_otorgado != null && g.monto_otorgado !== '') {
    const n = Number(g.monto_otorgado);
    monto = Number.isFinite(n) ? n : null;
  }
  return {
    cz_id: czId,
    cohort_entered_at: cohortMeta.cohort_entered_at,
    nombre: nonemptyText(sol && sol.nombre),
    apellido: nonemptyText(sol && sol.apellido),
    ci: toNum(sol && sol.ci),
    estado_id: toNum(sol && sol.solicitudes_estados_id),
    estado_label: estadoLabel != null ? estadoLabel : null,
    resultado: granted ? RESULT_GRANTED : RESULT_SIN_RESULTADO,
    monto_otorgado: granted ? monto : null,
    lrw_id: nonemptyText(sol && sol.lrw_id),
  };
}

/**
 * Build filtered list + KPIs (KPIs over full filtered set; rows paginated).
 *
 * @param {object} input
 * @returns {{ cohort: object, kpis: object, rows: object[], total: number, limit: number, offset: number }}
 */
function assemblePreaprobadosList(input) {
  const cohortByCz = buildCohortByCzId(
    input.estado8Rows,
    input.currentEstado8Solicitudes,
  );
  const solById = solicitudesById(input.solicitudRows);
  const grantedByCzId = grantedMapFromRows(input.grantedRows);
  const labelByCz = currentEstadoLabelByCzId(
    input.historicoRows || [],
    input.solicitudRows || [],
  );

  const fromIso = input.from || null;
  const toIso = input.to || null;
  const estadoFilter =
    input.estado != null && input.estado !== '' ? Number(input.estado) : null;
  const resultadoFilter = input.resultado || null;
  const q = input.q || null;
  const limit =
    input.limit != null ? Number(input.limit) : DEFAULT_LIMIT;
  const offset = input.offset != null ? Number(input.offset) : 0;
  const nowMs = input.nowMs;

  const allRows = [];
  for (const [czId, meta] of cohortByCz.entries()) {
    const sol = solById.get(czId) || null;
    if (!sol) continue;
    if (!inDateRange(meta.cohort_entered_at, fromIso, toIso)) continue;
    const row = formatListRow(
      czId,
      meta,
      sol,
      grantedByCzId,
      labelByCz.get(czId) || null,
    );
    if (estadoFilter != null && row.estado_id !== estadoFilter) continue;
    if (resultadoFilter && row.resultado !== resultadoFilter) continue;
    if (!matchesSearch(row, q)) continue;
    allRows.push(row);
  }

  allRows.sort(function (a, b) {
    const t = cmpAscNullsLastMs(
      tsMs(b.cohort_entered_at),
      tsMs(a.cohort_entered_at),
    );
    if (t !== 0) return t;
    return Number(b.cz_id) - Number(a.cz_id);
  });

  let grantedN = 0;
  let sinN = 0;
  let montoSum = 0;
  for (let i = 0; i < allRows.length; i += 1) {
    if (allRows[i].resultado === RESULT_GRANTED) {
      grantedN += 1;
      if (allRows[i].monto_otorgado != null) {
        montoSum += Number(allRows[i].monto_otorgado) || 0;
      }
    } else {
      sinN += 1;
    }
  }
  const preaprobados = allRows.length;
  const conversion = preaprobados > 0 ? grantedN / preaprobados : null;

  const page = allRows.slice(offset, offset + limit);

  return {
    cohort: {
      from: fromIso,
      to: toIso,
      in_progress: cohortInProgress(toIso, nowMs),
    },
    kpis: {
      preaprobados: preaprobados,
      granted: grantedN,
      sin_resultado: sinN,
      monto_otorgado: Math.round(montoSum * 100) / 100,
      conversion: conversion,
    },
    rows: page,
    total: preaprobados,
    limit: limit,
    offset: offset,
  };
}

function sortHistoricoAsc(rows) {
  return (rows || []).slice().sort(function (a, b) {
    const t = cmpAscNullsLastMs(tsMs(a.fechahora_src), tsMs(b.fechahora_src));
    if (t !== 0) return t;
    return (toNum(a.cz_historico_id) || 0) - (toNum(b.cz_historico_id) || 0);
  });
}

/**
 * @returns {object|null}
 */
function assemblePreaprobadosDetail(input) {
  const czId = toNum(input.czId);
  if (czId == null) return null;
  const cohortByCz = buildCohortByCzId(
    input.estado8Rows,
    input.currentEstado8Solicitudes,
  );
  const meta = cohortByCz.get(czId);
  if (!meta) return null;

  const sol = input.solicitud || null;
  if (!sol) return null;

  const grantedByCzId = grantedMapFromRows(
    input.grantedRow ? [input.grantedRow] : input.grantedRows || [],
  );
  const labels = currentEstadoLabelByCzId(input.historicoRows || [], [sol]);
  const listRow = formatListRow(
    czId,
    meta,
    sol,
    grantedByCzId,
    labels.get(czId) || null,
  );

  const historico = sortHistoricoAsc(input.historicoRows || []).map(function (e) {
    return {
      cz_historico_id: toNum(e.cz_historico_id),
      solicitudes_estados_id: toNum(e.solicitudes_estados_id),
      estado: nonemptyText(e.estado),
      solicitudes_estados_id_anterior: toNum(e.solicitudes_estados_id_anterior),
      estado_anterior: nonemptyText(e.estado_anterior),
      fechahora_src: e.fechahora_src != null ? e.fechahora_src : null,
    };
  });

  const g = grantedByCzId.get(czId) || null;

  return {
    cz_id: czId,
    cohort_entered_at: listRow.cohort_entered_at,
    cohort_from_historico: meta.from_historico,
    nombre: listRow.nombre,
    apellido: listRow.apellido,
    ci: listRow.ci,
    email: nonemptyText(sol.email),
    fecha_reg: sol.fecha_reg != null ? sol.fecha_reg : null,
    lrw_id: listRow.lrw_id,
    resultado: listRow.resultado,
    estado_id: listRow.estado_id,
    estado_label: listRow.estado_label,
    monto_otorgado: listRow.monto_otorgado,
    granted: g
      ? {
          cz_id: czId,
          monto_otorgado: listRow.monto_otorgado,
          updated_at_src: g.updated_at_src != null ? g.updated_at_src : null,
          synced_at: g.synced_at != null ? g.synced_at : null,
        }
      : null,
    synced_at: sol.synced_at != null ? sol.synced_at : null,
    updated_at_src: sol.updated_at_src != null ? sol.updated_at_src : null,
    historico: historico,
    historico_note:
      'Eventos disponibles en JANUS (puede estar incompleto hacia el pasado).',
  };
}

async function fetchAllPages(runPage) {
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await runPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    if (from > 500000) break;
  }
  return all;
}

async function fetchInChunks(supabase, table, select, column, ids) {
  if (!ids || !ids.length) return [];
  const unique = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const all = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const page = await fetchAllPages(function (from, to) {
      return supabase
        .from(table)
        .select(select)
        .in(column, chunk)
        .range(from, to);
    });
    all.push(...page);
  }
  return all;
}

const ESTADO8_SELECT =
  'cz_historico_id, cz_solicitud_id, solicitudes_estados_id, estado, fechahora_src';

const SOLICITUD_LIST_SELECT =
  'cz_id, ci, nombre, apellido, email, lrw_id, fecha_reg, solicitudes_estados_id, updated_at_src, synced_at';

const GRANTED_SELECT =
  'cz_id, ci, monto_otorgado, updated_at_src, synced_at';

const HISTORICO_SELECT =
  'cz_historico_id, cz_solicitud_id, solicitudes_estados_id, solicitudes_estados_id_anterior, estado, estado_anterior, fechahora_src';

async function fetchEstado8Rows(supabase) {
  return fetchAllPages(function (from, to) {
    return supabase
      .from('cz_funnel_solicitud_estados')
      .select(ESTADO8_SELECT)
      .eq('solicitudes_estados_id', PREAPROBADOS_ESTADO_ID)
      .range(from, to);
  });
}

async function fetchCurrentEstado8Solicitudes(supabase) {
  return fetchAllPages(function (from, to) {
    return supabase
      .from('cz_funnel_solicitudes')
      .select(SOLICITUD_LIST_SELECT)
      .eq('solicitudes_estados_id', PREAPROBADOS_ESTADO_ID)
      .range(from, to);
  });
}

async function fetchPreaprobadosListBundle(supabase) {
  const estado8Rows = await fetchEstado8Rows(supabase);
  const currentEstado8Solicitudes =
    await fetchCurrentEstado8Solicitudes(supabase);

  const cohortByCz = buildCohortByCzId(estado8Rows, currentEstado8Solicitudes);
  const cohortIds = [...cohortByCz.keys()];

  const solicitudRows = await fetchInChunks(
    supabase,
    'cz_funnel_solicitudes',
    SOLICITUD_LIST_SELECT,
    'cz_id',
    cohortIds,
  );

  // Ensure current-8 sols (already selected) are present even if chunk miss.
  const byId = solicitudesById(solicitudRows);
  for (let i = 0; i < currentEstado8Solicitudes.length; i += 1) {
    const s = currentEstado8Solicitudes[i];
    const id = toNum(s && s.cz_id);
    if (id != null && !byId.has(id)) {
      solicitudRows.push(s);
      byId.set(id, s);
    }
  }

  const grantedRows = cohortIds.length
    ? await fetchInChunks(
        supabase,
        'cz_funnel_granted_loans',
        GRANTED_SELECT,
        'cz_id',
        cohortIds,
      )
    : [];

  const historicoRows = cohortIds.length
    ? await fetchInChunks(
        supabase,
        'cz_funnel_solicitud_estados',
        HISTORICO_SELECT,
        'cz_solicitud_id',
        cohortIds,
      )
    : [];

  return {
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8Solicitudes,
    solicitudRows: solicitudRows,
    grantedRows: grantedRows,
    historicoRows: historicoRows,
  };
}

async function fetchPreaprobadosDetailBundle(supabase, czIdRaw) {
  const czId = toNum(czIdRaw);
  if (czId == null || !Number.isSafeInteger(czId)) {
    return { ok: false, reason: 'invalid_cz_id' };
  }

  const { data: sol, error: solErr } = await supabase
    .from('cz_funnel_solicitudes')
    .select(SOLICITUD_LIST_SELECT)
    .eq('cz_id', czId)
    .maybeSingle();
  if (solErr) throw solErr;
  if (!sol) return { ok: false, reason: 'not_found' };

  const estado8Rows = await fetchAllPages(function (from, to) {
    return supabase
      .from('cz_funnel_solicitud_estados')
      .select(ESTADO8_SELECT)
      .eq('solicitudes_estados_id', PREAPROBADOS_ESTADO_ID)
      .eq('cz_solicitud_id', czId)
      .range(from, to);
  });

  const currentEstado8Solicitudes =
    Number(sol.solicitudes_estados_id) === PREAPROBADOS_ESTADO_ID ? [sol] : [];

  const cohortByCz = buildCohortByCzId(estado8Rows, currentEstado8Solicitudes);
  if (!cohortByCz.has(czId)) {
    return { ok: false, reason: 'not_in_cohort' };
  }

  const { data: grantedRow, error: gErr } = await supabase
    .from('cz_funnel_granted_loans')
    .select(GRANTED_SELECT)
    .eq('cz_id', czId)
    .maybeSingle();
  if (gErr) throw gErr;

  const historicoRows = await fetchAllPages(function (from, to) {
    return supabase
      .from('cz_funnel_solicitud_estados')
      .select(HISTORICO_SELECT)
      .eq('cz_solicitud_id', czId)
      .range(from, to);
  });

  return {
    ok: true,
    czId: czId,
    estado8Rows: estado8Rows,
    currentEstado8Solicitudes: currentEstado8Solicitudes,
    solicitud: sol,
    grantedRow: grantedRow || null,
    historicoRows: historicoRows,
  };
}

module.exports = {
  PREAPROBADOS_ESTADO_ID,
  GRANTED_ESTADO_ID,
  RESULT_GRANTED,
  RESULT_SIN_RESULTADO,
  DEFAULT_LIMIT,
  ALLOWED_RESULTADOS,
  parseResultadoQuery,
  parseEstadoQuery,
  parseIsoQuery,
  parsePagination,
  buildCohortByCzId,
  isGrantedForSolicitud,
  cohortInProgress,
  assemblePreaprobadosList,
  assemblePreaprobadosDetail,
  fetchPreaprobadosListBundle,
  fetchPreaprobadosDetailBundle,
};
