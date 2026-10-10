'use strict';

/**
 * Preaprobados → ELM routes (mounted inside the /preaprobados router, which already requires
 * section permission 'preaprobados').
 *
 *   GET  /:czId/elm        read-only ELM status + eligibility preview (no PII bodies)
 *   POST /:czId/elm/send   "Enviar a ELM" (requireElmAction): one solicitud of the CDV cohort,
 *                          through the Rechazados manual send path (preaprobadosElmSend.js)
 *
 * There is no other write route: S1 / S2 are never exposed separately, so every send goes
 * through cohort membership, the CI resend guard and the orchestrator.
 * The browser sends only the solicitud id (URL). Request bodies are ignored: CI, salary,
 * activity, phone, email and source are resolved by the backend.
 */

const express = require('express');
const logger = require('../lib/logger');
const { requireElmAction } = require('../middleware/requireElmAction');
const { CODES } = require('../services/elm/constants');
const { loadPreaprobadoMember, sendPreaprobadoToElm } = require('../lib/preaprobadosElmSend');
const { loadCiResendHold } = require('../lib/rejectedElmResendGuard');

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
 * @param {{
 *   orchestrator?: object, getOrchestrator?: () => object,
 *   listView?: object, getListView?: () => object,
 *   supabase?: object,
 *   loadMember?: (czId: number) => Promise<object>,
 *   loadCiResendHold?: (ci: number, czId: number) => Promise<object|null>,
 * }} [opts]
 */
function createPreaprobadosElmRouter(opts) {
  const o = opts || {};
  const router = express.Router();
  let orchestrator = o.orchestrator || null;
  let listView = o.listView || null;
  function getOrchestrator() {
    if (o.getOrchestrator) return o.getOrchestrator();
    if (!orchestrator) {
      orchestrator = require('../services/elm/orchestrator').createElmOrchestrator();
    }
    return orchestrator;
  }
  function getListView() {
    if (o.getListView) return o.getListView();
    if (!listView) {
      listView = require('../services/elm/listView').createElmListView({
        sendReadiness: function () {
          return getOrchestrator().getSendReadiness();
        },
      });
    }
    return listView;
  }
  function getSupabase() {
    return o.supabase || require('../clients/supabase');
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

  router.post('/:czId/elm/send', requireElmAction, async function send(req, res) {
    try {
      const out = await sendPreaprobadoToElm(
        {
          orchestrator: getOrchestrator(),
          listView: getListView(),
          loadMember:
            o.loadMember ||
            function (czId) {
              return loadPreaprobadoMember(getSupabase(), czId);
            },
          loadCiResendHold:
            o.loadCiResendHold ||
            function (ci, czId) {
              return loadCiResendHold(getSupabase(), ci, czId);
            },
        },
        { czSolicitudId: req.params.czId, actorUserId: req.elmActorUserId },
      );
      return res.status(out.status).json(out.body);
    } catch (err) {
      return fail(res, 'POST /preaprobados/:czId/elm/send failed', err);
    }
  });

  return router;
}

module.exports = { createPreaprobadosElmRouter, statusFor };
