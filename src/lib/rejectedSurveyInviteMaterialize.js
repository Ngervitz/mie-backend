'use strict';

/**
 * Materialize rechazados_survey_invite recipient (queued). No provider send.
 *
 * Flow:
 *   eligibility → REAL_SURVEY_URL → RPC(recipient+impact+link[+reopen completed→sending])
 *   → PUBLIC_TRACKED_URL → templateVars.survey_url → buildRecipientPayloadSnapshot → UPDATE recipient
 *
 * RPC unit is atomic (incl. continuous-campaign reopen when migration applied).
 * RPC→snapshot frontier is not.
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
const {
  buildEmailClickTrackedUrl,
  upsertEmailSurveyInviteRecipientImpact,
} = require('./emailClickTracking');

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
 * Apply / refresh frozen snapshot on a recipient that already has marketing_impact_id.
 * Pre-start only (provider_send_started_at IS NULL).
 *
 * @returns {Promise<object|null>}
 */
async function applySurveyInviteSnapshot(supabase, args) {
  const { data: existing, error: loadErr } = await supabase
    .from('email_campaign_recipients')
    .select(
      'id, status, email, error_reason, idempotency_key, provider_send_started_at, marketing_impact_id, template_subject_snapshot, template_body_html_snapshot, payload_to, payload_from, payload_subject, payload_html, template_vars',
    )
    .eq('id', args.recipientId)
    .eq('idempotency_key', args.idempotencyKey)
    .maybeSingle();
  if (loadErr) {
    throw new Error('survey invite snapshot load failed: ' + loadErr.message);
  }
  if (!existing) return null;

  if (existing.provider_send_started_at != null) {
    return {
      ok: false,
      result: REASONS.PRIOR_ATTEMPT_BLOCKS,
      recipient_id: existing.id,
      status: existing.status,
      email_masked: args.emailMasked,
      repaired: false,
      marketing_impact_id: existing.marketing_impact_id || null,
    };
  }

  let sourceSubject = existing.template_subject_snapshot;
  let sourceHtml = existing.template_body_html_snapshot;
  let fromAddr = existing.payload_from;

  if (
    sourceSubject == null ||
    sourceHtml == null ||
    fromAddr == null ||
    String(fromAddr).trim() === ''
  ) {
    const { data: campaign, error: campErr } = await supabase
      .from('email_campaigns')
      .select('id, subject, body_html')
      .eq('id', args.campaignId)
      .maybeSingle();
    if (campErr) {
      throw new Error('survey invite campaign load failed: ' + campErr.message);
    }
    if (!campaign) {
      return {
        ok: false,
        result: REASONS.CAMPAIGN_NOT_CONFIGURED,
        email_masked: args.emailMasked,
        recipient_id: existing.id,
        status: existing.status,
        repaired: false,
        marketing_impact_id: existing.marketing_impact_id || null,
      };
    }
    if (sourceSubject == null) sourceSubject = campaign.subject;
    if (sourceHtml == null) sourceHtml = campaign.body_html;
    if (fromAddr == null || String(fromAddr).trim() === '') {
      fromAddr = requireCampaignsFrom();
    }
  }

  const snap = buildRecipientPayloadSnapshot({
    to: args.emailNorm,
    from: fromAddr,
    subject: sourceSubject,
    bodyHtml: sourceHtml,
    templateVars: args.templateVars,
    purpose: args.purpose,
  });

  const { data: updated, error: updErr } = await supabase
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
    .select('id, status, email, marketing_impact_id')
    .maybeSingle();

  if (updErr) {
    logger.error('survey invite snapshot update failed', {
      ci: args.ci,
      error: updErr.message,
    });
    throw new Error('survey invite snapshot update failed: ' + updErr.message);
  }
  if (!updated) return null;

  const hadCompleteSnapshot =
    classifyRecipientPayload(existing) === 'snapshot' &&
    existing.payload_html != null &&
    String(existing.payload_html).trim() !== '';
  const wasFailedAttempt =
    String(existing.status || '') === 'failed' ||
    (existing.error_reason != null && String(existing.error_reason).trim() !== '');

  return {
    ok: true,
    result: 'queued',
    recipient_id: updated.id,
    status: 'queued',
    email_masked: args.emailMasked,
    repaired: hadCompleteSnapshot || wasFailedAttempt,
    marketing_impact_id: updated.marketing_impact_id || null,
  };
}

