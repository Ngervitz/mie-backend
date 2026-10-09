'use strict';

/**
 * Preaprobados → ELM routes (mounted inside the /preaprobados router, which already requires
 * section permission 'preaprobados').
 *
 *   GET  /:czId/elm           read-only ELM status + eligibility preview (no PII bodies)
 *   POST /:czId/elm/evaluate  S1  (action gate; Fase 1A always answers elm_send_disabled)
 *   POST /:czId/elm/refer     S2  (action gate; Fase 1A always answers elm_send_disabled)
 *
 * The browser sends only the solicitud id (URL). Request bodies are ignored: CI, salary,
 * activity, phone, email and source are resolved by the backend.
 */

const express = require('express');
const logger = require('../lib/logger');
const { requireElmAction } = require('../middleware/requireElmAction');
const { CODES } = require('../services/elm/constants');

const STATUS_BY_CODE = Object.freeze({
  [CODES.INVALID_CZ_ID]: 400,
  [CODES.INVALID_CONTEXT]: 400,
  [CODES.MANUAL_REQUIRES_USER]: 400,
  [CODES.TRIGGER_ORIGIN_NOT_ENABLED]: 403,
  [CODES.SEND_DISABLED]: 503,
  [CODES.SOLICITUD_NOT_FOUND]: 404,
  [CODES.PROCESS_NOT_FOUND]: 404,
  [CODES.PROCESS_EXISTS]: 409,
  [CODES.CI_LOCK_BLOCKED]: 409,
  [CODES.S1_NOT_ELIGIBLE]: 409,
  [CODES.S2_ALREADY_STARTED]: 409,
  [CODES.S2_NOT_STARTABLE]: 409,
  [CODES.LATE_RESULT_DISCARDED]: 409,
  [CODES.PERSIST_FAILED]: 500,
});

function statusFor(result) {
  if (result && result.ok) return 200;
  return STATUS_BY_CODE[result && result.code] || 422;
}

/**
 * @param {{ orchestrator?: object }} [opts]
 */
function createPreaprobadosElmRouter(opts) {
  const router = express.Router();
  let orchestrator = (opts && opts.orchestrator) || null;
  function getOrchestrator() {
    if (!orchestrator) {
      orchestrator = require('../services/elm/orchestrator').createElmOrchestrator();
    }
    return orchestrator;
  }

  function fail(res, label, err) {
    logger.error(label, { error: err && err.message ? err.message : 'unknown' });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }

  router.get('/:czId/elm', async function getElmStatus(req, res) {
    try {
      const out = await getOrchestrator().getElmStatus(req.params.czId);
      return res.status(statusFor(out)).json(out);
    } catch (err) {
      return fail(res, 'GET /preaprobados/:czId/elm failed', err);
    }
  });

  router.post('/:czId/elm/evaluate', requireElmAction, async function evaluate(req, res) {
    try {
      const out = await getOrchestrator().evaluateElm(req.params.czId, {
        triggerOrigin: 'janus_manual',
        triggeredByUserId: req.elmActorUserId,
      });
      return res.status(statusFor(out)).json(out);
    } catch (err) {
      return fail(res, 'POST /preaprobados/:czId/elm/evaluate failed', err);
    }
  });

  router.post('/:czId/elm/refer', requireElmAction, async function refer(req, res) {
    try {
      const out = await getOrchestrator().referElm(req.params.czId, {
        triggerOrigin: 'janus_manual',
        triggeredByUserId: req.elmActorUserId,
      });
      return res.status(statusFor(out)).json(out);
    } catch (err) {
      return fail(res, 'POST /preaprobados/:czId/elm/refer failed', err);
    }
  });

  return router;
}

module.exports = { createPreaprobadosElmRouter, statusFor };
