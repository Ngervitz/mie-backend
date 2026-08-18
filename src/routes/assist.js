'use strict';

const express = require('express');
const logger = require('../lib/logger');
const { runAssistTurn } = require('../assist/engine');
const { resolveAssistAnthropicConfig } = require('../assist/anthropicClient');

const router = express.Router();

/**
 * POST /assist/chat
 * Body: { message, conversationHistory?, debug? }
 * No conversation persistence. History is client-supplied.
 */
router.post('/chat', async (req, res) => {
  const cfg = resolveAssistAnthropicConfig();
  if (!cfg) {
    return res.status(503).json({
      error: 'Assist no está configurado (falta ANTHROPIC_API_KEY)',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const message = body.message;
  const conversationHistory = Array.isArray(body.conversationHistory)
    ? body.conversationHistory
    : [];
  const debug = body.debug === true;
  const forceToolError =
    debug === true &&
    body.forceToolError === true &&
    String(process.env.ASSIST_ALLOW_FORCE_TOOL_ERROR || '').toLowerCase() ===
      'true';

  logger.info('POST /assist/chat', {
    historyItems: conversationHistory.length,
    debug,
    forceToolError,
  });

  try {
    const result = await runAssistTurn({
      message,
      conversationHistory,
      forceToolError,
    });
    const payload = {
      reply: result.reply,
      stopReason: result.stopReason,
    };
    if (debug) {
      payload.toolExecutions = result.toolExecutions;
      payload.rounds = result.rounds;
    }
    return res.status(200).json(payload);
  } catch (err) {
    const statusCode =
      err && err.statusCode ? err.statusCode : err && err.code === 'INVALID_MESSAGE' ? 400 : 502;
    const messageText = err && err.message ? err.message : 'Assist failed';
    logger.error('POST /assist/chat failed', {
      error: messageText,
      code: err && err.code ? err.code : null,
    });
    return res.status(statusCode).json({
      error: statusCode === 400 ? messageText : 'Failed to run Assist',
      code: err && err.code ? err.code : null,
    });
  }
});

module.exports = router;
