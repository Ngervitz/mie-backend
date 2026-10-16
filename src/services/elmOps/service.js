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
  classifyElmProcess,
  readPostReferralRejectionStatuses,
} = require('../elm/classification');
const { computeElmKpis } = require('../elm/kpis');
const {
  classifyOpportunity,
  filterOpportunities,
  situationOptions,
  vintageOptions,
  laneOptions,
  GESTION_TAB_ENABLED,
  CORRECTION_CUTOVER_AT,
} = require('./opportunityClassify');
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
  const postReferralStatuses =
    d.postReferralRejectionStatuses || readPostReferralRejectionStatuses();

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

  async function classifiedProcesses() {
    const rows = await elmRepo.listAllProcesses();
    const automatic = rows
      .filter(function (p) { return p.trigger_origin === 'cz_automatic'; })
      .map(function (p) { return Number(p.cz_solicitud_id); });
    const projectedByCz = automatic.length
      ? await elmRepo.getProjectedEstadosByCzIds(automatic)
      : new Map();
    return { rows: rows, projectedByCz: projectedByCz };
  }

  /** ELM KPIs (flow vs current state) segmented by trigger_origin. Window on process start. */
  async function kpis(query) {
    const q = query || {};
    const fromMs = q.from ? Date.parse(String(q.from)) : NaN;
    const toMs = q.to ? Date.parse(String(q.to)) : NaN;
    if ((q.from && !Number.isFinite(fromMs)) || (q.to && !Number.isFinite(toMs))) return null;
    const { rows, projectedByCz } = await classifiedProcesses();
    return computeElmKpis(rows, {
      from: q.from ? new Date(fromMs).toISOString() : null,
      to: q.to ? new Date(toMs).toISOString() : null,
      nowMs: now(),
      projectedByCz: projectedByCz,
      postReferralRejectionStatuses: postReferralStatuses,
    });
  }

  /**
   * Seguimiento operativo: everything that is neither in Preaprobados nor in Rechazados yet.
   *   in_evaluation / review   any origin (S1 favorable waiting S2, in flight, uncertain,
   *                            technical error, negative answer not confirmed as definitive)
   *   rejected_pending_cz      automatic definitive rejection CZ has not reflected as 3 yet
   *   queued                   automatic fallback request without ELM process yet
   */
  async function followup(limit) {
    const nowMs = now();
    const max = Math.min(limit || 200, 200);
    const { rows, projectedByCz } = await classifiedProcesses();
    const items = [];
    const rejectedAutomatic = [];
    for (const p of rows) {
      const czId = Number(p.cz_solicitud_id);
      const c = classifyElmProcess(p, {
        nowMs: nowMs,
        postReferralRejectionStatuses: postReferralStatuses,
        projectedEstado: projectedByCz.has(czId) ? projectedByCz.get(czId) : null,
      });
      const since = p.updated_at || p.created_at;
      const item = {
        kind: c.state,
        cz_solicitud_id: czId,
        ci: p.ci != null ? String(p.ci) : null,
        trigger_origin: p.trigger_origin || null,
        process_id: p.id,
        state: c.state,
        label: c.detail_label,
        provider_status: p.provider_status || null,
        since: since || null,
        age_hours: ageHours(since, nowMs),
      };
      if (c.state === 'in_evaluation' || c.state === 'review') items.push(item);
      else if (c.state === 'rejected' && p.trigger_origin === 'cz_automatic') {
        rejectedAutomatic.push(item);
      }
    }
    if (rejectedAutomatic.length) {
      const reflected = await repo.czIdsWithEstado3(
        rejectedAutomatic.map(function (i) { return i.cz_solicitud_id; }),
      );
      for (const i of rejectedAutomatic) {
        if (reflected.has(i.cz_solicitud_id)) continue;
        items.push(Object.assign({}, i, {
          kind: 'rejected_pending_cz',
          label: i.label + ' · pendiente de reflejo en Credizona (estado 3)',
        }));
      }
    }
    const withProcess = new Set(rows.map(function (p) { return Number(p.cz_solicitud_id); }));
    const queued = await repo.listOpenFallbackRequests(max);
    for (const r of queued) {
      if (withProcess.has(Number(r.cz_solicitud_id))) continue;
      items.push({
        kind: 'queued',
        cz_solicitud_id: Number(r.cz_solicitud_id),
        ci: r.ci != null ? String(r.ci) : null,
        trigger_origin: 'cz_automatic',
        process_id: null,
        state: 'in_evaluation',
        label: 'En cola para ELM (circuito automático)',
        provider_status: null,
        since: r.created_at || null,
        age_hours: ageHours(r.created_at, nowMs),
      });
    }
    items.sort(function (a, b) {
      return String(a.since || '').localeCompare(String(b.since || ''));
    });
    return items.slice(0, max);
  }

  function bagOf(map, czId) {
    const id = Number(czId);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (!map.has(id)) map.set(id, { cz_solicitud_id: id });
    return map.get(id);
  }

  function setIf(bag, key, value) {
    if (value != null && value !== '') bag[key] = value;
  }

  /**
   * One commercial row per solicitud for Preaprobados «Oportunidades ELM».
   * Composes existing followup / review-cases / active-referrals reads. No writes, no ELM send.
   */
  async function opportunities(query) {
    const q = query || {};
    const max = Math.min(q.limit || 200, 200);
    const [followupItems, cases, referrals] = await Promise.all([
      followup(max),
      listReviewCases('open', max),
      listC1ActiveReferrals(max),
    ]);
    const bags = new Map();
    for (const f of followupItems) {
      const bag = bagOf(bags, f.cz_solicitud_id);
      if (!bag) continue;
      setIf(bag, 'ci', f.ci);
      setIf(bag, 'followup_kind', f.kind);
      setIf(bag, 'followup_label', f.label);
      setIf(bag, 'since', f.since);
      if (f.age_hours != null) bag.age_hours = f.age_hours;
      setIf(bag, 'provider_status', f.provider_status);
      setIf(bag, 'trigger_origin', f.trigger_origin);
      setIf(bag, 'process_id', f.process_id);
    }
    for (const c of cases) {
      const bag = bagOf(bags, c.cz_solicitud_id);
      if (!bag) continue;
      setIf(bag, 'ci', c.ci);
      setIf(bag, 'reason_code', c.reason_code);
      if (c.related_cz_solicitud_id != null) bag.related_cz_solicitud_id = c.related_cz_solicitud_id;
      setIf(bag, 'review_id', c.id);
      if (c.version != null) bag.review_version = c.version;
      setIf(bag, 'since', c.created_at);
      if (c.age_hours != null) bag.age_hours = c.age_hours;
      const elm = c.elm || {};
      setIf(bag, 's1_status', elm.s1_status);
      setIf(bag, 's2_status', elm.s2_status);
      setIf(bag, 'provider_status', elm.provider_status);
      if (elm.granted_elm === true) bag.granted_elm = true;
      setIf(bag, 'process_id', elm.process_id);
    }
    for (const r of referrals) {
      const bag = bagOf(bags, r.cz_solicitud_id);
      if (!bag) continue;
      setIf(bag, 'ci', r.ci);
      bag.projected_estado = Number(r.projected_estado);
      setIf(bag, 'provider_status', r.provider_status);
      setIf(bag, 'since', r.referred_at || r.started_at);
      if (r.age_hours != null) bag.age_hours = r.age_hours;
      if (r.granted_elm === true) bag.granted_elm = true;
      setIf(bag, 'elm_process_id', r.elm_process_id);
      if (r.last_event) bag.last_event = r.last_event;
      if (Number(r.projected_estado) === 13 && r.fallback_outcome === 'referred') {
        setIf(bag, 's2_status', bag.s2_status || 'referred');
      }
    }
    const processIds = [];
    bags.forEach(function (bag) {
      if (bag.process_id) processIds.push(bag.process_id);
      if (bag.elm_process_id) processIds.push(bag.elm_process_id);
    });
    if (processIds.length) {
      const processes = await repo.getProcessesByIds(processIds);
      const nowMs = now();
      bags.forEach(function (bag) {
        const p =
          (bag.process_id && processes.get(bag.process_id)) ||
          (bag.elm_process_id && processes.get(bag.elm_process_id)) ||
          null;
        if (!p) return;
        setIf(bag, 's1_status', effective(p.s1_status, p.s1_lease_expires_at, nowMs));
        setIf(bag, 's2_status', effective(p.s2_status, p.s2_lease_expires_at, nowMs));
        setIf(bag, 's1_result_message', p.s1_result_message);
        setIf(bag, 's1_error_code', p.s1_error_code);
        if (p.s1_http_status != null) bag.s1_http_status = Number(p.s1_http_status);
        if (p.s1_attempts != null) bag.s1_attempts = Number(p.s1_attempts);
        setIf(bag, 'trigger_origin', p.trigger_origin);
        setIf(bag, 'process_updated_at', p.updated_at);
        if (p.ops_resolved_at) bag.ops_resolved_at = p.ops_resolved_at;
        setIf(bag, 'provider_status', p.provider_status);
        if (p.disbursed_at) bag.granted_elm = true;
      });
    }
    const items = [];
    bags.forEach(function (bag) {
      bag.dashboard = 'preaprobados';
      items.push(classifyOpportunity(bag));
    });
    items.sort(function (a, b) {
      return String(a.since || '').localeCompare(String(b.since || ''));
    });
    const filtered = filterOpportunities(items, { ci: q.ci, situation: q.situation });
    return {
      items: filtered.slice(0, max),
      situations: situationOptions(),
    };
  }

  /**
   * C1 rows in Credizona estado 3 that can still complete S2 (cellphone false-reject).
   * Shown under Rechazados; never mixed into Preaprobados CDV KPIs.
   */
  async function recoverable(query) {
    const q = query || {};
    const max = Math.min(q.limit || 200, 200);
    if (typeof repo.listPhoneInvalidFinalized !== 'function') {
      return { items: [], situations: situationOptions() };
    }
    const rows = await repo.listPhoneInvalidFinalized(max);
    const processIds = rows.map(function (r) { return r.elm_process_id; });
    const processes = await repo.getProcessesByIds(processIds);
    const czIds = rows.map(function (r) { return Number(r.cz_solicitud_id); });
    const inEstado3 = await repo.czIdsWithEstado3(czIds);
    const items = [];
    for (const r of rows) {
      const czId = Number(r.cz_solicitud_id);
      if (!inEstado3.has(czId)) continue;
      const p = r.elm_process_id ? processes.get(r.elm_process_id) : null;
      const s1 = p && p.s1_status ? p.s1_status : null;
      const s2 = p && p.s2_status ? p.s2_status : null;
      if (s1 !== S1.ELIGIBLE || s2 !== S2.NOT_STARTED) continue;
      items.push(
        classifyOpportunity({
          cz_solicitud_id: czId,
          ci: r.ci,
          reason_code: r.reason_code,
          s1_status: s1,
          s2_status: s2,
          since: r.finalized_at || r.created_at,
          age_hours: ageHours(r.finalized_at || r.created_at, now()),
          process_id: r.elm_process_id,
          projected_estado: 3,
          recoverable: true,
          dashboard: 'rechazados',
          followup_label: 'Paso 1 aceptado por ELM · paso 2 no enviado',
        }),
      );
    }
    const filtered = filterOpportunities(items, { ci: q.ci, situation: q.situation });
    return {
      items: filtered.slice(0, max),
      situations: situationOptions(),
    };
  }

  /**
   * Transitory Gestión ELM desk: pending 12/14 + estado-3 recoverables + 13 follow-up.
   * Composes opportunities() + recoverable(). No writes. Tab may be hidden later;
   * this read stays so history, audit and new-error detection remain.
   */
  async function gestion(query) {
    const q = query || {};
    const max = Math.min(q.limit || 200, 200);
    const [ops, rec] = await Promise.all([
      opportunities({ limit: max }),
      recoverable({ limit: max }),
    ]);
    const byId = new Map();
    (ops.items || []).forEach(function (item) {
      byId.set(item.cz_solicitud_id, item);
    });
    (rec.items || []).forEach(function (item) {
      byId.set(item.cz_solicitud_id, item);
    });
    const merged = Array.from(byId.values());
    merged.sort(function (a, b) {
      if (a.attention !== b.attention) return a.attention ? -1 : 1;
      if (a.vintage !== b.vintage) return a.vintage === 'historical' ? -1 : 1;
      return String(a.since || '').localeCompare(String(b.since || ''));
    });
    const filtered = filterOpportunities(merged, {
      ci: q.ci,
      situation: q.situation,
      vintage: q.vintage,
      lane: q.lane,
    });
    return {
      items: filtered.slice(0, max),
      situations: situationOptions(),
      vintages: vintageOptions(),
      lanes: laneOptions(),
      tab_enabled: GESTION_TAB_ENABLED === true,
      cutover_at: CORRECTION_CUTOVER_AT,
    };
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
    kpis,
    followup,
    opportunities,
    recoverable,
    gestion,
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
  classifyOpportunity,
  filterOpportunities,
  situationOptions,
};
