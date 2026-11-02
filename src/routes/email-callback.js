'use strict';

/**
 * Public ELM callback confirmation (GET page / POST event). Mount before requireAuth.
 */

const express = require('express');
const logger = require('../lib/logger');
const {
  lookupCallbackImpact,
  findCallbackConfirmed,
  confirmElmCallback,
} = require('../lib/elmCallbackConfirm');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlPage(title, bodyHtml) {
  return (
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111}' +
    'button{font-size:1rem;padding:.5rem 1rem;cursor:pointer}</style></head><body>' +
    bodyHtml + '</body></html>'
  );
}

function invalidPage(res, status) {
  return res.status(status || 400).send(
    htmlPage('Enlace inválido', '<p>Este enlace no es válido o ya no está disponible.</p>'),
  );
}

router.get('/email/callback/:token', async function (req, res) {
  const token = String((req.params && req.params.token) || '').trim();
  try {
    const supabase = require('../clients/supabase');
    const looked = await lookupCallbackImpact(supabase, token);
    if (!looked.ok) {
      return invalidPage(res, looked.reason === 'invalid_token' ? 400 : 404);
    }
    const existing = await findCallbackConfirmed(supabase, looked.impact.id);
    res.set('Cache-Control', 'private, no-store');
    if (existing) {
      return res.status(200).send(
        htmlPage(
          'Pedido registrado',
          '<h1>Ya registramos tu pedido</h1><p>Vamos a llamarte para ayudarte a continuar con la gestión.</p>',
        ),
      );
    }
    const safeToken = escapeHtml(token);
    return res.status(200).send(
      htmlPage(
        'Confirmar llamada',
        '<h1>¿Querés que te llamemos?</h1>' +
          '<p>Confirmá que querés recibir una llamada del equipo de Credizona.</p>' +
          '<form method="POST" action="/email/callback/' + safeToken + '">' +
          '<button type="submit">Quiero que me llamen</button></form>',
      ),
    );
  } catch (err) {
    logger.error('email callback GET failed', { error: err && err.message ? err.message : String(err) });
    return res.status(500).send(htmlPage('Error', '<p>No pudimos abrir esta página.</p>'));
  }
});

router.post('/email/callback/:token', async function (req, res) {
  const token = String((req.params && req.params.token) || '').trim();
  try {
    const supabase = require('../clients/supabase');
    const out = await confirmElmCallback(supabase, token);
    if (!out.ok) {
      return invalidPage(res, out.reason === 'invalid_token' ? 400 : 404);
    }
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).send(
      htmlPage(
        'Pedido registrado',
        '<h1>Pedido registrado</h1><p>Confirmamos que querés recibir una llamada.</p>',
      ),
    );
  } catch (err) {
    logger.error('email callback POST failed', { error: err && err.message ? err.message : String(err) });
    return res.status(500).send(htmlPage('Error', '<p>No pudimos registrar tu pedido.</p>'));
  }
});

module.exports = router;
