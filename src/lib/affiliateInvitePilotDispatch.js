'use strict';

/**
 * Two-recipient affiliate invite email dispatch (DIRECTED campaign + processQueue).
 * No mass-audience materialize. Nelson join token minted only on authorized --send.
 */

const { EMAIL_AUDIENCE_MODES } = require('../services/email-campaigns/audienceMode');
const { readCampaignsFrom } = require('../services/email-campaigns/payloadSnapshot');
const { issueInviteToken, getActiveAffiliateByCi } = require('./affiliateOptIn');
const { ciExistsInFunnel } = require('./affiliateOptInDbHelpers');
const { parseCi } = require('./affiliateDirectory');
const {
  AFFILIATE_INVITE_EMAIL_SUBJECT,
  loadTemplateBody,
  readPublicBaseUrl,
} = require('./affiliateInviteEmail');
const {
  NELSON_JOIN_TOKEN_PLACEHOLDER,
  PILOT_NELSON,
  PILOT_NICO,
  CONTROLLED_PILOT_RECIPIENTS,
  buildControlledPilotPayloadSnapshots,
  buildControlledPilotManifest,
} = require('./affiliateInviteControlledSend');
const { AFFILIATE_PILOT_AUTHORIZED_JOIN_CI } = require('./affiliateJoinPilotRoster');

const PILOT_CAMPAIGN_NAME =
  'PILOT affiliate invite Nelson+Nico (2-recipient controlled)';

const PILOT_IDEMPOTENCY_PREFIX = 'affiliate-pilot-2rec:v1:';

const CAMPAIGN_BODY_STUB =
  '<!-- DIRECTED affiliate pilot: per-recipient payload_html snapshots -->';

function pilotIdempotencyKey(key) {
  return PILOT_IDEMPOTENCY_PREFIX + String(key);
}

