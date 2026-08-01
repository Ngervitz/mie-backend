/**
 * Facebook Graph API client — host graph.facebook.com ONLY.
 * Token: FB_CREDIZONAUY_PAGE_ACCESS_TOKEN (Page Access Token, EAA...).
 * Never use graph.instagram.com or IG tokens here.
 */

const {
  GRAPH_BASE_URL,
  RATE_LIMIT_ERROR_CODES,
  getAccessToken,
} = require('./config');
const { reserveMetaApiBudget } = require('./locks');

class FacebookGraphError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'FacebookGraphError';
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
    const err = new Error('FB_CREDIZONAUY_PAGE_ACCESS_TOKEN is not configured');
    err.code = 'MISSING_FB_TOKEN';
    throw err;
  }
  return token;
}

function isNotFoundPayload(httpStatus, errorObj) {
  if (httpStatus === 404) return true;
  if (!errorObj) return false;
  const code = errorObj.code;
  const msg = String(errorObj.message || '').toLowerCase();
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
      throw new FacebookGraphError('Facebook Meta API hourly budget exhausted', {
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
    throw new FacebookGraphError(
      netErr && netErr.message ? netErr.message : 'Network error calling Facebook Graph',
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
    throw new FacebookGraphError(
      (errorObj && errorObj.message) || `Facebook rate limit (HTTP ${response.status})`,
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
      `Facebook Graph error HTTP ${response.status}`;
    throw new FacebookGraphError(message, {
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
 * Follow cursor pagination. Stops on empty page even if paging.next exists.
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
      const reserved = await reserveMetaApiBudget(1);
      if (!reserved) {
        throw new FacebookGraphError('Facebook Meta API hourly budget exhausted', {
          isRateLimited: true,
          metaCode: 'budget',
        });
      }
      let response;
      try {
        response = await fetch(nextUrl);
      } catch (netErr) {
        throw new FacebookGraphError(
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
        throw new FacebookGraphError(
          (errorObj && errorObj.message) || `Facebook rate limit (HTTP ${response.status})`,
          {
            isRateLimited: true,
            httpStatus: response.status,
            metaCode: errorObj && errorObj.code,
            body: pagePayload,
          },
        );
      }
      if (!response.ok || errorObj) {
        throw new FacebookGraphError(
          (errorObj && errorObj.message) || `Facebook Graph error HTTP ${response.status}`,
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

    if (data.length === 0) {
      break;
    }

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

/**
 * List Page feed posts. Feed is typically newest-first; stop past lookback.
 */
async function listFeed({ pageId, fields, untilTimestampMs }) {
  return paginate(
    `/${pageId}/feed`,
    {
      fields: fields || 'id,message,created_time,permalink_url',
      limit: '50',
    },
    {
      shouldStop(_payload, pageData) {
        if (untilTimestampMs == null) return false;
        if (!pageData.length) return false;
        const oldest = pageData[pageData.length - 1];
        if (!oldest || !oldest.created_time) return false;
        const ts = Date.parse(oldest.created_time);
        return Number.isFinite(ts) && ts < untilTimestampMs;
      },
    },
  );
}

async function listTopLevelComments(postId) {
  // No documented chronological guarantee — paginate fully.
  return paginate(`/${postId}/comments`, {
    fields: 'id,message,from,created_time',
    limit: '50',
  });
}

/**
 * Nested comments under a comment (= Instagram /replies equivalent).
 */
async function listNestedComments(commentId) {
  return paginate(`/${commentId}/comments`, {
    fields: 'id,message,from,created_time',
    limit: '50',
  });
}

async function postCommentReply(commentId, message) {
  // Facebook Graph: POST /{comment-id}/comments with message.
  return graphRequest(`/${commentId}/comments`, {
    method: 'POST',
    query: { message },
  });
}

module.exports = {
  FacebookGraphError,
  requireToken,
  graphRequest,
  paginate,
  listFeed,
  listTopLevelComments,
  listNestedComments,
  postCommentReply,
  isRateLimitedResponse,
  isNotFoundPayload,
};
