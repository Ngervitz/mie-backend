'use strict';

/**
 * Action gate for ELM routes (sends PII to a third party). Mounted AFTER the section gate.
 *
 * - Section read permission ('preaprobados') does NOT grant this action.
 * - X-Cron-Key is rejected here even though requireAuth / requireDashboardPermission let it
 *   through: ELM actions need a human session (trigger_origin janus_manual + user id).
 * - Fase 1A: admin-only (dashboard_users.is_admin). A dedicated permission key can replace this
 *   later without touching the orchestrator.
 */

const { findUserById } = require('../services/dashboardUsers');
const { isValidCronKey } = require('./auth');
const logger = require('../lib/logger');

async function requireElmAction(req, res, next) {
  try {
    if (req.dashboardAuthViaCron || isValidCronKey(req)) {
      return res.status(403).json({
        error: 'Acción ELM no disponible por cron',
        code: 'elm_cron_forbidden',
      });
    }

    const userId = req.dashboardUserId;
    if (!userId) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const user = await findUserById(userId);
    if (!user || !user.active) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    if (user.is_admin !== true) {
      return res.status(403).json({
        error: 'Sin permiso para ejecutar acciones ELM',
        code: 'elm_action_forbidden',
      });
    }

    req.elmActorUserId = String(user.id || userId);
    return next();
  } catch (err) {
    logger.error('requireElmAction failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Error de autorización' });
  }
}

module.exports = { requireElmAction };
