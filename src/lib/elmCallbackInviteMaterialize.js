'use strict';

/**
 * One-shot DIRECTED materializer for elm_callback_invite.
 * Universe is the hardcoded 7 cz_solicitud_id pairs. No segment engine. No cron.
 */

const logger = require('./logger');
const {
  PURPOSE,
  REASONS,
  AUTHORIZED_CASES,
  TEMPLATE_SUBJECT,
  TEMPLATE_BODY_HTML,
  authorizedCzIds,
  isAuthorizedPair,
  isExcludedPair,
  applyPreparedEmailCorrection,
  isValidEmail,
  buildIdempotencyKey,
  buildCallbackConfirmUrl,
  resolveNombre,
  maskEmail,
} = require('./elmCallbackInvite');
const { EMAIL_AUDIENCE_MODES } = require('../services/email-campaigns/audienceMode');
const {
  buildUnsubscribeUrl,
  normalizeEmail,
  resolveEmailPublicBaseUrl,
} = require('../services/email-campaigns/unsubscribeToken');
const { assertValidEmailPurpose } = require('../services/email-campaigns/purposes');
const { requireCampaignsFrom } = require('../services/email-campaigns/payloadSnapshot');
const { upsertEmailSurveyInviteRecipientImpact } = require('./emailClickTracking');
const { applySurveyInviteSnapshot } = require('./rejectedSurveyInviteMaterialize');
const { loadEmailSuppressionsByEmails } = require('./emailSuppressionsRead');

function campaignAudienceMode(campaign) {
  return campaign && campaign.audience_mode != null
    ? String(campaign.audience_mode).trim()
    : '';
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string|number} campaignId
 */
async function loadDirectedCampaign(supabase, campaignId) {
  const { data, error } = await supabase
    .from('email_campaigns')
    .select('id, name, status, audience_mode, segment_id, subject, body_html')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) {
    throw new Error('elm callback campaign load failed: ' + error.message);
  }
  if (!data) {
    const err = new Error('campaign not found');
    err.code = REASONS.CAMPAIGN_NOT_CONFIGURED;
    err.statusCode = 404;
    throw err;
  }
  if (campaignAudienceMode(data) !== EMAIL_AUDIENCE_MODES.DIRECTED) {
    const err = new Error(
      'elm_callback_invite requires a DIRECTED campaign (generic materialize is not allowed)',
    );
    err.code = REASONS.CAMPAIGN_NOT_DIRECTED;
    err.statusCode = 400;
    throw err;
  }
  if (data.segment_id != null) {
    const err = new Error('DIRECTED elm_callback_invite campaign must not have segment_id');
    err.code = REASONS.CAMPAIGN_NOT_DIRECTED;
    err.statusCode = 400;
    throw err;
  }
  return data;
}

async function assertNoForeignRecipients(supabase, campaignId) {
  const { data, error } = await supabase
    .from('email_campaign_recipients')
    .select('id, purpose, cz_solicitud_id, ci')
    .eq('campaign_id', campaignId);
  if (error) {
    throw new Error('elm callback recipients load failed: ' + error.message);
  }
  const rows = data || [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const purpose = row.purpose != null ? String(row.purpose).trim() : '';
    if (purpose !== PURPOSE || !isAuthorizedPair(row.ci, row.cz_solicitud_id)) {
      const err = new Error(
        'campaign already has recipients outside the elm_callback_invite allowlist',
      );
      err.code = REASONS.FOREIGN_RECIPIENTS;
      err.statusCode = 409;
      throw err;
    }
  }
  return rows;
}

async function loadAuthorizedSolicitudes(supabase) {
  const czIds = authorizedCzIds();
  const { data, error } = await supabase
    .from('cz_funnel_solicitudes')
    .select('cz_id, ci, nombre, apellido, email, celular')
    .in('cz_id', czIds);
  if (error) {
    throw new Error('elm callback solicitudes load failed: ' + error.message);
  }
  const byCz = new Map();
  for (let i = 0; i < (data || []).length; i += 1) {
    const row = data[i];
    const cz = Number(row.cz_id);
    if (Number.isSafeInteger(cz)) byCz.set(cz, row);
  }
  return byCz;
}

