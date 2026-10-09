'use strict';

/**
 * ELM operations (Fase 3B): queue of active referrals / uncertain ELM results and manual review
 * queue of the provider fallback.
 *
 * - A manual resolution never sends anything to ELM, never sets GRANTED (only the "Convertido"
 *   postback does) and never changes the ELM step states. It only stops the process from
 *   blocking new ELM sends of the same CI. provider_loan_disbursed requires GRANTED evidence.
 * - Concurrency: the operator sends the version they saw (process updated_at / case version).
 *   The RPC re-checks it under row lock, so a postback, a worker step or another operator in
 *   between makes the action answer `stale` instead of overwriting.
 * - Permissions: reads need section 'preaprobados'; every action needs requireElmAction
 *   (active admin, human session, never cron).
 */

const { S1, S2 } = require('../elm/constants');
const {
  REVIEW_PRIORITIES,
  REVIEW_CZ_OUTCOMES,
  PROCESS_CZ_OUTCOMES,
} = require('../providerFallback/constants');

const PROCESS_RESOLUTIONS = Object.freeze({
  referral: Object.freeze([
    'provider_closed_no_loan',
    'provider_loan_disbursed',
    'customer_withdrew',
    'other',
  ]),
  s2_unknown: Object.freeze([
    'provider_confirmed_not_received',
    'provider_closed_no_loan',
    'provider_loan_disbursed',
    'other',
  ]),
  s1_unknown: Object.freeze([
    'provider_confirmed_not_received',
    'provider_confirmed_no_referral',
    'other',
  ]),
});

const CASE_RESOLUTIONS = Object.freeze([
  'resolved_with_provider',
  'customer_contacted',
  'no_action_required',
  'other',
]);

const NOTE_MIN = 10;
const NOTE_MAX = 2000;
const MAX_TRIAGE_DAYS = 90;

/** HTTP status for each RPC answer. */
const ACTION_HTTP = Object.freeze({
  resolved: 200,
  assigned: 200,
  unassigned: 200,
  triaged: 200,
  not_found: 404,
  stale: 409,
  already_resolved: 409,
  in_flight: 409,
  not_resolvable: 409,
  evidence_required: 409,
  cz_outcome_required: 409,
  cz_outcome_not_applicable: 409,
  cz_outcome_mismatch: 409,
  invalid_cz_outcome: 400,
  invalid_resolution: 400,
  invalid_triage: 400,
  note_required: 400,
  invalid_assignee: 400,
  invalid_request: 400,
});

function isExpired(iso, nowMs) {
  if (!iso) return false;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) && t < nowMs;
}

function effective(status, leaseIso, nowMs) {
  return status === 'in_flight' && isExpired(leaseIso, nowMs) ? 'unknown' : status;
}

function ageHours(iso, nowMs) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 36e5));
}

/** @returns {'referral'|'s2_unknown'|'s1_unknown'|null} */
function processKind(p, nowMs) {
  const s1 = effective(p.s1_status, p.s1_lease_expires_at, nowMs);
  const s2 = effective(p.s2_status, p.s2_lease_expires_at, nowMs);
  if (s2 === S2.REFERRED) return 'referral';
  if (s2 === S2.UNKNOWN) return 's2_unknown';
  if (s1 === S1.UNKNOWN) return 's1_unknown';
  return null;
}

/** Short ELM state for the queues (no bodies). */
function elmStateOf(p, nowMs) {
  if (!p) return null;
  return {
    s1_status: effective(p.s1_status, p.s1_lease_expires_at, nowMs),
    s2_status: effective(p.s2_status, p.s2_lease_expires_at, nowMs),
    provider_status: p.provider_status || null,
    provider_status_at: p.provider_status_at || null,
    granted_elm: Boolean(p.disbursed_at),
    ops_resolution_code: p.ops_resolution_code || null,
    ops_resolved_at: p.ops_resolved_at || null,
  };
}

/**
 * @param {object} p elm_lead_processes row (OPEN_PROCESS_SELECT)
 * @param {{ nowMs: number, lastEvent?: object|null, blockedCzIds?: number[] }} ctx
 */
