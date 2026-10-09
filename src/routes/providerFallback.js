'use strict';

/**
 * Credizona → JANUS provider fallback S2S routes (mounted BEFORE requireAuth, own HMAC).
 *
 * POST /internal/providers/v1/fallback/start               enqueue (idempotent by cz_solicitud_id)
 * POST /internal/providers/v1/fallback/status              current state of one solicitud
 * POST /internal/providers/v1/fallback/events/pending      C1 event stream (PULL by the CZ cron)
 * POST /internal/providers/v1/fallback/events/ack          CZ confirms it processed an event
 * POST /internal/providers/v1/fallback/deliveries/pending  v1 (deprecated): final outcome only
 * POST /internal/providers/v1/fallback/deliveries/ack      v1 (deprecated)
 *
 * CZ gets the result by polling from its server; nothing depends on the applicant's browser
 * staying open. Events: seq per solicitud, event n is only delivered after n-1 is acked, an
 * unacked event is delivered again (idempotent by event id), events are never deleted.
 * Responses never include the snapshot (PII).
 */

const crypto = require('crypto');
const express = require('express');
const defaultLogger = require('../lib/logger');
const { verifyProviderFallbackHmac } = require('../lib/czProviderFallbackHmac');
const { readProviderFallbackConfig } = require('../services/providerFallback/config');
const { parseStartBody } = require('../services/providerFallback/snapshot');
const { FINAL_OUTCOMES, OUTCOME, CZ_ACK_RESULTS } = require('../services/providerFallback/constants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_PENDING_LIMIT = 50;
const MAX_PENDING_LIMIT = 200;
const MAX_ACK_ITEMS = 100;
const SECRET_UNAVAILABLE = Object.freeze(['hmac_secret_missing', 'hmac_secret_reused']);
const UNPROCESSABLE_START_ERRORS = Object.freeze(['from_api_excluded', 'cz_estado_not_evaluating']);

function positiveSafeInt(raw) {
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function estadoAtStart(row) {
  const raw =
    row.cz_estado_id_at_start != null
      ? row.cz_estado_id_at_start
      : row.snapshot && row.snapshot.cz_estado_id != null
        ? row.snapshot.cz_estado_id
        : null;
  return positiveSafeInt(raw);
}

/**
 * already_referred: related_cz_solicitud_id = the solicitud of the same CI whose active referral
 * blocked this one (this solicitud was NOT sent). manual_review: `review` is the registered
 * case; CZ must not tell the applicant a review is pending unless it is present.
 * @param {object} row
 * @param {{ status: string, due_at: string }|null} [review]
 * @param {{ projected_estado: number, last_seq: number }|null} [czState]
 */
function toView(row, review, czState) {
  return {
    cz_solicitud_id: Number(row.cz_solicitud_id),
    provider: row.provider,
    exec_status: row.exec_status,
    outcome: row.outcome,
    reason_code: row.reason_code || null,
    related_cz_solicitud_id: positiveSafeInt(row.related_cz_solicitud_id),
    cz_estado_id_at_start: estadoAtStart(row),
    review: review ? { status: review.status, due_at: review.due_at || null } : null,
    finalized_at: row.finalized_at || null,
    delivery_status: row.cz_delivery_status,
    acked_at: row.cz_acked_at || null,
    projected_estado: czState ? Number(czState.projected_estado) : null,
    last_event_seq: czState ? Number(czState.last_seq) : 0,
  };
}

/**
 * CZ applies target_estado with compare-and-set WHERE estado = from_estado. `review` is present
 * for an outcome event into 14 (manual_review) when its case is registered.
 */
function toEventView(e, review) {
  return {
    event_id: e.id,
    cz_solicitud_id: Number(e.cz_solicitud_id),
    seq: Number(e.seq),
    type: e.event_type,
    from_estado: Number(e.from_estado),
    target_estado: Number(e.target_estado),
    outcome: e.outcome || null,
    reason_code: e.reason_code || null,
    related_cz_solicitud_id: positiveSafeInt(e.related_cz_solicitud_id),
    provider_status: e.provider_status || null,
    provider_status_at: e.provider_status_at || null,
    review: review ? { status: review.status, due_at: review.due_at || null } : null,
    created_at: e.created_at,
    delivery_attempts: Number(e.delivery_attempts) || 0,
  };
}

/**
 * @param {{
 *   repository?: object,
 *   getWorker?: () => { kick: (czId: number) => boolean },
 *   config?: object,
 *   verifyHmac?: (headers: object, rawBody: Buffer) => { ok: boolean, reason: string|null },
 *   logger?: object,
 * }} [deps]
 */
function createProviderFallbackRouter(deps) {
  const d = deps || {};
  const config = d.config || readProviderFallbackConfig();
  const logger = d.logger || defaultLogger;
  const verifyHmac = d.verifyHmac || verifyProviderFallbackHmac;
  let repository = d.repository || null;
  function repo() {
    if (!repository) {
      repository = require('../services/providerFallback/repository').createProviderFallbackRepository();
    }
    return repository;
  }
  const getWorker =
    d.getWorker ||
    function () {
      return require('../services/providerFallback/worker').getDefaultProviderFallbackWorker();
    };

  async function viewsOf(rows) {
    const reviewIds = rows
      .filter(function (r) {
        return r.outcome === OUTCOME.MANUAL_REVIEW && r.id;
      })
      .map(function (r) {
        return r.id;
      });
    const reviews =
      reviewIds.length && typeof repo().getReviewStatusByRequestIds === 'function'
        ? await repo().getReviewStatusByRequestIds(reviewIds)
        : new Map();
    return rows.map(function (r) {
      return toView(r, reviews.get(r.id) || null);
    });
  }

  const router = express.Router();

  router.use(function authenticate(req, res, next) {
    const requestId = crypto.randomUUID();
    res.set('X-Request-Id', requestId);
    req.providerFallbackRequestId = requestId;
    const hmac = verifyHmac(req.headers, req.rawBody);
    if (hmac.ok) return next();
    if (SECRET_UNAVAILABLE.includes(hmac.reason)) {
      logger.error('provider fallback HMAC secret unavailable', {
        kind: 'provider_fallback',
        reason: hmac.reason,
        request_id: requestId,
      });
      return res.status(503).json({ error: 'unavailable' });
    }
    logger.warn('provider fallback HMAC rejected', {
      kind: 'provider_fallback',
      reason: hmac.reason,
      request_id: requestId,
    });
    return res.status(401).json({ error: 'unauthorized' });
  });

  function fail(res, req, err, where) {
    logger.error('provider fallback handler failed', {
      kind: 'provider_fallback',
      where: where,
      request_id: req.providerFallbackRequestId,
      message: err && err.message ? String(err.message).slice(0, 160) : null,
    });
    return res.status(503).json({ error: 'unavailable' });
  }

  router.post('/v1/fallback/start', async function (req, res) {
    if (!config.startEnabled) return res.status(503).json({ error: 'fallback_disabled' });
    const parsed = parseStartBody(req.body);
    if (parsed.error) {
      const status = UNPROCESSABLE_START_ERRORS.includes(parsed.error) ? 422 : 400;
      return res.status(status).json({ error: parsed.error });
    }
    const v = parsed.value;
    let out;
    try {
      out = await repo().enqueue({
        czSolicitudId: v.czSolicitudId,
        ci: v.ci,
        snapshot: v.snapshot,
        snapshotHash: v.snapshotHash,
      });
    } catch (err) {
      return fail(res, req, err, 'start');
    }
    if (out.conflict) {
      logger.warn('provider fallback start snapshot conflict', {
        kind: 'provider_fallback',
        cz_solicitud_id: v.czSolicitudId,
        request_id: req.providerFallbackRequestId,
      });
      return res.status(409).json({ error: 'snapshot_conflict', request: toView(out.request) });
    }

    let kicked = false;
    if (out.request.outcome === OUTCOME.PENDING) {
      try {
        kicked = getWorker().kick(v.czSolicitudId) === true;
      } catch (_) {
        logger.error('provider fallback kick scheduling failed', {
          kind: 'provider_fallback',
          cz_solicitud_id: v.czSolicitudId,
        });
      }
    }
    logger.info('provider fallback start', {
      kind: 'provider_fallback',
      cz_solicitud_id: v.czSolicitudId,
      created: out.created,
      kicked: kicked,
      request_id: req.providerFallbackRequestId,
    });
    return res.status(out.created ? 202 : 200).json({
      ok: true,
      created: out.created,
      request: toView(out.request),
    });
  });

  router.post('/v1/fallback/status', async function (req, res) {
    const czId = positiveSafeInt(req.body && req.body.cz_solicitud_id);
    if (czId == null) return res.status(400).json({ error: 'invalid_cz_solicitud_id' });
    try {
      const row = await repo().getStatusByCzId(czId);
      if (!row) return res.status(404).json({ error: 'not_found' });
      const views = await viewsOf([row]);
      const states = await repo().getCzStatesByCzIds([czId]);
      const s = states.get(czId) || null;
      views[0].projected_estado = s ? Number(s.projected_estado) : null;
      views[0].last_event_seq = s ? Number(s.last_seq) : 0;
      return res.status(200).json({ ok: true, request: views[0] });
    } catch (err) {
      return fail(res, req, err, 'status');
    }
  });

  router.post('/v1/fallback/events/pending', async function (req, res) {
    const raw = req.body && req.body.limit;
    let limit = DEFAULT_PENDING_LIMIT;
    if (raw != null) {
      limit = positiveSafeInt(raw);
      if (limit == null || limit > MAX_PENDING_LIMIT) return res.status(400).json({ error: 'invalid_limit' });
    }
    try {
      const rows = await repo().listPendingEvents(limit);
      const reviewIds = rows
        .filter(function (e) {
          return e.event_type === 'outcome' && e.outcome === OUTCOME.MANUAL_REVIEW && e.source_id;
        })
        .map(function (e) {
          return e.source_id;
        });
      const reviews = reviewIds.length ? await repo().getReviewStatusByRequestIds(reviewIds) : new Map();
      return res.status(200).json({
        ok: true,
        items: rows.map(function (e) {
          return toEventView(e, e.source_id ? reviews.get(e.source_id) || null : null);
        }),
      });
    } catch (err) {
      return fail(res, req, err, 'events_pending');
    }
  });

  router.post('/v1/fallback/events/ack', async function (req, res) {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ACK_ITEMS) {
      return res.status(400).json({ error: 'invalid_items' });
    }
    const results = [];
    try {
      for (const item of items) {
        const eventId = item && typeof item.event_id === 'string' ? item.event_id.trim() : '';
        const result = item && typeof item.result === 'string' ? item.result : null;
        if (!UUID_RE.test(eventId) || !CZ_ACK_RESULTS.includes(result)) {
          results.push({ event_id: eventId || null, status: 'invalid' });
          continue;
        }
        const r = await repo().ackEvent(eventId, result);
        results.push({ event_id: eventId, status: r.status, result: r.result || null });
      }
    } catch (err) {
      return fail(res, req, err, 'events_ack');
    }
    return res.status(200).json({ ok: true, results: results });
  });

  router.post('/v1/fallback/deliveries/pending', async function (req, res) {
    const raw = req.body && req.body.limit;
    let limit = DEFAULT_PENDING_LIMIT;
    if (raw != null) {
      limit = positiveSafeInt(raw);
      if (limit == null || limit > MAX_PENDING_LIMIT) return res.status(400).json({ error: 'invalid_limit' });
    }
    try {
      const rows = await repo().listPendingDeliveries(limit);
      return res.status(200).json({ ok: true, items: await viewsOf(rows) });
    } catch (err) {
      return fail(res, req, err, 'deliveries_pending');
    }
  });

  router.post('/v1/fallback/deliveries/ack', async function (req, res) {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ACK_ITEMS) {
      return res.status(400).json({ error: 'invalid_items' });
    }
    const results = [];
    try {
      for (const item of items) {
        const czId = positiveSafeInt(item && item.cz_solicitud_id);
        const outcome = item && typeof item.outcome === 'string' ? item.outcome : null;
        if (czId == null || !FINAL_OUTCOMES.includes(outcome)) {
          results.push({ cz_solicitud_id: czId, status: 'invalid' });
          continue;
        }
        const r = await repo().ack(czId, outcome);
        results.push({ cz_solicitud_id: czId, status: r.status });
      }
    } catch (err) {
      return fail(res, req, err, 'deliveries_ack');
    }
    return res.status(200).json({ ok: true, results: results });
  });

  return router;
}

module.exports = {
  createProviderFallbackRouter,
  toView,
  toEventView,
};
