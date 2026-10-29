'use strict';

/**
 * Affiliate SMS invite pilot 10 — controlled prepare/send with idempotent JT + tokens.
 * Default: dry-run (no issueInviteToken, no Notifyme).
 */

const { issueInviteToken, getActiveAffiliateByCi } = require('./affiliateOptIn');
const { ciExistsInFunnel } = require('./affiliateOptInDbHelpers');
const { parseCi } = require('./affiliateDirectory');
const { resolveAffiliateSmsPhone } = require('./affiliatePhoneResolve');
const { buildAffiliateJoinUrl } = require('./affiliateInviteEmail');
const {
  composePublicShortUrl,
} = require('./smsTinyUrl');
const {
  prepareIndividualSmsTracking,
} = require('./smsMarketingImpacts');
const {
  AFFILIATE_SMS_PILOT10_CIS,
  PILOT10_SMS_TEMPLATE,
  renderPilot10SmsText,
  gsm7Septets,
  smsSegmentsGsm7,
  dryRunInviteTokenForCi,
  sampleShortUrl,
} = require('./affiliateInviteSmsPilot10');
const { SMS_PURPOSES } = require('./smsCampaignClassification');
const { AFFILIATE_SMS_SOURCE_SYSTEM } = require('./affiliateInviteOutreachMetrics');

const PILOT10_CAMPAIGN_NAME =
  'PILOT affiliate SMS invite 10-recipient (join tokens JT)';
const PILOT10_IDEMPOTENCY_PREFIX = 'affiliate-sms-pilot10:';

function pilot10IdempotencyKey(ci) {
  return PILOT10_IDEMPOTENCY_PREFIX + String(ci);
}

function parseInviteTokenFromDestinationUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl).trim());
    const t = u.searchParams.get('t');
    return t != null && String(t).trim() ? String(t).trim() : null;
  } catch (_err) {
    return null;
  }
}

