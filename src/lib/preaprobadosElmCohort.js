'use strict';

/**
 * Preaprobados — ELM cohort next to the CDV cohort (read-only).
 *
 * CDV cohort (ever estado 8) is assembled by preaprobadosRead.js exactly as before and its
 * `kpis` are returned untouched. The ELM cohort is added here:
 *
 *   member = trigger_origin 'cz_automatic' AND commercial state referred ("Preaprobado ELM")
 *            or granted ("Otorgado ELM") AND the solicitud never reached CZ estado 3.
 *
 * Membership is dynamic (recomputed on every read): a later definitive rejection removes the
 * solicitud (it moves to Rechazados through CZ estado 3), a grant keeps it. Manual / batch
 * sends (historical rejected solicitudes) never enter: they stay in Rechazados. A solicitud in
 * both cohorts is one row (proveedor 'cdv_elm'). ELM KPIs (`kpis_elm`) never mix with CDV.
 */

const {
  parseResultadoQuery,
  buildCohortByCzId,
  assemblePreaprobadosList,
  currentEstadoLabelByCzId,
  matchesSearch,
  inDateRange,
  DEFAULT_LIMIT,
} = require('./preaprobadosRead');
const {
  classifyElmProcess,
  readPostReferralRejectionStatuses,
  COMMERCIAL,
} = require('../services/elm/classification');

const REJECTED_ESTADO_ID = 3;
const ELM_MEMBER_STATES = Object.freeze([COMMERCIAL.REFERRED, COMMERCIAL.GRANTED]);
const PROVEEDOR = Object.freeze({ CDV: 'cdv', ELM: 'elm', BOTH: 'cdv_elm' });
const IN_CHUNK = 200;
const PAGE_SIZE = 1000;

const SOLICITUD_SELECT =
  'cz_id, ci, nombre, apellido, email, lrw_id, fecha_reg, solicitudes_estados_id, updated_at_src, synced_at';
const HISTORICO_SELECT =
  'cz_historico_id, cz_solicitud_id, solicitudes_estados_id, solicitudes_estados_id_anterior, estado, estado_anterior, fechahora_src';

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

