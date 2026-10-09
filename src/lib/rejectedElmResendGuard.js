'use strict';

/**
 * Can a CI take a new manual ELM send from Rechazados? Decided from the ELM history of the CI's
 * OTHER solicitudes. A solicitud with its own process is never sent as new: that case is left to
 * the orchestrator (elm_process_exists, or resuming its own S2), unchanged.
 *
 * Shared by the Rechazados list, the detail and POST /rechazados/:ci/elm/send.
 *
 * - The database CI lock (elm_ci_lock_try, inside elm_claim_process) stays the authority for an
 *   active referral, an uncertain result, a send in progress and the calendar-month quota. Those
 *   are mirrored here only so the button can say why before the click.
 * - ELM refuses a lead of the same person within 30 days of the previous one. The calendar-month
 *   quota does not cover it (30 Sep → 1 Oct), and a process closed in JANUS does not mean ELM
 *   accepts a new referral: every other solicitud that reached ELM counts, whatever its state.
 * - Anything that cannot be read or dated holds the send (fail closed).
 */

const { readElmRowsByCis, OPEN_PROJECTED_ESTADOS } = require('./rejectedSurveyInviteElmGate');
const {
  classifyElmProcess,
  COMMERCIAL,
  readPostReferralRejectionStatuses,
} = require('../services/elm/classification');

const LOCKS_TABLE = 'elm_ci_send_locks';
const LOCKS_SELECT =
  'ci, cz_solicitud_id, state, month_key, blocks_future, block_reason, reserved_at, consumed_at';
const IN_CHUNK = 200;
const DAY_MS = 24 * 3600 * 1000;
const ELM_RESEND_WINDOW_DAYS = 30;
const MONTEVIDEO = 'America/Montevideo';

const HOLD = Object.freeze({
  ACTIVE: 'elm_ci_active',
  IN_PROGRESS: 'elm_ci_send_in_progress',
  UNVERIFIABLE: 'elm_ci_history_unverifiable',
  RECENT_SEND: 'elm_ci_recent_send',
  MONTHLY_QUOTA: 'elm_ci_monthly_quota_used',
});

/** Projected CZ estados of automatic solicitudes still open in the ELM circuit (16 = granted). */
const OPEN_FOR_SEND = Object.freeze(
  OPEN_PROJECTED_ESTADOS.filter(function (e) {
    return e !== 16;
  }),
);

const ACTIVE_STATES = Object.freeze([
  COMMERCIAL.IN_EVALUATION,
  COMMERCIAL.REFERRED,
  COMMERCIAL.REVIEW,
]);

function toMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

function latestMs(values) {
  let best = null;
  for (const v of values) {
    const t = toMs(v);
    if (t != null && (best == null || t > best)) best = t;
  }
  return best;
}

/** First day of the calendar month in Uruguay, 'YYYY-MM-01' (same as elm_month_key). */
function montevideoMonthKey(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MONTEVIDEO,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(ms));
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  return y + '-' + m + '-01';
}

function nextMonthKey(monthKey) {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return ny + '-' + String(nm).padStart(2, '0') + '-01';
}

function hold(reason, relatedCzId, until) {
  return {
    reason: reason,
    related_cz_solicitud_id: relatedCzId != null ? Number(relatedCzId) : null,
    until: until || null,
  };
}

/**
 * Pure.
 * @param {{
 *   ci: number,
 *   czSolicitudId?: number|null,   target; null = any new solicitud of the CI (list / detail)
 *   processes: object[]|undefined,
 *   states?: object[],
 *   openRequests?: object[],
 *   locks: object[]|undefined,
 *   nowMs: number,
 *   postReferralRejectionStatuses?: readonly string[],
 *   retryOwnProcess?: boolean,     manual retry of the target's own process: the target is
 *                                  still excluded, the CI's other solicitudes are evaluated
 * }} input
 * @returns {{ reason: string, related_cz_solicitud_id: number|null, until: string|null }|null}
 */
