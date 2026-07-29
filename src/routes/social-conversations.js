/**
 * MetaDash Instagram DMs + list.
 * GET  /api/social-conversations?status=pending&limit=&offset=
 * POST /api/social-conversations/:id/send
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { getAccessToken } = require('../services/instagram-dms/config');
const { runSendFlow } = require('../services/instagram-dms/send-flow');

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
 * List conversations. Default status=pending.
 * Order: pending first when mixed, then last_inbound_at desc.
 */
router.get('/', async (req, res) => {
  const statusRaw =
    typeof req.query.status === 'string' ? req.query.status.trim() : 'pending';
  const { limit, offset } = parsePaging(req.query);

  try {
    let q = supabase
      .from('social_conversations')
      .select(
        'id, platform, ig_conversation_id, recipient_ig_scoped_id, ig_username, status, last_inbound_at, last_outbound_at, response_window_expires_at, response_window_status, last_synced_at, last_sync_status, created_at, updated_at',
        { count: 'exact' },
      );

    if (statusRaw && statusRaw !== 'all') {
      q = q.eq('status', statusRaw);
    }

    if (!statusRaw || statusRaw === 'all') {
      q = q
        .order('status', { ascending: true })
        .order('last_inbound_at', { ascending: false, nullsFirst: false });
    } else {
      q = q.order('last_inbound_at', { ascending: false, nullsFirst: false });
    }

    const { data, error, count } = await q.range(offset, offset + limit - 1);

    if (error) {
      logger.error('GET /api/social-conversations failed', {
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    const conversations = data || [];
    return res.json({
      conversations,
      limit,
      offset,
      total: typeof count === 'number' ? count : conversations.length,
      hasMore:
        typeof count === 'number'
          ? offset + conversations.length < count
          : conversations.length === limit,
    });
  } catch (err) {
    logger.error('GET /api/social-conversations unexpected', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({
      error: err && err.message ? err.message : 'Internal error',
    });
  }
});

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
