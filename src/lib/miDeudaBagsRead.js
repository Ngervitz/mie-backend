'use strict';

/**
 * Mi Deuda bags — read-only fetch + HTTP response shaping (Stage 1D).
 * Business rules live in miDeudaBags.js; this module only loads rows and formats JSON.
 */

const { buildMiDeudaBagModel } = require('./miDeudaBags');

const PAGE_SIZE = 1000;

const SNAPSHOT_SELECT =
  'id, ci, period_label, consulted_on, created_at, source';

const INSTITUTION_SELECT =
  'id, snapshot_id, institution_name, category, moroso_mn, moroso_me, castigado_mn, castigado_me, colocacion_vencida_mn, colocacion_vencida_me, creditos_reestructurados_mn, creditos_reestructurados_me, sort_order, created_at';

async function fetchAllPages(queryFn) {
  const out = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await queryFn(from, to);
    if (error) throw error;
    const chunk = Array.isArray(data) ? data : [];
    out.push.apply(out, chunk);
    if (chunk.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

/**
 * Load all BCU snapshots + institutions (same universe as Stage 1C validation).
 * @param {object} supabase
 */
async function fetchMiDeudaBagBundle(supabase) {
  const snapshots = await fetchAllPages(function (from, to) {
    return supabase
      .from('rejected_bcu_snapshots')
      .select(SNAPSHOT_SELECT)
      .range(from, to);
  });
  const institutions = await fetchAllPages(function (from, to) {
    return supabase
      .from('rejected_bcu_institutions')
      .select(INSTITUTION_SELECT)
      .range(from, to);
  });
  return { snapshots: snapshots, institutions: institutions };
}

/**
 * Serializable API payload from buildMiDeudaBagModel output.
 * Does not invent totals or opt-in-by-bag fields.
 */
function formatMiDeudaBagsResponse(model) {
  const bags = (model.bags || []).map(function (b) {
    return {
      institution_canonical: b.institution_canonical,
      people_count: b.people_count,
      moroso_mn: b.moroso_mn,
      moroso_me: b.moroso_me,
      castigado_mn: b.castigado_mn,
      castigado_me: b.castigado_me,
      colocacion_vencida_mn: b.colocacion_vencida_mn,
      colocacion_vencida_me: b.colocacion_vencida_me,
      reestructurado_mn: b.reestructurado_mn,
      reestructurado_me: b.reestructurado_me,
      members: b.members || [],
    };
  });

  return {
    counts: model.counts || null,
    bags: bags,
    reestructurado_universe: model.reestructurado_universe || [],
    unmapped_rows: model.unmapped_rows || [],
    ambiguous_cases: model.ambiguous_cases || [],
    current_snapshot_ids: model.current_snapshot_ids || [],
  };
}

/**
 * End-to-end read helper for the route.
 * @param {object} supabase
 */
async function loadMiDeudaBags(supabase) {
  const bundle = await fetchMiDeudaBagBundle(supabase);
  const model = buildMiDeudaBagModel(bundle);
  return formatMiDeudaBagsResponse(model);
}

module.exports = {
  SNAPSHOT_SELECT,
  INSTITUTION_SELECT,
  fetchMiDeudaBagBundle,
  formatMiDeudaBagsResponse,
  loadMiDeudaBags,
};