async function materializeOne(supabase, args) {
  const unit = await upsertEmailSurveyInviteRecipientImpact(supabase, {
    idempotencyKey: args.idempotencyKey,
    campaignId: args.campaignId,
    ci: args.ci,
    email: args.emailNorm,
    purpose: PURPOSE,
    destinationUrl: args.destinationUrl,
    czSolicitudId: args.czSolicitudId,
  });

  const callbackUrl = buildCallbackConfirmUrl(unit.tracking_token, args.publicBase);
  const unsubscribeUrl = buildUnsubscribeUrl(args.publicBase, args.emailNorm);
  const templateVars = {
    nombre: args.nombre,
    callback_url: callbackUrl,
    unsubscribe_url: unsubscribeUrl,
  };

  if (unit.provider_send_started_at) {
    return {
      ok: false,
      result: unit.status === 'sent' ? REASONS.ALREADY_SENT : REASONS.PRIOR_ATTEMPT_BLOCKS,
      recipient_id: unit.recipient_id,
      cz_solicitud_id: args.czSolicitudId,
      ci: args.ci,
      email_masked: args.emailMasked,
      marketing_impact_id: unit.impact_id,
      tracking_token: unit.tracking_token,
      email_corrected: args.emailCorrected,
    };
  }

  const applied = await applySurveyInviteSnapshot(supabase, {
    recipientId: unit.recipient_id,
    idempotencyKey: args.idempotencyKey,
    emailNorm: args.emailNorm,
    templateVars: templateVars,
    purpose: PURPOSE,
    emailMasked: args.emailMasked,
    ci: args.ci,
    campaignId: args.campaignId,
  });
  if (!applied) {
    throw new Error('elm callback snapshot apply returned empty');
  }
  return {
    ok: applied.ok !== false,
    result: applied.result || REASONS.QUEUED,
    recipient_id: applied.recipient_id || unit.recipient_id,
    cz_solicitud_id: args.czSolicitudId,
    ci: args.ci,
    email_masked: args.emailMasked,
    marketing_impact_id: unit.impact_id,
    tracking_token: unit.tracking_token,
    email_corrected: args.emailCorrected,
    callback_url: callbackUrl,
  };
}

/**
 * Materialize exactly the 7 authorized solicitudes onto a DIRECTED campaign.
 * Does not send. Does not write CZ/ELM state. Does not UPDATE funnel emails.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string|number} campaignId
 */
