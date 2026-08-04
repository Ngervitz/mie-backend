/**
 * AI Visibility routes — weekly provider prompts + deterministic mention detection.
 * Isolated module: registered from server.js (same pattern as /email).
 * No auth on POST /run (same criterion as POST /email/process-queue).
 */

const express = require('express');
const logger = require('../lib/logger');
const { runWeeklyVisibilityCheck } = require('../services/ai-visibility/runner');

const router = express.Router();

/**
 * POST /ai-visibility/run
 * Body optional: { "week_of": "YYYY-MM-DD" } (must be a Monday if provided)
 */
router.post('/run', async (req, res) => {
  const body = req.body;

  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }

  const payload = body && typeof body === 'object' ? body : {};
  const keys = Object.keys(payload);
  for (const key of keys) {
    if (key !== 'week_of') {
      return res.status(400).json({
        error: 'Only optional field "week_of" is accepted',
      });
    }
  }

  const weekOf =
    payload.week_of === undefined ? undefined : payload.week_of;

  if (weekOf !== undefined && typeof weekOf !== 'string') {
    return res.status(400).json({ error: 'week_of must be a string when provided' });
  }

  try {
    const summary = await runWeeklyVisibilityCheck(
      weekOf === undefined ? {} : { weekOf },
    );
    return res.status(200).json(summary);
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    const isValidation =
      /week_of|YYYY-MM-DD|Monday|calendar date/i.test(message);

    logger.error('POST /ai-visibility/run failed', {
      error: message,
    });

    return res.status(isValidation ? 400 : 500).json({ error: message });
  }
});

module.exports = router;
