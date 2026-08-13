/**
 * Login / logout / me / one-time admin bootstrap for dashboard users.
 */

const express = require('express');
const env = require('../config/env');
const {
  createSessionToken,
  safeEqualPassword,
  buildSessionCookie,
  authConfigured,
} = require('../middleware/auth');
const { hashPassword, verifyPassword } = require('../lib/passwordHash');
const {
  findUserByEmail,
  findUserById,
  listPermissionSectionKeys,
  countUsers,
  createUser,
} = require('../services/dashboardUsers');
const logger = require('../lib/logger');

const router = express.Router();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /login
 * Body: { email, password }
 */
router.post('/login', async (req, res) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: 'Login no configurado' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = body.email != null ? String(body.email).trim().toLowerCase() : '';
  const password = body.password != null ? String(body.password) : '';

  if (!email || !password) {
    await sleep(500);
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user || !user.active) {
      await sleep(500);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      await sleep(500);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = createSessionToken(user.id);
    res.setHeader('Set-Cookie', buildSessionCookie(token));
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error('POST /login failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Error de login' });
  }
});

/**
 * POST /logout
 */
router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', buildSessionCookie('', { clear: true }));
  return res.status(200).json({ ok: true });
});

/**
 * GET /api/auth/me — mounted AFTER requireAuth in app.js.
 * Resolves user + permissions from DB (never from cookie claims beyond user_id).
 */
async function meHandler(req, res) {
  const userId = req.dashboardUserId;
  if (!userId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  try {
    const user = await findUserById(userId);
    if (!user || !user.active) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const isAdmin = user.is_admin === true;
    const permissions = isAdmin
      ? []
      : await listPermissionSectionKeys(user.id);

    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        is_admin: isAdmin,
      },
      // Empty when is_admin=true — admin has full access to every section.
      permissions,
      access: isAdmin ? 'admin_full' : 'section_permissions',
      note: isAdmin
        ? 'is_admin=true: acceso total a todas las secciones; permissions[] vacío a propósito.'
        : 'permissions lista las section_key permitidas.',
    });
  } catch (err) {
    logger.error('GET /api/auth/me failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'Error al resolver sesión' });
  }
}

/**
 * POST /admin/bootstrap-first-admin
 * One-time: create the first admin using DASHBOARD_LOGIN_PASSWORD.
 * Body: { email, password, bootstrapPassword }
 *
 * After success: REMOVE DASHBOARD_LOGIN_PASSWORD from env — it is not a
 * permanent login fallback.
 */
router.post('/admin/bootstrap-first-admin', async (req, res) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: 'Login no configurado' });
  }

  const shared = env.dashboardLoginPassword;
  if (!shared) {
    return res.status(503).json({
      error:
        'Bootstrap no disponible: DASHBOARD_LOGIN_PASSWORD no está configurada',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = body.email != null ? String(body.email).trim().toLowerCase() : '';
  const password = body.password != null ? String(body.password) : '';
  const bootstrapPassword =
    body.bootstrapPassword != null ? String(body.bootstrapPassword) : '';

  if (!safeEqualPassword(bootstrapPassword, shared)) {
    await sleep(500);
    return res.status(401).json({ error: 'Bootstrap no autorizado' });
  }

  if (!email || !password || password.length < 8) {
    return res.status(400).json({
      error: 'email y password (mín. 8 caracteres) son requeridos',
    });
  }

  try {
    const existing = await countUsers();
    if (existing > 0) {
      return res.status(409).json({
        error:
          'Ya existe al menos un usuario. Bootstrap deshabilitado. Creá colaboradores por SQL.',
      });
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser({
      email,
      passwordHash,
      isAdmin: true,
    });

    logger.info('bootstrap-first-admin created', {
      userId: user.id,
      email: user.email,
    });

    return res.status(201).json({
      ok: true,
      user: { id: user.id, email: user.email, is_admin: true },
      nextStep:
        'Eliminá DASHBOARD_LOGIN_PASSWORD de las variables de entorno. Ya no se usa para login; solo servía para este bootstrap de un solo uso.',
    });
  } catch (err) {
    logger.error('POST /admin/bootstrap-first-admin failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'No se pudo crear el admin' });
  }
});

module.exports = router;
module.exports.meHandler = meHandler;
