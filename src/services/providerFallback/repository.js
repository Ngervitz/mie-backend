'use strict';

/**
 * Provider fallback persistence (Supabase, service role, backend only).
 * Every state change goes through the RPCs in migrations/20261008_provider_fallback_requests.sql
 * and 20261009_elm_phase3b_operations.sql; the DB is the authority for idempotency, atomic
 * claim, leases and review-case creation.
 */

const { PROCESS_TABLE } = require('../elm/repository');

const TABLE = 'provider_fallback_requests';
const REVIEW_TABLE = 'provider_review_cases';
const CZ_STATE_TABLE = 'provider_cz_state';

/**
 * CZ-facing projection: no PII, no internal detail. cz_estado_id_at_start = estado CZ reported at
 * start (CZ applies its result only if the solicitud is still in that estado: compare-and-set).
 */
const STATUS_SELECT =
  'id, cz_solicitud_id, provider, exec_status, outcome, reason_code, related_cz_solicitud_id, cz_estado_id_at_start:snapshot->cz_estado_id, finalized_at, cz_delivery_status, cz_acked_at, created_at';

const CI_GUARD_SELECT =
  'id, cz_solicitud_id, ci, s1_status, s1_lease_expires_at, s2_status, s2_lease_expires_at, referred_at, provider_status, disbursed_at, ops_resolved_at';

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
function createProviderFallbackRepository(supabaseOverride) {
  let client = supabaseOverride || null;
  function db() {
    if (!client) client = require('../../clients/supabase');
    return client;
  }

  /** @returns {Promise<{ created: boolean, conflict: boolean, request: object }>} */
  async function enqueue(args) {
    const { data, error } = await db().rpc('provider_fallback_enqueue', {
      p_cz_solicitud_id: args.czSolicitudId,
      p_ci: args.ci,
      p_snapshot: args.snapshot,
      p_snapshot_hash: args.snapshotHash,
    });
    if (error) throw rpcError('provider_fallback_enqueue', error);
    const out = firstRow(data);
    if (!out || !out.request) throw new Error('provider_fallback_enqueue returned no request');
    return { created: out.created === true, conflict: out.conflict === true, request: out.request };
  }

  /** @returns {Promise<object[]>} */
  async function claim(args) {
    const { data, error } = await db().rpc('provider_fallback_claim', {
      p_worker_id: args.workerId,
      p_lease_seconds: args.leaseSeconds,
      p_limit: args.limit,
      p_cz_solicitud_id: args.czSolicitudId != null ? args.czSolicitudId : null,
    });
    if (error) throw rpcError('provider_fallback_claim', error);
    return Array.isArray(data) ? data : data ? [data] : [];
  }

  async function defer(args) {
    const { data, error } = await db().rpc('provider_fallback_defer', {
      p_id: args.id,
      p_worker_id: args.workerId,
      p_delay_seconds: args.delaySeconds,
      p_not_started: args.notStarted === true,
      p_reason: args.reason,
    });
    if (error) throw rpcError('provider_fallback_defer', error);
    return firstRow(data);
  }

  async function finalize(args) {
    const { data, error } = await db().rpc('provider_fallback_finalize', {
      p_id: args.id,
      p_worker_id: args.workerId,
      p_outcome: args.outcome,
      p_reason_code: args.reasonCode,
      p_reason_detail: args.reasonDetail || null,
      p_elm_process_id: args.elmProcessId || null,
      p_related_cz_solicitud_id: args.relatedCzSolicitudId || null,
      p_review_priority: args.reviewPriority || null,
      p_review_due_seconds: args.reviewDueSeconds != null ? args.reviewDueSeconds : null,
    });
    if (error) throw rpcError('provider_fallback_finalize', error);
    return firstRow(data);
  }

  /** Review case status per fallback request id (only for manual_review rows). */
  async function getReviewStatusByRequestIds(requestIds) {
    const ids = (requestIds || []).filter(Boolean);
    const out = new Map();
    if (!ids.length) return out;
    const { data, error } = await db()
      .from(REVIEW_TABLE)
      .select('fallback_request_id, status, due_at')
      .in('fallback_request_id', ids);
    if (error) throw rpcError(REVIEW_TABLE + ' read', error);
    for (const row of data || []) out.set(row.fallback_request_id, row);
    return out;
  }

  /** @returns {Promise<{ open: number, unassigned: number, overdue: number }>} */
  async function countReviewAlerts(nowIso) {
    async function count(apply) {
      const q = apply(
        db().from(REVIEW_TABLE).select('id', { count: 'exact', head: true }).eq('status', 'open'),
      );
      const { count: n, error } = await q;
      if (error) throw rpcError(REVIEW_TABLE + ' count', error);
      return n || 0;
    }
    const [open, unassigned, overdue] = await Promise.all([
      count(function (q) { return q; }),
      count(function (q) { return q.is('assigned_to', null); }),
      count(function (q) { return q.lt('due_at', nowIso); }),
    ]);
    return { open: open, unassigned: unassigned, overdue: overdue };
  }

  async function getStatusByCzId(czId) {
    const { data, error } = await db()
      .from(TABLE)
      .select(STATUS_SELECT)
      .eq('cz_solicitud_id', czId)
      .maybeSingle();
    if (error) throw rpcError(TABLE + ' read', error);
    return data || null;
  }

  async function listPendingDeliveries(limit) {
    const { data, error } = await db()
      .from(TABLE)
      .select(STATUS_SELECT)
      .eq('cz_delivery_status', 'pending')
      .order('finalized_at', { ascending: true })
      .order('cz_solicitud_id', { ascending: true })
      .limit(limit);
    if (error) throw rpcError(TABLE + ' read', error);
    return data || [];
  }

  /** @returns {Promise<{ status: string, acked_at?: string }>} */
  async function ack(czId, outcome) {
    const { data, error } = await db().rpc('provider_fallback_ack', {
      p_cz_solicitud_id: czId,
      p_outcome: outcome,
    });
    if (error) throw rpcError('provider_fallback_ack', error);
    const out = firstRow(data);
    if (!out || !out.status) throw new Error('provider_fallback_ack returned no status');
    return out;
  }

  /** C1 projected CZ estado per solicitud. @returns {Promise<Map<number, object>>} */
  async function getCzStatesByCzIds(czIds) {
    const ids = Array.from(new Set((czIds || []).map(Number).filter(Number.isSafeInteger)));
    const out = new Map();
    if (!ids.length) return out;
    const { data, error } = await db()
      .from(CZ_STATE_TABLE)
      .select('cz_solicitud_id, projected_estado, last_seq')
      .in('cz_solicitud_id', ids);
    if (error) throw rpcError(CZ_STATE_TABLE + ' read', error);
    for (const row of data || []) out.set(Number(row.cz_solicitud_id), row);
    return out;
  }

  /**
   * Read-only: other ELM processes of the same person, for the CI guard, with the projected CZ
   * estado of C1 solicitudes (3 = referral closed by a rejection).
   */
  async function listElmProcessesByCi(ci) {
    const { data, error } = await db()
      .from(PROCESS_TABLE)
      .select(CI_GUARD_SELECT)
      .eq('ci', ci);
    if (error) throw rpcError(PROCESS_TABLE + ' read', error);
    const rows = data || [];
    const states = await getCzStatesByCzIds(rows.map(function (r) { return r.cz_solicitud_id; }));
    return rows.map(function (r) {
      const s = states.get(Number(r.cz_solicitud_id));
      return Object.assign({}, r, { cz_projected_estado: s ? s.projected_estado : null });
    });
  }

  async function jsonRpc(name, params) {
    const { data, error } = await db().rpc(name, params);
    if (error) throw rpcError(name, error);
    const out = firstRow(data);
    if (!out || typeof out !== 'object') throw new Error(name + ' returned no result');
    return out;
  }

  /** @returns {Promise<{ status: 'acquired'|'held'|'blocked', block?: string, related_cz_solicitud_id?: number|null }>} */
  function acquireCiLock(args) {
    return jsonRpc('elm_ci_lock_acquire', {
      p_ci: args.ci,
      p_cz_solicitud_id: args.czSolicitudId,
      p_fallback_request_id: args.fallbackRequestId,
      p_at: null,
    });
  }

  function releaseUnstartedCiLock(czId) {
    return jsonRpc('elm_ci_lock_release_unstarted', { p_cz_solicitud_id: czId });
  }

  function reconcileCiLocks(limit) {
    return jsonRpc('elm_ci_lock_reconcile', { p_limit: limit });
  }

  function reconcileLateEvents(rejectionStatuses, limit) {
    return jsonRpc('provider_cz_reconcile_late', {
      p_rejection_statuses: Array.from(rejectionStatuses || []),
      p_limit: limit,
    });
  }

  /** Head event per solicitud (seq n after n-1 acked); counts the delivery attempt. */
  async function listPendingEvents(limit) {
    const { data, error } = await db().rpc('provider_cz_events_pending', { p_limit: limit });
    if (error) throw rpcError('provider_cz_events_pending', error);
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    return rows.sort(function (a, b) {
      return String(a.created_at).localeCompare(String(b.created_at)) ||
        Number(a.cz_solicitud_id) - Number(b.cz_solicitud_id) ||
        Number(a.seq) - Number(b.seq);
    });
  }

  /** @returns {Promise<{ status: string, acked_at?: string, result?: string, seq?: number }>} */
  function ackEvent(eventId, result) {
    return jsonRpc('provider_cz_event_ack', { p_event_id: eventId, p_result: result });
  }

  return {
    enqueue,
    claim,
    defer,
    finalize,
    getStatusByCzId,
    listPendingDeliveries,
    ack,
    listElmProcessesByCi,
    getReviewStatusByRequestIds,
    countReviewAlerts,
    getCzStatesByCzIds,
    acquireCiLock,
    releaseUnstartedCiLock,
    reconcileCiLocks,
    reconcileLateEvents,
    listPendingEvents,
    ackEvent,
  };
}

module.exports = {
  TABLE,
  REVIEW_TABLE,
  CZ_STATE_TABLE,
  STATUS_SELECT,
  createProviderFallbackRepository,
};
