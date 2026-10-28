'use strict';

/**
 * Seven-recipient affiliate invite email dispatch (DIRECTED + processQueue).
 * Join tokens minted only on authorized --send (one per CI).
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
  JOIN_TOKEN_PLACEHOLDER,
  buildPilot7PayloadSnapshots,
  buildPilot7Manifest,
} = require('./affiliateInvitePilot7Send');
const {
  AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS,
  PILOT7_RECIPIENTS,
} = require('./affiliateInvitePilot7Roster');

const PILOT7_CAMPAIGN_NAME =
  'PILOT affiliate invite 7-recipient controlled (join tokens)';

const PILOT7_IDEMPOTENCY_PREFIX = 'affiliate-pilot-7rec:v1:';

const CAMPAIGN_BODY_STUB =
  '<!-- DIRECTED affiliate pilot7: per-recipient payload_html snapshots -->';

function pilot7IdempotencyKey(key) {
  return PILOT7_IDEMPOTENCY_PREFIX + String(key);
}

function assertHtmlHasNoInvitePlaceholder(html, label) {
  const s = String(html || '');
  if (s.indexOf(JOIN_TOKEN_PLACEHOLDER) !== -1) {
    throw new Error(label + ': invite token placeholder must not be sent');
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function findPilot7CampaignWithRecipients(supabase) {
  const { data: campaign, error: cErr } = await supabase
    .from('email_campaigns')
    .select('id, name, status, recipient_count, created_at')
    .eq('name', PILOT7_CAMPAIGN_NAME)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cErr) throw new Error('pilot7 campaign lookup: ' + cErr.message);
  if (!campaign) return { campaign: null, recipients: [] };

  const { data: recipients, error: rErr } = await supabase
    .from('email_campaign_recipients')
    .select('id, email, status, idempotency_key, ci, sent_at, error_reason')
    .eq('campaign_id', campaign.id);
  if (rErr) throw new Error('pilot7 recipients lookup: ' + rErr.message);
  return { campaign: campaign, recipients: recipients || [] };
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
        ci: r.ci,
      };
    }),
  };
}

async function latestFunnelEmailForCi(supabase, ci) {
  const { data, error } = await supabase
    .from('cz_funnel_solicitudes')
    .select('email')
    .eq('ci', ci)
    .not('email', 'is', null)
    .order('fecha_reg', { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) throw error;
  const row = data && data[0];
  return row && row.email ? String(row.email).trim() : null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function validatePilot7RecipientAffiliateState(supabase) {
  const { normalizeEmail } = require('../services/email-campaigns/processor');
  const issues = [];

  for (let i = 0; i < PILOT7_RECIPIENTS.length; i += 1) {
    const meta = PILOT7_RECIPIENTS[i];
    const ci = parseCi(meta.ci);
    if (ci == null) {
      return { ok: false, reason: 'invalid_pilot7_ci_constant:' + meta.key };
    }
    if (AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS.indexOf(ci) === -1) {
      return { ok: false, reason: 'ci_not_in_pilot7_roster:' + meta.key };
    }

    const aff = await getActiveAffiliateByCi(supabase, ci);
    if (aff) {
      issues.push({ key: meta.key, ci: ci, reason: 'already_active_affiliate' });
    }

    const inFunnel = await ciExistsInFunnel(supabase, ci);
    if (!inFunnel) {
      issues.push({ key: meta.key, ci: ci, reason: 'not_in_funnel' });
    }

    const funnelEmail = await latestFunnelEmailForCi(supabase, ci);
    const rosterNorm = normalizeEmail(meta.email);
    const funnelNorm = normalizeEmail(funnelEmail);
    if (!funnelNorm) {
      issues.push({ key: meta.key, ci: ci, reason: 'funnel_email_missing' });
    } else if (rosterNorm !== funnelNorm) {
      issues.push({
        key: meta.key,
        ci: ci,
        reason: 'funnel_email_mismatch',
        roster_email: meta.email,
        funnel_email: funnelEmail,
      });
    }
  }

  if (issues.length) {
    return { ok: false, reason: 'pilot7_recipient_validation_failed', issues: issues };
  }
  return { ok: true };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function validatePilot7EmailsSendable(supabase) {
  const { normalizeEmail, isEmailCurrentlySuppressed } = require('../services/email-campaigns/processor');
  for (let i = 0; i < PILOT7_RECIPIENTS.length; i += 1) {
    const meta = PILOT7_RECIPIENTS[i];
    const emailNorm = normalizeEmail(meta.email);
    if (!emailNorm) {
      return { ok: false, reason: 'invalid_pilot7_email:' + meta.key };
    }
    const suppressed = await isEmailCurrentlySuppressed(emailNorm);
    if (suppressed) {
      return { ok: false, reason: 'email_suppressed:' + meta.key };
    }
  }
  return { ok: true };
}

/**
 * @param {{
 *   publicBaseUrl?: string|null,
 *   joinTokensByKey?: Map<string, string>|Record<string, string>|null,
 *   from?: string|null,
 * }} opts
 */
