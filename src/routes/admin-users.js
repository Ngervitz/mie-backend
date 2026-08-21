/**
 * Admin user management for Janus dashboard.
 * All routes require requireAdmin (mounted in app.js).
 *
 * GET    /api/admin/users
 * POST   /api/admin/users
 * PATCH  /api/admin/users/:id
 * PATCH  /api/admin/users/:id/permissions
 * PATCH  /api/admin/users/:id/password
 */

const express = require('express');
const { hashPassword } = require('../lib/passwordHash');
const { SECTION_KEYS } = require('../middleware/dashboardSections');
const {
  createUser,
  findUserById,
  listUsersWithPermissions,
  replaceUserPermissions,
  updateUser,
  listPermissionSectionKeys,
  setUserPassword,
} = require('../services/dashboardUsers');
const logger = require('../lib/logger');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizePermissions(raw) {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(SECTION_KEYS);
  const out = [];
  for (const item of raw) {
    const key = String(item || '').trim();
    if (allowed.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

router.get('/users', async (req, res) => {
  try {
    const users = await listUsersWithPermissions();
    return res.status(200).json({
      users,
      sectionKeys: [...SECTION_KEYS],
    });
  } catch (err) {
    logger.error('GET /api/admin/users failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'No se pudo listar usuarios' });
  }
});

router.post('/users', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = body.email != null ? String(body.email).trim().toLowerCase() : '';
  const password = body.password != null ? String(body.password) : '';
  const isAdmin = body.is_admin === true;
  const permissions = isAdmin ? [] : normalizePermissions(body.permissions);

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'email inválido' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'password mínimo 8 caracteres' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const user = await createUser({
      email,
      passwordHash,
      isAdmin,
    });

    let assigned = [];
    if (!isAdmin && permissions.length) {
      assigned = await replaceUserPermissions(user.id, permissions);
    }

    return res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        is_admin: user.is_admin === true,
        active: user.active === true,
        permissions: assigned,
      },
    });
  } catch (err) {
    const msg = err && err.message ? err.message : 'unknown';
    if (/duplicate|unique/i.test(msg)) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
    }
    logger.error('POST /api/admin/users failed', { error: msg });
    return res.status(500).json({ error: 'No se pudo crear el usuario' });
  }
});

router.patch('/users/:id/permissions', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id inválido' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const permissions = normalizePermissions(body.permissions);

  try {
    const target = await findUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    if (target.is_admin === true) {
      return res.status(400).json({
        error:
          'Los administradores tienen acceso total; no se asignan section_key',
      });
    }

    const assigned = await replaceUserPermissions(id, permissions);
    return res.status(200).json({
      user: {
        id: target.id,
        email: target.email,
        is_admin: false,
        active: target.active === true,
        permissions: assigned,
      },
    });
  } catch (err) {
    logger.error('PATCH /api/admin/users/:id/permissions failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'No se pudieron actualizar permisos' });
  }
});

router.patch('/users/:id/password', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id inválido' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const password = body.password != null ? String(body.password) : '';
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'password mínimo 8 caracteres' });
  }

  try {
    const target = await findUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const passwordHash = await hashPassword(password);
    const updated = await setUserPassword(id, passwordHash);

    return res.status(200).json({
      user: {
        id: updated.id,
        email: updated.email,
        is_admin: updated.is_admin === true,
        active: updated.active === true,
      },
    });
  } catch (err) {
    logger.error('PATCH /api/admin/users/:id/password failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'No se pudo actualizar la contraseña' });
  }
});

router.patch('/users/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id inválido' });
  }

  const actorId = req.dashboardUserId;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(body, 'active')) {
    if (typeof body.active !== 'boolean') {
      return res.status(400).json({ error: 'active debe ser boolean' });
    }
    patch.active = body.active;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'is_admin')) {
    if (typeof body.is_admin !== 'boolean') {
      return res.status(400).json({ error: 'is_admin debe ser boolean' });
    }
    patch.is_admin = body.is_admin;
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'Nada para actualizar' });
  }

  if (actorId && id === actorId) {
    if (patch.active === false) {
      return res.status(400).json({
        error: 'No podés desactivarte a vos mismo',
      });
    }
    if (patch.is_admin === false) {
      return res.status(400).json({
        error: 'No podés quitarte is_admin a vos mismo',
      });
    }
  }

  try {
    const target = await findUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const updated = await updateUser(id, patch);
    const permissions =
      updated.is_admin === true
        ? []
        : await listPermissionSectionKeys(updated.id);

    return res.status(200).json({
      user: {
        id: updated.id,
        email: updated.email,
        is_admin: updated.is_admin === true,
        active: updated.active === true,
        permissions,
      },
    });
  } catch (err) {
    logger.error('PATCH /api/admin/users/:id failed', {
      error: err && err.message ? err.message : 'unknown',
    });
    return res.status(500).json({ error: 'No se pudo actualizar el usuario' });
  }
});

module.exports = router;
