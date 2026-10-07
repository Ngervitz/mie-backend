'use strict';

/**
 * POST /elm/postback — ELM status postback receiver.
 *
 * Mandatory order:
 *   request → authenticateElmPostback → parse/validate → persist elm_postback_event
 *           → exact match by cz_solicitud_id → apply
 * A request that does not authenticate is NOT persisted, NOT matched and modifies nothing.
 *
 * FAIL-CLOSED: ELM has not confirmed how postbacks authenticate. Until a real
 * authenticateElmPostback is wired, every request gets 503 elm_postback_auth_not_configured
 * before the body is processed, so no external request generates events. Do not replace with
 * a guessed scheme.
 *
 * Once authenticated, every stored outcome (applied / stale / ignored_granted / unmatched /
 * invalid) answers 200 with the processing status: the event is persisted, so a retry would
 * not change anything and non-2xx would only trigger provider retry storms. Only a failure to
 * persist answers 500 (so the provider can retry).
 *
 * Request headers are never stored or logged.
 */

const express = require('express');
const { CODES } = require('../services/elm/constants');

async function rejectUntilConfigured() {
  return { ok: false, status: 503, code: CODES.POSTBACK_AUTH_NOT_CONFIGURED };
}

/**
 * @param {{
 *   authenticateElmPostback?: (req: object) => Promise<{ ok: boolean, status?: number, code?: string }>,
 *   processor?: { processElmPostback: (body: unknown) => Promise<object> },
 * }} [deps]
 */
function createElmPostbackRouter(deps) {
  const d = deps || {};
  const authenticateElmPostback = d.authenticateElmPostback || rejectUntilConfigured;
  let processor = d.processor || null;
  function getProcessor() {
    if (!processor) {
      processor = require('../services/elm/postback').createElmPostbackProcessor();
    }
    return processor;
  }

  const router = express.Router();

  router.post('/', async function (req, res) {
    let auth;
    try {
      auth = await authenticateElmPostback(req);
    } catch (_) {
      auth = null;
    }
    if (!auth || auth.ok !== true) {
      const status = auth && Number.isInteger(auth.status) ? auth.status : 503;
      return res.status(status).json({
        ok: false,
        error: (auth && auth.code) || CODES.POSTBACK_AUTH_NOT_CONFIGURED,
      });
    }
    try {
      const out = await getProcessor().processElmPostback(req.body);
      if (!out.ok) return res.status(500).json({ ok: false, error: out.code });
      return res.status(200).json({ ok: true, data: out.event });
    } catch (_) {
      return res.status(500).json({ ok: false, error: CODES.POSTBACK_PERSIST_FAILED });
    }
  });

  return router;
}

module.exports = {
  createElmPostbackRouter,
  rejectUntilConfigured,
};
