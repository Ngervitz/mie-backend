'use strict';

/**
 * ELM operations persistence (Supabase, service role, backend only).
 * Reads are batched per page (constant number of queries). Every write goes through an audited
 * RPC in migrations/20261009_elm_phase3b_operations.sql / 20261010_provider_fallback_c1_events.sql
 * (row lock + expected version); there is no direct update of elm_lead_processes /
 * provider_review_cases / provider_cz_conflicts from Node.
 */

const { PROCESS_TABLE, POSTBACK_EVENTS_TABLE } = require('../elm/repository');
const { TABLE: FALLBACK_TABLE, REVIEW_TABLE } = require('../providerFallback/repository');

const AUDIT_TABLE = 'elm_ops_audit_events';
const USERS_TABLE = 'dashboard_users';
const CONFLICTS_TABLE = 'provider_cz_conflicts';

const CONFLICT_SELECT =
  'id, cz_solicitud_id, conflict_code, projected_estado, attempted_type, attempted_target, detail, status, resolution_note, resolved_by, resolved_at, created_at';

/** Processes that block new ELM sends for their CI until resolved (no PII bodies). */
const OPEN_PROCESS_SELECT =
  'id, cz_solicitud_id, ci, trigger_origin, commercial_origin, created_at, updated_at, s1_status, s1_started_at, s1_lease_expires_at, s2_status, s2_started_at, s2_lease_expires_at, referred_at, provider_status, provider_status_at, disbursed_at, last_postback_event_id, last_postback_at, ops_resolved_at';

const CASE_PROCESS_SELECT =
  'id, cz_solicitud_id, s1_status, s1_lease_expires_at, s2_status, s2_lease_expires_at, referred_at, provider_status, provider_status_at, disbursed_at, last_postback_at, ops_resolution_code, ops_resolved_at';

const CASE_SELECT =
  'id, fallback_request_id, cz_solicitud_id, ci, elm_process_id, related_cz_solicitud_id, reason_code, priority, due_at, status, assigned_to, assigned_at, resolution_code, resolution_note, resolved_by, resolved_at, version, created_at, updated_at';

const MAX_LIST = 200;

function rpcError(name, error) {
  return new Error(name + ' failed: ' + String((error && error.message) || error));
}

function firstRow(data) {
  if (Array.isArray(data)) return data.length ? data[0] : null;
  return data || null;
}

function uniq(values) {
  return Array.from(new Set((values || []).filter(function (v) {
    return v != null && v !== '';
  })));
}

/**
 * @param {object} [supabaseOverride]
 */
