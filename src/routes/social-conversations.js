/**
 * MetaDash Instagram DMs.
 * POST /api/social-conversations/:id/send
 */

const express = require('express');
const logger = require('../lib/logger');
const { getAccessToken } = require('../services/instagram-dms/config');
const { runSendFlow } = require('../services/instagram-dms/send-flow');

const router = express.Router();

router.post('/:id/send', async (req, res) => {
  if (!getAccessToken()) {
    return res.status(503).json({
      error: 'IG_CREDIZONAUY_ACCESS_TOKEN is not configured',
      code: 'MISSING_IG_TOKEN',
    });
  }

  const conversationId = Number(req.params.id);
  if (!Number.isFinite(conversationId) || conversationId < 1) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }

  const messageText =
    req.body && typeof req.body.messageText === 'string'
      ? req.body.messageText.trim()
      : '';
  const sentBy =
    req.body && typeof req.body.sentBy === 'string'
      ? req.body.sentBy.trim()
      : '';
  const guardrailConfirmed = Boolean(
    req.body && req.body.guardrailConfirmed === true,
  );

  if (!messageText) {
    return res.status(400).json({ error: 'messageText is required' });
  }
  if (!sentBy) {
    return res.status(400).json({ error: 'sentBy is required' });
  }

  logger.info('POST /api/social-conversations/:id/send', {
    conversationId,
    sentBy,
    guardrailConfirmed,
  });

  try {
    const result = await runSendFlow({
      conversationId,
      messageText,
      sentBy,
      guardrailConfirmed,
    });
    return res.status(result.httpStatus).json(result.body);
  } catch (err) {
    logger.error('social-conversations send failed', {
      conversationId,
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

module.exports = router;
