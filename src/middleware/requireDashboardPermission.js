/**
 * Per-section authorization for Janus dashboard.
 * is_admin → full bypass. Otherwise requires a row in dashboard_user_permissions.
 * Cron (X-Cron-Key) → bypass (machine jobs, no human user).
 */

const {
  findUserById,
  userHasSectionPermission,
} = require('../services/dashboardUsers');
const { resolveSectionForPath, SECTION_KEYS } = require('./dashboardSections');
const { isValidCronKey } = require('./auth');
const logger = require('../lib/logger');

/**
 * @param {string} sectionKey
 * @returns {import('express').RequestHandler}
 */
function requireDashboardPermission(sectionKey) {
  if (!SECTION_KEYS.includes(sectionKey)) {
    throw new Error(`Unknown dashboard section_key: ${sectionKey}`);
  }

  return async function requireDashboardPermissionMiddleware(req, res, next) {
    try {
      if (req.dashboardAuthViaCron || isValidCronKey(req)) {
        return next();
      }

      const userId = req.dashboardUserId;
      if (!userId) {
        return res.status(401).json({ error: 'No autenticado' });
      }

      const user = await findUserById(userId);
      if (!user || !user.active) {
        return res.status(401).json({ error: 'No autenticado' });
      }

      if (user.is_admin === true) {
        return next();
      }

      const allowed = await userHasSectionPermission(userId, sectionKey);
      if (!allowed) {
        return res.status(403).json({
          error: 'Sin permiso para esta sección',
          section: sectionKey,
        });
      }

      return next();
    } catch (err) {
      logger.error('requireDashboardPermission failed', {
        sectionKey,
        error: err && err.message ? err.message : 'unknown',
      });
      return res.status(500).json({ error: 'Error de autorización' });
    }
  };
}

/**
 * For mixed routers (/reports, /jobs, /hugo): resolve section from the
 * central map and enforce. Paths not in the map stay session-only.
 *
 * @type {import('express').RequestHandler}
 */
async function enforceMappedSectionPermission(req, res, next) {
  try {
    const pathname = (req.originalUrl || req.url || '').split('?')[0];
    const sectionKey = resolveSectionForPath(pathname);
    if (!sectionKey) {
      return next();
    }
    return requireDashboardPermission(sectionKey)(req, res, next);
  } catch (err) {
    logger.error('enforceMappedSectionPermission failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Error de autorización' });
  }
}

module.exports = {
  requireDashboardPermission,
  enforceMappedSectionPermission,
};