function buildPilot7DispatchPlan(opts) {
  const from = opts && opts.from != null ? String(opts.from).trim() : readCampaignsFrom();
  if (!from) {
    return { ok: false, errorReason: 'EMAIL_CAMPAIGNS_FROM_MISSING' };
  }
  const publicBase =
    opts && opts.publicBaseUrl != null && String(opts.publicBaseUrl).trim() !== ''
      ? readPublicBaseUrl(opts.publicBaseUrl)
      : readPublicBaseUrl(process.env.EMAIL_PUBLIC_BASE_URL);

  const manifest = buildPilot7Manifest({
    publicBaseUrl: publicBase,
    joinTokensByKey: opts && opts.joinTokensByKey,
  });
  if (!manifest.ok) {
    return { ok: false, errorReason: manifest.errorReason || 'manifest_failed' };
  }

  const snapshots = buildPilot7PayloadSnapshots({
    from: from,
    publicBaseUrl: publicBase,
    joinTokensByKey: opts && opts.joinTokensByKey,
  });
  if (!snapshots.ok) {
    return { ok: false, errorReason: snapshots.errorReason || 'snapshot_failed' };
  }

  const tokens = opts && opts.joinTokensByKey;
  let anyPending = false;
  for (let i = 0; i < snapshots.rows.length; i += 1) {
    const row = snapshots.rows[i];
    if (row.join_token_pending) {
      anyPending = true;
      continue;
    }
    assertHtmlHasNoInvitePlaceholder(row.snapshot.payload_html, row.key);
    const html = row.snapshot.payload_html;
    if (html.indexOf('/affiliates/join') === -1) {
      return { ok: false, errorReason: 'join_link_missing:' + row.key };
    }
  }

  return {
    ok: true,
    campaign_name: PILOT7_CAMPAIGN_NAME,
    subject: AFFILIATE_INVITE_EMAIL_SUBJECT,
    from: from,
    public_base_url: publicBase,
    manifest: manifest,
    rows: snapshots.rows,
    template_body_bytes: Buffer.byteLength(loadTemplateBody(), 'utf8'),
    join_tokens_pending: anyPending,
    authorized_cis: AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS.slice(),
  };
}

/**
 * Mint one invite token per pilot CI. Never logs raw tokens.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function mintPilot7InviteTokens(supabase) {
  const now = new Date();
  const byKey = new Map();
  const meta = [];

  for (let i = 0; i < PILOT7_RECIPIENTS.length; i += 1) {
    const row = PILOT7_RECIPIENTS[i];
    const ci = parseCi(row.ci);
    if (ci == null || AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS.indexOf(ci) === -1) {
      return { ok: false, errorReason: 'mint_ci_not_authorized:' + row.key };
    }
    const issued = await issueInviteToken(supabase, ci, now);
    if (!issued.ok) {
      return {
        ok: false,
        errorReason: issued.error || 'issue_invite_failed',
        key: row.key,
        status: issued.status,
      };
    }
    byKey.set(row.key, issued.token);
    meta.push({
      key: row.key,
      ci: ci,
      invite_id: issued.invite && issued.invite.id,
      expires_at: issued.invite && issued.invite.expires_at,
    });
  }

  return { ok: true, joinTokensByKey: byKey, invites: meta };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   joinTokensByKey: Map<string, string>|Record<string, string>,
 *   from?: string|null,
 *   publicBaseUrl?: string|null,
 * }} input
 */
