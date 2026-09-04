'use strict';

/**
 * Pure Rechazados Mi Plan / Mi Deuda outreach helpers.
 * No I/O. Invite expiry is derived (not persisted).
 */

const MI_PLAN_STATUS = Object.freeze({
  NOT_INVITED: 'not_invited',
  INVITED: 'invited',
  ACTIVE: 'active',
});

const MI_DEUDA_STATUS = Object.freeze({
  NOT_INVITED: 'not_invited',
  INVITE_SENT: 'invite_sent',
  OPT_IN_ACCEPTED: 'opt_in_accepted',
  OPT_IN_REJECTED: 'opt_in_rejected',
});

const MI_DEUDA_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const OUTREACH_SELECT =
  'ci, mi_plan_status, mi_plan_updated_at, mi_deuda_status, mi_deuda_updated_at, mi_deuda_invited_at, mi_deuda_responded_at, created_at, updated_at';

/**
 * @param {unknown} status
 * @param {unknown} invitedAt
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function isMiDeudaInviteExpired(status, invitedAt, nowMs) {
  if (status !== MI_DEUDA_STATUS.INVITE_SENT) return false;
  if (invitedAt == null || invitedAt === '') return false;
  const t = Date.parse(String(invitedAt));
  if (!Number.isFinite(t)) return false;
  const now = nowMs != null ? Number(nowMs) : Date.now();
  if (!Number.isFinite(now)) return false;
  return now - t >= MI_DEUDA_INVITE_TTL_MS;
}

/**
 * Normalize DB row or missing row into API outreach fields.
 * @param {object|null|undefined} row
 * @param {number} [nowMs]
 */
function formatOutreach(row, nowMs) {
  if (!row || typeof row !== 'object') {
    return {
      mi_plan_status: MI_PLAN_STATUS.NOT_INVITED,
      mi_plan_updated_at: null,
      mi_deuda_status: MI_DEUDA_STATUS.NOT_INVITED,
      mi_deuda_updated_at: null,
      mi_deuda_invited_at: null,
      mi_deuda_responded_at: null,
      mi_deuda_invite_expired: false,
    };
  }

  const miPlanStatus =
    row.mi_plan_status != null && String(row.mi_plan_status).trim() !== ''
      ? String(row.mi_plan_status)
      : MI_PLAN_STATUS.NOT_INVITED;
  const miDeudaStatus =
    row.mi_deuda_status != null && String(row.mi_deuda_status).trim() !== ''
      ? String(row.mi_deuda_status)
      : MI_DEUDA_STATUS.NOT_INVITED;
  const invitedAt =
    row.mi_deuda_invited_at != null ? row.mi_deuda_invited_at : null;

  return {
    mi_plan_status: miPlanStatus,
    mi_plan_updated_at:
      row.mi_plan_updated_at != null ? row.mi_plan_updated_at : null,
    mi_deuda_status: miDeudaStatus,
    mi_deuda_updated_at:
      row.mi_deuda_updated_at != null ? row.mi_deuda_updated_at : null,
    mi_deuda_invited_at: invitedAt,
    mi_deuda_responded_at:
      row.mi_deuda_responded_at != null ? row.mi_deuda_responded_at : null,
    mi_deuda_invite_expired: isMiDeudaInviteExpired(
      miDeudaStatus,
      invitedAt,
      nowMs,
    ),
  };
}

module.exports = {
  MI_PLAN_STATUS,
  MI_DEUDA_STATUS,
  MI_DEUDA_INVITE_TTL_MS,
  OUTREACH_SELECT,
  isMiDeudaInviteExpired,
  formatOutreach,
};
