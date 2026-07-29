/**
 * Shared Instagram comment reply flow (MetaDash + recovery job).
 * Always reconciles GET /{comment-id}/replies before any publish.
 */

const supabase = require('../../clients/supabase');
const logger = require('../../lib/logger');
const { listReplies, postReply, InstagramGraphError } = require('./graph-client');

/**
 * @typedef {'published'|'already_replied'|'deleted'|'conflict'|'meta_error'|'transient_error'} ReplyOutcome
 */

/**
 * Optimistic lock pending → replying. Returns the row or null.
 */
async function acquireReplyLock(commentId) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('social_comments')
    .update({
      status: 'replying',
      reply_started_at: now,
      reply_error: null,
    })
    .eq('id', commentId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`acquireReplyLock failed: ${error.message}`);
  }
  return data || null;
}

async function markDeleted(commentId) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('social_comments')
    .update({
      is_deleted: true,
      deleted_at: now,
      status: 'ignored',
      reply_started_at: null,
      last_checked_at: now,
      reply_error: null,
    })
    .eq('id', commentId);
  if (error) throw new Error(`markDeleted failed: ${error.message}`);
}

async function markAlreadyReplied(commentId, reply) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('social_comments')
    .update({
      status: 'replied',
      reply_source: 'instagram',
      replied_text: reply.text != null ? String(reply.text) : null,
      ig_reply_id: reply.id ? String(reply.id) : null,
      replied_at: reply.timestamp
        ? new Date(reply.timestamp).toISOString()
        : now,
      replied_by: 'external:instagram',
      reply_started_at: null,
      last_checked_at: now,
      reply_error: null,
    })
    .eq('id', commentId);
  if (error) throw new Error(`markAlreadyReplied failed: ${error.message}`);
}

async function markPublished(commentId, { replyText, repliedBy, igReplyId }) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('social_comments')
    .update({
      status: 'replied',
      reply_source: 'metadash',
      replied_text: replyText,
      ig_reply_id: igReplyId,
      replied_by: repliedBy,
      replied_at: now,
      reply_attempted_at: now,
      last_checked_at: now,
      reply_started_at: null,
      reply_error: null,
    })
    .eq('id', commentId);
  if (error) throw new Error(`markPublished failed: ${error.message}`);
}

async function revertToPending(commentId, replyError) {
  const { error } = await supabase
    .from('social_comments')
    .update({
      status: 'pending',
      reply_error: replyError ? String(replyError).slice(0, 2000) : null,
      reply_started_at: null,
    })
    .eq('id', commentId);
  if (error) throw new Error(`revertToPending failed: ${error.message}`);
}

/**
 * Core reply flow used by POST /api/social-comments/:id/reply and recovery.
 *
 * @param {object} opts
 * @param {number|string} opts.commentId
 * @param {string|null} opts.replyText - required to publish; recovery may omit
 * @param {string|null} opts.repliedBy
 * @param {boolean} [opts.skipOptimisticLock=false] - recovery: already 'replying'
 * @param {object} [opts.commentRow] - optional preloaded row
 */