async function enqueuePilot7InviteEmails(supabase, input) {
  const tokens = input.joinTokensByKey;
  if (!tokens) {
    throw new Error('enqueuePilot7InviteEmails: joinTokensByKey required');
  }

  for (let i = 0; i < PILOT7_RECIPIENTS.length; i += 1) {
    const key = PILOT7_RECIPIENTS[i].key;
    let raw = null;
    if (tokens instanceof Map) raw = tokens.get(key);
    else raw = tokens[key];
    if (!raw || String(raw).trim() === '' || String(raw).trim() === JOIN_TOKEN_PLACEHOLDER) {
      throw new Error('enqueuePilot7InviteEmails: missing token for ' + key);
    }
  }

  const dup = await findPilot7CampaignWithRecipients(supabase);
  const dupCheck = detectDuplicateDispatch(dup.recipients);
  if (dupCheck.duplicate) {
    return {
      ok: false,
      errorReason: 'pilot7_dispatch_already_queued_or_sent',
      existing_campaign_id: dup.campaign && dup.campaign.id,
      blocking: dupCheck.blocking,
    };
  }

  const affiliateState = await validatePilot7RecipientAffiliateState(supabase);
  if (!affiliateState.ok) {
    return { ok: false, errorReason: affiliateState.reason, details: affiliateState.issues };
  }

  const sendable = await validatePilot7EmailsSendable(supabase);
  if (!sendable.ok) {
    return { ok: false, errorReason: sendable.reason };
  }

  const plan = buildPilot7DispatchPlan({
    from: input.from,
    publicBaseUrl: input.publicBaseUrl,
    joinTokensByKey: tokens,
  });
  if (!plan.ok) {
    return { ok: false, errorReason: plan.errorReason };
  }

  const { data: campaign, error: cErr } = await supabase
    .from('email_campaigns')
    .insert({
      name: PILOT7_CAMPAIGN_NAME,
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
      idempotency_key: pilot7IdempotencyKey(row.key),
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
        cohort: row.cohort,
        click_url: row.click_url,
      };
    }),
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   joinTokensByKey: Map<string, string>|Record<string, string>,
 *   from?: string|null,
 *   publicBaseUrl?: string|null,
 *   processQueue?: boolean,
 * }} input
 */
async function dispatchPilot7InviteEmails(supabase, input) {
  const enq = await enqueuePilot7InviteEmails(supabase, input);
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

/**
 * Dry-run / preflight with optional live Supabase checks.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
 * @param {{ from?: string|null, publicBaseUrl?: string|null }} [opts]
 */
async function runPilot7DryRunPreflight(supabase, opts) {
  const plan = buildPilot7DispatchPlan({
    from: opts && opts.from,
    publicBaseUrl: opts && opts.publicBaseUrl,
    joinTokensByKey: null,
  });
  if (!plan.ok) {
    return { ok: false, errorReason: plan.errorReason };
  }

  const out = {
    ok: true,
    mode: 'dry-run',
    send_executed: false,
    tokens_minted: false,
    campaign_name: plan.campaign_name,
    subject: plan.subject,
    from_configured: Boolean(plan.from),
    public_base_url: plan.public_base_url,
    join_tokens_pending: plan.join_tokens_pending,
    join_token_placeholder: JOIN_TOKEN_PLACEHOLDER,
    authorized_cis: plan.authorized_cis,
    recipients: plan.manifest.recipients,
    supabase_preflight: null,
  };

  if (supabase) {
    const affiliateState = await validatePilot7RecipientAffiliateState(supabase);
    const sendable = await validatePilot7EmailsSendable(supabase);
    const existing = await findPilot7CampaignWithRecipients(supabase);
    const dup = detectDuplicateDispatch(existing.recipients);
    out.supabase_preflight = {
      recipient_validation: affiliateState,
      email_sendable: sendable,
      prior_campaign_id: existing.campaign && existing.campaign.id,
      duplicate_dispatch: dup,
    };
    if (!affiliateState.ok || !sendable.ok) {
      out.ok = false;
      out.errorReason = !affiliateState.ok
        ? affiliateState.reason
        : sendable.reason;
    }
    if (dup.duplicate) {
      out.ok = false;
      out.errorReason = 'pilot7_dispatch_already_queued_or_sent';
    }
  }

  return out;
}

module.exports = {
  PILOT7_CAMPAIGN_NAME,
  PILOT7_IDEMPOTENCY_PREFIX,
  pilot7IdempotencyKey,
  findPilot7CampaignWithRecipients,
  validatePilot7RecipientAffiliateState,
  validatePilot7EmailsSendable,
  detectDuplicateDispatch,
  buildPilot7DispatchPlan,
  mintPilot7InviteTokens,
  enqueuePilot7InviteEmails,
  dispatchPilot7InviteEmails,
  runPilot7DryRunPreflight,
};
