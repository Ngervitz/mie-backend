'use strict';

/**
 * Rechazados V0 read helpers.
 *
 * List/detail assembly is pure (fixtures in unit tests). Supabase I/O lives
 * in fetch* functions used by the route.
 *
 * Name resolution (deterministic):
 * 1. Last rejection = estado 3 with MAX(fechahora_src); ties → cz_historico_id DESC.
 *    Use that solicitud's nombre/apellido if either is non-empty.
 * 2. Else latest solicitud for the CI with non-empty nombre or apellido
 *    (fecha_reg DESC NULLS LAST, then cz_id DESC).
 */

const {
  OPS_STATUS,
  deriveRejectedOps,
} = require('./rejectedOps');

const REJECTED_ESTADO_ID = 3;
const PAGE_SIZE = 1000;
const IN_CHUNK = 200;

const ALLOWED_OPS_STATUS = Object.freeze(Object.values(OPS_STATUS));

const SNAPSHOT_SELECT =
  'id, ci, period_label, consulted_on, source, storage_path, original_filename, content_type, file_size_bytes, created_at';

const INSTITUTION_SELECT =
  'id, snapshot_id, institution_name, category, vigente_mn, vigente_me, moroso_mn, moroso_me, castigado_mn, castigado_me, contingencias_mn, contingencias_me, sort_order, created_at';

/**
 * @param {unknown} raw
 * @returns {{ ok: true, status: string|null } | { ok: false }}
 */
function parseStatusQuery(raw) {
  if (raw == null) return { ok: true, status: null };
  const s = String(raw).trim();
  if (s === '') return { ok: true, status: null };
  if (!ALLOWED_OPS_STATUS.includes(s)) return { ok: false };
  return { ok: true, status: s };
}

function tsMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

function cmpDescNullsLastMs(aMs, bMs) {
  if (aMs == null && bMs == null) return 0;
  if (aMs == null) return 1;
  if (bMs == null) return -1;
  if (bMs > aMs) return 1;
  if (bMs < aMs) return -1;
  return 0;
}

function cmpTsDescNullsLast(a, b) {
  return cmpDescNullsLastMs(tsMs(a), tsMs(b));
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

function hasPersonName(sol) {
  return Boolean(nonemptyText(sol && sol.nombre) || nonemptyText(sol && sol.apellido));
}

function sortRejectionsDesc(rows) {
  return rows.slice().sort(function (a, b) {
    const t = cmpTsDescNullsLast(a.fechahora_src, b.fechahora_src);
    if (t !== 0) return t;
    return Number(b.cz_historico_id) - Number(a.cz_historico_id);
  });
}

function sortEncuestas(rows) {
  return rows.slice().sort(function (a, b) {
    const t = cmpTsDescNullsLast(a.completed_at, b.completed_at);
    if (t !== 0) return t;
    return Number(b.cz_id) - Number(a.cz_id);
  });
}

function snapshotSortKey(row) {
  const on = row && row.consulted_on != null ? String(row.consulted_on) : '';
  const created = row && row.created_at != null ? String(row.created_at) : '';
  return { on: on, created: created };
}

function sortSnapshotsDesc(rows) {
  return rows.slice().sort(function (a, b) {
    const ka = snapshotSortKey(a);
    const kb = snapshotSortKey(b);
    if (ka.on !== kb.on) return ka.on < kb.on ? 1 : -1;
    if (ka.created !== kb.created) return ka.created < kb.created ? 1 : -1;
    return String(b.id).localeCompare(String(a.id));
  });
}

function sortInstitutions(rows) {
  return rows.slice().sort(function (a, b) {
    const sa = Number(a.sort_order) || 0;
    const sb = Number(b.sort_order) || 0;
    if (sa !== sb) return sa - sb;
    const t = tsMs(a.created_at);
    const u = tsMs(b.created_at);
    if (t == null && u == null) return String(a.id).localeCompare(String(b.id));
    if (t == null) return 1;
    if (u == null) return -1;
    if (t !== u) return t - u;
    return String(a.id).localeCompare(String(b.id));
  });
}

function mapByCi(rows) {
  const map = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const ci = toNum(row && row.ci);
    if (ci == null || !Number.isSafeInteger(ci)) continue;
    if (!map.has(ci)) map.set(ci, []);
    map.get(ci).push(row);
  }
  return map;
}

