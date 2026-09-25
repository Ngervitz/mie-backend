'use strict';

/**
 * Mi Plan handoff S2S routes (mounted BEFORE requireAuth).
 *
 * POST /internal/miplan/v1/handoff/emit  — Credizona HMAC (dedicated secret)
 * POST /internal/miplan/v1/handoff/redeem — Mi Plan Bearer (dedicated secret)
 *
 * Never log raw handoff_code.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../lib/logger');
const env = require('../config/env');
const {
  PURPOSE,
  verifyMiplanHandoffHmac,
} = require('../lib/czMiplanHandoffHmac');
const {
  resolveRejectedEpisodeByLrw,
  emitHandoffToken,
  redeemHandoffToken,
  TTL_SECONDS,
} = require('../lib/miplanHandoffTokens');

const router = express.Router();

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_EMIT = 30;
const RATE_MAX_REDEEM = 60;
const emitHits = new Map();
const redeemHits = new Map();

function getClientIp(req) {
  if (req.socket && req.socket.remoteAddress) {
    return String(req.socket.remoteAddress);
  }
  return 'unknown';
}

function isRateLimited(map, ip, max) {
  const now = Date.now();
  const rec = map.get(ip);
  if (!rec || now - rec.start >= RATE_WINDOW_MS) {
    map.set(ip, { start: now, count: 1 });
    if (map.size > 10000) {
      for (const [key, value] of map) {
        if (now - value.start >= RATE_WINDOW_MS) map.delete(key);
      }
    }
    return false;
  }
  rec.count += 1;
  return rec.count > max;
}

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifyMiplanRedeemBearer(req) {
  const expected = env.miplanHandoffRedeemSecret;
  if (!expected) {
    return { ok: false, reason: 'redeem_secret_missing' };
  }
  const header = req.headers.authorization || req.headers.Authorization || '';
  const value = Array.isArray(header) ? header[0] : String(header);
  if (!value.toLowerCase().startsWith('bearer ')) {
    return { ok: false, reason: 'missing_bearer' };
  }
  const token = value.slice(7).trim();
  if (!token || !timingSafeEqualString(token, expected)) {
    return { ok: false, reason: 'unauthorized' };
  }
  return { ok: true };
}

function parseEmitBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid_body' };
  }
  const purpose = body.purpose != null ? String(body.purpose).trim() : '';
  if (purpose !== PURPOSE) {
    return { error: 'invalid_purpose' };
  }
  const lrw =
    body.lrw != null
      ? String(body.lrw).trim()
      : body.external_ref != null
        ? String(body.external_ref).trim()
        : '';
  if (!lrw) {
    return { error: 'missing_lrw' };
  }
  // Ignore client-asserted completed/rejected/ci/financial flags entirely.
  return { value: { purpose: PURPOSE, lrw: lrw } };
}

router.post('/v1/handoff/emit', async function (req, res) {
  const requestId = crypto.randomUUID();
  res.set('X-Request-Id', requestId);

  if (!env.czMiplanHandoffHmacSecret) {
    logger.error('Mi Plan handoff HMAC secret missing', {
      kind: 'miplan_handoff_emit',
      reason: 'hmac_secret_missing',
      request_id: requestId,
    });
    return res.status(503).json({ error: 'unavailable' });
  }

  if (isRateLimited(emitHits, getClientIp(req), RATE_MAX_EMIT)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const hmac = verifyMiplanHandoffHmac(req.headers, req.rawBody);
  if (!hmac.ok) {
    logger.warn('Mi Plan handoff emit HMAC rejected', {
      kind: 'miplan_handoff_emit',
      reason: hmac.reason,
      request_id: requestId,
    });
    return res.status(401).json({ error: 'unauthorized' });
  }

  const parsed = parseEmitBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    const supabase = require('../clients/supabase');
    const resolved = await resolveRejectedEpisodeByLrw(
      supabase,
      parsed.value.lrw,
    );
    if (!resolved.ok) {
      logger.warn('Mi Plan handoff emit episode rejected', {
        kind: 'miplan_handoff_emit',
        reason: resolved.reason,
        request_id: requestId,
      });
      const status =
        resolved.reason === 'lrw_not_found' ||
        resolved.reason === 'episode_not_rejected'
          ? 404
          : 503;
      return res.status(status).json({ error: resolved.reason });
    }

    const emitted = await emitHandoffToken(supabase, resolved);
    if (!emitted.ok) {
      logger.error('Mi Plan handoff emit failed', {
        kind: 'miplan_handoff_emit',
        reason: emitted.reason,
        request_id: requestId,
      });
      return res.status(503).json({ error: 'unavailable' });
    }

    logger.info('Mi Plan handoff emitted', {
      kind: 'miplan_handoff_emit',
      request_id: requestId,
      token_id: emitted.token_id,
      expires_in: TTL_SECONDS,
    });

    return res.status(200).json({
      ok: true,
      purpose: PURPOSE,
      handoff_code: emitted.handoff_code,
      expires_in: emitted.expires_in,
      expires_at: emitted.expires_at,
    });
  } catch (err) {
    logger.error('Mi Plan handoff emit handler failed', {
      kind: 'miplan_handoff_emit',
      reason: 'handler_failed',
      request_id: requestId,
      message: err && err.message ? String(err.message).slice(0, 120) : null,
    });
    return res.status(503).json({ error: 'unavailable' });
  }
});

router.post('/v1/handoff/redeem', async function (req, res) {
  const requestId = crypto.randomUUID();
  res.set('X-Request-Id', requestId);

  if (!env.miplanHandoffRedeemSecret) {
    logger.error('Mi Plan handoff redeem secret missing', {
      kind: 'miplan_handoff_redeem',
      reason: 'redeem_secret_missing',
      request_id: requestId,
    });
    return res.status(503).json({ error: 'unavailable' });
  }

  if (isRateLimited(redeemHits, getClientIp(req), RATE_MAX_REDEEM)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const auth = verifyMiplanRedeemBearer(req);
  if (!auth.ok) {
    logger.warn('Mi Plan handoff redeem auth rejected', {
      kind: 'miplan_handoff_redeem',
      reason: auth.reason,
      request_id: requestId,
    });
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const code =
    body.handoff_code != null
      ? String(body.handoff_code)
      : body.code != null
        ? String(body.code)
        : '';

  // Never log code
  try {
    const supabase = require('../clients/supabase');
    const result = await redeemHandoffToken(supabase, code);
    if (!result.ok) {
      logger.warn('Mi Plan handoff redeem denied', {
        kind: 'miplan_handoff_redeem',
        reason: result.reason,
        request_id: requestId,
      });
      return res.status(result.status || 401).json({ error: result.reason });
    }

    logger.info('Mi Plan handoff redeemed', {
      kind: 'miplan_handoff_redeem',
      request_id: requestId,
      token_id: result.token_id,
    });

    return res.status(200).json({
      ok: true,
      context: result.context,
    });
  } catch (err) {
    logger.error('Mi Plan handoff redeem handler failed', {
      kind: 'miplan_handoff_redeem',
      reason: 'handler_failed',
      request_id: requestId,
      message: err && err.message ? String(err.message).slice(0, 120) : null,
    });
    return res.status(503).json({ error: 'unavailable' });
  }
});

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

function attachRawBody(req, _res, buf) {
  req.rawBody = Buffer.from(buf);
}

function resetRateLimitForTests() {
  emitHits.clear();
  redeemHits.clear();
}

module.exports = router;
module.exports.jsonErrorHandler = jsonErrorHandler;
module.exports.attachRawBody = attachRawBody;
module.exports.resetRateLimitForTests = resetRateLimitForTests;
module.exports.verifyMiplanRedeemBearer = verifyMiplanRedeemBearer;
