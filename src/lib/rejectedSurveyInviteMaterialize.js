'use strict';

/**
 * Materialize rechazados_survey_invite recipient (queued). No provider send.
 */

const logger = require('./logger');
const {
  PURPOSE,
  REASONS,
  buildSurveyInviteIdempotencyKey,
  buildSurveyUrl,
  resolveInviteNombre,
} = require('./rejectedSurveyInvite');
const eligibility = require('./rejectedSurveyInviteEligibility');
const {
  buildUnsubscribeUrl,
  normalizeEmail,
} = require('../services/email-campaigns/unsubscribeToken');
const { assertValidEmailPurpose } = require('../services/email-campaigns/purposes');
const {
  classifyRecipientPayload,
  requireCampaignsFrom,
  buildRecipientPayloadSnapshot,
} = require('../services/email-campaigns/payloadSnapshot');

function isUniqueViolation(err) {
  if (!err) return false;
  const code = err.code != null ? String(err.code) : '';
  const msg = err.message != null ? String(err.message) : '';
  return code === '23505' || /duplicate|unique/i.test(msg);
}

/**
 * Map existing recipient status → API result reason.
 * @param {object} recipient
 */
function mapExistingRecipientResult(recipient) {
  const status = String(recipient.status || '');
  if (status === 'queued') {
    return {
      result: REASONS.ALREADY_PENDING,
      recipient_id: recipient.id,
      status: status,
      email_masked: null,
    };
  }
  if (status === 'sent') {
    return {
      result: REASONS.ALREADY_SENT,
      recipient_id: recipient.id,
      status: status,
      email_masked: null,
    };
  }
  return {
    result: REASONS.PRIOR_ATTEMPT_BLOCKS,
    recipient_id: recipient.id,
    status: status,
    email_masked: null,
  };
}

/**
 * Pre-start snapshot repair uses frozen template source, never the live campaign.
 * Post-start snapshot rows are not rewritten. Legacy rows keep the old var-only repair.
 *
 * @returns {Promise<object|null>} result, or null to fall through to insert
 */