function createElmOpsRepository(supabaseOverride) {
  let client = supabaseOverride || null;
  function db() {
    if (!client) client = require('../../clients/supabase');
    return client;
  }

  /** Active referrals (S2 referred) and uncertain steps (unknown) not manually resolved. */
  async function listOpenProcesses(limit) {
    const { data, error } = await db()
      .from(PROCESS_TABLE)
      .select(OPEN_PROCESS_SELECT)
      .or('s2_status.in.(referred,unknown),s1_status.eq.unknown')
      .is('ops_resolved_at', null)
      .order('created_at', { ascending: true })
      .limit(Math.min(limit || MAX_LIST, MAX_LIST));
    if (error) throw rpcError(PROCESS_TABLE + ' read', error);
    return data || [];
  }

  async function getProcessById(id) {
    const { data, error } = await db()
      .from(PROCESS_TABLE)
      .select(OPEN_PROCESS_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (error) throw rpcError(PROCESS_TABLE + ' read', error);
    return data || null;
  }

  async function getProcessesByIds(ids) {
    const list = uniq(ids);
    const out = new Map();
    if (!list.length) return out;
    const { data, error } = await db().from(PROCESS_TABLE).select(CASE_PROCESS_SELECT).in('id', list);
    if (error) throw rpcError(PROCESS_TABLE + ' read', error);
    for (const row of data || []) out.set(row.id, row);
    return out;
  }

  async function getPostbackEventsByIds(ids) {
    const list = uniq(ids);
    const out = new Map();
    if (!list.length) return out;
    const { data, error } = await db()
      .from(POSTBACK_EVENTS_TABLE)
      .select('id, received_at, raw_status, processing_status, provider_event_at')
      .in('id', list);
    if (error) throw rpcError(POSTBACK_EVENTS_TABLE + ' read', error);
    for (const row of data || []) out.set(row.id, row);
    return out;
  }

  /** related cz id → solicitudes of the same CI that were NOT sent because of it. */
  async function listBlockedByRelated(relatedCzIds) {
    const list = uniq(relatedCzIds).map(Number);
    const out = new Map();
    if (!list.length) return out;
    const { data, error } = await db()
      .from(FALLBACK_TABLE)
      .select('cz_solicitud_id, related_cz_solicitud_id, outcome, finalized_at')
      .in('related_cz_solicitud_id', list)
      .eq('outcome', 'already_referred');
    if (error) throw rpcError(FALLBACK_TABLE + ' read', error);
    for (const row of data || []) {
      const key = Number(row.related_cz_solicitud_id);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(Number(row.cz_solicitud_id));
    }
    return out;
  }

  async function listReviewCases(status, limit) {
    let q = db().from(REVIEW_TABLE).select(CASE_SELECT);
    q = status === 'resolved'
      ? q.eq('status', 'resolved').order('resolved_at', { ascending: false })
      : q.eq('status', 'open').order('due_at', { ascending: true });
    const { data, error } = await q.limit(Math.min(limit || MAX_LIST, MAX_LIST));
    if (error) throw rpcError(REVIEW_TABLE + ' read', error);
    return data || [];
  }

  async function getUsersByIds(ids) {
    const list = uniq(ids);
    const out = new Map();
    if (!list.length) return out;
    const { data, error } = await db().from(USERS_TABLE).select('id, email').in('id', list);
    if (error) throw rpcError(USERS_TABLE + ' read', error);
    for (const row of data || []) out.set(row.id, row);
    return out;
  }

  /** People who can act on the queues (same gate as requireElmAction: active admins). */
  async function listAssignableUsers() {
    const { data, error } = await db()
      .from(USERS_TABLE)
      .select('id, email')
      .eq('active', true)
      .eq('is_admin', true)
      .order('email', { ascending: true });
    if (error) throw rpcError(USERS_TABLE + ' read', error);
    return data || [];
  }

  async function countOpenProcesses() {
    const { count, error } = await db()
      .from(PROCESS_TABLE)
      .select('id', { count: 'exact', head: true })
      .or('s2_status.in.(referred,unknown),s1_status.eq.unknown')
      .is('ops_resolved_at', null);
    if (error) throw rpcError(PROCESS_TABLE + ' count', error);
    return count || 0;
  }

  async function listAuditEvents(entityType, entityId) {
    const { data, error } = await db()
      .from(AUDIT_TABLE)
      .select('id, entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail, created_at')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: true })
      .limit(MAX_LIST);
    if (error) throw rpcError(AUDIT_TABLE + ' read', error);
    return data || [];
  }

  async function callStatusRpc(name, params) {
    const { data, error } = await db().rpc(name, params);
    if (error) throw rpcError(name, error);
    const out = firstRow(data);
    if (!out || !out.status) throw new Error(name + ' returned no status');
    return out;
  }

  function resolveProcess(args) {
    return callStatusRpc('elm_resolve_process', {
      p_process_id: args.processId,
      p_expected_updated_at: args.expectedUpdatedAt,
      p_resolution_code: args.resolutionCode,
      p_note: args.note,
      p_actor_user_id: args.actorUserId,
      p_cz_outcome: args.czOutcome || 'none',
    });
  }

  function assignReviewCase(args) {
    return callStatusRpc('provider_review_assign', {
      p_case_id: args.caseId,
      p_expected_version: args.expectedVersion,
      p_assignee: args.assigneeUserId || null,
      p_actor_user_id: args.actorUserId,
    });
  }

  function triageReviewCase(args) {
    return callStatusRpc('provider_review_triage', {
      p_case_id: args.caseId,
      p_expected_version: args.expectedVersion,
      p_priority: args.priority,
      p_due_at: args.dueAt,
      p_actor_user_id: args.actorUserId,
    });
  }

  /** C1: p_cz_outcome referred | rejected | granted | none (emits review.resolved when ≠ none). */
  function resolveReviewCase(args) {
    return callStatusRpc('provider_review_resolve', {
      p_case_id: args.caseId,
      p_expected_version: args.expectedVersion,
      p_resolution_code: args.resolutionCode,
      p_note: args.note,
      p_actor_user_id: args.actorUserId,
      p_cz_outcome: args.czOutcome,
    });
  }

  /** C1 solicitudes in 13 (derivado a ventas) or 14 (revisión), oldest first. */
  async function listC1ActiveReferrals(staleAfterHours, limit) {
    const { data, error } = await db().rpc('provider_c1_active_referrals', {
      p_stale_after_hours: staleAfterHours,
      p_limit: Math.min(limit || MAX_LIST, MAX_LIST),
    });
    if (error) throw rpcError('provider_c1_active_referrals', error);
    return Array.isArray(data) ? data : data ? [data] : [];
  }

  async function listCzConflicts(status, limit) {
    const { data, error } = await db()
      .from(CONFLICTS_TABLE)
      .select(CONFLICT_SELECT)
      .eq('status', status === 'resolved' ? 'resolved' : 'open')
      .order('created_at', { ascending: status !== 'resolved' })
      .limit(Math.min(limit || MAX_LIST, MAX_LIST));
    if (error) throw rpcError(CONFLICTS_TABLE + ' read', error);
    return data || [];
  }

  function resolveCzConflict(args) {
    return callStatusRpc('provider_cz_conflict_resolve', {
      p_conflict_id: args.conflictId,
      p_note: args.note,
      p_actor_user_id: args.actorUserId,
    });
  }

  /** Automatic fallback requests not finalized yet (queued / running), oldest first. */
  async function listOpenFallbackRequests(limit) {
    const { data, error } = await db()
      .from(FALLBACK_TABLE)
      .select('id, cz_solicitud_id, ci, exec_status, outcome, elm_process_id, created_at')
      .is('finalized_at', null)
      .order('created_at', { ascending: true })
      .limit(Math.min(limit || MAX_LIST, MAX_LIST));
    if (error) throw rpcError(FALLBACK_TABLE + ' read', error);
    return data || [];
  }

  /** Subset of the given solicitudes that already show CZ estado 3 in the JANUS mirror. */
  async function czIdsWithEstado3(czIds) {
    const ids = uniq(czIds).map(Number);
    const out = new Set();
    for (let i = 0; i < ids.length; i += MAX_LIST) {
      const chunk = ids.slice(i, i + MAX_LIST);
      const [hist, cur] = await Promise.all([
        db()
          .from('cz_funnel_solicitud_estados')
          .select('cz_solicitud_id')
          .eq('solicitudes_estados_id', 3)
          .in('cz_solicitud_id', chunk),
        db()
          .from('cz_funnel_solicitudes')
          .select('cz_id')
          .eq('solicitudes_estados_id', 3)
          .in('cz_id', chunk),
      ]);
      if (hist.error) throw rpcError('cz_funnel_solicitud_estados read', hist.error);
      if (cur.error) throw rpcError('cz_funnel_solicitudes read', cur.error);
      for (const r of hist.data || []) out.add(Number(r.cz_solicitud_id));
      for (const r of cur.data || []) out.add(Number(r.cz_id));
    }
    return out;
  }

  return {
    listOpenFallbackRequests,
    czIdsWithEstado3,
    listOpenProcesses,
    getProcessById,
    getProcessesByIds,
    getPostbackEventsByIds,
    listBlockedByRelated,
    listReviewCases,
    getUsersByIds,
    listAssignableUsers,
    countOpenProcesses,
    listAuditEvents,
    resolveProcess,
    assignReviewCase,
    triageReviewCase,
    resolveReviewCase,
    listC1ActiveReferrals,
    listCzConflicts,
    resolveCzConflict,
  };
}

module.exports = {
  AUDIT_TABLE,
  OPEN_PROCESS_SELECT,
  CASE_SELECT,
  createElmOpsRepository,
};
