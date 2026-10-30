'use strict';

/**
 * One welcome email after a successful affiliate registration.
 * Uses email_campaigns + email_campaign_recipients and the existing provider.
 * Does not send on invite, click, OTP request, or an already-registered CI.
 */

const { EMAIL_PURPOSES } = require('../services/email-campaigns/purposes');
const { applyTemplate } = require('../services/email-campaigns/renderTemplate');
const { buildReferralUrl } = require('./affiliateJoinContract');
const { parseCi } = require('./affiliateDirectory');

const AFFILIATE_WELCOME_SUBJECT =
  '¡Bienvenido a Credizona! Empezá a ganar recomendándonos';

const AFFILIATE_WELCOME_CAMPAIGN_NAME = 'Affiliate welcome';

const AFFILIATE_WELCOME_IDEMPOTENCY_PREFIX = 'affiliate-welcome:';

const WELCOME_BODY_TEMPLATE = [
  '<!DOCTYPE html>',
  '<html lang="es">',
  '<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>',
  '<body style="margin:0;padding:0;background-color:#f4f6f8;">',
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f6f8;">',
  '<tr><td align="center" style="padding:16px 12px 24px;">',
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background-color:#ffffff;">',
  '<tr><td style="padding:28px 28px 8px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#1a3a4a;">',
  '<p style="margin:0 0 16px;">{{saludo}}</p>',
  '<p style="margin:0 0 16px;">Primero que nada, muchas gracias por sumarte a Credizona y confiar en nosotros.</p>',
  '<p style="margin:0 0 16px;">Estamos dando los primeros pasos con nuestro programa de afiliados y, por ahora, es una prueba piloto con un grupo reducido de personas.</p>',
  '<p style="margin:0 0 16px;">Nuestra idea es que, si los resultados son buenos, podamos ampliar el programa y que tengas una nueva oportunidad de ganar dinero recomendando Credizona.</p>',
  '<p style="margin:0 0 16px;">Recordá que podés ganar <strong>$500 por cada préstamo efectivamente otorgado</strong> a una persona nueva que llegue a través de tu enlace, hasta un máximo de cinco préstamos remunerados.</p>',
  '<p style="margin:0 0 8px;"><strong>Este es tu enlace personal para compartir:</strong></p>',
  '<p style="margin:0 0 16px;"><a href="{{affiliate_url}}" target="_blank" rel="noopener noreferrer" style="color:#0d7a5f;font-weight:bold;">{{affiliate_url}}</a></p>',
  '<p style="margin:0 0 16px;">Podés enviarlo por WhatsApp a familiares, amigos o conocidos que estén buscando un préstamo.</p>',
  '<p style="margin:0 0 16px;">¡Gracias por ser parte de esta primera etapa!</p>',
  '<p style="margin:0;">Un abrazo,</p>',
  '<p style="margin:0;"><strong>Equipo Credizona</strong></p>',
  '</td></tr></table></td></tr></table></body></html>',
].join('');

function welcomeIdempotencyKey(affiliateId) {
  return AFFILIATE_WELCOME_IDEMPOTENCY_PREFIX + String(affiliateId);
}

function providerIdempotencyKey(affiliateId) {
  return 'janus-affiliate-welcome:' + String(affiliateId);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isValidAffiliateEmail(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s.length > 254 || /\s/.test(s)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * Dashboard label. OK means the provider accepted the message, not mailbox delivery.
 * @param {{ status?: string, provider_message_id?: string|null }|null} recipient
 * @param {boolean} hasValidEmail
 */
function welcomeEmailDashboardLabel(recipient, hasValidEmail) {
  if (recipient) {
    const status = String(recipient.status || '');
    if (status === 'sent' && recipient.provider_message_id) return 'OK';
    if (status === 'failed' || status === 'bounced') return 'Error';
    return 'Pendiente';
  }
  return hasValidEmail ? 'Pendiente' : 'Sin email';
}

function welcomeSaludo(nombre) {
  const name = nombre != null ? String(nombre).trim() : '';
  if (!name) return '¡Hola!';
  return '¡Hola, ' + name + '!';
}

function renderWelcome(nombre, affiliateUrl) {
  const safeUrl = escapeHtml(affiliateUrl);
  return applyTemplate(WELCOME_BODY_TEMPLATE, {
    saludo: escapeHtml(welcomeSaludo(nombre)),
    affiliate_url: safeUrl,
  });
}

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data) return [data];
  return [];
}