function openProcessView(p, ctx) {
  const nowMs = ctx.nowMs;
  const kind = processKind(p, nowMs);
  const since = p.referred_at || p.s2_started_at || p.s1_started_at || p.created_at;
  const ev = ctx.lastEvent || null;
  return {
    process_id: p.id,
    cz_solicitud_id: Number(p.cz_solicitud_id),
    ci: p.ci != null ? String(p.ci) : null,
    kind: kind,
    since: since || null,
    age_hours: ageHours(since, nowMs),
    trigger_origin: p.trigger_origin || null,
    commercial_origin: p.commercial_origin || null,
    elm: elmStateOf(p, nowMs),
    last_event: ev
      ? {
          received_at: ev.received_at || null,
          status: ev.raw_status || null,
          processing_status: ev.processing_status || null,
        }
      : null,
    blocked_cz_solicitud_ids: ctx.blockedCzIds || [],
    version: p.updated_at || null,
    allowed_resolutions: kind ? PROCESS_RESOLUTIONS[kind].slice() : [],
  };
}

/**
 * @param {object} c provider_review_cases row
 * @param {{ nowMs: number, process?: object|null, users?: Map<string, object> }} ctx
 */
function reviewCaseView(c, ctx) {
  const nowMs = ctx.nowMs;
  const users = ctx.users || new Map();
  const assignee = c.assigned_to ? users.get(c.assigned_to) || { id: c.assigned_to } : null;
  const resolver = c.resolved_by ? users.get(c.resolved_by) || { id: c.resolved_by } : null;
  const open = c.status === 'open';
  return {
    id: c.id,
    cz_solicitud_id: Number(c.cz_solicitud_id),
    ci: c.ci != null ? String(c.ci) : null,
    related_cz_solicitud_id: c.related_cz_solicitud_id != null ? Number(c.related_cz_solicitud_id) : null,
    reason_code: c.reason_code,
    priority: c.priority,
    due_at: c.due_at,
    overdue: open && isExpired(c.due_at, nowMs),
    unassigned: open && !c.assigned_to,
    created_at: c.created_at,
    age_hours: ageHours(c.created_at, nowMs),
    status: c.status,
    assigned_to: assignee ? { id: assignee.id, email: assignee.email || null } : null,
    assigned_at: c.assigned_at || null,
    resolution: c.resolved_at
      ? {
          code: c.resolution_code,
          note: c.resolution_note,
          by: resolver ? { id: resolver.id, email: resolver.email || null } : null,
          at: c.resolved_at,
        }
      : null,
    elm: elmStateOf(ctx.process || null, nowMs),
    version: c.version,
  };
}

/** provider_c1_active_referrals row → ops view (13 derivado a ventas, 14 en revisión). */
function c1ReferralView(r) {
  return {
    cz_solicitud_id: Number(r.cz_solicitud_id),
    ci: r.ci != null ? String(r.ci) : null,
    projected_estado: Number(r.projected_estado),
    fallback_outcome: r.fallback_outcome || null,
    reason_code: r.reason_code || null,
    elm_process_id: r.elm_process_id || null,
    started_at: r.started_at || null,
    referred_at: r.referred_at || null,
    age_hours: r.age_hours != null ? Number(r.age_hours) : null,
    provider_status: r.provider_status || null,
    provider_status_at: r.provider_status_at || null,
    last_postback_at: r.last_postback_at || null,
    hours_since_last_signal: r.hours_since_last_signal != null ? Number(r.hours_since_last_signal) : null,
    last_event: r.last_event_type
      ? { seq: Number(r.last_event_seq), type: r.last_event_type, delivery_status: r.last_event_delivery || null }
      : null,
    unacked_events: Number(r.unacked_events) || 0,
    open_conflicts: Number(r.open_conflicts) || 0,
    lock: r.lock_state
      ? { state: r.lock_state, month: r.lock_month || null, block_reason: r.lock_block_reason || null }
      : null,
    granted_elm: r.granted_elm === true,
    stale: r.stale === true,
  };
}

function cleanNote(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s.length >= NOTE_MIN && s.length <= NOTE_MAX ? s : null;
}

