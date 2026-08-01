/**
 * Facebook Page comment reply flow (MetaDash + recovery job).
 * Always reconciles GET /{comment-id}/comments before any publish.
 */

const supabase = require('../../clients/supabase');
const logger = require('../../lib/logger');
const {
  listNestedComments,
  postCommentReply,
  FacebookGraphError,
} = require('./graph-client');

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
      reply_source: 'facebook',
      replied_text: reply.text != null ? String(reply.text) : null,
      ig_reply_id: reply.id ? String(reply.id) : null,
      replied_at: reply.timestamp
        ? new Date(reply.timestamp).toISOString()
        : now,
      replied_by: 'external:facebook',
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
 * @param {string|null} opts.replyText
 * @param {string|null} opts.repliedBy
 * @param {boolean} [opts.skipOptimisticLock=false]
 * @param {object} [opts.commentRow]
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

  if (row.platform && row.platform !== 'facebook') {
    await revertToPending(commentId, 'Wrong platform for Facebook reply flow');
    return {
      outcome: 'conflict',
      httpStatus: 400,
      body: { error: 'Comment platform is not facebook' },
    };
  }

  const fbCommentId = row.ig_comment_id;

  // --- Step 2: always reconcile nested /comments first (no exceptions) ---
  let repliesResult;
  try {
    repliesResult = await listNestedComments(fbCommentId);
  } catch (err) {
    if (err instanceof FacebookGraphError && err.isNotFound) {
      await markDeleted(commentId);
      return {
        outcome: 'deleted',
        httpStatus: 410,
        body: {
          ok: false,
          deleted: true,
          message: 'Comment was deleted or is no longer accessible on Facebook',
        },
      };
    }

    if (
      err instanceof FacebookGraphError &&
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

  const existingReplies = (repliesResult.items || []).map((r) => ({
    id: r.id,
    text: r.message != null ? r.message : null,
    timestamp: r.created_time || null,
  }));

  if (existingReplies.length > 0) {
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
        replySource: 'facebook',
        igReplyId: sorted[0].id || null,
        repliedText: sorted[0].text || null,
      },
    };
  }

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
    publishResult = await postCommentReply(fbCommentId, String(replyText).trim());
  } catch (err) {
    if (err instanceof FacebookGraphError && err.isNotFound) {
      await markDeleted(commentId);
      return {
        outcome: 'deleted',
        httpStatus: 410,
        body: {
          ok: false,
          deleted: true,
          message: 'Comment was deleted or is no longer accessible on Facebook',
        },
      };
    }

    await revertToPending(
      commentId,
      err && err.message ? err.message : 'Publish failed',
    );
    return {
      outcome: err instanceof FacebookGraphError && err.isRateLimited
        ? 'transient_error'
        : 'meta_error',
      httpStatus: 502,
      rateLimited: Boolean(err instanceof FacebookGraphError && err.isRateLimited),
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

  logger.info('Facebook reply published', {
    commentId,
    fbCommentId,
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
