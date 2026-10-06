'use strict';

/**
 * Mi Plan waitlist interest — browser-facing (mounted BEFORE requireAuth).
 *
 * POST /miplan/v1/interest  { handoff_code }
 *   200 { ok: true, registered: true }   first registration and replays alike
 *   4xx/5xx { ok: false }                 never says why
 *
 * The handoff_code is the only credential (capability already held by the
 * Credizona thank-you page). CORS is limited to MIPLAN_INTEREST_ALLOWED_ORIGINS.
 * Never log raw handoff_code or CI.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../lib/logger');
const env = require('../config/env');
const {
  parseInterestBody,
  registerMiplanInterest,
} = require('../lib/miplanInterest');

const router = express.Router();

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://www.credizona.com.uy',
  'https://credizona.com.uy',
]);
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;
const rateHits = new Map();

function allowedOrigins() {
  const raw = env.miplanInterestAllowedOrigins;
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return String(raw)
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

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

/** Requests without Origin (non-browser) get no CORS headers; unknown origins are refused. */
function cors(req, res, next) {
  const origin = req.headers.origin;
  res.set('Vary', 'Origin');
  if (origin != null) {
    if (allowedOrigins().indexOf(String(origin)) === -1) {
      return res.status(403).json({ ok: false });
    }
    res.set('Access-Control-Allow-Origin', String(origin));
  }
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }
  return next();
}

router.use('/v1/interest', cors);

router.post('/v1/interest', async function (req, res) {
  const requestId = crypto.randomUUID();
  res.set('X-Request-Id', requestId);
  res.set('Cache-Control', 'no-store');

  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({ ok: false });
  }

  const parsed = parseInterestBody(req.body);
  if (parsed.error) {
    logger.warn('Mi Plan interest rejected', {
      kind: 'miplan_interest',
      reason: parsed.error,
      request_id: requestId,
    });
    return res.status(400).json({ ok: false });
  }

  try {
    const supabase = require('../clients/supabase');
    const result = await registerMiplanInterest(supabase, parsed.value.handoff_code);
    const meta = {
      kind: 'miplan_interest',
      reason: result.reason,
      request_id: requestId,
      token_id: result.token_id || null,
    };
    if (!result.ok) {
      if (result.status >= 500) logger.error('Mi Plan interest failed', meta);
      else logger.warn('Mi Plan interest rejected', meta);
      return res.status(result.status).json({ ok: false });
    }
    logger.info('Mi Plan interest registered', meta);
    return res.status(200).json({ ok: true, registered: true });
  } catch (err) {
    logger.error('Mi Plan interest handler failed', {
      kind: 'miplan_interest',
      reason: 'handler_failed',
      request_id: requestId,
      message: err && err.message ? String(err.message).slice(0, 120) : null,
    });
    return res.status(503).json({ ok: false });
  }
});

function jsonErrorHandler(err, req, res, next) {
  if (!err) return next();
  if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
    return res.status(413).json({ ok: false });
  }
  if (
    err.type === 'entity.parse.failed' ||
    err.status === 400 ||
    err instanceof SyntaxError
  ) {
    return res.status(400).json({ ok: false });
  }
  return next(err);
}

function resetRateLimitForTests() {
  rateHits.clear();
}

module.exports = router;
module.exports.jsonErrorHandler = jsonErrorHandler;
module.exports.resetRateLimitForTests = resetRateLimitForTests;
module.exports.DEFAULT_ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS;
