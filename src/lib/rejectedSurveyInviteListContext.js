'use strict';

/**
 * Janus / Supabase rows for batch survey-invite on the Rechazados list.
 * Prefer bundle.estadoRows + bundle.solicitudRows from fetchRejectedListBundle;
 * otherwise load with PostgREST pagination (no 1000-row cap).
 */

const { REJECTED_ESTADO_ID } = require('./rejectedSurveyInvite');

const SURVEY_INVITE_SOLICITUD_SELECT =
  'cz_id, ci, email, lrw_id, nombre';
const SURVEY_INVITE_ESTADO_SELECT =
  'cz_historico_id, cz_solicitud_id, fechahora_src, solicitudes_estados_id';

const PAGE_SIZE = 1000;

function solicitudHasInviteFields(row) {
  if (!row || row.cz_id == null || row.ci == null) return false;
  return (
    Object.prototype.hasOwnProperty.call(row, 'email') &&
    Object.prototype.hasOwnProperty.call(row, 'lrw_id') &&
    Object.prototype.hasOwnProperty.call(row, 'nombre')
  );
}

function estadoHasInviteFields(row) {
  if (!row || row.cz_solicitud_id == null) return false;
  return (
    Object.prototype.hasOwnProperty.call(row, 'fechahora_src') &&
    Object.prototype.hasOwnProperty.call(row, 'solicitudes_estados_id')
  );
}

/**
 * @param {{ estadoRows: object[], solicitudRows: object[] }} ctx
 */
function assertSurveyInviteBundleContext(ctx) {
  if (!ctx || !Array.isArray(ctx.estadoRows) || !Array.isArray(ctx.solicitudRows)) {
    throw new Error(
      'survey invite list context requires estadoRows and solicitudRows arrays',
    );
  }
  if (ctx.solicitudRows.length) {
    const bad = ctx.solicitudRows.find(function (r) {
      return !solicitudHasInviteFields(r);
    });
    if (bad) {
      throw new Error(
        'bundle solicitudRows missing survey-invite fields (email, lrw_id, nombre)',
      );
    }
  }
  if (ctx.estadoRows.length) {
    const badE = ctx.estadoRows.find(function (r) {
      return !estadoHasInviteFields(r);
    });
    if (badE) {
      throw new Error('bundle estadoRows missing survey-invite fields');
    }
  }
}

/**
 * @param {object} [opts]
 * @returns {{ estadoRows: object[], solicitudRows: object[] }|null}
 */
function tryBundledSurveyInviteContext(opts) {
  if (!opts || opts.estadoRows == null || opts.solicitudRows == null) {
    return null;
  }
  const ctx = {
    estadoRows: opts.estadoRows,
    solicitudRows: opts.solicitudRows,
  };
  assertSurveyInviteBundleContext(ctx);
  return ctx;
}

async function fetchAllPages(supabase, queryFn) {
  const all = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await queryFn(from, to);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/**
 * Paginated full-table load (fallback when bundle not passed).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function fetchSurveyInviteListContextFromSupabase(supabase) {
  const solicitudRows = await fetchAllPages(supabase, function (from, to) {
    return supabase
      .from('cz_funnel_solicitudes')
      .select(SURVEY_INVITE_SOLICITUD_SELECT)
      .order('cz_id', { ascending: true })
      .range(from, to);
  });
  const estadoRows = await fetchAllPages(supabase, function (from, to) {
    return supabase
      .from('cz_funnel_solicitud_estados')
      .select(SURVEY_INVITE_ESTADO_SELECT)
      .eq('solicitudes_estados_id', REJECTED_ESTADO_ID)
      .order('cz_historico_id', { ascending: true })
      .range(from, to);
  });
  return { solicitudRows: solicitudRows, estadoRows: estadoRows };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} [opts]
 * @returns {Promise<{ estadoRows: object[], solicitudRows: object[] }>}
 */
async function resolveSurveyInviteListContext(supabase, opts) {
  const bundled = tryBundledSurveyInviteContext(opts);
  if (bundled) return bundled;
  return fetchSurveyInviteListContextFromSupabase(supabase);
}

module.exports = {
  SURVEY_INVITE_SOLICITUD_SELECT,
  SURVEY_INVITE_ESTADO_SELECT,
  PAGE_SIZE,
  assertSurveyInviteBundleContext,
  tryBundledSurveyInviteContext,
  resolveSurveyInviteListContext,
  fetchSurveyInviteListContextFromSupabase,
  solicitudHasInviteFields,
  estadoHasInviteFields,
};
