/**
 * Instagram Graph API client — host graph.instagram.com ONLY.
 * Token: IG_CREDIZONAUY_ACCESS_TOKEN (Instagram Business Login, IGAA...).
 * Never use graph.facebook.com or Page Access Tokens (EAA...) here.
 */

const {
  GRAPH_BASE_URL,
  RATE_LIMIT_ERROR_CODES,
  getAccessToken,
} = require('./config');
const { reserveMetaApiBudget } = require('./locks');

class InstagramGraphError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'InstagramGraphError';
    this.isRateLimited = Boolean(opts.isRateLimited);
    this.isNotFound = Boolean(opts.isNotFound);
    this.isTransient = Boolean(opts.isTransient);
    this.httpStatus = opts.httpStatus || null;
    this.metaCode = opts.metaCode != null ? opts.metaCode : null;
    this.body = opts.body || null;
  }
}

function requireToken() {
  const token = getAccessToken();
  if (!token) {
    const err = new Error('IG_CREDIZONAUY_ACCESS_TOKEN is not configured');
    err.code = 'MISSING_IG_TOKEN';
    throw err;
  }
  return token;
}

function isNotFoundPayload(httpStatus, errorObj) {
  if (httpStatus === 404) return true;
  if (!errorObj) return false;
  const code = errorObj.code;
  const msg = String(errorObj.message || '').toLowerCase();
  // Common Meta "object gone / unsupported get" signals.
  if (code === 100 && /does not exist|unsupported get request|invalid.*id/i.test(msg)) {
    return true;
  }
  if (/does not exist|cannot be loaded|object.*not.*found/i.test(msg)) {
    return true;
  }
  return false;
}

function isRateLimitedResponse(httpStatus, errorObj) {
  if (httpStatus === 429) return true;
  if (!errorObj) return false;
  if (RATE_LIMIT_ERROR_CODES.has(Number(errorObj.code))) return true;
  const msg = String(errorObj.message || '').toLowerCase();
  if (/rate limit|user request limit|application request limit/i.test(msg)) {
    return true;
  }
  return false;
}

function isTransientHttp(httpStatus) {
  return httpStatus === 408 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504;
}

/**
 * @param {string} path - path beginning with / (relative to GRAPH_BASE_URL)
 * @param {{ method?: string, query?: Record<string,string>, body?: object, reserveBudget?: boolean }} options
 */
