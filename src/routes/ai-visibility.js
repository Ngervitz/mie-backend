/**
 * AI Visibility routes — weekly provider prompts + deterministic mention detection.
 * Isolated module: registered from server.js (same pattern as /email).
 * No auth on POST /run (same criterion as POST /email/process-queue).
 */

const express = require('express');
const logger = require('../lib/logger');
const supabase = require('../clients/supabase');
const {
  runWeeklyVisibilityCheck,
  runSinglePromptCheck,
} = require('../services/ai-visibility/runner');

const router = express.Router();

/**
 * GET /ai-visibility/prompts
 * Active prompts for the dashboard list.
 */
router.get('/prompts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ai_visibility_prompts')
      .select('id, text, category')
      .eq('active', true)
      .order('id', { ascending: true });

    if (error) {
      logger.error('GET /ai-visibility/prompts failed', {
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ prompts: data || [] });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /ai-visibility/prompts unexpected', { error: message });
    return res.status(500).json({ error: message });
  }
});

/**
 * GET /ai-visibility/responses
 * Latest week_of present in ai_visibility_responses + all rows for that week.
 */
router.get('/responses', async (req, res) => {
  try {
    const { data: weekRows, error: weekErr } = await supabase
      .from('ai_visibility_responses')
      .select('week_of')
      .order('week_of', { ascending: false })
      .limit(1);

    if (weekErr) {
      logger.error('GET /ai-visibility/responses week query failed', {
        error: weekErr.message,
      });
      return res.status(500).json({ error: weekErr.message });
    }

    if (
      !Array.isArray(weekRows) ||
      weekRows.length === 0 ||
      !weekRows[0].week_of
    ) {
      return res.status(200).json({ week_of: null, responses: [] });
    }

    const latestWeek = weekRows[0].week_of;

    const { data: responses, error: listErr } = await supabase
      .from('ai_visibility_responses')
      .select(
        [
          'prompt_id',
          'prompt_text_snapshot',
          'provider',
          'model_name',
          'week_of',
          'status',
          'raw_response',
          'error',
          'error_code',
          'mentions_credizona',
          'mentioned_entities',
          'fetched_at',
        ].join(','),
      )
      .eq('week_of', latestWeek)
      .order('prompt_id', { ascending: true })
      .order('provider', { ascending: true })
      .order('model_name', { ascending: true });

    if (listErr) {
      logger.error('GET /ai-visibility/responses list failed', {
        error: listErr.message,
      });
      return res.status(500).json({ error: listErr.message });
    }

    return res.status(200).json({
      week_of: latestWeek,
      responses: responses || [],
    });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /ai-visibility/responses unexpected', { error: message });
    return res.status(500).json({ error: message });
  }
});

/**
 * POST /ai-visibility/run/:promptId
 * Run all providers for a single active prompt (current Monday week).
 * Registered before POST /run so path params are unambiguous.
 */
router.post('/run/:promptId', async (req, res) => {
  const rawId = req.params.promptId;
  const promptId = Number(rawId);

  if (!Number.isInteger(promptId) || promptId <= 0) {
    return res.status(400).json({ error: 'promptId must be a positive integer' });
  }

  try {
    const summary = await runSinglePromptCheck({ promptId });
    return res.status(200).json(summary);
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    if (err && err.code === 'PROMPT_NOT_FOUND') {
      logger.warn('POST /ai-visibility/run/:promptId not found', {
        promptId,
        error: message,
      });
      return res.status(404).json({ error: message });
    }

    const isValidation =
      /week_of|YYYY-MM-DD|Monday|calendar date|promptId must be/i.test(
        message,
      );

    logger.error('POST /ai-visibility/run/:promptId failed', {
      promptId,
      error: message,
    });

    return res.status(isValidation ? 400 : 500).json({ error: message });
  }
});

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