async function loadContact(supabase, ci) {
  const { data, error } = await supabase
    .from('cz_funnel_solicitudes')
    .select('ci, email, nombre, apellido, cz_id')
    .eq('ci', ci);
  if (error) throw error;
  const rows = rowsOf(data);
  let best = null;
  let email = null;
  let nombre = null;
  rows.forEach(function (row) {
    const czId = Number(row.cz_id);
    const newer = !best || (Number.isFinite(czId) && czId >= best);
    if (newer) best = Number.isFinite(czId) ? czId : best;
    if (newer && row.nombre != null && String(row.nombre).trim()) {
      nombre = String(row.nombre).trim();
    } else if (!nombre && row.nombre != null && String(row.nombre).trim()) {
      nombre = String(row.nombre).trim();
    }
    const candidate = row.email != null ? String(row.email).trim() : '';
    if (newer && isValidAffiliateEmail(candidate)) email = candidate.toLowerCase();
    else if (!email && isValidAffiliateEmail(candidate)) email = candidate.toLowerCase();
  });
  return { email: email, nombre: nombre };
}

async function ensureWelcomeCampaign(supabase) {
  const { data: existing, error: readErr } = await supabase
    .from('email_campaigns')
    .select('id, name')
    .eq('name', AFFILIATE_WELCOME_CAMPAIGN_NAME)
    .limit(1);
  if (readErr) throw readErr;
  const found = rowsOf(existing)[0];
  if (found && found.id != null) return found;

  const { data: created, error } = await supabase
    .from('email_campaigns')
    .insert({
      name: AFFILIATE_WELCOME_CAMPAIGN_NAME,
      subject: AFFILIATE_WELCOME_SUBJECT,
      body_html: WELCOME_BODY_TEMPLATE,
      audience_mode: 'DIRECTED',
      segment_id: null,
      segment_rules_snapshot: null,
      status: 'sending',
    })
    .select('id, name')
    .single();
  if (error) {
    if (error.code === '23505') {
      const again = await supabase
        .from('email_campaigns')
        .select('id, name')
        .eq('name', AFFILIATE_WELCOME_CAMPAIGN_NAME)
        .limit(1);
      const row = rowsOf(again.data)[0];
      if (row) return row;
    }
    throw error;
  }
  return created;
}

async function findWelcomeRecipient(supabase, affiliateId) {
  const { data, error } = await supabase
    .from('email_campaign_recipients')
    .select('id, status, provider_message_id, idempotency_key, email')
    .eq('idempotency_key', welcomeIdempotencyKey(affiliateId))
    .limit(1);
  if (error) throw error;
  return rowsOf(data)[0] || null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id: string, code: string, ci: number }} affiliate
 * @param {{ send?: function, referralOrigin?: string, from?: string }} [opts]
 */
