'use strict';

/**
 * ELM persistence + JANUS reads (Supabase, service role, backend only).
 *
 * Idempotency authority is the DB: every state change goes through the RPCs in
 * migrations/20261007_elm_lead_processes.sql. There is no direct insert/update on
 * elm_lead_processes from Node (claim = INSERT ... ON CONFLICT DO NOTHING inside the RPC).
 */

const { resolveBasesForCandidates } = require('../../lib/cdvSheetSync');

const PROCESS_TABLE = 'elm_lead_processes';

const SOLICITUD_SELECT =
  'cz_id, ci, nombre, apellido, email, celular, salario, fecha_nacimiento, relacion_laboral, lrw_id, solicitudes_estados_id, updated_at_src, synced_at';

const GRANTED_SELECT = 'cz_id, ci, monto_otorgado, updated_at_src, synced_at';

function firstRow(data) {
  if (Array.isArray(data)) return data.length ? data[0] : null;
  return data || null;
}

function rpcError(name, error) {
  return new Error(name + ' failed: ' + String((error && error.message) || error));
}

/**
 * @param {object} [supabaseOverride]
 */
function createElmRepository(supabaseOverride) {
  let client = supabaseOverride || null;
  function db() {
    if (!client) client = require('../../clients/supabase');
    return client;
  }

  async function loadSolicitudContext(czId) {
    const sb = db();
    const { data: solicitud, error: solErr } = await sb
      .from('cz_funnel_solicitudes')
      .select(SOLICITUD_SELECT)
      .eq('cz_id', czId)
      .maybeSingle();
    if (solErr) throw rpcError('cz_funnel_solicitudes read', solErr);
    if (!solicitud) return { solicitud: null, grantedRow: null };
    const { data: grantedRow, error: gErr } = await sb
      .from('cz_funnel_granted_loans')
      .select(GRANTED_SELECT)
      .eq('cz_id', czId)
      .maybeSingle();
    if (gErr) throw rpcError('cz_funnel_granted_loans read', gErr);
    return { solicitud: solicitud, grantedRow: grantedRow || null };
  }

  /** Provenance base label for the solicitud ('' when none). Same resolver as Sheet BASE. */
  async function resolveBaseLabel(czId) {
    const out = await resolveBasesForCandidates(db(), [
      { cz_solicitud_id: String(czId) },
    ]);
    return out.get(String(czId)) || '';
  }

  async function getProcessByCzId(czId) {
    const { data, error } = await db()
      .from(PROCESS_TABLE)
      .select('*')
      .eq('cz_solicitud_id', czId)
      .maybeSingle();
    if (error) throw rpcError(PROCESS_TABLE + ' read', error);
    return data || null;
  }

  /** @returns {Promise<{ claimed: boolean, process: object }>} */
  async function claimProcess(args) {
    const { data, error } = await db().rpc('elm_claim_process', {
      p_cz_solicitud_id: args.czSolicitudId,
      p_ci: args.ci,
      p_source_brand: args.sourceBrand,
      p_trigger_origin: args.triggerOrigin,
      p_triggered_by_user_id: args.triggeredByUserId || null,
      p_cz_estado_id_at_start: args.czEstadoIdAtStart,
      p_lrw_id_at_start: args.lrwIdAtStart,
      p_s1_request: args.s1Request,
      p_lease_seconds: args.leaseSeconds,
    });
    if (error) throw rpcError('elm_claim_process', error);
    const out = firstRow(data);
    if (!out || !out.process) throw new Error('elm_claim_process returned no process');
    return { claimed: out.claimed === true, process: out.process };
  }

  async function finishStep(rpcName, processId, result) {
    const { data, error } = await db().rpc(rpcName, {
      p_process_id: processId,
      p_status: result.status,
      p_response: result.response,
      p_http_status: result.httpStatus,
      p_result_message: result.resultMessage,
      p_latency_ms: result.latencyMs,
      p_error_code: result.errorCode,
      p_error_detail: result.errorDetail,
    });
    if (error) throw rpcError(rpcName, error);
    return firstRow(data);
  }

  async function finishS1(processId, result) {
    return finishStep('elm_finish_s1', processId, result);
  }

  async function finishS2(processId, result) {
    return finishStep('elm_finish_s2', processId, result);
  }

  async function beginS2(czId, s2Request, leaseSeconds) {
    const { data, error } = await db().rpc('elm_begin_s2', {
      p_cz_solicitud_id: czId,
      p_s2_request: s2Request,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw rpcError('elm_begin_s2', error);
    return firstRow(data);
  }

  async function expireStaleInFlight(czId) {
    const { data, error } = await db().rpc('elm_expire_stale_in_flight', {
      p_cz_solicitud_id: czId,
    });
    if (error) throw rpcError('elm_expire_stale_in_flight', error);
    return firstRow(data);
  }

  return {
    loadSolicitudContext,
    resolveBaseLabel,
    getProcessByCzId,
    claimProcess,
    finishS1,
    beginS2,
    finishS2,
    expireStaleInFlight,
  };
}

module.exports = {
  PROCESS_TABLE,
  SOLICITUD_SELECT,
  createElmRepository,
};
