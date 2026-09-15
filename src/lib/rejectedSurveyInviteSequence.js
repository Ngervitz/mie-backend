'use strict';

/**
 * Rechazados survey-invite 3-step sequence — pure helpers.
 * Catch-up: resolve the single due step for "now", never backfill skipped steps.
 */

const {
  REASONS,
  classifyPriorRecipient,
} = require('./rejectedSurveyInvite');

const MS_HOUR = 60 * 60 * 1000;
/** Fixed windows (not env-configurable in this stage). */
const STEP1_MIN_MS = 2 * MS_HOUR;
const STEP1_MAX_MS = 24 * MS_HOUR;
const STEP2_MAX_MS = 72 * MS_HOUR;
/** Observability only — stuck queued past normal 5m+30m retry cycle. */
const STUCK_PENDING_THRESHOLD_MS = 2 * MS_HOUR;

const ATTEMPT_KIND = Object.freeze({
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  REPAIRABLE: 'REPAIRABLE',
  TERMINAL: 'TERMINAL',
});

const SEQUENCE_REASONS = Object.freeze({
  NOT_DUE: 'not_due',
  PREVIOUS_PENDING: 'previous_pending',
  SEQUENCE_COMPLETE: 'sequence_complete',
});

function tsMs(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

/**
 * Age in ms from T0 (last rejection fechahora_src) to now.
 * @returns {number|null}
 */
function surveyInviteAgeMs(t0, now) {
  const a = tsMs(t0);
  const b = now instanceof Date ? now.getTime() : tsMs(now);
  if (a == null || b == null) return null;
  return b - a;
}

/**
 * Single due step for catch-up: what step corresponds NOW.
 * @returns {1|2|3|null} null = age < 2h or unknown T0
 */
function resolveDueSurveyInviteStep(t0, now) {
  const age = surveyInviteAgeMs(t0, now);
  if (age == null || age < STEP1_MIN_MS) return null;
  if (age < STEP1_MAX_MS) return 1;
  if (age < STEP2_MAX_MS) return 2;
  return 3;
}

/**
 * Map classifyPriorRecipient → attempt kind for sequence gates.
 * @returns {'PENDING'|'SUCCESS'|'REPAIRABLE'|'TERMINAL'|null}
 */
function classifySurveyInviteAttemptKind(recipient) {
  const c = classifyPriorRecipient(recipient || null);
  if (!c) return null;
  if (c.reason === REASONS.ALREADY_PENDING) return ATTEMPT_KIND.PENDING;
  if (c.repairable === true) return ATTEMPT_KIND.REPAIRABLE;
  if (c.reason === REASONS.ALREADY_SENT) return ATTEMPT_KIND.SUCCESS;
  return ATTEMPT_KIND.TERMINAL;
}

/**
 * Previous unresolved gate: any earlier step PENDING or REPAIRABLE blocks dueStep.
 *
 * @param {{ 1?: object|null, 2?: object|null, 3?: object|null }} attemptsByStep
 * @param {1|2|3} dueStep
 * @returns {{ step: number, kind: string, recipient: object }|null}
 */
function findPreviousUnresolvedSurveyInvite(attemptsByStep, dueStep) {
  const due = Number(dueStep);
  if (!Number.isFinite(due) || due < 2) return null;
  const map = attemptsByStep || {};
  for (let s = 1; s < due; s += 1) {
    const kind = classifySurveyInviteAttemptKind(map[s] || null);
    if (
      kind === ATTEMPT_KIND.PENDING ||
      kind === ATTEMPT_KIND.REPAIRABLE
    ) {
      return { step: s, kind: kind, recipient: map[s] };
    }
  }
  return null;
}

/**
 * Stuck pending observability (queued past threshold and due for pickup).
 * Clock: COALESCE(last_attempt_at, created_at).
 */
function isStuckPendingSurveyInvite(recipient, now) {
  if (!recipient || String(recipient.status || '') !== 'queued') return false;
  const nowMs = now instanceof Date ? now.getTime() : tsMs(now);
  if (nowMs == null) return false;

  const clock =
    tsMs(recipient.last_attempt_at) != null
      ? tsMs(recipient.last_attempt_at)
      : tsMs(recipient.created_at);
  if (clock == null) return false;
  if (nowMs - clock < STUCK_PENDING_THRESHOLD_MS) return false;

  if (recipient.next_attempt_at != null && recipient.next_attempt_at !== '') {
    const next = tsMs(recipient.next_attempt_at);
    if (next != null && next > nowMs) return false;
  }
  return true;
}

/**
 * Whether the sequence is finished for this CI (no further Encuesta invites).
 * Survey completed is handled by eligibility; this covers STEP3 closed.
 */
function isSurveyInviteSequenceComplete(attemptsByStep) {
  const kind3 = classifySurveyInviteAttemptKind(
    attemptsByStep && attemptsByStep[3] ? attemptsByStep[3] : null,
  );
  return kind3 === ATTEMPT_KIND.SUCCESS || kind3 === ATTEMPT_KIND.TERMINAL;
}

module.exports = {
  MS_HOUR,
  STEP1_MIN_MS,
  STEP1_MAX_MS,
  STEP2_MAX_MS,
  STUCK_PENDING_THRESHOLD_MS,
  ATTEMPT_KIND,
  SEQUENCE_REASONS,
  surveyInviteAgeMs,
  resolveDueSurveyInviteStep,
  classifySurveyInviteAttemptKind,
  findPreviousUnresolvedSurveyInvite,
  isStuckPendingSurveyInvite,
  isSurveyInviteSequenceComplete,
  tsMs,
};