async function sendAffiliateWelcomeEmail(supabase, affiliate, opts) {
  const o = opts || {};
  if (!affiliate || !affiliate.id || !affiliate.code) {
    return { ok: false, status: 'error', reason: 'affiliate_incomplete' };
  }
  const ci = parseCi(affiliate.ci);
  if (ci == null) {
    return { ok: false, status: 'sin_email', reason: 'missing_ci' };
  }

  const existing = await findWelcomeRecipient(supabase, affiliate.id);
  if (existing && existing.status === 'sent' && existing.provider_message_id) {
    return { ok: true, status: 'ok', already_sent: true };
  }
  if (existing && (existing.status === 'failed' || existing.status === 'bounced')) {
    return { ok: true, status: 'error', already_attempted: true };
  }

  const contact = await loadContact(supabase, ci);
  if (!contact.email) {
    return { ok: true, status: 'sin_email', reason: 'sin_email', sent: false };
  }

  const affiliateUrl = buildReferralUrl(affiliate.code, o.referralOrigin);
  const html = renderWelcome(contact.nombre, affiliateUrl);
  const fromAddr = String(
    o.from != null ? o.from : process.env.EMAIL_CAMPAIGNS_FROM || '',
  ).trim();

  const campaign = await ensureWelcomeCampaign(supabase);
  const nowIso = new Date().toISOString();
  let recipient = existing;

  if (!recipient) {
    const { data, error } = await supabase
      .from('email_campaign_recipients')
      .insert({
        campaign_id: campaign.id,
        idempotency_key: welcomeIdempotencyKey(affiliate.id),
        ci: String(ci),
        email: contact.email,
        status: 'queued',
        purpose: EMAIL_PURPOSES.AFFILIATE_WELCOME,
        template_vars: {
          nombre: contact.nombre || '',
          saludo: welcomeSaludo(contact.nombre),
          affiliate_url: affiliateUrl,
        },
        payload_to: contact.email,
        payload_from: fromAddr || null,
        payload_subject: AFFILIATE_WELCOME_SUBJECT,
        payload_html: html,
        attempt_count: 0,
      })
      .select('id, status, provider_message_id, idempotency_key, email')
      .single();
    if (error) {
      if (error.code === '23505') {
        recipient = await findWelcomeRecipient(supabase, affiliate.id);
        if (recipient && recipient.status === 'sent' && recipient.provider_message_id) {
          return { ok: true, status: 'ok', already_sent: true };
        }
      }
      if (!recipient) throw error;
    } else {
      recipient = data;
    }
  }

  if (!fromAddr) {
    await supabase
      .from('email_campaign_recipients')
      .update({
        status: 'failed',
        error_reason: 'EMAIL_CAMPAIGNS_FROM is not configured',
        last_attempt_at: nowIso,
        attempt_count: 1,
      })
      .eq('id', recipient.id);
    return { ok: false, status: 'error', reason: 'from_missing' };
  }

  const send =
    typeof o.send === 'function'
      ? o.send
      : async function defaultSend(args) {
          const { getEmailProvider } = require('../services/email-provider');
          return getEmailProvider().send(args);
        };

  try {
    const result = await send({
      to: contact.email,
      subject: AFFILIATE_WELCOME_SUBJECT,
      html: html,
      from: fromAddr,
      idempotencyKey: providerIdempotencyKey(affiliate.id),
    });
    const messageId =
      result && result.providerMessageId != null
        ? String(result.providerMessageId)
        : '';
    if (!messageId) {
      throw new Error('provider accepted the call without providerMessageId');
    }
    await supabase
      .from('email_campaign_recipients')
      .update({
        status: 'sent',
        provider_message_id: messageId,
        sent_at: nowIso,
        last_attempt_at: nowIso,
        attempt_count: 1,
        error_reason: null,
        payload_html: html,
        payload_subject: AFFILIATE_WELCOME_SUBJECT,
      })
      .eq('id', recipient.id);
    return { ok: true, status: 'ok', provider_message_id: messageId };
  } catch (err) {
    await supabase
      .from('email_campaign_recipients')
      .update({
        status: 'failed',
        error_reason: err && err.message ? String(err.message) : 'send failed',
        last_attempt_at: nowIso,
        attempt_count: 1,
      })
      .eq('id', recipient.id);
    return { ok: false, status: 'error', reason: 'provider_rejected' };
  }
}

module.exports = {
  AFFILIATE_WELCOME_SUBJECT,
  AFFILIATE_WELCOME_CAMPAIGN_NAME,
  AFFILIATE_WELCOME_IDEMPOTENCY_PREFIX,
  WELCOME_BODY_TEMPLATE,
  welcomeIdempotencyKey,
  providerIdempotencyKey,
  isValidAffiliateEmail,
  welcomeEmailDashboardLabel,
  renderWelcome,
  sendAffiliateWelcomeEmail,
};