function evaluateCiResendHold(input) {
  const ci = Number(input.ci);
  const target = input.czSolicitudId != null ? Number(input.czSolicitudId) : null;
  if (!Array.isArray(input.processes) || !Array.isArray(input.locks)) {
    return hold(HOLD.UNVERIFIABLE, null);
  }
  const nowMs = input.nowMs;
  const ofCi = function (r) {
    return Number(r.ci) === ci;
  };
  const processes = input.processes.filter(ofCi);
  if (
    target != null &&
    input.retryOwnProcess !== true &&
    processes.some((p) => Number(p.cz_solicitud_id) === target)
  ) {
    return null;
  }
  const others = processes.filter((p) => Number(p.cz_solicitud_id) !== target);
  const locks = input.locks.filter(ofCi).filter((l) => Number(l.cz_solicitud_id) !== target);
  const states = (input.states || []).filter(ofCi);
  const projected = new Map();
  for (const s of states) projected.set(Number(s.cz_solicitud_id), Number(s.projected_estado));

  for (const p of others) {
    const czId = Number(p.cz_solicitud_id);
    const c = classifyElmProcess(p, {
      nowMs: nowMs,
      postReferralRejectionStatuses: input.postReferralRejectionStatuses || [],
      projectedEstado:
        p.trigger_origin === 'cz_automatic' && projected.has(czId) ? projected.get(czId) : null,
    });
    if (!c || ACTIVE_STATES.includes(c.state)) return hold(HOLD.ACTIVE, czId);
  }
  for (const s of states) {
    if (Number(s.cz_solicitud_id) === target) continue;
    if (OPEN_FOR_SEND.includes(Number(s.projected_estado))) return hold(HOLD.ACTIVE, s.cz_solicitud_id);
  }
  for (const l of locks) {
    if (l.blocks_future === true) return hold(HOLD.ACTIVE, l.cz_solicitud_id);
  }
  for (const r of (input.openRequests || []).filter(ofCi)) {
    if (Number(r.cz_solicitud_id) !== target) return hold(HOLD.IN_PROGRESS, r.cz_solicitud_id);
  }
  for (const l of locks) {
    if (l.state === 'reserved') return hold(HOLD.IN_PROGRESS, l.cz_solicitud_id);
  }

  let last = null;
  for (const p of others) {
    const t = latestMs([p.created_at, p.s1_started_at, p.s2_started_at, p.referred_at]);
    if (t == null) return hold(HOLD.UNVERIFIABLE, p.cz_solicitud_id);
    if (!last || t > last.ms) last = { ms: t, czId: p.cz_solicitud_id };
  }
  for (const l of locks) {
    if (l.state === 'released') continue;
    const t = latestMs([l.reserved_at, l.consumed_at]);
    if (t == null) return hold(HOLD.UNVERIFIABLE, l.cz_solicitud_id);
    if (!last || t > last.ms) last = { ms: t, czId: l.cz_solicitud_id };
  }

  const timed = [];
  if (last && nowMs < last.ms + ELM_RESEND_WINDOW_DAYS * DAY_MS) {
    timed.push(
      hold(HOLD.RECENT_SEND, last.czId, new Date(last.ms + ELM_RESEND_WINDOW_DAYS * DAY_MS).toISOString()),
    );
  }
  const month = montevideoMonthKey(nowMs);
  const lockedIds = new Set(
    locks
      .filter((l) => l.state === 'reserved' || l.state === 'consumed')
      .map((l) => Number(l.cz_solicitud_id)),
  );
  const quota =
    locks.find((l) => l.state === 'consumed' && String(l.month_key || '').slice(0, 10) === month) ||
    others.find((p) => {
      const t = toMs(p.s1_started_at);
      return t != null && !lockedIds.has(Number(p.cz_solicitud_id)) && montevideoMonthKey(t) === month;
    });
  if (quota) timed.push(hold(HOLD.MONTHLY_QUOTA, quota.cz_solicitud_id, nextMonthKey(month)));
  if (!timed.length) return null;
  timed.sort((a, b) => String(b.until).localeCompare(String(a.until)));
  return timed[0];
}

/**
 * Processes, projected estados, open fallback requests and CI send locks of the given CIs.
 * Process reads throw; if only the locks cannot be read, `locks` is null so the ELM history is
 * still shown and every send of those CIs is held as unverifiable.
 */
async function readElmSendRowsByCis(supabase, cis) {
  const rows = await readElmRowsByCis(supabase, cis);
  let locks = [];
  try {
    for (let i = 0; i < cis.length; i += IN_CHUNK) {
      const chunk = cis.slice(i, i + IN_CHUNK);
      const res = await supabase.from(LOCKS_TABLE).select(LOCKS_SELECT).in('ci', chunk);
      if (res.error) throw new Error(LOCKS_TABLE + ' read failed: ' + res.error.message);
      locks.push(...(res.data || []));
    }
  } catch (_) {
    locks = null;
  }
  return Object.assign({}, rows, { locks: locks });
}

/**
 * Hold for sending `czSolicitudId` of `ci` now. Read errors propagate: the caller blocks.
 * @param {object} supabase
 * @param {number} ci
 * @param {number} czSolicitudId
 * @param {{
 *   now?: () => number,
 *   postReferralRejectionStatuses?: string[],
 *   readRows?: Function,
 *   retryOwnProcess?: boolean,
 * }} [opts]
 */
async function loadCiResendHold(supabase, ci, czSolicitudId, opts) {
  const o = opts || {};
  const rows = await (o.readRows || readElmSendRowsByCis)(supabase, [Number(ci)]);
  return evaluateCiResendHold({
    ci: ci,
    czSolicitudId: czSolicitudId,
    processes: rows.processes,
    states: rows.states,
    openRequests: rows.openRequests,
    locks: rows.locks,
    nowMs: (o.now || Date.now)(),
    postReferralRejectionStatuses:
      o.postReferralRejectionStatuses || readPostReferralRejectionStatuses(),
    retryOwnProcess: o.retryOwnProcess === true,
  });
}

module.exports = {
  HOLD,
  ELM_RESEND_WINDOW_DAYS,
  montevideoMonthKey,
  evaluateCiResendHold,
  readElmSendRowsByCis,
  loadCiResendHold,
};