function solicitudesById(rows) {
  const map = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const id = toNum(rows[i] && rows[i].cz_id);
    if (id == null) continue;
    map.set(id, rows[i]);
  }
  return map;
}

/**
 * Join estado 3 → solicitud.ci. Skip rows without a usable CI.
 * @returns {Map<number, object[]>}
 */
function rejectionsByCi(estadoRows, solById) {
  const map = new Map();
  for (let i = 0; i < estadoRows.length; i += 1) {
    const e = estadoRows[i];
    if (Number(e && e.solicitudes_estados_id) !== REJECTED_ESTADO_ID) continue;
    const solId = toNum(e && e.cz_solicitud_id);
    const sol = solId != null ? solById.get(solId) : null;
    const ci = toNum(sol && sol.ci);
    if (ci == null || !Number.isSafeInteger(ci)) continue;
    if (!map.has(ci)) map.set(ci, []);
    map.get(ci).push(e);
  }
  return map;
}

function resolvePersonName(lastRejection, solById, solsForCi) {
  const lastSolId = toNum(lastRejection && lastRejection.cz_solicitud_id);
  const lastSol = lastSolId != null ? solById.get(lastSolId) : null;
  if (hasPersonName(lastSol)) {
    return {
      nombre: nonemptyText(lastSol.nombre),
      apellido: nonemptyText(lastSol.apellido),
    };
  }
  const named = (solsForCi || []).filter(hasPersonName).sort(function (a, b) {
    const t = cmpTsDescNullsLast(a.fecha_reg, b.fecha_reg);
    if (t !== 0) return t;
    return Number(b.cz_id) - Number(a.cz_id);
  });
  if (named.length) {
    return {
      nombre: nonemptyText(named[0].nombre),
      apellido: nonemptyText(named[0].apellido),
    };
  }
  return { nombre: null, apellido: null };
}

function institutionsBySnapshotId(institutionRows) {
  const map = new Map();
  for (let i = 0; i < institutionRows.length; i += 1) {
    const row = institutionRows[i];
    const sid = row && row.snapshot_id;
    if (!sid) continue;
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(row);
  }
  for (const [sid, list] of map.entries()) {
    map.set(sid, sortInstitutions(list));
  }
  return map;
}

function formatInstitution(row) {
  return {
    id: row.id,
    institution_name: row.institution_name,
    category: row.category,
    vigente_mn: toNum(row.vigente_mn) || 0,
    vigente_me: toNum(row.vigente_me) || 0,
    moroso_mn: toNum(row.moroso_mn) || 0,
    moroso_me: toNum(row.moroso_me) || 0,
    castigado_mn: toNum(row.castigado_mn) || 0,
    castigado_me: toNum(row.castigado_me) || 0,
    contingencias_mn: toNum(row.contingencias_mn) || 0,
    contingencias_me: toNum(row.contingencias_me) || 0,
    sort_order: Number(row.sort_order) || 0,
  };
}

function snapshotDerived(snapshot, institutions) {
  const ops = deriveRejectedOps({
    institutions: institutions,
    consultedOn: snapshot && snapshot.consulted_on,
  });
  return ops;
}

function formatSnapshot(snapshot, instMap, withDerived) {
  const institutions = (instMap.get(snapshot.id) || []).map(formatInstitution);
  const body = {
    id: snapshot.id,
    period_label: snapshot.period_label,
    consulted_on: snapshot.consulted_on,
    source: snapshot.source,
    storage_path: snapshot.storage_path != null ? snapshot.storage_path : null,
    original_filename:
      snapshot.original_filename != null ? snapshot.original_filename : null,
    content_type: snapshot.content_type != null ? snapshot.content_type : null,
    file_size_bytes:
      snapshot.file_size_bytes != null ? toNum(snapshot.file_size_bytes) : null,
    created_at: snapshot.created_at,
    institutions: institutions,
  };
  if (withDerived) {
    const ops = snapshotDerived(snapshot, institutions);
    body.worst_bcu = ops.worst_bcu;
    body.ops_status = ops.ops_status;
    body.next_review_on = ops.next_review_on;
  }
  return body;
}