async function runReplyFlow(opts) {
  const {
    commentId,
    replyText = null,
    repliedBy = null,
    skipOptimisticLock = false,
    commentRow = null,
  } = opts;

  let row = commentRow;

  if (!skipOptimisticLock) {
    row = await acquireReplyLock(commentId);
    if (!row) {
      return {
        outcome: 'conflict',
        httpStatus: 409,
        body: { error: 'Comment is not pending (already replying, replied, or ignored)' },
      };
    }
  } else if (!row) {
    const { data, error } = await supabase
      .from('social_comments')
      .select('*')
      .eq('id', commentId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    row = data;
    if (!row) {
      return {
        outcome: 'conflict',
        httpStatus: 404,
        body: { error: 'Comment not found' },
      };
    }
  }

  const igCommentId = row.ig_comment_id;

  // --- Step 2: always reconcile /replies first (no exceptions) ---
  let repliesResult;
  try {
    repliesResult = await listReplies(igCommentId);
  } catch (err) {
    if (err instanceof InstagramGraphError && err.isNotFound) {
      await markDeleted(commentId);
      return {
        outcome: 'deleted',
        httpStatus: 410,
        body: {
          ok: false,
          deleted: true,
          message: 'Comment was deleted or is no longer accessible on Instagram',
        },
      };
    }

    if (
      err instanceof InstagramGraphError &&
      (err.isTransient || err.isRateLimited)
    ) {
      await revertToPending(
        commentId,
        err.message || 'Transient error during reply reconciliation',
      );
      return {
        outcome: 'transient_error',
        httpStatus: 502,
        rateLimited: Boolean(err.isRateLimited),
        body: {
          ok: false,
          error: err.message,
          statusReverted: 'pending',
        },
      };
    }

    // Unknown Meta/network failure during reconcile — do not leave stuck in replying.
    await revertToPending(
      commentId,
      err && err.message ? err.message : 'Reconciliation failed',
    );
    return {
      outcome: 'meta_error',
      httpStatus: 502,
      body: {
        ok: false,
        error: err && err.message ? err.message : 'Reconciliation failed',
        statusReverted: 'pending',
      },
    };
  }

  const existingReplies = repliesResult.items || [];
  if (existingReplies.length > 0) {
    // Prefer the earliest reply as the "existing" answer.
    const sorted = [...existingReplies].sort((a, b) => {
      const ta = Date.parse(a.timestamp || 0) || 0;
      const tb = Date.parse(b.timestamp || 0) || 0;
      return ta - tb;
    });
    await markAlreadyReplied(commentId, sorted[0]);
    return {
      outcome: 'already_replied',
      httpStatus: 200,
      body: {
        ok: true,
        alreadyReplied: true,
        replySource: 'instagram',
        igReplyId: sorted[0].id || null,
        repliedText: sorted[0].text || null,
      },
    };
  }

  // Recovery without replyText: cannot publish — revert so MetaDash can retry.
  if (!replyText || !String(replyText).trim()) {
    await revertToPending(commentId, 'Recovery: no reply found on Meta; reverted for retry');
    return {
      outcome: 'reverted',
      httpStatus: 200,
      body: {
        ok: true,
        recovered: true,
        status: 'pending',
        message: 'No existing reply on Meta; status reverted to pending',
      },
    };
  }

  // --- Step 3: publish ---
  let publishResult;
  try {
    publishResult = await postReply(igCommentId, String(replyText).trim());
  } catch (err) {
    if (err instanceof InstagramGraphError && err.isNotFound) {
      await markDeleted(commentId);
      return {
        outcome: 'deleted',
        httpStatus: 410,
        body: {
          ok: false,
          deleted: true,
          message: 'Comment was deleted or is no longer accessible on Instagram',
        },
      };
    }

    await revertToPending(
      commentId,
      err && err.message ? err.message : 'Publish failed',
    );
    return {
      outcome: err instanceof InstagramGraphError && err.isRateLimited
        ? 'transient_error'
        : 'meta_error',
      httpStatus: 502,
      rateLimited: Boolean(err instanceof InstagramGraphError && err.isRateLimited),
      body: {
        ok: false,
        error: err && err.message ? err.message : 'Publish failed',
        statusReverted: 'pending',
      },
    };
  }

  const igReplyId =
    (publishResult && (publishResult.id || publishResult.reply_id)) || null;

  await markPublished(commentId, {
    replyText: String(replyText).trim(),
    repliedBy: repliedBy || null,
    igReplyId: igReplyId ? String(igReplyId) : null,
  });

  logger.info('Instagram reply published', {
    commentId,
    igCommentId,
    igReplyId,
    repliedBy,
  });

  return {
    outcome: 'published',
    httpStatus: 200,
    body: {
      ok: true,
      alreadyReplied: false,
      replySource: 'metadash',
      igReplyId,
      repliedText: String(replyText).trim(),
    },
  };
}

module.exports = {
  runReplyFlow,
  acquireReplyLock,
  markDeleted,
  markAlreadyReplied,
  markPublished,
  revertToPending,
};
