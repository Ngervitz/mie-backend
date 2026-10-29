'use strict';

/**
 * Affiliate SMS invite pilot 10 — controlled dispatch via existing Notifyme + JT stack.
 * Real Notifyme I/O only when ALLOW_AFFILIATE_SMS_PILOT10_DISPATCH=true and pre-send gates pass.
 */

const { randomUUID } = require('crypto');
const { NotifymeError } = require('../services/notifyme-client');
const { buildAffiliateJoinUrl } = require('./affiliateInviteEmail');
const { SMS_PURPOSES } = require('./smsCampaignClassification');
const { AFFILIATE_SMS_SOURCE_SYSTEM } = require('./affiliateInviteOutreachMetrics');
const { AFFILIATE_SMS_PILOT10_CIS, gsm7Septets, smsSegmentsGsm7 } = require('./affiliateInviteSmsPilot10');
const {
  PILOT10_CAMPAIGN_NAME,
  findPilot10SmsCampaign,
  isPilot10SendAuthorized,
  preparePilot10RecipientPlan,
  recoverPilot10Artifacts,
} = require('./affiliateInviteSmsPilot10Orchestration');
const { evaluateAffiliateSmsPilot10PreSendGates } = require('./affiliateInviteSmsPilot10PreSendGates');
const {
  sendPilot10MessageWithNotifymeReconcile,
  resumePilot10UnknownDelivery,
} = require('./affiliateInviteSmsPilot10Notifyme');

const PILOT10_JOIN_DESTINATION = 'https://s.credizona.net/affiliates/join';

async function ensurePilot10SmsCampaign(supabase) {
  const existing = await findPilot10SmsCampaign(supabase);
  if (existing && existing.id) return existing;

  const id = randomUUID();
  const { data, error } = await supabase
    .from('sms_campaigns')
    .insert({
      id: id,
      name: PILOT10_CAMPAIGN_NAME,
      total_messages: AFFILIATE_SMS_PILOT10_CIS.length,
      status: 'sending',
      destination_url: PILOT10_JOIN_DESTINATION,
      utm_campaign_value: id,
      short_url: null,
      campaign_series_id: null,
      vertical: 'affiliates',
      purpose: SMS_PURPOSES.AFFILIATE_PROGRAM_INVITE,
    })
    .select('id, name, status, vertical, purpose, total_messages, created_at')
    .single();
  if (error) throw error;
  return data;
}

async function hasPendingOrDeliveredPilotMessage(supabase, campaignId, ci) {
  const recovered = await recoverPilot10Artifacts(supabase, campaignId, ci);
  if (recovered && recovered.kind === 'already_delivered') return true;
  if (recovered && recovered.message) {
    const st = String(recovered.message.status || '').toUpperCase();
    if (st === 'DELIVERED') return true;
    if (recovered.message.unique_id && st !== 'ERROR') return true;
  }
  return false;
}

function assertPilot10SmsTextOk(text) {
  const gsm = gsm7Septets(text);
  const segments = smsSegmentsGsm7(gsm.septets);
  if (gsm.encoding !== 'GSM-7' || segments !== 1) {
    return {
      ok: false,
      reason: 'sms_not_single_gsm7_segment',
      gsm7: gsm,
      segments: segments,
    };
  }
  return { ok: true, gsm7: gsm, segments: segments };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ dryRun?: boolean, skipPreSendGates?: boolean }} [opts]
 */
