/**
 * Login / logout for shared-password dashboard auth.
 */

const express = require('express');
const env = require('../config/env');
const {
  createSessionToken,
  safeEqualPassword,
  buildSessionCookie,
  authConfigured,
} = require('../middleware/auth');

const router = express.Router();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /login
 * Body: { password }
 */
router.post('/login', async (req, res) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: 'Login no configurado' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const password = body.password != null ? String(body.password) : '';

  if (!safeEqualPassword(password, env.dashboardLoginPassword)) {
    await sleep(500);
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  const token = createSessionToken();
  res.setHeader('Set-Cookie', buildSessionCookie(token));
  return res.status(200).json({ ok: true });
});

/**
 * POST /logout
 */
router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', buildSessionCookie('', { clear: true }));
  return res.status(200).json({ ok: true });
});

module.exports = router;
