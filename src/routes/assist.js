'use strict';

const express = require('express');
const logger = require('../lib/logger');
const { runAssistTurn } = require('../assist/engine');
const { resolveAssistAnthropicConfig } = require('../assist/anthropicClient');
const { isValidCronKey } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /assist/chat
 * Body: { message, conversationHistory?, debug?, conversationId?, forceToolError? }
 * No conversation persistence. History is client-supplied.
 * conversationId is a session UUID for logs/memories only — not a chat thread.
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
  // Harness-only: cron key + debug + forceToolError. Session dashboard users
  // cannot trigger this even if they send the body field.
  const forceToolError =
    debug === true && body.forceToolError === true && isValidCronKey(req);

  logger.info('POST /assist/chat', {
    historyItems: conversationHistory.length,
    debug,
    forceToolError,
  });

  try {
    const result = await runAssistTurn({
      message,
      conversationHistory,
      conversationId: body.conversationId,
      forceToolError,
    });
    const payload = {
      reply: result.reply,
      stopReason: result.stopReason,
      conversationId: result.conversationId,
    };
    if (debug) {
      payload.toolExecutions = result.toolExecutions;
      payload.rounds = result.rounds;
      payload.toolRoundsUsed = result.toolRoundsUsed;
      payload.toolExecutionsUsed = result.toolExecutionsUsed;
      payload.budgetEvents = result.budgetEvents;
      payload.turnNumber = result.turnNumber;
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
