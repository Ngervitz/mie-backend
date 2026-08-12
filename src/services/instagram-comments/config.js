/**
 * Instagram comments module config (Credizona @credizonauy).
 * Token is read at call time — never via requireEnv() — so missing IG
 * credentials do not crash unrelated app boot (GA4, Activity, SMS).
 */

const IG_USER_ID =
  (process.env.IG_CREDIZONAUY_USER_ID || '27296348433398160').trim();
const GRAPH_API_VERSION = (process.env.IG_GRAPH_API_VERSION || 'v21.0').trim();
const GRAPH_BASE_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

/** Shared hourly Meta call budget for all three Instagram jobs. */
const RATE_BUDGET_BUCKET = 'instagram_credizonauy';
/** Conservative threshold: 80% of Meta's 200 calls/hour. */
const RATE_BUDGET_HOURLY_LIMIT = 160;
const RATE_BUDGET_WINDOW_SECONDS = 3600;

const MEDIA_LOOKBACK_DAYS = 60;
const COMMENT_POLL_LOOKBACK_DAYS = 60;

const JOB_NAMES = {
  postsSync: 'instagram_posts_sync',
  commentsPoll: 'instagram_comments_poll',
  replyRecovery: 'instagram_reply_recovery',
};

const JOB_LOCK_TTL_SECONDS = {
  postsSync: 30 * 60,
  commentsPoll: 10 * 60,
  replyRecovery: 10 * 60,
};

const REPLY_STUCK_MINUTES = 5;

const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32]);

function getAccessToken() {
  const token = String(process.env.IG_CREDIZONAUY_ACCESS_TOKEN || '').trim();
  return token || null;
}

/**
 * TEMP safe diagnostic for IG_CREDIZONAUY_ACCESS_TOKEN (no secret values).
 * Compares RAW env vs trimmed; never returns the token or recoverable fragments.
 */
function getIgAccessTokenDiagnostic() {
  const rawEnv = process.env.IG_CREDIZONAUY_ACCESS_TOKEN;
  if (rawEnv == null || rawEnv === '') {
    return {
      present: false,
      rawLength: 0,
      trimmedLength: 0,
      startsWithExpectedPrefix: false,
      hasLeadingWhitespace: false,
      hasTrailingWhitespace: false,
      containsSpace: false,
      containsTab: false,
      containsNewline: false,
      containsCarriageReturn: false,
      containsLiteralBackslashN: false,
      containsLiteralBackslashR: false,
      containsQuotesAtEdges: false,
      containsNonAscii: false,
    };
  }

  const raw = String(rawEnv);
  const trimmed = raw.trim();
  let containsNonAscii = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      containsNonAscii = true;
      break;
    }
  }

  return {
    present: true,
    rawLength: raw.length,
    trimmedLength: trimmed.length,
    startsWithExpectedPrefix: trimmed.startsWith('IGAA'),
    hasLeadingWhitespace: raw !== raw.trimStart(),
    hasTrailingWhitespace: raw !== raw.trimEnd(),
    containsSpace: trimmed.includes(' '),
    containsTab: trimmed.includes('\t'),
    containsNewline: trimmed.includes('\n'),
    containsCarriageReturn: trimmed.includes('\r'),
    containsLiteralBackslashN: trimmed.includes('\\n'),
    containsLiteralBackslashR: trimmed.includes('\\r'),
    containsQuotesAtEdges:
      trimmed.startsWith("'") ||
      trimmed.startsWith('"') ||
      trimmed.endsWith("'") ||
      trimmed.endsWith('"'),
    containsNonAscii,
  };
}

/**
 * True when a Meta/Graph failure looks like an access-token / OAuth problem.
 * @param {unknown} err
 */
function isIgAccessTokenAuthFailure(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'MISSING_IG_TOKEN') return true;

  const msg = String(err.message || '').toLowerCase();
  if (
    /cannot parse access token|error validating access token|invalid.?oauth|oauthexception|access token|malformed.*token|session has expired/.test(
      msg,
    )
  ) {
    return true;
  }

  const body = err.body;
  const metaErr = body && typeof body === 'object' ? body.error : null;
  if (metaErr && typeof metaErr === 'object') {
    const metaMsg = String(metaErr.message || '').toLowerCase();
    if (
      /cannot parse access token|error validating access token|invalid.?oauth|access token|malformed.*token|session has expired/.test(
        metaMsg,
      )
    ) {
      return true;
    }
    if (metaErr.type === 'OAuthException' || Number(metaErr.code) === 190) {
      return true;
    }
  }

  return false;
}

module.exports = {
  IG_USER_ID,
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
  getIgAccessTokenDiagnostic,
  isIgAccessTokenAuthFailure,
};
