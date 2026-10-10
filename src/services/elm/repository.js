'use strict';

/**
 * ELM persistence + JANUS reads (Supabase, service role, backend only).
 *
 * Idempotency authority is the DB: every state change goes through the RPCs in
 * migrations/20261007_elm_lead_processes.sql, 20261007_elm_postback_events.sql and
 * 20261009_elm_phase3b_operations.sql. There is no
 * direct insert/update on elm_lead_processes / elm_postback_events from Node.
 */

const { resolveBasesForCandidates } = require('../../lib/cdvSheetSync');

const PROCESS_TABLE = 'elm_lead_processes';
const POSTBACK_EVENTS_TABLE = 'elm_postback_events';

const SOLICITUD_SELECT =
  'cz_id, ci, nombre, apellido, email, celular, salario, fecha_nacimiento, relacion_laboral, lrw_id, solicitudes_estados_id, updated_at_src, synced_at';

const GRANTED_SELECT = 'cz_id, ci, monto_otorgado, updated_at_src, synced_at';

/**
 * List/cell/KPI projection: no request bodies. Result messages are ELM's short documented
 * answers (needed to tell a definitive rejection from an ambiguous one). The S2 response body
 * (redacted at write time) is read only to recognize Aceptado ELM (classification.isS2Accepted);
 * views never return it.
 */
const PROCESS_LIST_SELECT =
  'id, cz_solicitud_id, ci, trigger_origin, send_origin, created_at, updated_at, s1_status, s1_attempts, s1_http_status, s1_error_code, s1_started_at, s1_completed_at, s1_lease_expires_at, s1_result_message, s2_status, s2_http_status, s2_error_code, s2_response, s2_started_at, s2_completed_at, s2_lease_expires_at, s2_result_message, referred_at, provider_status, provider_status_at, disbursed_at, disbursed_amount, ops_resolution_code, ops_resolved_at';

const CZ_STATE_TABLE = 'provider_cz_state';

const IN_CHUNK = 200;
const PAGE_SIZE = 1000;

function chunks(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(ids.slice(i, i + IN_CHUNK));
  return out;
}