async function dispatchAffiliateInviteSmsPilot10(supabase, opts) {
  const o = opts || {};
  const dryRun = o.dryRun === true || !isPilot10SendAuthorized({ dryRun: false });

  if (!dryRun && !o.skipPreSendGates) {
    const gates = evaluateAffiliateSmsPilot10PreSendGates(process.env);
    if (!gates.ok) {
      return { ok: false, errorReason: 'pilot10_pre_send_gates_failed', blockers: gates.blockers };
    }
  }

  if (!dryRun && !isPilot10SendAuthorized({ dryRun: false })) {
    return {
      ok: false,
      errorReason: 'pilot10_dispatch_not_authorized',
      detail: 'Set ALLOW_AFFILIATE_SMS_PILOT10_DISPATCH=true',
    };
  }

  const campaign = dryRun ? null : await ensurePilot10SmsCampaign(supabase);
  const now = new Date();
  const results = [];

  for (let i = 0; i < AFFILIATE_SMS_PILOT10_CIS.length; i += 1) {
    const ci = AFFILIATE_SMS_PILOT10_CIS[i];
    const plan = await preparePilot10RecipientPlan(supabase, ci, now, { dryRun: dryRun });
    if (!plan.ok) {
      results.push({ ci: ci, ok: false, plan: plan });
      continue;
    }
    if (plan.skipped) {
      results.push({ ci: ci, ok: true, skipped: true, reason: plan.reason });
      continue;
    }

    const textCheck = assertPilot10SmsTextOk(plan.sms_text);
    if (!textCheck.ok) {
      results.push({ ci: ci, ok: false, reason: textCheck.reason, gsm7: textCheck.gsm7 });
      continue;
    }

    if (dryRun) {
      results.push({
        ci: ci,
        ok: true,
        dry_run: true,
        idempotency_key: plan.idempotency_key,
        segments: textCheck.segments,
      });
      continue;
    }

    const campaignId = campaign.id;
    const unknownResume = await resumePilot10UnknownDelivery(supabase, campaignId, ci);
    if (unknownResume && unknownResume.block_auto_resend) {
      results.push({
        ci: ci,
        ok: false,
        reason: 'notifyme_delivery_unknown_manual_review',
        unique_id: unknownResume.unique_id,
        delivery: unknownResume,
      });
      continue;
    }
    if (unknownResume && unknownResume.resolved === 'delivered') {
      results.push({
        ci: ci,
        ok: true,
        skipped: true,
        reason: 'recovered_delivered_after_unknown',
        unique_id: unknownResume.unique_id,
      });
      continue;
    }
    if (unknownResume && unknownResume.resolved === 'not_received_confirmed') {
      // Same unique_id row remains; deliver will reuse persisted row via send helper.
    } else if (await hasPendingOrDeliveredPilotMessage(supabase, campaignId, ci)) {
      results.push({ ci: ci, ok: true, skipped: true, reason: 'message_already_queued_or_delivered' });
      continue;
    }

    if (!plan.marketing_impact_id || !plan.phone || !plan.sms_text) {
      results.push({
        ci: ci,
        ok: false,
        reason: plan.reused ? 'reused_plan_incomplete' : 'plan_missing_send_fields',
      });
      continue;
    }

    try {
      const delivery = await sendPilot10MessageWithNotifymeReconcile({
        supabase: supabase,
        campaignId: campaignId,
        message: {
          phone: plan.phone,
          text: plan.sms_text,
          source_system: AFFILIATE_SMS_SOURCE_SYSTEM,
          source_record_id: plan.invite_token_id,
          czuid: String(plan.ci),
          marketing_impact_id: plan.marketing_impact_id,
        },
        existingUniqueId:
          unknownResume && unknownResume.resolved === 'not_received_confirmed'
            ? String(unknownResume.unique_id)
            : null,
        retryConfirmedNotReceived: Boolean(
          unknownResume && unknownResume.resolved === 'not_received_confirmed',
        ),
      });
      if (delivery.block_auto_resend) {
        results.push({
          ci: ci,
          ok: false,
          reason: 'notifyme_delivery_unknown_manual_review',
          unique_id: delivery.unique_id,
          delivery: delivery,
        });
        continue;
      }
      if (!delivery.ok) {
        results.push({
          ci: ci,
          ok: false,
          reason: delivery.reason || 'notifyme_send_failed',
          unique_id: delivery.unique_id,
          delivery: delivery,
        });
        continue;
      }
      results.push({
        ci: ci,
        ok: true,
        sent: true,
        campaign_id: campaignId,
        marketing_impact_id: plan.marketing_impact_id,
        invite_token_id: plan.invite_token_id,
        unique_id: delivery.unique_id,
        notifyme: delivery,
      });
    } catch (err) {
      results.push({
        ci: ci,
        ok: false,
        reason: 'notifyme_send_failed',
        error: err instanceof NotifymeError ? err.message : String(err && err.message ? err.message : err),
      });
    }
  }

  const allOk = results.every(function (r) {
    return r.ok;
  });

  return {
    ok: allOk,
    dry_run: dryRun,
    campaign: campaign
      ? {
          id: campaign.id,
          name: campaign.name,
          vertical: campaign.vertical,
          purpose: campaign.purpose,
        }
      : { name: PILOT10_CAMPAIGN_NAME, destination_url: PILOT10_JOIN_DESTINATION },
    join_public_url: PILOT10_JOIN_DESTINATION,
    recipients: results,
  };
}

module.exports = {
  PILOT10_JOIN_DESTINATION,
  ensurePilot10SmsCampaign,
  dispatchAffiliateInviteSmsPilot10,
};
