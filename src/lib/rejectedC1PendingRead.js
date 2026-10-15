'use strict';

/**
 * C1 solicitudes with open projected CZ estado (12 / 13 / 14 / 15) merged into Rechazados
 * for display and ELM follow-up only. Not part of rejectedUniverseByCi (estado 3).
 */

const {
  listOpsForRejectedDisplay,
  sortSnapshotsDesc,
  sortEncuestas,
  encuestaScoreMeta,
  formatSnapshot,
  institutionsBySnapshotId,
} = require('./rejectedOpsRead');
const { formatOutreach } = require('./rejectedOutreach');
const { loanPurposeOf } = require('./czSurveyVersion');

/** Open projected estados shown in Rechazados (display merge only). */
const C1_DISPLAY_PROJECTED_ESTADOS = Object.freeze([12, 13, 14, 15]);

const ELM_PROCESS_GRANTED_SELECT = 'cz_solicitud_id';

const PAGE_SIZE = 1000;

const SOLICITUD_SELECT = 'cz_id, ci, nombre, apellido, fecha_reg, solicitudes_estados_id, updated_at_src';

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

function solicitudesById(rows) {
  const map = new Map();
  for (let i = 0; i < (rows || []).length; i += 1) {
    const row = rows[i];
    const id = toNum(row && row.cz_id);
    if (id != null) map.set(id, row);
  }
  return map;
}

function hasPersonName(sol) {
  return Boolean(nonemptyText(sol && sol.nombre) || nonemptyText(sol && sol.apellido));
}

function resolvePersonName(solicitudesByCz, entries) {
  for (let i = 0; i < entries.length; i += 1) {
    const sol = solicitudesByCz.get(entries[i].cz_solicitud_id);
    if (hasPersonName(sol)) {
      return {
        nombre: nonemptyText(sol.nombre),
        apellido: nonemptyText(sol.apellido),
      };
    }
  }
  return { nombre: null, apellido: null };
}

function outreachByCi(outreachRows) {
  const map = new Map();
  for (let i = 0; i < (outreachRows || []).length; i += 1) {
    const row = outreachRows[i];
    const ci = toNum(row && row.ci);
    if (ci == null || !Number.isSafeInteger(ci)) continue;
    map.set(ci, row);
  }
  return map;
}

function sortRejectedSolicitudesDesc(list) {
  return (list || []).slice().sort(function (a, b) {
    const t = cmpTsDescNullsLast(a.rejected_at, b.rejected_at);
    if (t !== 0) return t;
    return Number(b.cz_solicitud_id) - Number(a.cz_solicitud_id);
  });
}

function appendC1SolicitudesToRow(row, entries) {
  const seen = new Set(
    (row.rejected_solicitudes || []).map(function (r) {
      return Number(r.cz_solicitud_id);
    }),
  );
  const merged = (row.rejected_solicitudes || []).slice();
  for (let i = 0; i < entries.length; i += 1) {
    const id = entries[i].cz_solicitud_id;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push({
      cz_solicitud_id: id,
      rejected_at: entries[i].rejected_at,
    });
  }
  row.rejected_solicitudes = sortRejectedSolicitudesDesc(merged);
}

function c1PassesOpsStatusFilter(ops, statusFilter) {
  if (!statusFilter) return true;
  if (!ops.has_rejected_bcu_snapshot) return false;
  return ops.ops_status === statusFilter;
}

/**
 * @param {number} ci
 * @param {object[]} entries
 * @param {Map<number, object>} solicitudesByCz
 * @param {object} ops from listOpsForRejectedDisplay
 * @param {object} outreach
 */
function buildC1OnlyListRow(ci, entries, solicitudesByCz, ops, outreach) {
  const sorted = sortRejectedSolicitudesDesc(
    entries.map(function (e) {
      return { cz_solicitud_id: e.cz_solicitud_id, rejected_at: e.rejected_at };
    }),
  );
  const primary = sorted[0];
  const name = resolvePersonName(solicitudesByCz, sorted);
  return Object.assign(
    {
      ci: ci,
      cz_solicitud_id: primary.cz_solicitud_id,
      rejected_solicitudes: sorted,
      nombre: name.nombre,
      apellido: name.apellido,
      rejected_at: primary.rejected_at || null,
      score_v2: null,
      encuesta_completed_at: null,
      survey_version: null,
      segmentacion_base: null,
      worst_bcu: ops.worst_bcu,
      ops_status: ops.ops_status,
      next_review_on: ops.next_review_on,
      list_origin: 'c1_elm_followup',
    },
    outreach,
  );
}

