/**
 * MetaDash social comment replies + list (Instagram + Facebook).
 * GET  /api/social-comments?status=pending&limit=&offset=
 * POST /api/social-comments/:id/reply  — dispatches by comment.platform
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { getAccessToken: getIgAccessToken } = require('../services/instagram-comments/config');
const { runReplyFlow: runIgReplyFlow } = require('../services/instagram-comments/reply-flow');
const { getAccessToken: getFbAccessToken } = require('../services/facebook-comments/config');
const { runReplyFlow: runFbReplyFlow } = require('../services/facebook-comments/reply-flow');

const router = express.Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parsePaging(query) {
  const limitRaw = parseInt(String(query.limit || DEFAULT_LIMIT), 10);
  const offsetRaw = parseInt(String(query.offset || '0'), 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
  return { limit, offset };
}

/**
 * List comments. Default status=pending.
 * Order: pending first (when mixed), then comment_timestamp desc.
 */
router.get('/', async (req, res) => {
  const statusRaw =
    typeof req.query.status === 'string' ? req.query.status.trim() : 'pending';
  const { limit, offset } = parsePaging(req.query);

  try {
    let q = supabase
      .from('social_comments')
      .select(
        'id, social_media_post_id, platform, ig_comment_id, ig_media_id, from_username, from_ig_user_id, text, comment_timestamp, status, reply_source, replied_text, ig_reply_id, replied_by, replied_at, is_deleted, fetched_at, created_at, updated_at',
        { count: 'exact' },
      )
      .eq('is_deleted', false);

    if (statusRaw && statusRaw !== 'all') {
      q = q.eq('status', statusRaw);
    }

    // pending first when listing mixed statuses; always newest comments next.
    if (!statusRaw || statusRaw === 'all') {
      q = q
        .order('status', { ascending: true })
        .order('comment_timestamp', { ascending: false });
    } else if (statusRaw === 'pending') {
      q = q.order('comment_timestamp', { ascending: false });
    } else {
      q = q.order('comment_timestamp', { ascending: false });
    }

    const { data, error, count } = await q.range(offset, offset + limit - 1);

    if (error) {
      logger.error('GET /api/social-comments failed', { error: error.message });
      return res.status(500).json({ error: error.message });
    }

    const comments = data || [];
    return res.json({
      comments,
      limit,
      offset,
      total: typeof count === 'number' ? count : comments.length,
      hasMore:
        typeof count === 'number'
          ? offset + comments.length < count
          : comments.length === limit,
    });
  } catch (err) {
    logger.error('GET /api/social-comments unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

router.post('/:id/reply', async (req, res) => {
  const idRaw = req.params.id;
  const commentId = Number(idRaw);
  if (!Number.isFinite(commentId) || commentId < 1) {
    return res.status(400).json({ error: 'Invalid comment id' });
  }

  const replyText =
    req.body && typeof req.body.replyText === 'string'
      ? req.body.replyText.trim()
      : '';
  const repliedBy =
    req.body && typeof req.body.repliedBy === 'string'
      ? req.body.repliedBy.trim()
      : '';

  if (!replyText) {
    return res.status(400).json({ error: 'replyText is required' });
  }
  if (!repliedBy) {
    return res.status(400).json({ error: 'repliedBy is required' });
  }

  logger.info('POST /api/social-comments/:id/reply', {
    commentId,
    repliedBy,
  });

  try {
    const { data: commentRow, error: loadErr } = await supabase
      .from('social_comments')
      .select('*')
      .eq('id', commentId)
      .maybeSingle();

    if (loadErr) {
      return res.status(500).json({ error: loadErr.message });
    }
    if (!commentRow) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const platform = commentRow.platform;
    let result;

    if (platform === 'facebook') {
      if (!getFbAccessToken()) {
        return res.status(503).json({
          error: 'FB_CREDIZONAUY_PAGE_ACCESS_TOKEN is not configured',
          code: 'MISSING_FB_TOKEN',
        });
      }
      result = await runFbReplyFlow({
        commentId,
        replyText,
        repliedBy,
        skipOptimisticLock: false,
        commentRow,
      });
    } else if (platform === 'instagram') {
      if (!getIgAccessToken()) {
        return res.status(503).json({
          error: 'IG_CREDIZONAUY_ACCESS_TOKEN is not configured',
          code: 'MISSING_IG_TOKEN',
        });
      }
      result = await runIgReplyFlow({
        commentId,
        replyText,
        repliedBy,
        skipOptimisticLock: false,
        commentRow,
      });
    } else {
      return res.status(400).json({
        error: `Unsupported comment platform: ${platform || 'unknown'}`,
      });
    }

    return res.status(result.httpStatus).json(result.body);
  } catch (err) {
    logger.error('social-comments reply failed', {
      commentId,
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

module.exports = router;