function currentOpsFromLatestSnapshot(snapshotsDesc, instMap) {
  if (!snapshotsDesc.length) {
    return {
      worst_bcu: null,
      ops_status: OPS_STATUS.BCU_PENDING,
      next_review_on: null,
    };
  }
  const latest = snapshotsDesc[0];
  const institutions = (instMap.get(latest.id) || []).map(formatInstitution);
  return snapshotDerived(latest, institutions);
}

function formatListRow(ci, lastRejection, name, encuesta, ops) {
  return {
    ci: ci,
    nombre: name.nombre,
    apellido: name.apellido,
    rejected_at: lastRejection.fechahora_src || null,
    score_v2: encuesta ? toNum(encuesta.score_v2) : null,
    encuesta_completed_at: encuesta ? encuesta.completed_at || null : null,
    worst_bcu: ops.worst_bcu,
    ops_status: ops.ops_status,
    next_review_on: ops.next_review_on,
  };
}

/**
 * @param {{
 *   estadoRows: object[],
 *   solicitudRows: object[],
 *   encuestaRows: object[],
 *   snapshotRows: object[],
 *   institutionRows: object[],
 *   status?: string|null,
 * }} input
 */
function assembleRejectedList(input) {
  const solById = solicitudesById(input.solicitudRows || []);
  const byCi = rejectionsByCi(input.estadoRows || [], solById);
  const encuestasByCi = mapByCi(input.encuestaRows || []);
  const snapshotsByCi = mapByCi(input.snapshotRows || []);
  const instMap = institutionsBySnapshotId(input.institutionRows || []);
  const solsByCi = mapByCi(input.solicitudRows || []);
  const statusFilter = input.status || null;

  const rows = [];
  for (const [ci, rejections] of byCi.entries()) {
    const sortedRej = sortRejectionsDesc(rejections);
    const lastRejection = sortedRej[0];
    const name = resolvePersonName(lastRejection, solById, solsByCi.get(ci) || []);
    const encuestas = sortEncuestas(encuestasByCi.get(ci) || []);
    const encuesta = encuestas[0] || null;
    const snaps = sortSnapshotsDesc(snapshotsByCi.get(ci) || []);
    const ops = currentOpsFromLatestSnapshot(snaps, instMap);
    if (statusFilter && ops.ops_status !== statusFilter) continue;
    rows.push(formatListRow(ci, lastRejection, name, encuesta, ops));
  }

  rows.sort(function (a, b) {
    return cmpTsDescNullsLast(a.rejected_at, b.rejected_at);
  });
  return rows;
}

/**
 * @returns {object|null} null when CI has no estado 3
 */
function assembleRejectedDetail(input) {
  const ci = input.ci;
  const solById = solicitudesById(input.solicitudRows || []);
  const byCi = rejectionsByCi(input.estadoRows || [], solById);
  const rejections = byCi.get(ci) || [];
  if (!rejections.length) return null;

  const sortedRej = sortRejectionsDesc(rejections);
  const lastRejection = sortedRej[0];
  const solsForCi = (input.solicitudRows || []).filter(function (s) {
    return toNum(s.ci) === ci;
  });
  const name = resolvePersonName(lastRejection, solById, solsForCi);
  const encuestas = sortEncuestas(
    (input.encuestaRows || []).filter(function (e) {
      return toNum(e.ci) === ci;
    }),
  );
  const snaps = sortSnapshotsDesc(
    (input.snapshotRows || []).filter(function (s) {
      return toNum(s.ci) === ci;
    }),
  );
  const instMap = institutionsBySnapshotId(input.institutionRows || []);
  const ops = currentOpsFromLatestSnapshot(snaps, instMap);
  const latestEncuesta = encuestas[0] || null;

  return {
    ci: ci,
    nombre: name.nombre,
    apellido: name.apellido,
    rejected_at: lastRejection.fechahora_src || null,
    score_v2: latestEncuesta ? toNum(latestEncuesta.score_v2) : null,
    encuesta_completed_at: latestEncuesta
      ? latestEncuesta.completed_at || null
      : null,
    worst_bcu: ops.worst_bcu,
    ops_status: ops.ops_status,
    next_review_on: ops.next_review_on,
    rejections: sortedRej.map(function (e) {
      return {
        cz_historico_id: e.cz_historico_id,
        cz_solicitud_id: e.cz_solicitud_id,
        solicitudes_estados_id: e.solicitudes_estados_id,
        estado: e.estado != null ? e.estado : null,
        fechahora_src: e.fechahora_src || null,
      };
    }),
    encuestas: encuestas.map(function (e) {
      return {
        cz_id: e.cz_id,
        score_v2: toNum(e.score_v2),
        completed_at: e.completed_at || null,
        email: e.email != null ? e.email : null,
      };
    }),
    snapshots: snaps.map(function (s) {
      return formatSnapshot(s, instMap, true);
    }),
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
  }
  return all;
}

