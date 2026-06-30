const express = require('express');
const { runHugo } = require('../services/hugo-brain');
const { generateVoiceBrief } = require('../services/hugo-voice');
const { askHugo } = require('../services/hugo-ask');
const { handleOpenAiChatCompletion, streamOpenAiChatCompletion } = require('../services/hugo-openai');
const { startAvatarSession, keepAliveAvatarSession, stopAvatarSession } = require('../services/hugo-avatar');
const { loadDailyKnowledge } = require('../services/daily-knowledge');
const { isValidDateOnly, todayUtc } = require('./reports');
const logger = require('../lib/logger');

const router = express.Router();

router.post('/run', async (req, res) => {
  const rawDate = req.body?.date;

  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    if (!isValidDateOnly(String(rawDate))) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
  }

  const date = rawDate ? String(rawDate) : undefined;

  try {
    const result = await runHugo({ date });
    return res.json(result);
  } catch (err) {
    // HugoError carries a safe status + body (no secrets, no stack traces).
    if (err && typeof err.status === 'number' && err.body) {
      logger.error('Hugo run failed', { status: err.status, error: err.body.error });
      return res.status(err.status).json(err.body);
    }

    logger.error('Hugo run failed', { error: err && err.message ? err.message : 'unknown' });
    return res.status(500).json({ error: 'Failed to run Hugo' });
  }
});

router.get('/voice', async (req, res) => {
  const rawDate = req.query?.date;

  let date;
  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    if (!isValidDateOnly(String(rawDate))) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    date = String(rawDate);
  } else {
    // Missing date defaults to today (UTC), consistent with the rest of Hugo.
    date = todayUtc();
  }

  try {
    const result = await generateVoiceBrief({ date });
    return res.json(result);
  } catch (err) {
    // VoiceError and HugoError both carry a safe status + body (no secrets).
    if (err && typeof err.status === 'number' && err.body) {
      logger.error('Hugo voice failed', { status: err.status, error: err.body.error });
      return res.status(err.status).json(err.body);
    }

    logger.error('Hugo voice failed', { error: err && err.message ? err.message : 'unknown' });
    return res.status(500).json({ error: 'Failed to generate voice brief' });
  }
});

router.post('/ask', async (req, res) => {
  const rawDate = req.body?.date;

  let date;
  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    if (!isValidDateOnly(String(rawDate))) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    date = String(rawDate);
  } else {
    date = todayUtc();
  }

  const rawQuestion = req.body?.question;
  const question = typeof rawQuestion === 'string' ? rawQuestion.trim() : '';
  if (!question) {
    return res.status(400).json({ error: 'Question is required.' });
  }

  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  try {
    const result = await askHugo({ date, question, history });
    return res.json(result);
  } catch (err) {
    // AskError carries a safe status + body (no secrets, no stack traces).
    if (err && typeof err.status === 'number' && err.body) {
      logger.error('Hugo ask failed', { status: err.status, error: err.body.error });
      return res.status(err.status).json(err.body);
    }

    logger.error('Hugo ask failed', { error: err && err.message ? err.message : 'unknown' });
    return res.status(500).json({ error: 'Failed to ask Hugo.' });
  }
});

// Read-only Daily Knowledge resource.
// - POST /hugo/run GENERATES Daily Knowledge (Claude + GPT) and persists it.
// - GET /hugo/knowledge READS the already-persisted Daily Knowledge only.
// Hugo Web must consume GET /hugo/knowledge as the canonical source for the
// Executive Brief. POST /hugo/run is intended for manual regeneration and
// administrative workflows, NOT for normal frontend page loads.
// This handler never calls runHugo, buildHugoContext, Claude or GPT, and never
// writes to the database.
router.get('/knowledge', async (req, res) => {
  const rawDate = req.query?.date;

  let date;
  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    if (!isValidDateOnly(String(rawDate))) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    date = String(rawDate);
  } else {
    date = todayUtc();
  }

  try {
    const knowledge = await loadDailyKnowledge(date);
    if (!knowledge) {
      return res.status(404).json({ error: 'Daily Knowledge not found for requested date.' });
    }

    // Return exactly what is stored — no transformation, no wrapping.
    return res.json(knowledge);
  } catch (err) {
    logger.error('Hugo knowledge failed', { date, error: err && err.message ? err.message : 'unknown' });
    return res.status(500).json({ error: 'Failed to load Daily Knowledge' });
  }
});

