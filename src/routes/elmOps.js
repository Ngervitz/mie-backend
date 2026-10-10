'use strict';

/**
 * ELM operations routes (Fase 3B), mounted at /preaprobados/elm-ops inside the /preaprobados
 * router (section permission 'preaprobados' already required). Actions also require
 * requireElmAction (active admin, human session, never cron) and are audited in the DB.
 *
 *   GET  /summary                          counts for badges/alerts
 *   GET  /kpis?from=&to=                   ELM KPIs (flow vs current) by trigger_origin
 *   GET  /followup                         seguimiento operativo (in evaluation / review /
 *                                          automatic rejection not reflected in CZ / queued)
 *   GET  /processes                        active referrals + uncertain ELM results (CI blockers)
 *   POST /processes/:id/resolve            audited manual resolution (never sends, never GRANTED)
 *                                          { expected_updated_at, resolution_code, cz_outcome,
 *                                            note, correction?: true (Aceptado ELM only) }
 *   GET  /review-cases?status=open|resolved
 *   POST /review-cases/:id/assign          { expected_version, assignee_user_id|null }
 *   POST /review-cases/:id/triage          { expected_version, priority, due_at }
 *   POST /review-cases/:id/resolve         { expected_version, resolution_code, note,
 *                                            cz_outcome: referred|rejected|granted|none }
 *   GET  /assignees                        active admins (action gate)
 *   GET  /audit?entity_type=&entity_id=    audit trail of one entity
 *   GET  /c1/active-referrals              C1 solicitudes in 13/14: age, last ELM status, stale
 *   GET  /c1/conflicts?status=open|resolved  events not emitted because they contradict CZ state
 *   POST /c1/conflicts/:id/resolve         { note } audited acknowledgement (no CZ change)
 */

const express = require('express');
const logger = require('../lib/logger');
const { requireElmAction } = require('../middleware/requireElmAction');
const { ACTION_HTTP } = require('../services/elmOps/service');

function limitOf(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 200 ? n : 100;
}

/**
 * @param {{ service?: object, requireAction?: Function }} [opts]
 */
function createElmOpsRouter(opts) {
  const o = opts || {};
  const requireAction = o.requireAction || requireElmAction;
  let service = o.service || null;
  function svc() {
    if (!service) service = require('../services/elmOps/service').createElmOpsService();
    return service;
  }

  function fail(res, label, err) {
    logger.error(label, { error: err && err.message ? String(err.message).slice(0, 200) : 'unknown' });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }

  function sendAction(res, out) {
    const status = ACTION_HTTP[out && out.status] || 500;
    return res.status(status).json(Object.assign({ ok: status === 200 }, out));
  }

  const router = express.Router();

  router.get('/summary', async function (req, res) {
    try {
      return res.json({ ok: true, data: await svc().summary() });
    } catch (err) {
      return fail(res, 'GET elm-ops/summary failed', err);
    }
  });

  router.get('/kpis', async function (req, res) {
    try {
      const data = await svc().kpis({ from: req.query.from, to: req.query.to });
      if (!data) return res.status(400).json({ ok: false, error: 'invalid_request' });
      return res.json({ ok: true, data: data });
    } catch (err) {
      return fail(res, 'GET elm-ops/kpis failed', err);
    }
  });

  router.get('/followup', async function (req, res) {
    try {
      return res.json({ ok: true, items: await svc().followup(limitOf(req.query.limit)) });
    } catch (err) {
      return fail(res, 'GET elm-ops/followup failed', err);
    }
  });

  router.get('/processes', async function (req, res) {
    try {
      return res.json({ ok: true, items: await svc().listOpenProcesses(limitOf(req.query.limit)) });
    } catch (err) {
      return fail(res, 'GET elm-ops/processes failed', err);
    }
  });

  router.post('/processes/:id/resolve', requireAction, async function (req, res) {
    try {
      return sendAction(res, await svc().resolveProcess(req.params.id, req.body, req.elmActorUserId));
    } catch (err) {
      return fail(res, 'POST elm-ops/processes/:id/resolve failed', err);
    }
  });

  router.get('/review-cases', async function (req, res) {
    try {
      const items = await svc().listReviewCases(req.query.status, limitOf(req.query.limit));
      return res.json({ ok: true, items: items });
    } catch (err) {
      return fail(res, 'GET elm-ops/review-cases failed', err);
    }
  });

  router.post('/review-cases/:id/assign', requireAction, async function (req, res) {
    try {
      return sendAction(res, await svc().assignReviewCase(req.params.id, req.body, req.elmActorUserId));
    } catch (err) {
      return fail(res, 'POST elm-ops/review-cases/:id/assign failed', err);
    }
  });

  router.post('/review-cases/:id/triage', requireAction, async function (req, res) {
    try {
      return sendAction(res, await svc().triageReviewCase(req.params.id, req.body, req.elmActorUserId));
    } catch (err) {
      return fail(res, 'POST elm-ops/review-cases/:id/triage failed', err);
    }
  });

  router.post('/review-cases/:id/resolve', requireAction, async function (req, res) {
    try {
      return sendAction(res, await svc().resolveReviewCase(req.params.id, req.body, req.elmActorUserId));
    } catch (err) {
      return fail(res, 'POST elm-ops/review-cases/:id/resolve failed', err);
    }
  });

  router.get('/assignees', requireAction, async function (req, res) {
    try {
      return res.json({ ok: true, items: await svc().listAssignableUsers() });
    } catch (err) {
      return fail(res, 'GET elm-ops/assignees failed', err);
    }
  });

  router.get('/c1/active-referrals', async function (req, res) {
    try {
      return res.json({ ok: true, items: await svc().listC1ActiveReferrals(limitOf(req.query.limit)) });
    } catch (err) {
      return fail(res, 'GET elm-ops/c1/active-referrals failed', err);
    }
  });

  router.get('/c1/conflicts', async function (req, res) {
    try {
      return res.json({ ok: true, items: await svc().listCzConflicts(req.query.status, limitOf(req.query.limit)) });
    } catch (err) {
      return fail(res, 'GET elm-ops/c1/conflicts failed', err);
    }
  });

  router.post('/c1/conflicts/:id/resolve', requireAction, async function (req, res) {
    try {
      return sendAction(res, await svc().resolveCzConflict(req.params.id, req.body, req.elmActorUserId));
    } catch (err) {
      return fail(res, 'POST elm-ops/c1/conflicts/:id/resolve failed', err);
    }
  });

  router.get('/audit', async function (req, res) {
    try {
      const items = await svc().listAuditEvents(req.query.entity_type, req.query.entity_id);
      if (!items) return res.status(400).json({ ok: false, error: 'invalid_request' });
      return res.json({ ok: true, items: items });
    } catch (err) {
      return fail(res, 'GET elm-ops/audit failed', err);
    }
  });

  return router;
}

module.exports = { createElmOpsRouter };