function uniqueIds(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

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

  /**
   * Provenance base label for the solicitud ('' when none). Same resolver as Sheet BASE.
   * `jt` (from the CZ start snapshot) is used when the mirror has not synced the solicitud yet.
   */
  async function resolveBaseLabel(czId, jt) {
    const candidate = { cz_solicitud_id: String(czId) };
    if (jt) candidate.jt = jt;
    const out = await resolveBasesForCandidates(db(), [candidate]);
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

  /**
   * Takes the CI lock and inserts the process in one transaction (C1). Blocked by the lock →
   * { claimed: false, process: null, blocked: { block, related_cz_solicitud_id, month_key } }.
   * @returns {Promise<{ claimed: boolean, process: object|null, blocked?: object }>}
   */
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
      p_commercial_origin: args.commercialOrigin || null,
      p_send_origin: args.sendOrigin,
    });
    if (error) throw rpcError('elm_claim_process', error);
    const out = firstRow(data);
    if (out && out.claimed !== true && out.blocked) {
      return { claimed: false, process: null, blocked: out.blocked };
    }
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

  /** @returns {Promise<object|null>} the row back in in_flight, or null when not allowed */
  async function retryStep(args) {
    const { data, error } = await db().rpc('elm_retry_step', {
      p_cz_solicitud_id: args.czSolicitudId,
      p_step: args.step,
      p_expected_attempts: args.expectedAttempts,
      p_max_attempts: args.maxAttempts,
      p_retry_safe_error_codes: Array.from(args.retrySafeErrorCodes || []),
      p_lease_seconds: args.leaseSeconds,
    });
    if (error) throw rpcError('elm_retry_step', error);
    return firstRow(data);
  }

  /**
   * Operator retry of an S1 that ELM provably never received (20261011 migration). One
   * transaction: new CI reservation + archived attempt + process back to in_flight + audit.
   * @returns {Promise<{ status: string, reason?: string, process?: object, lock?: object }>}
   */
  async function manualRetryS1(args) {
    const { data, error } = await db().rpc('elm_manual_retry_s1', {
      p_cz_solicitud_id: args.czSolicitudId,
      p_expected_attempts: args.expectedAttempts,
      p_max_attempts: args.maxAttempts,
      p_lease_seconds: args.leaseSeconds,
      p_actor_user_id: args.actorUserId,
    });
    if (error) throw rpcError('elm_manual_retry_s1', error);
    const out = firstRow(data);
    if (!out || typeof out.status !== 'string') throw new Error('elm_manual_retry_s1 returned no status');
    return out;
  }

  async function expireStaleInFlight(czId) {
    const { data, error } = await db().rpc('elm_expire_stale_in_flight', {
      p_cz_solicitud_id: czId,
    });
    if (error) throw rpcError('elm_expire_stale_in_flight', error);
    return firstRow(data);
  }

  /** Append-only record of a result that arrived after the step left in_flight. */
  async function recordLateResult(args) {
    const r = args.result || {};
    const { data, error } = await db().rpc('elm_record_late_result', {
      p_process_id: args.processId,
      p_cz_solicitud_id: args.czSolicitudId,
      p_step: args.step,
      p_late_status: r.status,
      p_http_status: r.httpStatus != null ? r.httpStatus : null,
      p_result_message: r.resultMessage != null ? r.resultMessage : null,
      p_error_code: r.errorCode != null ? r.errorCode : null,
      p_response: r.response != null ? r.response : null,
      p_latency_ms: r.latencyMs != null ? r.latencyMs : null,
      p_trigger_origin: args.triggerOrigin || null,
    });
    if (error) throw rpcError('elm_record_late_result', error);
    return firstRow(data);
  }

  /** Batched solicitud + CDV granted rows. @returns {Promise<Map<number, {solicitud, grantedRow}>>} */
  async function loadSolicitudContexts(czIds) {
    const ids = uniqueIds(czIds);
    const out = new Map();
    const sb = db();
    for (const chunk of chunks(ids)) {
      const { data, error } = await sb
        .from('cz_funnel_solicitudes')
        .select(SOLICITUD_SELECT)
        .in('cz_id', chunk);
      if (error) throw rpcError('cz_funnel_solicitudes read', error);
      for (const s of data || []) {
        out.set(Number(s.cz_id), { solicitud: s, grantedRow: null });
      }
    }
    const found = Array.from(out.keys());
    for (const chunk of chunks(found)) {
      const { data, error } = await sb
        .from('cz_funnel_granted_loans')
        .select(GRANTED_SELECT)
        .in('cz_id', chunk);
      if (error) throw rpcError('cz_funnel_granted_loans read', error);
      for (const g of data || []) {
        const ctx = out.get(Number(g.cz_id));
        if (ctx) ctx.grantedRow = g;
      }
    }
    return out;
  }

  /** Batched provenance base labels. @returns {Promise<Map<string, string>>} */
  async function resolveBaseLabels(czIds) {
    return resolveBasesForCandidates(
      db(),
      uniqueIds(czIds).map(function (id) {
        return { cz_solicitud_id: String(id) };
      }),
    );
  }

  /** Batched process rows (list projection). @returns {Promise<Map<number, object>>} */
  async function getProcessesByCzIds(czIds) {
    const out = new Map();
    for (const chunk of chunks(uniqueIds(czIds))) {
      const { data, error } = await db()
        .from(PROCESS_TABLE)
        .select(PROCESS_LIST_SELECT)
        .in('cz_solicitud_id', chunk);
      if (error) throw rpcError(PROCESS_TABLE + ' read', error);
      for (const p of data || []) out.set(Number(p.cz_solicitud_id), p);
    }
    return out;
  }

  /** Every process (list projection), optionally only the given trigger / send origins. */
  async function listAllProcesses(opts) {
    const origins = opts && Array.isArray(opts.triggerOrigins) ? opts.triggerOrigins : null;
    const sendOrigins = opts && Array.isArray(opts.sendOrigins) ? opts.sendOrigins : null;
    const all = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let q = db().from(PROCESS_TABLE).select(PROCESS_LIST_SELECT);
      if (origins) q = q.in('trigger_origin', origins);
      if (sendOrigins) q = q.in('send_origin', sendOrigins);
      const { data, error } = await q
        .order('created_at', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw rpcError(PROCESS_TABLE + ' read', error);
      const rows = data || [];
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return all;
  }

  /** C1 projected CZ estado per solicitud (automatic circuit only). @returns {Promise<Map<number, number>>} */
  async function getProjectedEstadosByCzIds(czIds) {
    const out = new Map();
    for (const chunk of chunks(uniqueIds(czIds))) {
      const { data, error } = await db()
        .from(CZ_STATE_TABLE)
        .select('cz_solicitud_id, projected_estado')
        .in('cz_solicitud_id', chunk);
      if (error) throw rpcError(CZ_STATE_TABLE + ' read', error);
      for (const r of data || []) out.set(Number(r.cz_solicitud_id), Number(r.projected_estado));
    }
    return out;
  }

  async function recordPostbackEvent(ev) {
    const { data, error } = await db().rpc('elm_postback_record_event', {
      p_raw_status: ev.rawStatus,
      p_normalized_status: ev.normalizedStatus,
      p_ci: ev.ci,
      p_provider_external_id: ev.providerExternalId,
      p_received_cz_solicitud_id: ev.receivedCzSolicitudId,
      p_provider_event_at: ev.providerEventAt,
      p_payload: ev.payload,
    });
    if (error) throw rpcError('elm_postback_record_event', error);
    const row = firstRow(data);
    if (!row || !row.id) throw new Error('elm_postback_record_event returned no event');
    return row;
  }

  async function resolvePostbackEvent(args) {
    const { data, error } = await db().rpc('elm_postback_resolve_event', {
      p_event_id: args.eventId,
      p_process_id: args.processId,
      p_match_method: args.matchMethod,
      p_unresolved_status: args.unresolvedStatus,
      p_error_code: args.errorCode,
    });
    if (error) throw rpcError('elm_postback_resolve_event', error);
    const row = firstRow(data);
    if (!row || !row.id) throw new Error('elm_postback_resolve_event returned no event');
    return row;
  }

  async function getPostbackEvent(eventId) {
    const { data, error } = await db()
      .from(POSTBACK_EVENTS_TABLE)
      .select('id, received_at, processing_status, match_method, normalized_status, provider_event_at')
      .eq('id', eventId)
      .maybeSingle();
    if (error) throw rpcError(POSTBACK_EVENTS_TABLE + ' read', error);
    return data || null;
  }

  return {
    loadSolicitudContext,
    resolveBaseLabel,
    getProcessByCzId,
    claimProcess,
    finishS1,
    beginS2,
    finishS2,
    retryStep,
    manualRetryS1,
    expireStaleInFlight,
    recordLateResult,
    loadSolicitudContexts,
    resolveBaseLabels,
    getProcessesByCzIds,
    listAllProcesses,
    getProjectedEstadosByCzIds,
    recordPostbackEvent,
    resolvePostbackEvent,
    getPostbackEvent,
  };
}

module.exports = {
  PROCESS_TABLE,
  POSTBACK_EVENTS_TABLE,
  SOLICITUD_SELECT,
  PROCESS_LIST_SELECT,
  CZ_STATE_TABLE,
  createElmRepository,
};