/**
 * C1 display merge only: solicitudes with ELM otorgamiento confirmado (`disbursed_at`) stay out of
 * Rechazados; same criterion as classification / provider fallback (no second commercial rule).
 * @param {object[]} states
 * @param {Set<number>|number[]} grantedCzIds
 */
function filterC1StatesExcludingElmGranted(states, grantedCzIds) {
  const granted =
    grantedCzIds instanceof Set
      ? grantedCzIds
      : new Set(
          (grantedCzIds || [])
            .map(Number)
            .filter(function (n) {
              return Number.isSafeInteger(n) && n > 0;
            }),
        );
  return (states || []).filter(function (st) {
    const id = toNum(st && st.cz_solicitud_id);
    return id != null && !granted.has(id);
  });
}

async function fetchElmGrantedCzIds(supabase, czIds) {
  const ids = Array.from(
    new Set(
      (czIds || [])
        .map(Number)
        .filter(function (n) {
          return Number.isSafeInteger(n) && n > 0;
        }),
    ),
  );
  const granted = new Set();
  if (!ids.length) return granted;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('elm_lead_processes')
      .select(ELM_PROCESS_GRANTED_SELECT)
      .in('cz_solicitud_id', chunk)
      .not('disbursed_at', 'is', null);
    if (error) throw rpcError('elm_lead_processes', error);
    for (const row of data || []) {
      const id = toNum(row && row.cz_solicitud_id);
      if (id != null) granted.add(id);
    }
  }
  return granted;
}

function mergeC1FollowupIntoRejectedRows(estado3Rows, input) {
  const states = filterC1StatesExcludingElmGranted(
    Array.isArray(input.states) ? input.states : [],
    input.grantedCzIds || null,
  );
  const solicitudesByCz = input.solicitudesByCz || new Map();
  const statusFilter = input.statusFilter || null;
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const outreachMap = outreachByCi(input.outreachRows || []);

  const byCi = new Map();
  for (let i = 0; i < states.length; i += 1) {
    const st = states[i];
    const czId = toNum(st && st.cz_solicitud_id);
    const ci = toNum(st && st.ci);
    const projected = toNum(st && st.projected_estado);
    if (czId == null || ci == null || !C1_DISPLAY_PROJECTED_ESTADOS.includes(Number(projected))) {
      continue;
    }
    if (!byCi.has(ci)) byCi.set(ci, []);
    byCi.get(ci).push({
      cz_solicitud_id: czId,
      rejected_at: (st && st.updated_at) || null,
    });
  }

  const merged = (estado3Rows || []).slice();
  const rowByCi = new Map(
    merged.map(function (row) {
      return [Number(row.ci), row];
    }),
  );

  for (const [ci, entries] of byCi.entries()) {
    const sortedEntries = sortRejectedSolicitudesDesc(entries);
    const existing = rowByCi.get(ci);
    if (existing) {
      appendC1SolicitudesToRow(existing, sortedEntries);
      continue;
    }
    const ops = listOpsForRejectedDisplay(ci, input.snapshotRows, input.institutionRows);
    if (!c1PassesOpsStatusFilter(ops, statusFilter)) continue;
    const outreach = formatOutreach(outreachMap.get(ci) || null, nowMs);
    merged.push(
      buildC1OnlyListRow(ci, sortedEntries, solicitudesByCz, ops, outreach),
    );
  }

  merged.sort(function (a, b) {
    return cmpTsDescNullsLast(a.rejected_at, b.rejected_at);
  });
  return merged;
}

