/**
 * MetaDash Instagram comment replies.
 * POST /api/social-comments/:id/reply
 */

const express = require('express');
const logger = require('../lib/logger');
const { getAccessToken } = require('../services/instagram-comments/config');
const { runReplyFlow } = require('../services/instagram-comments/reply-flow');

const router = express.Router();

router.post('/:id/reply', async (req, res) => {
  if (!getAccessToken()) {
    return res.status(503).json({
      error: 'IG_CREDIZONAUY_ACCESS_TOKEN is not configured',
      code: 'MISSING_IG_TOKEN',
    });
  }

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
    const result = await runReplyFlow({
      commentId,
      replyText,
      repliedBy,
      skipOptimisticLock: false,
    });
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