function isPilot10SendAuthorized(opts) {
  if (opts && opts.dryRun === true) return false;
  if (opts && opts.dryRun === false) {
    return String(process.env.ALLOW_AFFILIATE_SMS_PILOT10_DISPATCH || '').toLowerCase() === 'true';
  }
  return false;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function findPilot10SmsCampaign(supabase) {
  const { data, error } = await supabase
    .from('sms_campaigns')
    .select('id, name, status, vertical, purpose, total_messages, created_at')
    .eq('name', PILOT10_CAMPAIGN_NAME)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Recover invite token + JT artifacts from persisted short link (post tracking prep).
 */
async function recoverPilot10Artifacts(supabase, campaignId, ci) {
  const parsedCi = parseCi(ci);
  if (parsedCi == null) return null;

  const { data: msgs, error: mErr } = await supabase
    .from('sms_messages')
    .select(
      'unique_id, phone, text, status, delivered_at, marketing_impact_id, source_record_id, czuid',
    )
    .eq('campaign_id', campaignId)
    .eq('source_system', AFFILIATE_SMS_SOURCE_SYSTEM)
    .eq('czuid', String(parsedCi))
    .order('submission_order', { ascending: false })
    .limit(5);
  if (mErr) throw mErr;

  const rows = msgs || [];
  if (!rows.length) return null;

  const delivered = rows.find(function (r) {
    return r.delivered_at != null || String(r.status || '').toUpperCase() === 'DELIVERED';
  });
  if (delivered) {
    return {
      kind: 'already_delivered',
      message: delivered,
      invite_token_id: delivered.source_record_id,
    };
  }

  const candidate = rows[0];
  if (!candidate.marketing_impact_id) {
    return {
      kind: 'partial_message_without_impact',
      message: candidate,
      invite_token_id: candidate.source_record_id,
    };
  }

  const { data: link, error: lErr } = await supabase
    .from('sms_short_links')
    .select('short_code, destination_url, impact_id')
    .eq('impact_id', candidate.marketing_impact_id)
    .limit(1)
    .maybeSingle();
  if (lErr) throw lErr;

  const inviteToken = link
    ? parseInviteTokenFromDestinationUrl(link.destination_url)
    : null;

  return {
    kind: 'recoverable',
    message: candidate,
    short_code: link && link.short_code ? String(link.short_code) : null,
    short_url: link && link.short_code ? composePublicShortUrl(link.short_code) : null,
    invite_token: inviteToken,
    invite_token_id: candidate.source_record_id,
    marketing_impact_id: candidate.marketing_impact_id,
    sms_text: candidate.text,
  };
}

/**
 * Detect issued invite without recoverable JT artifacts (unsafe to re-mint).
 */
async function detectPartialMintBlocker(supabase, ci, campaignId) {
  const parsedCi = parseCi(ci);
  if (parsedCi == null) return null;

  const recovered = campaignId
    ? await recoverPilot10Artifacts(supabase, campaignId, parsedCi)
    : null;
  if (recovered && recovered.kind !== 'partial_message_without_impact') {
    return null;
  }

  const { data: invites, error } = await supabase
    .from('affiliate_invite_tokens')
    .select('id, status, issued_at')
    .eq('ci', parsedCi)
    .eq('status', 'issued')
    .order('issued_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!invites || !invites.length) return null;

  if (
    !recovered ||
    recovered.kind === 'partial_message_without_impact' ||
    (recovered.kind === 'recoverable' && !recovered.invite_token)
  ) {
    return {
      code: 'PILOT_PARTIAL_MINT',
      ci: parsedCi,
      invite_token_id: invites[0].id,
      detail:
        'Issued invite token without recoverable JT short link; raw token is not stored in DB',
    };
  }

  return null;
}

async function validatePilot10Ci(supabase, ci) {
  const parsed = parseCi(ci);
  if (parsed == null) return { ok: false, reason: 'invalid_ci' };
  const aff = await getActiveAffiliateByCi(supabase, parsed);
  if (aff) return { ok: false, reason: 'already_active_affiliate' };
  const inFunnel = await ciExistsInFunnel(supabase, parsed);
  if (!inFunnel) return { ok: false, reason: 'not_in_funnel' };
  const phone = await resolveAffiliateSmsPhone(supabase, parsed);
  if (!phone) return { ok: false, reason: 'missing_phone' };
  return { ok: true, ci: parsed, phone: phone };
}

/**
 * Build send plan for one CI (dry-run or live mint + tracking prep).
 */
async function preparePilot10RecipientPlan(supabase, ci, now, opts) {
  const o = opts || {};
  const validation = await validatePilot10Ci(supabase, ci);
  if (!validation.ok) {
    return { ok: false, ci: ci, reason: validation.reason };
  }

  const campaign = await findPilot10SmsCampaign(supabase);
  const campaignId = campaign && campaign.id ? String(campaign.id) : null;

  const blocker = await detectPartialMintBlocker(supabase, validation.ci, campaignId);
  if (blocker) {
    return { ok: false, ci: validation.ci, blocker: blocker };
  }

  if (campaignId) {
    const recovered = await recoverPilot10Artifacts(supabase, campaignId, validation.ci);
    if (recovered && recovered.kind === 'already_delivered') {
      return {
        ok: true,
        ci: validation.ci,
        skipped: true,
        reason: 'already_delivered',
        idempotency_key: pilot10IdempotencyKey(validation.ci),
      };
    }
    if (recovered && recovered.kind === 'recoverable' && recovered.invite_token) {
      const text =
        recovered.sms_text ||
        renderPilot10SmsText(recovered.short_url || '');
      const gsm = gsm7Septets(text);
      return {
        ok: true,
        ci: validation.ci,
        reused: true,
        idempotency_key: pilot10IdempotencyKey(validation.ci),
        phone: validation.phone,
        invite_token_id: recovered.invite_token_id,
        marketing_impact_id: recovered.marketing_impact_id,
        short_url: recovered.short_url,
        sms_text: text,
        gsm7: gsm,
        segments: smsSegmentsGsm7(gsm.septets),
        invite_token: recovered.invite_token,
      };
    }
  }

  const dryRun = !isPilot10SendAuthorized(o);
  let inviteToken;
  let inviteId;

  if (dryRun) {
    inviteToken = dryRunInviteTokenForCi(validation.ci);
    inviteId = 'dry-run-invite-' + String(validation.ci);
  } else {
    const minted = await issueInviteToken(supabase, validation.ci, now);
    if (!minted.ok) {
      return { ok: false, ci: validation.ci, reason: 'invite_mint_failed', detail: minted };
    }
    inviteToken = minted.token;
    inviteId = minted.invite && minted.invite.id ? String(minted.invite.id) : null;
  }

  const joinUrl = buildAffiliateJoinUrl(inviteToken);
  let shortUrl = null;
  let impactId = null;
  let smsText = null;

  if (dryRun) {
    shortUrl = sampleShortUrl('https://s.credizona.net');
    smsText = renderPilot10SmsText(shortUrl);
  } else if (campaignId) {
    const trackingPlans = await prepareIndividualSmsTracking({
      supabase: supabase,
      campaignId: campaignId,
      recipients: [
        {
          phone: validation.phone,
          destination_url: joinUrl,
          source_system: AFFILIATE_SMS_SOURCE_SYSTEM,
          source_record_id: inviteId,
          contact_id: null,
          czuid: String(validation.ci),
        },
      ],
    });
    const plan = trackingPlans[0];
    shortUrl = composePublicShortUrl(plan.short_code);
    impactId = plan.impact_id;
    smsText = renderPilot10SmsText(shortUrl);
  } else {
    return { ok: false, ci: validation.ci, reason: 'pilot_campaign_missing' };
  }

  const gsm = gsm7Septets(smsText);
  return {
    ok: true,
    ci: validation.ci,
    dry_run: dryRun,
    idempotency_key: pilot10IdempotencyKey(validation.ci),
    phone: validation.phone,
    invite_token_id: inviteId,
    invite_token: dryRun ? inviteToken : undefined,
    join_url: joinUrl,
    short_url: shortUrl,
    marketing_impact_id: impactId,
    sms_text: smsText,
    gsm7: gsm,
    segments: smsSegmentsGsm7(gsm.septets),
    fits_single_gsm7_segment: gsm.encoding === 'GSM-7' && gsm.septets != null && gsm.septets <= 160,
  };
}

async function prepareAffiliateInviteSmsPilot10Batch(supabase, now, opts) {
  const plans = [];
  for (let i = 0; i < AFFILIATE_SMS_PILOT10_CIS.length; i += 1) {
    const ci = AFFILIATE_SMS_PILOT10_CIS[i];
    const plan = await preparePilot10RecipientPlan(supabase, ci, now, opts);
    plans.push(plan);
  }
  return {
    ok: plans.every(function (p) {
      return p.ok || p.skipped;
    }),
    campaign: {
      name: PILOT10_CAMPAIGN_NAME,
      vertical: 'affiliates',
      purpose: SMS_PURPOSES.AFFILIATE_PROGRAM_INVITE,
    },
    recipients: plans,
  };
}

module.exports = {
  PILOT10_CAMPAIGN_NAME,
  PILOT10_IDEMPOTENCY_PREFIX,
  pilot10IdempotencyKey,
  parseInviteTokenFromDestinationUrl,
  isPilot10SendAuthorized,
  findPilot10SmsCampaign,
  recoverPilot10Artifacts,
  detectPartialMintBlocker,
  preparePilot10RecipientPlan,
  prepareAffiliateInviteSmsPilot10Batch,
};
