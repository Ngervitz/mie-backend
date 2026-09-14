'use strict';

/**
 * Public email unsubscribe.
 * Mount BEFORE requireAuth.
 *
 * GET  /email/unsubscribe?t=…  → confirmation page (no write)
 * POST /email/unsubscribe      → upsert email_suppressions (idempotent)
 */

const express = require('express');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  verifyUnsubscribeToken,
} = require('../services/email-campaigns/unsubscribeToken');

const router = express.Router();

router.use(express.urlencoded({ extended: false }));

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readToken(req) {
  if (req.method === 'GET') {
    return req.query && req.query.t != null ? String(req.query.t) : '';
  }
  if (req.body && req.body.t != null) return String(req.body.t);
  return '';
}

function htmlPage(title, bodyHtml) {
  return (
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' +
    escapeHtml(title) +
    '</title>' +
    '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111}' +
    'button{font-size:1rem;padding:.5rem 1rem;cursor:pointer}</style></head><body>' +
    bodyHtml +
    '</body></html>'
  );
}

/**
 * Idempotent suppress by normalized email.
 * Avoids onConflict on expression unique index lower(email).
 */
async function upsertSuppression(emailNorm) {
  const { data: existing, error: selErr } = await supabase
    .from('email_suppressions')
    .select('id')
    .eq('email', emailNorm)
    .maybeSingle();

  if (selErr) {
    throw new Error('suppression lookup failed: ' + selErr.message);
  }
  if (existing) {
    return { created: false };
  }

  const { error: insErr } = await supabase.from('email_suppressions').insert({
    email: emailNorm,
    reason: 'unsubscribe',
  });

  if (insErr) {
    const msg = insErr.message || '';
    if (/duplicate|unique|23505/i.test(msg)) {
      return { created: false };
    }
    throw new Error('suppression insert failed: ' + msg);
  }
  return { created: true };
}

router.get('/email/unsubscribe', function (req, res) {
  const token = readToken(req);
  const verified = verifyUnsubscribeToken(token);
  if (!verified.ok) {
    if (verified.reason === 'secret_missing') {
      logger.error('email unsubscribe GET: secret missing');
      return res.status(503).send(
        htmlPage(
          'No disponible',
          '<p>El servicio de baja no está configurado.</p>',
        ),
      );
    }
    return res
      .status(400)
      .send(
        htmlPage(
          'Enlace inválido',
          '<p>Este enlace de baja no es válido.</p>',
        ),
      );
  }

  const safeToken = escapeHtml(token);
  const body =
    '<h1>Cancelar suscripción</h1>' +
    '<p>Confirmá que querés dejar de recibir emails de Credizona / Janus.</p>' +
    '<form method="POST" action="/email/unsubscribe">' +
    '<input type="hidden" name="t" value="' +
    safeToken +
    '">' +
    '<button type="submit">Confirmar baja</button>' +
    '</form>';

  return res.status(200).send(htmlPage('Confirmar baja', body));
});

router.post('/email/unsubscribe', async function (req, res) {
  const token = readToken(req);
  const verified = verifyUnsubscribeToken(token);
  if (!verified.ok) {
    if (verified.reason === 'secret_missing') {
      logger.error('email unsubscribe POST: secret missing');
      return res.status(503).send(
        htmlPage(
          'No disponible',
          '<p>El servicio de baja no está configurado.</p>',
        ),
      );
    }
    return res
      .status(400)
      .send(
        htmlPage(
          'Enlace inválido',
          '<p>Este enlace de baja no es válido.</p>',
        ),
      );
  }

  try {
    await upsertSuppression(verified.email);
  } catch (err) {
    logger.error('email unsubscribe POST failed', {
      error: err && err.message ? err.message : String(err),
    });
    return res
      .status(500)
      .send(
        htmlPage(
          'Error',
          '<p>No pudimos procesar la baja. Intentá de nuevo más tarde.</p>',
        ),
      );
  }

  return res
    .status(200)
    .send(
      htmlPage(
        'Baja confirmada',
        '<h1>Baja confirmada</h1><p>Ya no recibirás emails de esta plataforma.</p>',
      ),
    );
});

module.exports = router;
module.exports.upsertSuppression = upsertSuppression;
