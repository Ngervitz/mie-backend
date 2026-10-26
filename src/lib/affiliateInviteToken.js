'use strict';

/**
 * Invite token helpers (pure + crypto). Raw token never stored or logged.
 */

const crypto = require('crypto');

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const INVITE_STATUSES = Object.freeze(['issued', 'consumed', 'revoked', 'expired']);

function hashInviteToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
}

function generateRawInviteToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * @param {number} ci
 * @param {string|Date} now
 */
function inviteExpiresAt(now) {
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  return new Date(t + INVITE_TTL_MS).toISOString();
}

/**
 * @param {object} row
 * @param {string|Date} now
 */
function isInviteTokenUsable(row, now) {
  if (!row) return false;
  if (row.status !== 'issued') return false;
  const expires = Date.parse(String(row.expires_at));
  const t = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(expires) || !Number.isFinite(t)) return false;
  return t < expires;
}

module.exports = {
  INVITE_TTL_MS,
  TOKEN_BYTES,
  INVITE_STATUSES,
  hashInviteToken,
  generateRawInviteToken,
  inviteExpiresAt,
  isInviteTokenUsable,
};
