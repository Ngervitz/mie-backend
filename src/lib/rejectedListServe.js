'use strict';

/**
 * GET /rechazados list assembly: bundle → filter/sort → paginate → encuestas page → attach*.
 */

const {
  assembleRejectedList,
  fetchRejectedListBundle,
  fetchListEncuestasForCis,
  applyEncuestasToListRows,
  paginateAssembledList,
} = require('./rejectedOpsRead');
const {
  attachSurveyInviteToListRows,
} = require('./rejectedSurveyInviteEligibility');
const {
  attachSurveySequenceToListRows,
  attachSurveyEmailClickedToListRows,
} = require('./rejectedSurveyInviteDisplay');
const { attachMiDeudaOptinToListRows } = require('./miplanDebtOptinRead');
const { attachElmToRejectedRows } = require('./rejectedElmRead');

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   status?: string|null,
 *   pagination: { paginated: boolean, limit: number|null, offset: number },
 *   listView?: object,
 *   logger?: object,
 * }} opts
 */
async function loadRejectedListResponse(supabase, opts) {
  const options = opts || {};
  const bundle = await fetchRejectedListBundle(supabase);
  const assembled = assembleRejectedList({
    estadoRows: bundle.estadoRows,
    solicitudRows: bundle.solicitudRows,
    encuestaRows: [],
    snapshotRows: bundle.snapshotRows,
    institutionRows: bundle.institutionRows,
    outreachRows: bundle.outreachRows,
    status: options.status || null,
  });
  const pageMeta = paginateAssembledList(assembled, options.pagination);
  let pageRows = pageMeta.rows;

  if (pageRows.length) {
    const cis = pageRows
      .map(function (r) {
        return Number(r.ci);
      })
      .filter(function (n) {
        return Number.isSafeInteger(n);
      });
    const encuestaRows = await fetchListEncuestasForCis(supabase, cis);
    pageRows = applyEncuestasToListRows(pageRows, encuestaRows);
  }

  const withInvite = await attachSurveyInviteToListRows(supabase, pageRows, {
    estadoRows: bundle.estadoRows,
    solicitudRows: bundle.solicitudRows,
  });
  const surveyInviteAvailable =
    withInvite.length === 0 ||
    withInvite.every(function (r) {
      return !(r.survey_invite && r.survey_invite.available === false);
    });
  const withSequence = await attachSurveySequenceToListRows(
    supabase,
    withInvite,
  );
  const withEmailClick = await attachSurveyEmailClickedToListRows(
    supabase,
    withSequence,
  );
  const optin = await attachMiDeudaOptinToListRows(supabase, withEmailClick);
  const elmAvailable = await attachElmToRejectedRows(optin.rows, {
    supabase: supabase,
    listView: options.listView,
    logger: options.logger,
  });

  return {
    rows: optin.rows,
    total: pageMeta.total,
    limit: pageMeta.limit,
    offset: pageMeta.offset,
    paginated: pageMeta.paginated,
    mi_deuda_optin_available: optin.available,
    mi_deuda_optin_error_code: optin.error_code,
    elm_available: elmAvailable,
    survey_invite_available: surveyInviteAvailable,
  };
}

module.exports = {
  loadRejectedListResponse,
};