function nonemptyText(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/** @returns {{ ok: true, value: string|null } | { ok: false }} */
function parseProveedorQuery(raw) {
  if (raw == null) return { ok: true, value: null };
  const s = String(raw).trim().toLowerCase();
  if (s === '' || s === 'all' || s === 'todos') return { ok: true, value: null };
  if (s === PROVEEDOR.CDV || s === PROVEEDOR.ELM) return { ok: true, value: s };
  return { ok: false };
}

/**
 * CDV values keep parseResultadoQuery; ELM values filter the ELM cohort only.
 * @returns {{ ok: true, cdv: string|null, elm: string|null } | { ok: false }}
 */
function parseCombinedResultadoQuery(raw) {
  const s = raw == null ? '' : String(raw).trim().toLowerCase();
  if (s === 'elm_preaprobado' || s === 'elm_referred') {
    return { ok: true, cdv: null, elm: COMMERCIAL.REFERRED };
  }
  if (s === 'elm_otorgado' || s === 'elm_granted') {
    return { ok: true, cdv: null, elm: COMMERCIAL.GRANTED };
  }
  const p = parseResultadoQuery(raw);
  if (!p.ok) return { ok: false };
  return { ok: true, cdv: p.value, elm: null };
}

/**
 * @param {{
 *   processes: object[],                      elm_lead_processes rows (list projection)
 *   projectedByCz?: Map<number, number>,      provider_cz_state for automatic processes
 *   rejectedCzIds?: Set<number>,              solicitudes with CZ estado 3 (historico or current)
 *   nowMs?: number,
 *   postReferralRejectionStatuses?: readonly string[],
 * }} input
 * @returns {Map<number, { process: object, classification: object, entered_at: string|null }>}
 */
function buildElmCohortByCzId(input) {
  const out = new Map();
  const projected = input.projectedByCz || new Map();
  const rejected = input.rejectedCzIds || new Set();
  for (const p of input.processes || []) {
    if (!p || p.trigger_origin !== 'cz_automatic') continue;
    const czId = toNum(p.cz_solicitud_id);
    if (czId == null || rejected.has(czId)) continue;
    const c = classifyElmProcess(p, {
      nowMs: input.nowMs,
      postReferralRejectionStatuses: input.postReferralRejectionStatuses || [],
      projectedEstado: projected.has(czId) ? projected.get(czId) : null,
    });
    if (!c || !ELM_MEMBER_STATES.includes(c.state)) continue;
    out.set(czId, {
      process: p,
      classification: c,
      entered_at: p.referred_at || p.s2_completed_at || p.disbursed_at || null,
    });
  }
  return out;
}

function elmMemberView(czId, m) {
  const p = m.process;
  return {
    state: m.classification.state,
    label: m.classification.label,
    detail_label: m.classification.detail_label,
    referred_at: p.referred_at || null,
    disbursed_at: p.disbursed_at || null,
    provider_status: p.provider_status || null,
    trigger_origin: p.trigger_origin,
    process_id: p.id || null,
    cz_solicitud_id: czId,
  };
}

function cmpDescNullsLast(aIso, bIso) {
  const a = tsMs(aIso);
  const b = tsMs(bIso);
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

/**
 * CDV list (unchanged rules, full filtered set) + ELM cohort rows, then one sort + page.
 * @param {object} input CDV bundle fields (as assemblePreaprobadosList) plus:
 *   elmCohort: Map (buildElmCohortByCzId), elmSolicitudRows, elmHistoricoRows,
 *   resultadoCdv, resultadoElm, proveedor
 */
function assembleCombinedPreaprobadosList(input) {
  const limit = input.limit != null ? Number(input.limit) : DEFAULT_LIMIT;
  const offset = input.offset != null ? Number(input.offset) : 0;
  const proveedor = input.proveedor || null;
  const resultadoCdv = input.resultadoCdv || null;
  const resultadoElm = input.resultadoElm || null;
  const elmCohort = input.elmCohort || new Map();

  const cdv = assemblePreaprobadosList({
    estado8Rows: input.estado8Rows,
    currentEstado8Solicitudes: input.currentEstado8Solicitudes,
    solicitudRows: input.solicitudRows,
    grantedRows: input.grantedRows,
    historicoRows: input.historicoRows,
    from: input.from,
    to: input.to,
    estado: input.estado,
    resultado: resultadoCdv,
    q: input.q,
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
    nowMs: input.nowMs,
  });

  const includeCdv = proveedor !== PROVEEDOR.ELM && !resultadoElm;
  const includeElm = proveedor !== PROVEEDOR.CDV && !resultadoCdv;
  const cdvCohortIds = new Set(
    buildCohortByCzId(input.estado8Rows, input.currentEstado8Solicitudes).keys(),
  );

  const rows = [];
  const byCz = new Map();
  if (includeCdv) {
    for (const r of cdv.rows) {
      const m = elmCohort.get(Number(r.cz_id));
      const row = Object.assign({}, r, {
        proveedor: m ? PROVEEDOR.BOTH : PROVEEDOR.CDV,
        elm_member: m ? elmMemberView(Number(r.cz_id), m) : null,
      });
      rows.push(row);
      byCz.set(Number(r.cz_id), row);
    }
  }

  const elmRowsForKpi = [];
  if (includeElm && elmCohort.size) {
    const solById = new Map();
    for (const s of input.elmSolicitudRows || []) solById.set(Number(s.cz_id), s);
    const labelByCz = currentEstadoLabelByCzId(
      input.elmHistoricoRows || [],
      input.elmSolicitudRows || [],
    );
    const estadoFilter =
      input.estado != null && input.estado !== '' ? Number(input.estado) : null;
    for (const [czId, m] of elmCohort.entries()) {
      if (resultadoElm && m.classification.state !== resultadoElm) continue;
      if (!inDateRange(m.entered_at, input.from || null, input.to || null)) continue;
      const sol = solById.get(czId) || null;
      const base = {
        cz_id: czId,
        cohort_entered_at: m.entered_at,
        nombre: nonemptyText(sol && sol.nombre),
        apellido: nonemptyText(sol && sol.apellido),
        ci: toNum(sol && sol.ci) != null ? toNum(sol.ci) : toNum(m.process.ci),
        estado_id: toNum(sol && sol.solicitudes_estados_id),
        estado_label: labelByCz.get(czId) || null,
        resultado: null,
        monto_otorgado: null,
        lrw_id: nonemptyText(sol && sol.lrw_id),
      };
      if (estadoFilter != null && base.estado_id !== estadoFilter) continue;
      if (!matchesSearch(base, input.q || null)) continue;
      elmRowsForKpi.push(m);
      const existing = byCz.get(czId);
      if (existing) continue;
      const row = Object.assign(base, {
        proveedor: cdvCohortIds.has(czId) ? PROVEEDOR.BOTH : PROVEEDOR.ELM,
        elm_member: elmMemberView(czId, m),
      });
      rows.push(row);
      byCz.set(czId, row);
    }
  }

  rows.sort(function (a, b) {
    const t = cmpDescNullsLast(a.cohort_entered_at, b.cohort_entered_at);
    if (t !== 0) return t;
    return Number(b.cz_id) - Number(a.cz_id);
  });

  let grantedElm = 0;
  for (const m of elmRowsForKpi) {
    if (m.classification.state === COMMERCIAL.GRANTED) grantedElm += 1;
  }
  const preaprobadosElm = elmRowsForKpi.length;

  return {
    cohort: cdv.cohort,
    kpis: cdv.kpis,
    kpis_elm: {
      preaprobados_elm: preaprobadosElm,
      otorgados_elm: grantedElm,
      vigentes_elm: preaprobadosElm - grantedElm,
      conversion_elm: preaprobadosElm > 0 ? grantedElm / preaprobadosElm : null,
      scope: 'cz_automatic',
    },
    rows: rows.slice(offset, offset + limit),
    total: rows.length,
    limit: limit,
    offset: offset,
  };
}

async function fetchInChunks(supabase, table, select, column, ids, extra) {
  const unique = Array.from(new Set((ids || []).filter(function (v) { return v != null; })));
  const all = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    for (let from = 0; ; from += PAGE_SIZE) {
      let q = supabase.from(table).select(select).in(column, chunk);
      if (extra) q = extra(q);
      const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      const rows = data || [];
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
  }
  return all;
}

/** Solicitudes (of the given ids) that reached CZ estado 3, historico or current. */
function rejectedSetFrom(estado3Rows, solicitudRows) {
  const set = new Set();
  for (const e of estado3Rows || []) {
    if (Number(e.solicitudes_estados_id) === REJECTED_ESTADO_ID) {
      set.add(Number(e.cz_solicitud_id));
    }
  }
  for (const s of solicitudRows || []) {
    if (Number(s.solicitudes_estados_id) === REJECTED_ESTADO_ID) set.add(Number(s.cz_id));
  }
  return set;
}

/**
 * @param {object} supabase
 * @param {{ elmRepository: object, nowMs?: number, postReferralRejectionStatuses?: string[] }} deps
 */
async function fetchElmCohortBundle(supabase, deps) {
  const repo = deps.elmRepository;
  const processes = await repo.listAllProcesses({ triggerOrigins: ['cz_automatic'] });
  if (!processes.length) {
    return { elmCohort: new Map(), elmSolicitudRows: [], elmHistoricoRows: [] };
  }
  const ids = processes.map(function (p) { return Number(p.cz_solicitud_id); });
  const projectedByCz = await repo.getProjectedEstadosByCzIds(ids);
  const postReferral = deps.postReferralRejectionStatuses || readPostReferralRejectionStatuses();
  const candidates = buildElmCohortByCzId({
    processes: processes,
    projectedByCz: projectedByCz,
    nowMs: deps.nowMs,
    postReferralRejectionStatuses: postReferral,
  });
  const candidateIds = Array.from(candidates.keys());
  if (!candidateIds.length) {
    return { elmCohort: candidates, elmSolicitudRows: [], elmHistoricoRows: [] };
  }
  const [solicitudRows, historicoRows] = await Promise.all([
    fetchInChunks(supabase, 'cz_funnel_solicitudes', SOLICITUD_SELECT, 'cz_id', candidateIds),
    fetchInChunks(
      supabase,
      'cz_funnel_solicitud_estados',
      HISTORICO_SELECT,
      'cz_solicitud_id',
      candidateIds,
    ),
  ]);
  const rejected = rejectedSetFrom(historicoRows, solicitudRows);
  for (const id of rejected) candidates.delete(id);
  return {
    elmCohort: candidates,
    elmSolicitudRows: solicitudRows,
    elmHistoricoRows: historicoRows,
  };
}

/**
 * Detail for a solicitud that is only in the ELM cohort (CDV detail answered not_in_cohort).
 * @returns {Promise<object|null>}
 */
async function fetchElmCohortDetail(supabase, czId, deps) {
  const repo = deps.elmRepository;
  const process = await repo.getProcessByCzId(czId);
  if (!process || process.trigger_origin !== 'cz_automatic') return null;
  const projected = await repo.getProjectedEstadosByCzIds([czId]);
  const { data: sol, error: solErr } = await supabase
    .from('cz_funnel_solicitudes')
    .select(SOLICITUD_SELECT)
    .eq('cz_id', czId)
    .maybeSingle();
  if (solErr) throw solErr;
  const historicoRows = await fetchInChunks(
    supabase,
    'cz_funnel_solicitud_estados',
    HISTORICO_SELECT,
    'cz_solicitud_id',
    [czId],
  );
  const cohort = buildElmCohortByCzId({
    processes: [process],
    projectedByCz: projected,
    rejectedCzIds: rejectedSetFrom(historicoRows, sol ? [sol] : []),
    nowMs: deps.nowMs,
    postReferralRejectionStatuses:
      deps.postReferralRejectionStatuses || readPostReferralRejectionStatuses(),
  });
  const m = cohort.get(czId);
  if (!m) return null;
  return assembleElmCohortDetail(czId, m, sol || null, historicoRows);
}

function assembleElmCohortDetail(czId, m, sol, historicoRows) {
  const labels = currentEstadoLabelByCzId(historicoRows || [], sol ? [sol] : []);
  const historico = (historicoRows || [])
    .slice()
    .sort(function (a, b) {
      const t = -cmpDescNullsLast(a.fechahora_src, b.fechahora_src);
      if (t !== 0) return t;
      return (toNum(a.cz_historico_id) || 0) - (toNum(b.cz_historico_id) || 0);
    })
    .map(function (e) {
      return {
        cz_historico_id: toNum(e.cz_historico_id),
        solicitudes_estados_id: toNum(e.solicitudes_estados_id),
        estado: nonemptyText(e.estado),
        solicitudes_estados_id_anterior: toNum(e.solicitudes_estados_id_anterior),
        estado_anterior: nonemptyText(e.estado_anterior),
        fechahora_src: e.fechahora_src != null ? e.fechahora_src : null,
      };
    });
  return {
    cz_id: czId,
    cohort_entered_at: m.entered_at,
    cohort_from_historico: false,
    nombre: nonemptyText(sol && sol.nombre),
    apellido: nonemptyText(sol && sol.apellido),
    ci: toNum(sol && sol.ci) != null ? toNum(sol.ci) : toNum(m.process.ci),
    email: nonemptyText(sol && sol.email),
    fecha_reg: sol && sol.fecha_reg != null ? sol.fecha_reg : null,
    lrw_id: nonemptyText(sol && sol.lrw_id),
    resultado: null,
    estado_id: toNum(sol && sol.solicitudes_estados_id),
    estado_label: labels.get(czId) || null,
    monto_otorgado: null,
    granted: null,
    synced_at: sol && sol.synced_at != null ? sol.synced_at : null,
    updated_at_src: sol && sol.updated_at_src != null ? sol.updated_at_src : null,
    historico: historico,
    historico_note: 'Eventos disponibles en JANUS (puede estar incompleto hacia el pasado).',
    proveedor: PROVEEDOR.ELM,
    elm_member: elmMemberView(czId, m),
  };
}

module.exports = {
  PROVEEDOR,
  ELM_MEMBER_STATES,
  parseProveedorQuery,
  parseCombinedResultadoQuery,
  buildElmCohortByCzId,
  assembleCombinedPreaprobadosList,
  assembleElmCohortDetail,
  rejectedSetFrom,
  fetchElmCohortBundle,
  fetchElmCohortDetail,
};