async function graphRequest(path, options = {}) {
  const {
    method = 'GET',
    query = {},
    body = null,
    reserveBudget = true,
  } = options;

  if (reserveBudget) {
    const reserved = await reserveMetaApiBudget(1);
    if (!reserved) {
      throw new InstagramGraphError('Shared Meta API hourly budget exhausted', {
        isRateLimited: true,
        metaCode: 'budget',
      });
    }
  }

  const token = requireToken();
  const url = new URL(`${GRAPH_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }
  url.searchParams.set('access_token', token);

  const fetchOpts = { method, headers: {} };
  if (body != null) {
    fetchOpts.headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url.toString(), fetchOpts);
  } catch (netErr) {
    throw new InstagramGraphError(
      netErr && netErr.message ? netErr.message : 'Network error calling Instagram Graph',
      { isTransient: true },
    );
  }

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  const errorObj = payload && payload.error ? payload.error : null;

  if (isRateLimitedResponse(response.status, errorObj)) {
    throw new InstagramGraphError(
      (errorObj && errorObj.message) || `Instagram rate limit (HTTP ${response.status})`,
      {
        isRateLimited: true,
        httpStatus: response.status,
        metaCode: errorObj && errorObj.code,
        body: payload,
      },
    );
  }

  if (!response.ok || errorObj) {
    const message =
      (errorObj && errorObj.message) ||
      `Instagram Graph error HTTP ${response.status}`;
    throw new InstagramGraphError(message, {
      isNotFound: isNotFoundPayload(response.status, errorObj),
      isTransient: isTransientHttp(response.status),
      httpStatus: response.status,
      metaCode: errorObj && errorObj.code,
      body: payload,
    });
  }

  return payload;
}

/**
 * Follow cursor pagination. Calls onPage(dataArray) for each page.
 * Stops when next is missing or shouldStop(pagePayload) returns true.
 * @returns {{ pages: number, items: array }}
 */
async function paginate(path, query, { shouldStop } = {}) {
  const items = [];
  let pages = 0;
  let nextUrl = null;
  let first = true;

  while (true) {
    let payload;
    if (first) {
      first = false;
      payload = await graphRequest(path, { query });
    } else if (nextUrl) {
      // Cursor URLs from Meta already include access_token; still reserve budget.
      const reserved = await reserveMetaApiBudget(1);
      if (!reserved) {
        throw new InstagramGraphError('Shared Meta API hourly budget exhausted', {
          isRateLimited: true,
          metaCode: 'budget',
        });
      }
      let response;
      try {
        response = await fetch(nextUrl);
      } catch (netErr) {
        throw new InstagramGraphError(
          netErr && netErr.message ? netErr.message : 'Network error during pagination',
          { isTransient: true },
        );
      }
      const text = await response.text();
      let pagePayload = null;
      try {
        pagePayload = text ? JSON.parse(text) : null;
      } catch {
        pagePayload = { raw: text };
      }
      const errorObj = pagePayload && pagePayload.error ? pagePayload.error : null;
      if (isRateLimitedResponse(response.status, errorObj)) {
        throw new InstagramGraphError(
          (errorObj && errorObj.message) || `Instagram rate limit (HTTP ${response.status})`,
          {
            isRateLimited: true,
            httpStatus: response.status,
            metaCode: errorObj && errorObj.code,
            body: pagePayload,
          },
        );
      }
      if (!response.ok || errorObj) {
        throw new InstagramGraphError(
          (errorObj && errorObj.message) || `Instagram Graph error HTTP ${response.status}`,
          {
            isNotFound: isNotFoundPayload(response.status, errorObj),
            isTransient: isTransientHttp(response.status),
            httpStatus: response.status,
            metaCode: errorObj && errorObj.code,
            body: pagePayload,
          },
        );
      }
      payload = pagePayload;
    } else {
      break;
    }

    pages += 1;
    const data = Array.isArray(payload.data) ? payload.data : [];
    items.push(...data);

    if (typeof shouldStop === 'function' && shouldStop(payload, data, items)) {
      break;
    }

    nextUrl =
      payload.paging && typeof payload.paging.next === 'string'
        ? payload.paging.next
        : null;
    if (!nextUrl) break;
  }

  return { pages, items };
}

async function listMedia({ userId, fields, untilTimestampMs }) {
  // Media is returned newest-first; stop once we pass the lookback window.
  return paginate(
    `/${userId}/media`,
    {
      fields: fields || 'id,caption,media_type,permalink,timestamp',
      limit: '50',
    },
    {
      shouldStop(_payload, pageData) {
        if (untilTimestampMs == null) return false;
        if (!pageData.length) return false;
        const oldest = pageData[pageData.length - 1];
        if (!oldest || !oldest.timestamp) return false;
        const ts = Date.parse(oldest.timestamp);
        return Number.isFinite(ts) && ts < untilTimestampMs;
      },
    },
  );
}

async function listTopLevelComments(mediaId) {
  // No documented chronological guarantee for early-stop by last_comment_id —
  // paginate until Meta has no more pages.
  return paginate(`/${mediaId}/comments`, {
    fields: 'id,text,username,timestamp,from',
    limit: '50',
  });
}

async function listReplies(commentId) {
  return paginate(`/${commentId}/replies`, {
    fields: 'id,text,username,timestamp,from',
    limit: '50',
  });
}

async function postReply(commentId, message) {
  // Instagram Graph: POST /{comment-id}/replies with message query/body.
  return graphRequest(`/${commentId}/replies`, {
    method: 'POST',
    query: { message },
  });
}

module.exports = {
  InstagramGraphError,
  requireToken,
  graphRequest,
  paginate,
  listMedia,
  listTopLevelComments,
  listReplies,
  postReply,
  isRateLimitedResponse,
  isNotFoundPayload,
};