function positiveInt(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(raw) {
  return typeof raw === 'string' && UUID_RE.test(raw);
}

/**
 * @param {{
 *   repository?: object,
 *   elmRepository?: object,
 *   fallbackRepository?: object,
 *   now?: () => number,
 *   logger?: object,
 * }} [deps]
 */
function createElmOpsService(deps) {
  const d = deps || {};
  const repo = d.repository || require('./repository').createElmOpsRepository();
  const elmRepo = d.elmRepository || require('../elm/repository').createElmRepository();
  const fallbackRepo =
    d.fallbackRepository ||
    require('../providerFallback/repository').createProviderFallbackRepository();
  const now = d.now || Date.now;
  const logger = d.logger || require('../../lib/logger');
  const c1StaleHours =
    d.c1StaleHours ||
    require('../providerFallback/config').readProviderFallbackConfig().activeReferralStaleHours;

  async function listOpenProcesses(limit) {
    const nowMs = now();
    const rows = await repo.listOpenProcesses(limit);
    const [events, blocked] = await Promise.all([
      repo.getPostbackEventsByIds(rows.map(function (r) { return r.last_postback_event_id; })),
      repo.listBlockedByRelated(rows.map(function (r) { return r.cz_solicitud_id; })),
    ]);
    return rows.map(function (p) {
      return openProcessView(p, {
        nowMs: nowMs,
        lastEvent: p.last_postback_event_id ? events.get(p.last_postback_event_id) || null : null,
        blockedCzIds: blocked.get(Number(p.cz_solicitud_id)) || [],
      });
    });
  }

  async function listReviewCases(status, limit) {
    const nowMs = now();
    const rows = await repo.listReviewCases(status === 'resolved' ? 'resolved' : 'open', limit);
    const [processes, users] = await Promise.all([
      repo.getProcessesByIds(rows.map(function (r) { return r.elm_process_id; })),
      repo.getUsersByIds(
        rows.reduce(function (acc, r) {
          if (r.assigned_to) acc.push(r.assigned_to);
          if (r.resolved_by) acc.push(r.resolved_by);
          return acc;
        }, []),
      ),
    ]);
    return rows.map(function (c) {
      return reviewCaseView(c, {
        nowMs: nowMs,
        process: c.elm_process_id ? processes.get(c.elm_process_id) || null : null,
        users: users,
      });
    });
  }

  async function summary() {
    const [openProcesses, alerts] = await Promise.all([
      repo.countOpenProcesses(),
      fallbackRepo.countReviewAlerts(new Date(now()).toISOString()),
    ]);
    return {
      open_elm_processes: openProcesses,
      review_open: alerts.open,
      review_unassigned: alerts.unassigned,
      review_overdue: alerts.overdue,
    };
  }

  /**
   * An in_flight whose lease already ended is persisted as unknown first (same rule as every
   * write path), so it can be resolved; a live in_flight answers `in_flight`.
   * cz_outcome (C1): a referral CZ still has as active (13) needs rejected (13 → 3, with
   * provider_closed_no_loan) or granted (13 → 16, provider_loan_disbursed + Convertido); the
   * RPC answers cz_outcome_required / cz_outcome_mismatch otherwise. Default none.
   */
  async function resolveProcess(processId, body, actorUserId) {
    const b = body || {};
    if (!isUuid(processId) || typeof b.expected_updated_at !== 'string') {
      return { status: 'invalid_request' };
    }
    const czOutcome = b.cz_outcome == null || b.cz_outcome === '' ? 'none' : b.cz_outcome;
    if (!PROCESS_CZ_OUTCOMES.includes(czOutcome)) return { status: 'invalid_cz_outcome' };
    const note = cleanNote(b.note);
    if (!note) return { status: 'note_required' };
    const code = typeof b.resolution_code === 'string' ? b.resolution_code.trim() : '';

    let p = await repo.getProcessById(processId);
    if (!p) return { status: 'not_found' };
    if (p.ops_resolved_at) return { status: 'already_resolved' };
    let expected = b.expected_updated_at;
    const nowMs = now();
    const expired =
      (p.s1_status === 'in_flight' && isExpired(p.s1_lease_expires_at, nowMs)) ||
      (p.s2_status === 'in_flight' && isExpired(p.s2_lease_expires_at, nowMs));
    if (expired) {
      if (p.updated_at !== expected) return { status: 'stale' };
      const updated = await elmRepo.expireStaleInFlight(Number(p.cz_solicitud_id));
      if (updated) {
        p = updated;
        expected = updated.updated_at;
      }
    }
    const kind = processKind(p, nowMs);
    if (!kind) return { status: 'not_resolvable' };
    if (!PROCESS_RESOLUTIONS[kind].includes(code)) return { status: 'invalid_resolution' };

    const out = await repo.resolveProcess({
      processId: processId,
      expectedUpdatedAt: expected,
      resolutionCode: code,
      note: note,
      actorUserId: actorUserId,
      czOutcome: czOutcome,
    });
    logger.info('elm process manually resolved', {
      process_id: processId,
      cz_solicitud_id: Number(p.cz_solicitud_id),
      resolution_code: code,
      cz_outcome: czOutcome,
      status: out.status,
    });
    return out;
  }

  async function assignReviewCase(caseId, body, actorUserId) {
    const b = body || {};
    const version = positiveInt(b.expected_version);
    const assignee = b.assignee_user_id == null || b.assignee_user_id === '' ? null : b.assignee_user_id;
    if (!isUuid(caseId) || version == null || (assignee !== null && !isUuid(assignee))) {
      return { status: 'invalid_request' };
    }
    if (assignee) {
      const allowed = await repo.listAssignableUsers();
      if (!allowed.some(function (u) { return u.id === assignee; })) {
        return { status: 'invalid_assignee' };
      }
    }
    return repo.assignReviewCase({
      caseId: caseId,
      expectedVersion: version,
      assigneeUserId: assignee,
      actorUserId: actorUserId,
    });
  }

  async function triageReviewCase(caseId, body, actorUserId) {
    const b = body || {};
    const version = positiveInt(b.expected_version);
    if (!isUuid(caseId) || version == null) return { status: 'invalid_request' };
    const priority = typeof b.priority === 'string' ? b.priority.trim() : '';
    const dueMs = typeof b.due_at === 'string' ? Date.parse(b.due_at) : NaN;
    const nowMs = now();
    if (
      !REVIEW_PRIORITIES.includes(priority) ||
      !Number.isFinite(dueMs) ||
      dueMs <= nowMs ||
      dueMs > nowMs + MAX_TRIAGE_DAYS * 864e5
    ) {
      return { status: 'invalid_triage' };
    }
    return repo.triageReviewCase({
      caseId: caseId,
      expectedVersion: version,
      priority: priority,
      dueAt: new Date(dueMs).toISOString(),
      actorUserId: actorUserId,
    });
  }

  async function resolveReviewCase(caseId, body, actorUserId) {
    const b = body || {};
    const version = positiveInt(b.expected_version);
    if (!isUuid(caseId) || version == null) return { status: 'invalid_request' };
    const code = typeof b.resolution_code === 'string' ? b.resolution_code.trim() : '';
    if (!CASE_RESOLUTIONS.includes(code)) return { status: 'invalid_resolution' };
    const czOutcome = typeof b.cz_outcome === 'string' ? b.cz_outcome.trim() : '';
    if (!REVIEW_CZ_OUTCOMES.includes(czOutcome)) return { status: 'invalid_cz_outcome' };
    const note = cleanNote(b.note);
    if (!note) return { status: 'note_required' };
    const out = await repo.resolveReviewCase({
      caseId: caseId,
      expectedVersion: version,
      resolutionCode: code,
      note: note,
      actorUserId: actorUserId,
      czOutcome: czOutcome,
    });
    logger.info('provider review case resolved', {
      case_id: caseId,
      resolution_code: code,
      cz_outcome: czOutcome,
      status: out.status,
      cz_event: out.cz_event && out.cz_event.status ? out.cz_event.status : null,
    });
    return out;
  }

  async function listC1ActiveReferrals(limit) {
    const rows = await repo.listC1ActiveReferrals(c1StaleHours, limit);
    return rows.map(c1ReferralView);
  }

  async function listCzConflicts(status, limit) {
    return repo.listCzConflicts(status === 'resolved' ? 'resolved' : 'open', limit);
  }

  async function resolveCzConflict(conflictId, body, actorUserId) {
    const b = body || {};
    if (!isUuid(conflictId)) return { status: 'invalid_request' };
    const note = cleanNote(b.note);
    if (!note) return { status: 'note_required' };
    return repo.resolveCzConflict({ conflictId: conflictId, note: note, actorUserId: actorUserId });
  }

  async function listAuditEvents(entityType, entityId) {
    if (!['elm_process', 'review_case', 'cz_conflict'].includes(entityType) || !isUuid(entityId)) return null;
    return repo.listAuditEvents(entityType, entityId);
  }

  return {
    listOpenProcesses,
    listReviewCases,
    summary,
    resolveProcess,
    assignReviewCase,
    triageReviewCase,
    resolveReviewCase,
    listAssignableUsers: function () {
      return repo.listAssignableUsers();
    },
    listAuditEvents,
    listC1ActiveReferrals,
    listCzConflicts,
    resolveCzConflict,
  };
}

module.exports = {
  PROCESS_RESOLUTIONS,
  CASE_RESOLUTIONS,
  ACTION_HTTP,
  processKind,
  openProcessView,
  reviewCaseView,
  c1ReferralView,
  createElmOpsService,
};