async function repairSurveyInviteRecipient(supabase, args) {
  const { data: existing, error: loadErr } = await supabase
    .from('email_campaign_recipients')
    .select(
      'id, status, email, error_reason, idempotency_key, provider_send_started_at, template_subject_snapshot, template_body_html_snapshot, payload_to, payload_from, payload_subject, payload_html, template_vars',
    )
    .eq('id', args.recipientId)
    .eq('idempotency_key', args.idempotencyKey)
    .maybeSingle();
  if (loadErr) {
    throw new Error('survey invite repair load failed: ' + loadErr.message);
  }
  if (!existing) return null;

  if (classifyRecipientPayload(existing) === 'snapshot') {
    if (existing.provider_send_started_at != null) {
      return {
        ok: false,
        result: REASONS.PRIOR_ATTEMPT_BLOCKS,
        recipient_id: existing.id,
        status: existing.status,
        email_masked: args.emailMasked,
        repaired: false,
      };
    }
    const sourceSubject = existing.template_subject_snapshot;
    const sourceHtml = existing.template_body_html_snapshot;
    if (sourceSubject == null || sourceHtml == null) {
      const err = new Error('payload_snapshot_incomplete');
      err.code = 'PAYLOAD_SNAPSHOT_INCOMPLETE';
      throw err;
    }
    const fromFrozen = existing.payload_from;
    if (fromFrozen == null || String(fromFrozen).trim() === '') {
      const err = new Error('payload_snapshot_incomplete');
      err.code = 'PAYLOAD_SNAPSHOT_INCOMPLETE';
      throw err;
    }
    const snap = buildRecipientPayloadSnapshot({
      to: args.emailNorm,
      from: fromFrozen,
      subject: sourceSubject,
      bodyHtml: sourceHtml,
      templateVars: args.templateVars,
      purpose: args.purpose,
    });
    const { data: repaired, error: repErr } = await supabase
      .from('email_campaign_recipients')
      .update({
        email: snap.email,
        template_vars: snap.template_vars,
        payload_to: snap.payload_to,
        payload_from: snap.payload_from,
        payload_subject: snap.payload_subject,
        payload_html: snap.payload_html,
        template_subject_snapshot: snap.template_subject_snapshot,
        template_body_html_snapshot: snap.template_body_html_snapshot,
        status: 'queued',
        error_reason: null,
        next_attempt_at: null,
      })
      .eq('id', existing.id)
      .eq('idempotency_key', args.idempotencyKey)
      .is('provider_send_started_at', null)
      .select('id, status, email')
      .maybeSingle();
    if (repErr) {
      logger.error('survey invite repair failed', {
        ci: args.ci,
        error: repErr.message,
      });
      throw new Error('survey invite repair failed: ' + repErr.message);
    }
    if (!repaired) return null;
    return {
      ok: true,
      result: 'queued',
      recipient_id: repaired.id,
      status: 'queued',
      email_masked: args.emailMasked,
      repaired: true,
    };
  }

  const { data: repaired, error: repErr } = await supabase
    .from('email_campaign_recipients')
    .update({
      template_vars: args.templateVars,
      email: args.emailNorm,
      status: 'queued',
      error_reason: null,
      next_attempt_at: null,
    })
    .eq('id', args.recipientId)
    .eq('idempotency_key', args.idempotencyKey)
    .select('id, status, email')
    .maybeSingle();
  if (repErr) {
    logger.error('survey invite repair failed', {
      ci: args.ci,
      error: repErr.message,
    });
    throw new Error('survey invite repair failed: ' + repErr.message);
  }
  if (!repaired) return null;
  return {
    ok: true,
    result: 'queued',
    recipient_id: repaired.id,
    status: 'queued',
    email_masked: args.emailMasked,
    repaired: true,
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {unknown} ciRaw
 * @param {string|number|null|undefined} [campaignId]
 *   Explicit campaign for sequence step. If omitted, legacy wave1 env
 *   (Stage 2B single-campaign path only — sequence always passes STEP id).
 */
async function materializeRejectedSurveyInvite(supabase, ciRaw, campaignId) {
  assertValidEmailPurpose(PURPOSE);

  const resolvedCampaignId =
    campaignId != null && String(campaignId).trim() !== ''
      ? String(campaignId).trim()
      : eligibility.getWave1CampaignId();

  const elig = await eligibility.getRejectedSurveyInviteEligibility(
    supabase,
    ciRaw,
    { campaignId: resolvedCampaignId },
  );

  if (!elig.eligible) {
    return {
      ok: false,
      result: elig.reason,
      email_masked: elig.email_masked,
      recipient_id: elig.prior_recipient_id,
      campaign_id: resolvedCampaignId,
      due_step: null,
    };
  }

  const publicBase = eligibility.getEmailPublicBaseUrl();
  if (!resolvedCampaignId || !publicBase) {
    return {
      ok: false,
      result: !resolvedCampaignId
        ? REASONS.CAMPAIGN_NOT_CONFIGURED
        : REASONS.PUBLIC_BASE_URL_MISSING,
      email_masked: elig.email_masked,
      recipient_id: null,
      campaign_id: resolvedCampaignId,
      due_step: null,
    };
  }

  const surveyUrl = buildSurveyUrl(elig.lrw_id);
  const unsubscribeUrl = buildUnsubscribeUrl(publicBase, elig.email);
  const nombre = resolveInviteNombre(elig.nombre);
  const templateVars = {
    nombre: nombre,
    survey_url: surveyUrl,
    unsubscribe_url: unsubscribeUrl,
  };
  const idempotencyKey = buildSurveyInviteIdempotencyKey(
    resolvedCampaignId,
    elig.ci,
  );
  const emailNorm = normalizeEmail(elig.email);

  if (elig.repairable && elig.prior_recipient_id != null) {
    const repaired = await repairSurveyInviteRecipient(supabase, {
      recipientId: elig.prior_recipient_id,
      idempotencyKey: idempotencyKey,
      emailNorm: emailNorm,
      templateVars: templateVars,
      purpose: PURPOSE,
      emailMasked: elig.email_masked,
      ci: elig.ci,
    });
    if (repaired) {
      repaired.campaign_id = resolvedCampaignId;
      return repaired;
    }
  }

  const fromAddr = requireCampaignsFrom();
  const { data: campaign, error: campErr } = await supabase
    .from('email_campaigns')
    .select('id, subject, body_html')
    .eq('id', resolvedCampaignId)
    .maybeSingle();
  if (campErr) {
    throw new Error('survey invite campaign load failed: ' + campErr.message);
  }
  if (!campaign) {
    return {
      ok: false,
      result: REASONS.CAMPAIGN_NOT_CONFIGURED,
      email_masked: elig.email_masked,
      recipient_id: null,
      campaign_id: resolvedCampaignId,
      due_step: null,
    };
  }

  const snap = buildRecipientPayloadSnapshot({
    to: emailNorm,
    from: fromAddr,
    subject: campaign.subject,
    bodyHtml: campaign.body_html,
    templateVars: templateVars,
    purpose: PURPOSE,
  });

  const insertRow = {
    campaign_id: resolvedCampaignId,
    idempotency_key: idempotencyKey,
    ci: String(elig.ci),
    email: snap.email,
    status: 'queued',
    purpose: PURPOSE,
    template_vars: snap.template_vars,
    payload_to: snap.payload_to,
    payload_from: snap.payload_from,
    payload_subject: snap.payload_subject,
    payload_html: snap.payload_html,
    template_subject_snapshot: snap.template_subject_snapshot,
    template_body_html_snapshot: snap.template_body_html_snapshot,
  };

  const { data: inserted, error: insErr } = await supabase
    .from('email_campaign_recipients')
    .insert(insertRow)
    .select('id, status, email, idempotency_key')
    .maybeSingle();

  if (!insErr && inserted) {
    return {
      ok: true,
      result: 'queued',
      recipient_id: inserted.id,
      status: 'queued',
      email_masked: elig.email_masked,
      repaired: false,
      campaign_id: resolvedCampaignId,
    };
  }

  if (!isUniqueViolation(insErr)) {
    logger.error('survey invite insert failed', {
      ci: elig.ci,
      error: insErr && insErr.message,
    });
    throw new Error(
      'survey invite insert failed: ' +
        (insErr && insErr.message ? insErr.message : 'unknown'),
    );
  }

  // Conflict: load by idempotency_key (same logical attempt).
  const { data: existing, error: exErr } = await supabase
    .from('email_campaign_recipients')
    .select('id, status, email, error_reason, idempotency_key')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (exErr) {
    throw new Error('survey invite conflict load failed: ' + exErr.message);
  }
  if (!existing) {
    // Fallback: campaign + email unique
    const { data: byEmail, error: emErr } = await supabase
      .from('email_campaign_recipients')
      .select('id, status, email, error_reason, idempotency_key')
      .eq('campaign_id', resolvedCampaignId)
      .eq('email', emailNorm)
      .maybeSingle();
    if (emErr || !byEmail) {
      throw new Error(
        'survey invite conflict but existing row not found: ' +
          (emErr && emErr.message ? emErr.message : 'missing'),
      );
    }
    const mapped = mapExistingRecipientResult(byEmail);
    mapped.email_masked = elig.email_masked;
    mapped.ok = false;
    mapped.campaign_id = resolvedCampaignId;
    return mapped;
  }

  const mapped = mapExistingRecipientResult(existing);
  mapped.email_masked = elig.email_masked;
  mapped.ok = false;
  mapped.campaign_id = resolvedCampaignId;
  if (mapped.result === REASONS.ALREADY_PENDING) {
    // Concurrent insert that won — treat success-equivalent for caller UX
    return {
      ok: true,
      result: REASONS.ALREADY_PENDING,
      recipient_id: existing.id,
      status: existing.status,
      email_masked: elig.email_masked,
      repaired: false,
      campaign_id: resolvedCampaignId,
    };
  }
  return mapped;
}

module.exports = {
  materializeRejectedSurveyInvite,
  isUniqueViolation,
  mapExistingRecipientResult,
};
