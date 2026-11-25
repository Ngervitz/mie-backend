'use strict';

const { REJECTED_ESTADO_ID } = require('./czSurveyConversion');

const CZ_FUNNEL_SUMMARY_PAGE_SIZE = 1000;

/**
 * @param {(from: number, to: number) => Promise<{ data?: unknown[]|null, error?: { message?: string }|null }>} runPage
 * @returns {Promise<unknown[]>}
 */
async function fetchAllPaginated(runPage) {
  const all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await runPage(offset, offset + CZ_FUNNEL_SUMMARY_PAGE_SIZE - 1);
    if (error) {
      throw new Error(error.message || 'paginated select failed');
    }
    const page = data || [];
    all.push(...page);
    if (page.length < CZ_FUNNEL_SUMMARY_PAGE_SIZE) break;
    offset += CZ_FUNNEL_SUMMARY_PAGE_SIZE;
  }
  return all;
}

/**
 * Load full CZ funnel mirror rows for GET /reports/cz-funnel-summary (PostgREST-safe).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function loadCzFunnelSummarySources(supabase) {
  const [grantedLoans, solicitudes, encuestas, estadoRows, outreachInterest] =
    await Promise.all([
    fetchAllPaginated(function (from, to) {
      return supabase
        .from('cz_funnel_granted_loans')
        .select('cz_id, monto_otorgado, updated_at_src')
        .order('cz_id', { ascending: true })
        .range(from, to);
    }),
    fetchAllPaginated(function (from, to) {
      return supabase
        .from('cz_funnel_solicitudes')
        .select('cz_id, ci, fecha_reg')
        .order('cz_id', { ascending: true })
        .range(from, to);
    }),
    fetchAllPaginated(function (from, to) {
      return supabase
        .from('cz_funnel_encuestas')
        .select('cz_id, ci, score_v2, version_cuestionario, completed_at, tipo')
        .order('cz_id', { ascending: true })
        .range(from, to);
    }),
    fetchAllPaginated(function (from, to) {
      return supabase
        .from('cz_funnel_solicitud_estados')
        .select(
          'cz_solicitud_id, solicitudes_estados_id, fechahora_src, cz_historico_id',
        )
        .eq('solicitudes_estados_id', REJECTED_ESTADO_ID)
        .order('cz_historico_id', { ascending: true })
        .range(from, to);
    }),
    fetchAllPaginated(function (from, to) {
      return supabase
        .from('rejected_ci_outreach')
        .select('ci, mi_plan_interest_at, mi_plan_interest_source')
        .not('mi_plan_interest_at', 'is', null)
        .eq('mi_plan_interest_source', 'credizona_rejected_thank_you')
        .order('ci', { ascending: true })
        .range(from, to);
    }),
    ]);

  return {
    grantedLoans,
    solicitudes,
    encuestas,
    estadoRows,
    outreachInterest,
  };
}

module.exports = {
  CZ_FUNNEL_SUMMARY_PAGE_SIZE,
  fetchAllPaginated,
  loadCzFunnelSummarySources,
};