async function fetchAllProjectedStates(supabase) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('provider_cz_state')
      .select('cz_solicitud_id, ci, projected_estado, updated_at')
      .in('projected_estado', C1_DISPLAY_PROJECTED_ESTADOS.slice())
      .order('updated_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw rpcError('provider_cz_state', error);
    const page = data || [];
    out.push.apply(out, page);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

async function fetchProjectedStatesForCi(supabase, ci) {
  const nci = Number(ci);
  if (!Number.isSafeInteger(nci) || nci <= 0) return [];
  const { data, error } = await supabase
    .from('provider_cz_state')
    .select('cz_solicitud_id, ci, projected_estado, updated_at')
    .eq('ci', nci)
    .in('projected_estado', C1_DISPLAY_PROJECTED_ESTADOS.slice());
  if (error) throw rpcError('provider_cz_state', error);
  return data || [];
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

async function loadAndMergeC1FollowupRows(supabase, estado3Rows, opts) {
  const options = opts || {};
  const states = await fetchAllProjectedStates(supabase);
  const czIds = states.map(function (s) {
    return Number(s.cz_solicitud_id);
  });
  const grantedCzIds = await fetchElmGrantedCzIds(supabase, czIds);
  const solicitudesByCz = await fetchSolicitudesByCzIds(supabase, czIds);
  return mergeC1FollowupIntoRejectedRows(estado3Rows, {
    states: states,
    grantedCzIds: grantedCzIds,
    solicitudesByCz: solicitudesByCz,
    snapshotRows: options.snapshotRows || [],
    institutionRows: options.institutionRows || [],
    outreachRows: options.outreachRows || [],
    statusFilter: options.statusFilter || null,
    nowMs: options.nowMs,
  });
}

async function loadC1FollowupCzIdsForCi(supabase, ci) {
  const states = await fetchProjectedStatesForCi(supabase, ci);
  const czIds = states.map(function (row) {
    return Number(row.cz_solicitud_id);
  });
  const grantedCzIds = await fetchElmGrantedCzIds(supabase, czIds);
  return filterC1StatesExcludingElmGranted(states, grantedCzIds)
    .map(function (row) {
      return Number(row.cz_solicitud_id);
    })
    .filter(function (n) {
      return Number.isSafeInteger(n) && n > 0;
    });
}

/** Projected C1 rows for display/detail, minus ELM-granted solicitudes. */
async function loadC1FollowupStatesForCi(supabase, ci) {
  const states = await fetchProjectedStatesForCi(supabase, ci);
  const grantedCzIds = await fetchElmGrantedCzIds(
    supabase,
    states.map(function (s) {
      return Number(s.cz_solicitud_id);
    }),
  );
  return filterC1StatesExcludingElmGranted(states, grantedCzIds);
}

/**
 * Detail for CI with C1 follow-up only (no estado 3). Real encuestas/snapshots only when present.
 * @param {object} bundle from fetchRejectedDetailBundle
 * @param {object[]} c1States projected rows for the CI
 * @returns {object|null}
 */
function assembleC1FollowupDetail(bundle, c1States) {
  const ci = toNum(bundle && bundle.ci);
  if (ci == null || !Array.isArray(c1States) || !c1States.length) return null;

  const solById = solicitudesById(bundle.solicitudRows || []);
  const entries = c1States
    .map(function (st) {
      const czId = toNum(st && st.cz_solicitud_id);
      if (czId == null) return null;
      const sol = solById.get(czId) || null;
      return {
        cz_solicitud_id: czId,
        rejected_at: (st && st.updated_at) || null,
        projected_estado: toNum(st && st.projected_estado),
        solicitudes_estados_id: sol ? toNum(sol.solicitudes_estados_id) : null,
      };
    })
    .filter(Boolean);

  const sortedEntries = sortRejectedSolicitudesDesc(
    entries.map(function (e) {
      return { cz_solicitud_id: e.cz_solicitud_id, rejected_at: e.rejected_at };
    }),
  );
  if (!sortedEntries.length) return null;

  const solicitudesByCz = new Map();
  for (const e of entries) {
    const sol = solById.get(e.cz_solicitud_id);
    if (sol) solicitudesByCz.set(e.cz_solicitud_id, sol);
  }
  const name = resolvePersonName(solicitudesByCz, sortedEntries);
  const primary = sortedEntries[0];

  const encuestas = sortEncuestas(bundle.encuestaRows || []);
  const latestEncuesta = encuestas[0] || null;
  const latestMeta = encuestaScoreMeta(latestEncuesta);
  const ops = listOpsForRejectedDisplay(ci, bundle.snapshotRows, bundle.institutionRows);
  const instMap = institutionsBySnapshotId(bundle.institutionRows || []);
  const snaps = sortSnapshotsDesc(bundle.snapshotRows || []);
  const outreachRow =
    (bundle.outreachRows || []).find(function (r) {
      return toNum(r && r.ci) === ci;
    }) || null;

  const rejections = sortedEntries.map(function (r) {
    const meta = entries.find(function (e) {
      return e.cz_solicitud_id === r.cz_solicitud_id;
    });
    return {
      cz_historico_id: null,
      cz_solicitud_id: r.cz_solicitud_id,
      solicitudes_estados_id: meta ? meta.solicitudes_estados_id : null,
      estado: null,
      fechahora_src: r.rejected_at,
      c1_projected_estado: meta ? meta.projected_estado : null,
    };
  });

  return {
    ci: ci,
    nombre: name.nombre,
    apellido: name.apellido,
    rejected_at: primary.rejected_at || null,
    score_v2: latestEncuesta ? toNum(latestEncuesta.score_v2) : null,
    encuesta_completed_at: latestEncuesta ? latestEncuesta.completed_at || null : null,
    survey_version: latestMeta.survey_version,
    segmentacion_base: latestMeta.segmentacion_base,
    worst_bcu: ops.worst_bcu,
    ops_status: ops.ops_status,
    next_review_on: ops.next_review_on,
    outreach: formatOutreach(outreachRow, bundle.nowMs),
    rejections: rejections,
    encuestas: encuestas.map(function (e) {
      const meta = encuestaScoreMeta(e);
      return {
        cz_id: e.cz_id,
        score_v2: toNum(e.score_v2),
        completed_at: e.completed_at || null,
        email: e.email != null ? e.email : null,
        survey_version: meta.survey_version,
        segmentacion_base: meta.segmentacion_base,
        loan_purpose: loanPurposeOf(e),
      };
    }),
    snapshots: snaps.map(function (s) {
      return formatSnapshot(s, instMap, true);
    }),
    list_origin: 'c1_elm_followup',
    c1_followup_only: true,
  };
}

/**
 * @param {object} detail assembled rejected detail (estado 3)
 * @param {object[]} c1States
 * @param {object} bundle
 */
function appendC1FollowupToDetailRejections(detail, c1States, bundle) {
  if (!detail || !Array.isArray(c1States) || !c1States.length) return detail;
  const solById = solicitudesById(bundle.solicitudRows || []);
  const seen = new Set(
    (detail.rejections || []).map(function (r) {
      return Number(r.cz_solicitud_id);
    }),
  );
  const extra = [];
  for (let i = 0; i < c1States.length; i += 1) {
    const st = c1States[i];
    const czId = toNum(st && st.cz_solicitud_id);
    if (czId == null || seen.has(czId)) continue;
    seen.add(czId);
    const sol = solById.get(czId) || null;
    extra.push({
      cz_historico_id: null,
      cz_solicitud_id: czId,
      solicitudes_estados_id: sol ? toNum(sol.solicitudes_estados_id) : null,
      estado: null,
      fechahora_src: (st && st.updated_at) || null,
      c1_projected_estado: toNum(st && st.projected_estado),
    });
  }
  if (!extra.length) return detail;
  detail.rejections = (detail.rejections || [])
    .concat(extra)
    .sort(function (a, b) {
      return cmpTsDescNullsLast(a.fechahora_src, b.fechahora_src);
    });
  return detail;
}

module.exports = {
  C1_DISPLAY_PROJECTED_ESTADOS,
  filterC1StatesExcludingElmGranted,
  fetchElmGrantedCzIds,
  mergeC1FollowupIntoRejectedRows,
  loadAndMergeC1FollowupRows,
  loadC1FollowupCzIdsForCi,
  loadC1FollowupStatesForCi,
  fetchAllProjectedStates,
  fetchProjectedStatesForCi,
  fetchSolicitudesByCzIds,
  assembleC1FollowupDetail,
  appendC1FollowupToDetailRejections,
};