async function fetchInChunks(supabase, table, select, column, ids) {
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

async function fetchRejectedEstadoRows(supabase, solicitudIds) {
  if (solicitudIds && !solicitudIds.length) return [];
  if (solicitudIds) {
    const unique = [];
    const seen = new Set();
    for (let i = 0; i < solicitudIds.length; i += 1) {
      const id = solicitudIds[i];
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
    const all = [];
    for (let i = 0; i < unique.length; i += IN_CHUNK) {
      const chunk = unique.slice(i, i + IN_CHUNK);
      const page = await fetchAllPages(function (from, to) {
        return supabase
          .from('cz_funnel_solicitud_estados')
          .select(
            'cz_historico_id, cz_solicitud_id, solicitudes_estados_id, estado, fechahora_src',
          )
          .eq('solicitudes_estados_id', REJECTED_ESTADO_ID)
          .in('cz_solicitud_id', chunk)
          .range(from, to);
      });
      all.push(...page);
    }
    return all;
  }
  return fetchAllPages(function (from, to) {
    return supabase
      .from('cz_funnel_solicitud_estados')
      .select(
        'cz_historico_id, cz_solicitud_id, solicitudes_estados_id, estado, fechahora_src',
      )
      .eq('solicitudes_estados_id', REJECTED_ESTADO_ID)
      .range(from, to);
  });
}

async function fetchRejectedListBundle(supabase) {
  const estadoRows = await fetchRejectedEstadoRows(supabase, null);
  const solicitudIds = estadoRows.map(function (e) {
    return e.cz_solicitud_id;
  });
  const rejectedSolicitudes = await fetchInChunks(
    supabase,
    'cz_funnel_solicitudes',
    'cz_id, ci, nombre, apellido, fecha_reg',
    'cz_id',
    solicitudIds,
  );
  const cis = [];
  for (let i = 0; i < rejectedSolicitudes.length; i += 1) {
    const ci = toNum(rejectedSolicitudes[i].ci);
    if (ci != null) cis.push(ci);
  }
  const solicitudRows = cis.length
    ? await fetchInChunks(
        supabase,
        'cz_funnel_solicitudes',
        'cz_id, ci, nombre, apellido, fecha_reg',
        'ci',
        cis,
      )
    : [];
  const encuestaRows = cis.length
    ? await fetchInChunks(
        supabase,
        'cz_funnel_encuestas',
        'cz_id, ci, score_v2, completed_at, email',
        'ci',
        cis,
      )
    : [];
  const snapshotRows = cis.length
    ? await fetchInChunks(
        supabase,
        'rejected_bcu_snapshots',
        SNAPSHOT_SELECT,
        'ci',
        cis,
      )
    : [];
  const snapshotIds = snapshotRows.map(function (s) {
    return s.id;
  });
  const institutionRows = snapshotIds.length
    ? await fetchInChunks(
        supabase,
        'rejected_bcu_institutions',
        INSTITUTION_SELECT,
        'snapshot_id',
        snapshotIds,
      )
    : [];
  return {
    estadoRows: estadoRows,
    solicitudRows: solicitudRows,
    encuestaRows: encuestaRows,
    snapshotRows: snapshotRows,
    institutionRows: institutionRows,
  };
}

async function fetchRejectedDetailBundle(supabase, ci) {
  const solicitudRows = await fetchAllPages(function (from, to) {
    return supabase
      .from('cz_funnel_solicitudes')
      .select('cz_id, ci, nombre, apellido, fecha_reg')
      .eq('ci', ci)
      .range(from, to);
  });
  const solicitudIds = solicitudRows.map(function (s) {
    return s.cz_id;
  });
  const estadoRows = solicitudIds.length
    ? await fetchRejectedEstadoRows(supabase, solicitudIds)
    : [];
  const encuestaRows = await fetchAllPages(function (from, to) {
    return supabase
      .from('cz_funnel_encuestas')
      .select('cz_id, ci, score_v2, completed_at, email')
      .eq('ci', ci)
      .range(from, to);
  });
  const snapshotRows = await fetchAllPages(function (from, to) {
    return supabase
      .from('rejected_bcu_snapshots')
      .select(SNAPSHOT_SELECT)
      .eq('ci', ci)
      .range(from, to);
  });
  const snapshotIds = snapshotRows.map(function (s) {
    return s.id;
  });
  const institutionRows = snapshotIds.length
    ? await fetchInChunks(
        supabase,
        'rejected_bcu_institutions',
        INSTITUTION_SELECT,
        'snapshot_id',
        snapshotIds,
      )
    : [];
  return {
    ci: ci,
    estadoRows: estadoRows,
    solicitudRows: solicitudRows,
    encuestaRows: encuestaRows,
    snapshotRows: snapshotRows,
    institutionRows: institutionRows,
  };
}

function hasRejectedHistorico(estadoRows, solicitudRows, ci) {
  const byCi = rejectionsByCi(estadoRows || [], solicitudesById(solicitudRows || []));
  return byCi.has(ci);
}

async function fetchCiHasRejectedHistorico(supabase, ci) {
  const solicitudRows = await fetchAllPages(function (from, to) {
    return supabase
      .from('cz_funnel_solicitudes')
      .select('cz_id, ci')
      .eq('ci', ci)
      .range(from, to);
  });
  const solicitudIds = solicitudRows.map(function (s) {
    return s.cz_id;
  });
  if (!solicitudIds.length) return false;
  const estadoRows = await fetchRejectedEstadoRows(supabase, solicitudIds);
  return hasRejectedHistorico(estadoRows, solicitudRows, ci);
}

function buildCreatedSnapshotResponse(snapshot, institutionRows) {
  const instMap = new Map();
  instMap.set(snapshot.id, institutionRows || []);
  const formatted = formatSnapshot(snapshot, instMap, true);
  return {
    id: formatted.id,
    ci: snapshot.ci,
    period_label: formatted.period_label,
    consulted_on: formatted.consulted_on,
    source: formatted.source,
    storage_path: formatted.storage_path,
    original_filename: formatted.original_filename,
    content_type: formatted.content_type,
    file_size_bytes: formatted.file_size_bytes,
    created_by: snapshot.created_by != null ? snapshot.created_by : null,
    created_at: formatted.created_at,
    institutions: formatted.institutions,
    worst_bcu: formatted.worst_bcu,
    ops_status: formatted.ops_status,
    next_review_on: formatted.next_review_on,
  };
}

module.exports = {
  REJECTED_ESTADO_ID,
  ALLOWED_OPS_STATUS,
  parseStatusQuery,
  sortRejectionsDesc,
  sortEncuestas,
  sortSnapshotsDesc,
  sortInstitutions,
  assembleRejectedList,
  assembleRejectedDetail,
  fetchRejectedListBundle,
  fetchRejectedDetailBundle,
  hasRejectedHistorico,
  fetchCiHasRejectedHistorico,
  formatInstitution,
  formatSnapshot,
  buildCreatedSnapshotResponse,
};
