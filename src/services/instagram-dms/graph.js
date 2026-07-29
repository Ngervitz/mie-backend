/**
 * Instagram DM Graph calls — graph.instagram.com only.
 * Reuses shared graphRequest/paginate + rate budget from comments module.
 */

const {
  graphRequest,
  paginate,
  InstagramGraphError,
} = require('../instagram-comments/graph-client');
const { reserveMetaApiBudget } = require('../instagram-comments/locks');
const { IG_USER_ID } = require('./config');

async function listConversations(userId = IG_USER_ID) {
  return paginate(`/${userId}/conversations`, {
    platform: 'instagram',
    fields: 'id,updated_time,participants',
    limit: '50',
  });
}

/**
 * Fetch conversation + messages via fields=messages{...}.
 * Follows messages.paging.next when present (budget reserved per page).
 */
async function getConversationWithMessages(conversationId) {
  const payload = await graphRequest(`/${conversationId}`, {
    query: {
      fields: 'id,participants,messages{id,message,from,created_time}',
    },
  });

  const messages = [];
  const first = payload && payload.messages ? payload.messages : null;
  if (first && Array.isArray(first.data)) {
    messages.push(...first.data);
  }

  let nextUrl =
    first && first.paging && typeof first.paging.next === 'string'
      ? first.paging.next
      : null;

  while (nextUrl) {
    const reserved = await reserveMetaApiBudget(1);
    if (!reserved) {
      throw new InstagramGraphError('Shared Meta API hourly budget exhausted', {
        isRateLimited: true,
        metaCode: 'budget',
      });
    }

    // next URLs from Meta already include access_token.
    let response;
    try {
      response = await fetch(nextUrl);
    } catch (netErr) {
      throw new InstagramGraphError(
        netErr && netErr.message ? netErr.message : 'Network error paging messages',
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
    if (
      response.status === 429 ||
      (errorObj && [4, 17, 32].includes(Number(errorObj.code)))
    ) {
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
          httpStatus: response.status,
          metaCode: errorObj && errorObj.code,
          body: pagePayload,
          isTransient: [408, 502, 503, 504].includes(response.status),
        },
      );
    }

    const data = Array.isArray(pagePayload.data) ? pagePayload.data : [];
    messages.push(...data);
    nextUrl =
      pagePayload.paging && typeof pagePayload.paging.next === 'string'
        ? pagePayload.paging.next
        : null;
  }

  return {
    id: payload && payload.id ? String(payload.id) : String(conversationId),
    participants: payload && payload.participants ? payload.participants : null,
    messages,
  };
}

/**
 * Send DM. recipient.id must be Instagram-scoped customer id — never conversation id.
 */
async function sendDirectMessage(recipientIgScopedId, text, userId = IG_USER_ID) {
  return graphRequest(`/${userId}/messages`, {
    method: 'POST',
    body: {
      recipient: { id: String(recipientIgScopedId) },
      message: { text: String(text) },
    },
  });
}

module.exports = {
  listConversations,
  getConversationWithMessages,
  sendDirectMessage,
  InstagramGraphError,
};
