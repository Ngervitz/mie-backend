'use strict';

/**
 * POST /elm/postback — ELM status postback receiver.
 *
 * Mounted in app.js BEFORE the global JSON parser and requireAuth (ELM has no dashboard
 * session). Mandatory order:
 *   request → authenticateElmPostback → parse JSON → parse/validate → persist elm_postback_event
 *           → exact match by cz_solicitud_id → apply
 * A request that does not authenticate is not parsed, NOT persisted, NOT matched and modifies
 * nothing.
 *
 * Auth (src/lib/elmPostbackToken.js): header X-Credizona-Postback-Token against
 * ELM_POSTBACK_TOKEN_CURRENT / ELM_POSTBACK_TOKEN_PREVIOUS.
 *   - no valid token configured → 503 elm_postback_auth_not_configured (fail closed)
 *   - token missing / malformed / wrong → 401 elm_postback_unauthorized (same body for all)
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
const { createElmPostbackAuthenticator } = require('../lib/elmPostbackToken');
const defaultLogger = require('../lib/logger');

const BODY_LIMIT = '64kb';

/**
 * @param {{
 *   authenticateElmPostback?: (req: object) => Promise<{ ok: boolean, status?: number, code?: string, reason?: string }>,
 *   processor?: { processElmPostback: (body: unknown) => Promise<object> },
 *   logger?: { warn: Function },
 * }} [deps]
 */
function createElmPostbackRouter(deps) {
  const d = deps || {};
  const authenticateElmPostback = d.authenticateElmPostback || createElmPostbackAuthenticator();
  const logger = d.logger || defaultLogger;
  let processor = d.processor || null;
  function getProcessor() {
    if (!processor) {
      processor = require('../services/elm/postback').createElmPostbackProcessor();
    }
    return processor;
  }

  const router = express.Router();

  async function authenticate(req, res, next) {
    let auth;
    try {
      auth = await authenticateElmPostback(req);
    } catch (_) {
      auth = null;
    }
    if (auth && auth.ok === true) return next();
    const status = auth && (auth.status === 401 || auth.status === 503) ? auth.status : 503;
    const code = status === 401 ? CODES.POSTBACK_UNAUTHORIZED : CODES.POSTBACK_AUTH_NOT_CONFIGURED;
    logger.warn('elm postback auth rejected', { status: status, reason: (auth && auth.reason) || null });
    return res.status(status).json({ ok: false, error: code });
  }

  router.post(
    '/',
    authenticate,
    express.json({ limit: BODY_LIMIT }),
    async function handlePostback(req, res) {
      try {
        const out = await getProcessor().processElmPostback(req.body);
        if (!out.ok) return res.status(500).json({ ok: false, error: out.code });
        return res.status(200).json({ ok: true, data: out.event });
      } catch (_) {
        return res.status(500).json({ ok: false, error: CODES.POSTBACK_PERSIST_FAILED });
      }
    },
    // eslint-disable-next-line no-unused-vars
    function postbackBodyError(err, req, res, next) {
      if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ ok: false, error: CODES.POSTBACK_BODY_TOO_LARGE });
      }
      return res.status(400).json({ ok: false, error: CODES.POSTBACK_BODY_INVALID });
    },
  );

  return router;
}

module.exports = {
  BODY_LIMIT,
  createElmPostbackRouter,
};