/**
 * Pre-start snapshot repair — kept for callers/tests; uses tracked templateVars.
 * Prefer materializeRejectedSurveyInvite which runs RPC first.
 *
 * @returns {Promise<object|null>}
 */
async function repairSurveyInviteRecipient(supabase, args) {
  return applySurveyInviteSnapshot(supabase, {
    recipientId: args.recipientId,
    idempotencyKey: args.idempotencyKey,
    emailNorm: args.emailNorm,
    templateVars: args.templateVars,
    purpose: args.purpose,
    emailMasked: args.emailMasked,
    ci: args.ci,
    campaignId: args.campaignId,
  });
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {unknown} ciRaw
 * @param {string|number|null|undefined} [campaignId]
 * @param {{ czSolicitudId?: string|number|null }} [opts]
 *   czSolicitudId — optional explicit episode for historical pilot materialize.
 *   When omitted, eligibility uses global last-rejection-by-CI (normal flow).
 */
async function materializeRejectedSurveyInvite(
  supabase,
  ciRaw,
  campaignId,
  opts,
) {
  assertValidEmailPurpose(PURPOSE);

  const resolvedCampaignId =
    campaignId != null && String(campaignId).trim() !== ''
      ? String(campaignId).trim()
      : eligibility.getWave1CampaignId();

  const options = opts || {};
  const eligOpts = { campaignId: resolvedCampaignId };
  if (
    options.czSolicitudId != null &&
    String(options.czSolicitudId).trim() !== ''
  ) {
    eligOpts.czSolicitudId = options.czSolicitudId;
  }

  const elig = await eligibility.getRejectedSurveyInviteEligibility(
    supabase,
    ciRaw,
    eligOpts,
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

  const czSolicitudId =
    elig.cz_solicitud_id != null ? Number(elig.cz_solicitud_id) : null;
  if (czSolicitudId == null || !Number.isFinite(czSolicitudId)) {
    return {
      ok: false,
      result: REASONS.NO_CURRENT_REJECTION,
      email_masked: elig.email_masked,
      recipient_id: null,
      campaign_id: resolvedCampaignId,
      due_step: null,
    };
  }

  const realSurveyUrl = buildSurveyUrl(elig.lrw_id);
  const idempotencyKey = buildSurveyInviteIdempotencyKey(
    resolvedCampaignId,
    czSolicitudId,
  );
  const emailNorm = normalizeEmail(elig.email);

  // Unit: recipient + impact + link (atomic). Snapshot is a later frontier.
  const unit = await upsertEmailSurveyInviteRecipientImpact(supabase, {
    idempotencyKey: idempotencyKey,
    campaignId: resolvedCampaignId,
    ci: elig.ci,
    email: emailNorm,
    purpose: PURPOSE,
    destinationUrl: realSurveyUrl,
    czSolicitudId: czSolicitudId,
  });

  const trackedUrl = buildEmailClickTrackedUrl(unit.tracking_token, publicBase);
  const unsubscribeUrl = buildUnsubscribeUrl(publicBase, elig.email);
  const nombre = resolveInviteNombre(elig.nombre);
  const templateVars = {
    nombre: nombre,
    survey_url: trackedUrl,
    unsubscribe_url: unsubscribeUrl,
  };

  if (unit.provider_send_started_at) {
    const mapped = mapExistingRecipientResult({
      id: unit.recipient_id,
      status: unit.status,
    });
    mapped.ok = false;
    mapped.email_masked = elig.email_masked;
    mapped.campaign_id = resolvedCampaignId;
    mapped.marketing_impact_id = unit.impact_id;
    mapped.tracking_token = unit.tracking_token;
    return mapped;
  }

  const applied = await applySurveyInviteSnapshot(supabase, {
    recipientId: unit.recipient_id,
    idempotencyKey: idempotencyKey,
    emailNorm: emailNorm,
    templateVars: templateVars,
    purpose: PURPOSE,
    emailMasked: elig.email_masked,
    ci: elig.ci,
    campaignId: resolvedCampaignId,
  });

  if (!applied) {
    throw new Error('survey invite snapshot apply returned empty');
  }

  applied.campaign_id = resolvedCampaignId;
  applied.marketing_impact_id = unit.impact_id;
  applied.tracking_token = unit.tracking_token;
  return applied;
}

module.exports = {
  materializeRejectedSurveyInvite,
  repairSurveyInviteRecipient,
  applySurveyInviteSnapshot,
  isUniqueViolation,
  mapExistingRecipientResult,
};
