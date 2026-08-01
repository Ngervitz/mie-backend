/**
 * Facebook Page comments module (Credizona Page).
 * Token is read at call time — never via requireEnv() — so missing FB
 * credentials do not crash unrelated app boot.
 */

const FB_PAGE_ID =
  (process.env.FB_CREDIZONAUY_PAGE_ID || '106598160812283').trim();
const GRAPH_API_VERSION = (process.env.FB_GRAPH_API_VERSION || 'v21.0').trim();
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** Dedicated hourly Meta call budget — separate from Instagram. */
const RATE_BUDGET_BUCKET = 'facebook_credizona';
/** Conservative threshold: 80% of Meta's 200 calls/hour. */
const RATE_BUDGET_HOURLY_LIMIT = 160;
const RATE_BUDGET_WINDOW_SECONDS = 3600;

const MEDIA_LOOKBACK_DAYS = 60;
const COMMENT_POLL_LOOKBACK_DAYS = 60;

const JOB_NAMES = {
  postsSync: 'facebook_posts_sync',
  commentsPoll: 'facebook_comments_poll',
  replyRecovery: 'facebook_reply_recovery',
};

const JOB_LOCK_TTL_SECONDS = {
  postsSync: 30 * 60,
  commentsPoll: 10 * 60,
  replyRecovery: 10 * 60,
};

const REPLY_STUCK_MINUTES = 5;

const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32]);

function getAccessToken() {
  const token = (process.env.FB_CREDIZONAUY_PAGE_ACCESS_TOKEN || '').trim();
  return token || null;
}

module.exports = {
  FB_PAGE_ID,
  GRAPH_API_VERSION,
  GRAPH_BASE_URL,
  RATE_BUDGET_BUCKET,
  RATE_BUDGET_HOURLY_LIMIT,
  RATE_BUDGET_WINDOW_SECONDS,
  MEDIA_LOOKBACK_DAYS,
  COMMENT_POLL_LOOKBACK_DAYS,
  JOB_NAMES,
  JOB_LOCK_TTL_SECONDS,
  REPLY_STUCK_MINUTES,
  RATE_LIMIT_ERROR_CODES,
  getAccessToken,
};
