'use strict';

/**
 * Offline unit checks for rejectedOutreach helpers.
 * Run: node scripts/unit-rejected-outreach.js
 */

const assert = require('assert');
const {
  MI_PLAN_STATUS,
  MI_DEUDA_STATUS,
  MI_DEUDA_INVITE_TTL_MS,
  isMiDeudaInviteExpired,
  formatOutreach,
} = require('../src/lib/rejectedOutreach');

const DAY_MS = 24 * 60 * 60 * 1000;
const invitedAt = '2026-09-01T12:00:00.000Z';
const invitedMs = Date.parse(invitedAt);

assert.strictEqual(MI_DEUDA_INVITE_TTL_MS, 7 * DAY_MS);

assert.strictEqual(
  isMiDeudaInviteExpired(MI_DEUDA_STATUS.INVITE_SENT, invitedAt, invitedMs + 6 * DAY_MS),
  false,
);
assert.strictEqual(
  isMiDeudaInviteExpired(MI_DEUDA_STATUS.INVITE_SENT, invitedAt, invitedMs + 7 * DAY_MS),
  true,
);
assert.strictEqual(
  isMiDeudaInviteExpired(MI_DEUDA_STATUS.INVITE_SENT, invitedAt, invitedMs + 8 * DAY_MS),
  true,
);
assert.strictEqual(
  isMiDeudaInviteExpired(MI_DEUDA_STATUS.NOT_INVITED, invitedAt, invitedMs + 30 * DAY_MS),
  false,
);
assert.strictEqual(
  isMiDeudaInviteExpired(MI_DEUDA_STATUS.OPT_IN_ACCEPTED, invitedAt, invitedMs + 30 * DAY_MS),
  false,
);
assert.strictEqual(
  isMiDeudaInviteExpired(MI_DEUDA_STATUS.INVITE_SENT, null, invitedMs + 30 * DAY_MS),
  false,
);
assert.strictEqual(
  isMiDeudaInviteExpired(MI_DEUDA_STATUS.INVITE_SENT, 'not-a-date', invitedMs + 30 * DAY_MS),
  false,
);

const defaults = formatOutreach(null);
assert.deepStrictEqual(defaults, {
  mi_plan_status: MI_PLAN_STATUS.NOT_INVITED,
  mi_plan_updated_at: null,
  mi_deuda_status: MI_DEUDA_STATUS.NOT_INVITED,
  mi_deuda_updated_at: null,
  mi_deuda_invited_at: null,
  mi_deuda_responded_at: null,
  mi_deuda_invite_expired: false,
});
assert.deepStrictEqual(formatOutreach(undefined), defaults);

const live = formatOutreach(
  {
    ci: 111,
    mi_plan_status: MI_PLAN_STATUS.INVITED,
    mi_plan_updated_at: '2026-08-01T00:00:00.000Z',
    mi_deuda_status: MI_DEUDA_STATUS.INVITE_SENT,
    mi_deuda_updated_at: '2026-09-01T12:00:00.000Z',
    mi_deuda_invited_at: invitedAt,
    mi_deuda_responded_at: null,
  },
  invitedMs + 6 * DAY_MS,
);
assert.strictEqual(live.mi_plan_status, 'invited');
assert.strictEqual(live.mi_deuda_status, 'invite_sent');
assert.strictEqual(live.mi_deuda_invite_expired, false);

const expired = formatOutreach(
  {
    mi_plan_status: MI_PLAN_STATUS.NOT_INVITED,
    mi_deuda_status: MI_DEUDA_STATUS.INVITE_SENT,
    mi_deuda_invited_at: invitedAt,
  },
  invitedMs + 7 * DAY_MS,
);
assert.strictEqual(expired.mi_deuda_invite_expired, true);

console.log('OK unit-rejected-outreach');