// OpenAI-compatible Chat Completions wrapper for LiveAvatar FULL Mode.
// Private endpoint: requires the X-Hugo-OpenAI-Secret header. Reuses askHugo
// via the hugo-openai service; never duplicates Hugo logic.
router.post('/openai/chat/completions', async (req, res) => {
  const secret = process.env.HUGO_OPENAI_WRAPPER_SECRET;
  if (!secret) {
    return res.status(500).json({
      error: {
        message: 'Hugo OpenAI wrapper secret is not configured.',
        type: 'server_error',
        code: 'missing_secret',
      },
    });
  }

  // Accept either X-Hugo-OpenAI-Secret or Authorization: Bearer <secret>
  // (HeyGen LiveAvatar FULL Mode sends the key via the Bearer header).
  // Prefer X-Hugo-OpenAI-Secret when both are present.
  const headerSecret = req.headers['x-hugo-openai-secret'];
  const authHeader = req.headers.authorization || '';
  const bearerSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const provided = headerSecret || bearerSecret;

  if (!provided || provided !== secret) {
    return res.status(401).json({
      error: {
        message: 'Unauthorized.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
  }

  try {
    // ElevenLabs / OpenAI streaming: deliver the answer as SSE chunks.
    if (req.body && req.body.stream === true) {
      await streamOpenAiChatCompletion(req.body, res);
      return undefined;
    }

    const result = await handleOpenAiChatCompletion(req.body || {});
    return res.json(result);
  } catch (err) {
    // If the SSE stream already started writing, we can't send a JSON error.
    if (res.headersSent) {
      try { res.end(); } catch (endErr) { /* noop */ }
      return undefined;
    }
    // OpenAiError carries a safe OpenAI-compatible status + body.
    if (err && typeof err.status === 'number' && err.body) {
      return res.status(err.status).json(err.body);
    }
    return res.status(500).json({
      error: {
        message: 'Failed to process request.',
        type: 'server_error',
        code: 'internal_error',
      },
    });
  }
});

// Start a LiveAvatar LITE session bridged to the ElevenLabs Agent (whose
// Custom LLM is Hugo's OpenAI-compatible wrapper). Thin adapter: it mints a
// session token and starts the session on LiveAvatar, then returns only
// client-safe connection data. No secrets are ever returned to the frontend.
router.post('/avatar/session', async (req, res) => {
  try {
    const result = await startAvatarSession();
    return res.json(result);
  } catch (err) {
    // AvatarError carries a safe status + body (no secrets, no raw bodies).
    if (err && typeof err.status === 'number' && err.body) {
      return res.status(err.status).json(err.body);
    }
    return res.status(500).json({
      error: {
        status: 500,
        provider: 'liveavatar',
        message: 'Failed to start avatar session.',
        code: 'internal_error',
      },
    });
  }
});

// MIE-20: keep-alive proxy. The frontend calls this every ~45s with the active
// session_id; the backend forwards to LiveAvatar with the server-side API key.
// Never exposes secrets; returns clean JSON only.
router.post('/avatar/keepalive', async (req, res) => {
  const raw = req.body && req.body.session_id;
  const sessionId = typeof raw === 'string' ? raw.trim() : '';
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  try {
    await keepAliveAvatarSession(sessionId);
    return res.json({ ok: true });
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : 502;
    return res.status(status).json({ error: 'LiveAvatar keep-alive failed', status });
  }
});

// MIE-17B: stop proxy. Ends the LiveAvatar session so credits stop accruing.
// Accepts BOTH application/json and application/x-www-form-urlencoded so the
// browser can use navigator.sendBeacon() during unload. Idempotent: a second
// stop (or stopping an already-closed session) still returns ok. Never throws
// in a way that could block the closing browser; never exposes secrets.
router.post('/avatar/stop', express.urlencoded({ extended: false }), async (req, res) => {
  const raw = req.body && req.body.session_id;
  const sessionId = typeof raw === 'string' ? raw.trim() : '';
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  try {
    await stopAvatarSession(sessionId);
    return res.json({ ok: true });
  } catch (err) {
    // Idempotent + unload-safe: never surface a failure that could matter to a
    // closing browser. Log the upstream issue and still report ok.
    const status = err && typeof err.status === 'number' ? err.status : 502;
    logger.warn('Hugo avatar stop upstream issue', { status });
    return res.json({ ok: true });
  }
});

module.exports = router;
