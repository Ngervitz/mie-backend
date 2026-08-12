/**
 * Instagram DMs module helpers.
 * Reuses comments-module token + shared rate budget (bucket instagram_credizonauy).
 * Does not touch social_comments / social_media_posts.
 */

const { IG_USER_ID, getAccessToken, getIgAccessTokenDiagnostic, isIgAccessTokenAuthFailure } = require('../instagram-comments/config');

/** Job lock name for DM sync. */
const DMS_SYNC_JOB_NAME = 'instagram_dms_sync';
const DMS_SYNC_LOCK_TTL_SECONDS = 10 * 60;

/** Send lock TTL for POST /api/social-conversations/:id/send */
const SEND_LOCK_TTL_SECONDS = 120;

/** 24h messaging window from last inbound (v1 — no Human Agent 7d). */
const RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** response_window_status flips to expiring when <= 2h remain. */
const EXPIRING_THRESHOLD_MS = 2 * 60 * 60 * 1000;

module.exports = {
  IG_USER_ID,
  getAccessToken,
  getIgAccessTokenDiagnostic,
  isIgAccessTokenAuthFailure,
  DMS_SYNC_JOB_NAME,
  DMS_SYNC_LOCK_TTL_SECONDS,
  SEND_LOCK_TTL_SECONDS,
  RESPONSE_WINDOW_MS,
  EXPIRING_THRESHOLD_MS,
};