async function materializeElmCallbackInviteCampaign(supabase, campaignId) {
  assertValidEmailPurpose(PURPOSE);
  requireCampaignsFrom();

  const publicBase = resolveEmailPublicBaseUrl();
  if (!publicBase) {
    const err = new Error('EMAIL_PUBLIC_BASE_URL is not configured');
    err.code = REASONS.PUBLIC_BASE_URL_MISSING;
    err.statusCode = 500;
    throw err;
  }

  const campaign = await loadDirectedCampaign(supabase, campaignId);
  await assertNoForeignRecipients(supabase, campaign.id);

  const subject = campaign.subject != null && String(campaign.subject).trim() !== ''
    ? String(campaign.subject)
    : TEMPLATE_SUBJECT;
  const bodyHtml =
    campaign.body_html != null && String(campaign.body_html).trim() !== ''
      ? String(campaign.body_html)
      : TEMPLATE_BODY_HTML;

  if (subject.indexOf('{{') === -1 && bodyHtml.indexOf('{{callback_url}}') === -1) {
    logger.warn('elm callback campaign body missing {{callback_url}} placeholder', {
      campaign_id: campaign.id,
    });
  }

  const byCz = await loadAuthorizedSolicitudes(supabase);
  const candidates = [];
  const skipped = [];

  for (let i = 0; i < AUTHORIZED_CASES.length; i += 1) {
    const authorized = AUTHORIZED_CASES[i];
    const row = byCz.get(authorized.cz_solicitud_id);
    if (!row) {
      skipped.push({
        ci: authorized.ci,
        cz_solicitud_id: authorized.cz_solicitud_id,
        result: REASONS.NOT_AUTHORIZED,
        email_masked: null,
      });
      continue;
    }
    if (isExcludedPair(row.ci, row.cz_id)) {
      skipped.push({
        ci: authorized.ci,
        cz_solicitud_id: authorized.cz_solicitud_id,
        result: REASONS.NOT_AUTHORIZED,
        email_masked: null,
      });
      continue;
    }
    if (!isAuthorizedPair(row.ci, row.cz_id)) {
      skipped.push({
        ci: authorized.ci,
        cz_solicitud_id: authorized.cz_solicitud_id,
        result: REASONS.CI_MISMATCH,
        email_masked: null,
      });
      continue;
    }
    const corrected = applyPreparedEmailCorrection(row.ci, row.cz_id, row.email);
    const emailRaw = corrected.email;
    if (!emailRaw) {
      skipped.push({
        ci: authorized.ci,
        cz_solicitud_id: authorized.cz_solicitud_id,
        result: REASONS.MISSING_EMAIL,
        email_masked: null,
        email_corrected: corrected.corrected,
      });
      continue;
    }
    if (!isValidEmail(emailRaw)) {
      skipped.push({
        ci: authorized.ci,
        cz_solicitud_id: authorized.cz_solicitud_id,
        result: REASONS.INVALID_EMAIL,
        email_masked: maskEmail(emailRaw),
        email_corrected: corrected.corrected,
      });
      continue;
    }
    candidates.push({
      authorized: authorized,
      row: row,
      emailNorm: normalizeEmail(emailRaw),
      emailCorrected: corrected.corrected,
      nombre: resolveNombre(row.nombre),
    });
  }

  const suppressionLoad = await loadEmailSuppressionsByEmails(
    supabase,
    candidates.map(function (c) {
      return c.emailNorm;
    }),
  );
  if (!suppressionLoad.ok) {
    const err = new Error('email_suppressions unavailable; refusing elm callback materialize');
    err.code = REASONS.SUPPRESSIONS_UNAVAILABLE;
    err.statusCode = 503;
    throw err;
  }

  const destinationUrl = publicBase + '/email/callback';
  const recipients = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (suppressionLoad.emails.has(c.emailNorm)) {
      skipped.push({
        ci: c.authorized.ci,
        cz_solicitud_id: c.authorized.cz_solicitud_id,
        result: REASONS.EMAIL_SUPPRESSED,
        email_masked: maskEmail(c.emailNorm),
        email_corrected: c.emailCorrected,
      });
      continue;
    }
    const out = await materializeOne(supabase, {
      campaignId: campaign.id,
      publicBase: publicBase,
      destinationUrl: destinationUrl,
      czSolicitudId: c.authorized.cz_solicitud_id,
      ci: c.authorized.ci,
      emailNorm: c.emailNorm,
      emailMasked: maskEmail(c.emailNorm),
      emailCorrected: c.emailCorrected,
      nombre: c.nombre,
      idempotencyKey: buildIdempotencyKey(campaign.id, c.authorized.cz_solicitud_id),
      subject: subject,
      bodyHtml: bodyHtml,
    });
    recipients.push(out);
  }

  const queued = recipients.filter(function (r) {
    return r.ok && r.result === REASONS.QUEUED;
  }).length;

  const { error: countErr } = await supabase
    .from('email_campaigns')
    .update({
      recipient_count: recipients.length,
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaign.id);
  if (countErr) {
    logger.warn('elm callback recipient_count update failed', {
      campaign_id: campaign.id,
      error: countErr.message,
    });
  }

  logger.info('elm callback invite materialized', {
    campaign_id: campaign.id,
    authorized: AUTHORIZED_CASES.length,
    queued: queued,
    skipped: skipped.length,
  });

  return {
    campaign_id: campaign.id,
    purpose: PURPOSE,
    authorized_count: AUTHORIZED_CASES.length,
    queued: queued,
    recipients: recipients,
    skipped: skipped,
  };
}

module.exports = {
  materializeElmCallbackInviteCampaign,
  loadDirectedCampaign,
};
