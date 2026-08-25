'use strict';

/**
 * Credizona → Janus tracking ingest.
 * POST /tracking/events — HMAC auth, mounted BEFORE requireAuth.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../lib/logger');
const env = require('../config/env');
const { verifyTrackingHmac } = require('../lib/czTrackingHmac');
const {
  parseTrackingEventBody,
  ingestCredizonaTrackingEvent,
} = require('../lib/czTrackingEvents');

const router = express.Router();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;
const rateHits = new Map();

function getClientIp(req) {
  if (req.socket && req.socket.remoteAddress) {
    return String(req.socket.remoteAddress);
  }
  return 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const rec = rateHits.get(ip);
  if (!rec || now - rec.start >= RATE_WINDOW_MS) {
    rateHits.set(ip, { start: now, count: 1 });
    if (rateHits.size > 10000) {
      for (const [key, value] of rateHits) {
        if (now - value.start >= RATE_WINDOW_MS) rateHits.delete(key);
      }
    }
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_MAX;
}

function resetRateLimitForTests() {
  rateHits.clear();
}

function jsonErrorHandler(err, req, res, next) {
  if (!err) return next();
  if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  if (
    err.type === 'entity.parse.failed' ||
    err.status === 400 ||
    err instanceof SyntaxError
  ) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  return next(err);
}

router.post('/events', async (req, res) => {
  const requestId = crypto.randomUUID();
  res.set('X-Request-Id', requestId);

  if (!env.czTrackingHmacSecret) {
    logger.error('CZ tracking HMAC secret missing', {
      kind: 'cz_tracking_event',
      reason: 'hmac_secret_missing',
      request_id: requestId,
    });
    return res.status(503).json({ error: 'unavailable' });
  }

  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const hmac = verifyTrackingHmac(req.headers, req.rawBody);
  if (!hmac.ok) {
    if (hmac.reason === 'hmac_secret_missing') {
      logger.error('CZ tracking HMAC secret missing', {
        kind: 'cz_tracking_event',
        reason: 'hmac_secret_missing',
        request_id: requestId,
      });
      return res.status(503).json({ error: 'unavailable' });
    }
    logger.warn('CZ tracking HMAC rejected', {
      kind: 'cz_tracking_event',
      reason: hmac.reason,
      request_id: requestId,
    });
    return res.status(401).json({ error: 'unauthorized' });
  }

  const parsed = parseTrackingEventBody(req.body);
  if (parsed.error) {
    const status = parsed.error === 'invalid_tracking_token' ? 422 : 400;
    logger.warn('CZ tracking event validation failed', {
      kind: 'cz_tracking_event',
      reason: parsed.reason || parsed.error,
      request_id: requestId,
      event_name:
        req.body && typeof req.body.event_name === 'string'
          ? String(req.body.event_name).trim().slice(0, 32)
          : null,
    });
    return res.status(status).json({ error: parsed.error });
  }

  try {
    const supabase = require('../clients/supabase');
    const result = await ingestCredizonaTrackingEvent(
      supabase,
      parsed.value,
      requestId,
    );
    if (result.status === 200) {
      return res.status(200).json({
        ok: true,
        duplicate: Boolean(result.duplicate),
      });
    }
    return res.status(result.status).json({ error: result.error });
  } catch (_err) {
    logger.error('CZ tracking event handler failed', {
      kind: 'cz_tracking_event',
      reason: 'insert_failed',
      request_id: requestId,
    });
    return res.status(503).json({ error: 'unavailable' });
  }
});

module.exports = router;
module.exports.jsonErrorHandler = jsonErrorHandler;
module.exports.resetRateLimitForTests = resetRateLimitForTests;
module.exports.attachRawBody = function attachRawBody(req, _res, buf) {
  req.rawBody = Buffer.from(buf);
};