function assertHtmlHasNoInvitePlaceholder(html, label) {
  const s = String(html || '');
  if (s.indexOf(NELSON_JOIN_TOKEN_PLACEHOLDER) !== -1) {
    throw new Error(label + ': invite token placeholder must not be sent');
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function findPilotCampaignWithRecipients(supabase) {
  const { data: campaign, error: cErr } = await supabase
    .from('email_campaigns')
    .select('id, name, status, recipient_count, created_at')
    .eq('name', PILOT_CAMPAIGN_NAME)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cErr) throw new Error('pilot campaign lookup: ' + cErr.message);
  if (!campaign) return { campaign: null, recipients: [] };

  const { data: recipients, error: rErr } = await supabase
    .from('email_campaign_recipients')
    .select('id, email, status, idempotency_key, ci, sent_at, error_reason')
    .eq('campaign_id', campaign.id);
  if (rErr) throw new Error('pilot recipients lookup: ' + rErr.message);
  return { campaign: campaign, recipients: recipients || [] };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function validatePilotRecipientAffiliateState(supabase) {
  const nelsonCi = parseCi(PILOT_NELSON.ci);
  const nicoCi = parseCi(PILOT_NICO.ci);
  if (nelsonCi == null || nicoCi == null) {
    return { ok: false, reason: 'invalid_pilot_ci_constants' };
  }

  const nelsonAff = await getActiveAffiliateByCi(supabase, nelsonCi);
  if (nelsonAff) {
    return { ok: false, reason: 'nelson_already_active_affiliate' };
  }

  const nicoAff = await getActiveAffiliateByCi(supabase, nicoCi);
  if (!nicoAff) {
    return { ok: false, reason: 'nico_not_active_affiliate' };
  }
  if (String(nicoAff.code || '').trim() !== PILOT_NICO.referral_code) {
    return { ok: false, reason: 'nico_referral_code_mismatch' };
  }

  const nelsonInFunnel = await ciExistsInFunnel(supabase, nelsonCi);
  if (!nelsonInFunnel) {
    return { ok: false, reason: 'nelson_not_in_funnel' };
  }

  return { ok: true, nico_affiliate_id: nicoAff.id };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function validatePilotEmailsSendable(_supabase) {
  const { normalizeEmail, isEmailCurrentlySuppressed } = require('../services/email-campaigns/processor');
  for (let i = 0; i < CONTROLLED_PILOT_RECIPIENTS.length; i += 1) {
    const meta = CONTROLLED_PILOT_RECIPIENTS[i];
    const emailNorm = normalizeEmail(meta.email);
    if (!emailNorm) {
      return { ok: false, reason: 'invalid_pilot_email:' + meta.key };
    }
    const suppressed = await isEmailCurrentlySuppressed(emailNorm);
    if (suppressed) {
      return { ok: false, reason: 'email_suppressed:' + meta.key };
    }
  }
  return { ok: true };
}

function detectDuplicateDispatch(existingRecipients) {
  const list = existingRecipients || [];
  if (list.length === 0) return { duplicate: false };

  const blocking = list.filter(function (r) {
    return r.status === 'queued' || r.status === 'sent';
  });
  if (blocking.length === 0) return { duplicate: false, prior_failed: list.length };

  return {
    duplicate: true,
    blocking: blocking.map(function (r) {
      return {
        email: r.email,
        status: r.status,
        id: r.id,
        idempotency_key: r.idempotency_key,
      };
    }),
  };
}

/**
 * @param {{
 *   publicBaseUrl?: string|null,
 *   nelsonJoinToken?: string|null,
 *   from?: string|null,
 * }} opts
 */
function buildPilotDispatchPlan(opts) {
  const from = opts && opts.from != null ? String(opts.from).trim() : readCampaignsFrom();
  if (!from) {
    return { ok: false, errorReason: 'EMAIL_CAMPAIGNS_FROM_MISSING' };
  }
  const publicBase =
    opts && opts.publicBaseUrl != null && String(opts.publicBaseUrl).trim() !== ''
      ? readPublicBaseUrl(opts.publicBaseUrl)
      : readPublicBaseUrl(process.env.EMAIL_PUBLIC_BASE_URL);

  const manifest = buildControlledPilotManifest({
    publicBaseUrl: publicBase,
    nelsonJoinToken: opts && opts.nelsonJoinToken,
  });
  if (!manifest.ok) {
    return { ok: false, errorReason: manifest.errorReason || 'manifest_failed' };
  }

  const snapshots = buildControlledPilotPayloadSnapshots({
    from: from,
    publicBaseUrl: publicBase,
    nelsonJoinToken: opts && opts.nelsonJoinToken,
  });
  if (!snapshots.ok) {
    return { ok: false, errorReason: snapshots.errorReason || 'snapshot_failed' };
  }

  const nelsonTokenRaw = opts && opts.nelsonJoinToken;
  const hasRealNelsonToken =
    nelsonTokenRaw != null &&
    String(nelsonTokenRaw).trim() !== '' &&
    String(nelsonTokenRaw).trim() !== NELSON_JOIN_TOKEN_PLACEHOLDER;

  for (let i = 0; i < snapshots.rows.length; i += 1) {
    const row = snapshots.rows[i];
    if (row.key === PILOT_NELSON.key && !hasRealNelsonToken) {
      // Dry-run: Nelson HTML still contains placeholder until mint at --send.
    } else {
      assertHtmlHasNoInvitePlaceholder(row.snapshot.payload_html, row.key);
    }
    if (row.key === PILOT_NICO.key) {
      const html = row.snapshot.payload_html;
      if (html.indexOf('/affiliates/join') !== -1) {
        return { ok: false, errorReason: 'nico_html_must_not_contain_join_path' };
      }
      if (html.indexOf('/a/' + PILOT_NICO.referral_code) === -1) {
        return { ok: false, errorReason: 'nico_referral_link_missing' };
      }
    }
  }

  return {
    ok: true,
    campaign_name: PILOT_CAMPAIGN_NAME,
    subject: AFFILIATE_INVITE_EMAIL_SUBJECT,
    from: from,
    public_base_url: publicBase,
    manifest: manifest,
    rows: snapshots.rows,
    template_body_bytes: Buffer.byteLength(loadTemplateBody(), 'utf8'),
    nelson_ci: AFFILIATE_PILOT_AUTHORIZED_JOIN_CI,
    nelson_join_token_pending: !hasRealNelsonToken,
  };
}

/**
 * Mint Nelson invite token (authorized send only). Never logs raw token.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function mintNelsonPilotInviteToken(supabase) {
  const ci = parseCi(PILOT_NELSON.ci);
  if (ci == null || ci !== AFFILIATE_PILOT_AUTHORIZED_JOIN_CI) {
    return { ok: false, errorReason: 'nelson_ci_not_authorized' };
  }
  const now = new Date();
  const issued = await issueInviteToken(supabase, ci, now);
  if (!issued.ok) {
    return {
      ok: false,
      errorReason: issued.error || 'issue_invite_failed',
      status: issued.status,
    };
  }
  return {
    ok: true,
    invite_id: issued.invite && issued.invite.id,
    expires_at: issued.invite && issued.invite.expires_at,
    token: issued.token,
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   nelsonJoinToken: string,
 *   from?: string|null,
 *   publicBaseUrl?: string|null,
 * }} input
 */
async function enqueuePilotInviteEmails(supabase, input) {
  const token = String(input.nelsonJoinToken || '').trim();
  if (!token || token === NELSON_JOIN_TOKEN_PLACEHOLDER) {
    throw new Error('enqueuePilotInviteEmails: nelsonJoinToken required');
  }

  const dup = await findPilotCampaignWithRecipients(supabase);
  const dupCheck = detectDuplicateDispatch(dup.recipients);
  if (dupCheck.duplicate) {
    return {
      ok: false,
      errorReason: 'pilot_dispatch_already_queued_or_sent',
      existing_campaign_id: dup.campaign && dup.campaign.id,
      blocking: dupCheck.blocking,
    };
  }

  const affiliateState = await validatePilotRecipientAffiliateState(supabase);
  if (!affiliateState.ok) {
    return { ok: false, errorReason: affiliateState.reason };
  }

  const sendable = await validatePilotEmailsSendable(supabase);
  if (!sendable.ok) {
    return { ok: false, errorReason: sendable.reason };
  }

  const plan = buildPilotDispatchPlan({
    from: input.from,
    publicBaseUrl: input.publicBaseUrl,
    nelsonJoinToken: token,
  });
  if (!plan.ok) {
    return { ok: false, errorReason: plan.errorReason };
  }

  const { data: campaign, error: cErr } = await supabase
    .from('email_campaigns')
    .insert({
      name: PILOT_CAMPAIGN_NAME,
      subject: AFFILIATE_INVITE_EMAIL_SUBJECT,
      body_html: CAMPAIGN_BODY_STUB,
      audience_mode: EMAIL_AUDIENCE_MODES.DIRECTED,
      segment_id: null,
      segment_rules_snapshot: null,
      status: 'sending',
      recipient_count: plan.rows.length,
    })
    .select('id, name, status')
    .single();
  if (cErr) {
    return { ok: false, errorReason: 'campaign_insert:' + cErr.message };
  }

  const recipientInserts = plan.rows.map(function (row) {
    const snap = row.snapshot;
    return {
      campaign_id: campaign.id,
      idempotency_key: pilotIdempotencyKey(row.key),
      ci: row.ci != null ? String(row.ci) : null,
      email: snap.email,
      status: 'queued',
      purpose: null,
      template_vars: snap.template_vars || {},
      payload_to: snap.payload_to,
      payload_from: snap.payload_from,
      payload_subject: snap.payload_subject,
      payload_html: snap.payload_html,
      template_subject_snapshot: snap.template_subject_snapshot,
      template_body_html_snapshot: snap.template_body_html_snapshot,
    };
  });

  const { error: rErr } = await supabase
    .from('email_campaign_recipients')
    .insert(recipientInserts);
  if (rErr) {
    return {
      ok: false,
      errorReason: 'recipients_insert:' + rErr.message,
      campaign_id: campaign.id,
    };
  }

  return {
    ok: true,
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    recipient_count: recipientInserts.length,
    recipients: plan.rows.map(function (row) {
      return {
        key: row.key,
        email: row.email,
        ci: row.ci,
        click_url: row.click_url,
      };
    }),
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   nelsonJoinToken: string,
 *   from?: string|null,
 *   publicBaseUrl?: string|null,
 *   processQueue?: boolean,
 * }} input
 */
async function dispatchPilotInviteEmails(supabase, input) {
  const enq = await enqueuePilotInviteEmails(supabase, input);
  if (!enq.ok) return enq;

  let queueSummary = null;
  if (input.processQueue !== false) {
    const { processQueue } = require('../services/email-campaigns/processor');
    queueSummary = await processQueue({ campaignId: enq.campaign_id });
  }

  return {
    ok: true,
    campaign_id: enq.campaign_id,
    campaign_name: enq.campaign_name,
    recipient_count: enq.recipient_count,
    recipients: enq.recipients,
    process_queue: queueSummary,
  };
}

module.exports = {
  PILOT_CAMPAIGN_NAME,
  PILOT_IDEMPOTENCY_PREFIX,
  pilotIdempotencyKey,
  assertHtmlHasNoInvitePlaceholder,
  findPilotCampaignWithRecipients,
  validatePilotRecipientAffiliateState,
  validatePilotEmailsSendable,
  detectDuplicateDispatch,
  buildPilotDispatchPlan,
  mintNelsonPilotInviteToken,
  enqueuePilotInviteEmails,
  dispatchPilotInviteEmails,
};
