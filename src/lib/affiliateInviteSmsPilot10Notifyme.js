'use strict';

/**
 * Pilot 10 Notifyme send: persist unique_id before SOAP, unknown on timeout, poll before retry.
 */

const { AFFILIATE_SMS_SOURCE_SYSTEM } = require('./affiliateInviteOutreachMetrics');
const {
  insertDeliverAndReconcileSingle,
  pollStatus,
  classifyNotifymeDeliveryStatus,
  patchSmsMessagesByUniqueIds,
  deliverInsertedRows,
  NotifymeError,
} = require('../services/notifyme-client');

async function loadPilotMessageRow(supabase, campaignId, ci) {
  const { data, error } = await supabase
    .from('sms_messages')
    .select(
      'unique_id, campaign_id, submission_order, phone, text, status, delivered_at, marketing_impact_id, source_record_id, czuid',
    )
    .eq('campaign_id', campaignId)
    .eq('source_system', AFFILIATE_SMS_SOURCE_SYSTEM)
    .eq('czuid', String(ci))
    .order('submission_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * After process restart: reconcile rows left in unknown/pending without auto-resend unless confirmed not received.
 */
async function resumePilot10UnknownDelivery(supabase, campaignId, ci) {
  const row = await loadPilotMessageRow(supabase, campaignId, ci);
  if (!row || !row.unique_id) return null;

  const st = String(row.status || '').toUpperCase();
  if (st === 'DELIVERED' || row.delivered_at) {
    return { resolved: 'delivered', unique_id: String(row.unique_id) };
  }
  if (st !== 'UNKNOWN' && st !== 'PENDING') {
    return null;
  }

  await pollStatus([String(row.unique_id)]);
  const refreshed = await loadPilotMessageRow(supabase, campaignId, ci);
  const outcome = classifyNotifymeDeliveryStatus(refreshed && refreshed.status);
  if (outcome === 'delivered') {
    return { resolved: 'delivered', unique_id: String(refreshed.unique_id) };
  }
  if (outcome === 'not_received') {
    return {
      resolved: 'not_received_confirmed',
      unique_id: String(refreshed.unique_id),
      block_auto_resend: false,
    };
  }
  return {
    resolved: 'unknown',
    unique_id: String(refreshed.unique_id),
    block_auto_resend: true,
  };
}

/**
 * @param {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   campaignId: string,
 *   message: object,
 *   existingUniqueId?: string|null,
 *   retryConfirmedNotReceived?: boolean,
 * }} args
 */
async function sendPilot10MessageWithNotifymeReconcile(args) {
  const a = args || {};
  if (a.retryConfirmedNotReceived && a.existingUniqueId) {
    const uid = String(a.existingUniqueId);
    const row = await loadPilotMessageRow(a.supabase, a.campaignId, a.message.czuid);
    if (!row || String(row.unique_id) !== uid) {
      throw new NotifymeError('Pilot retry unique_id mismatch', { kind: 'validation', status: 409 });
    }
    try {
      await deliverInsertedRows(a.campaignId, [row]);
      return {
        ok: true,
        unique_id: uid,
        delivery: 'retry_submitted',
        block_auto_resend: false,
      };
    } catch (err) {
      const mapped = err instanceof NotifymeError ? err : err;
      if (mapped.kind === 'timeout') {
        await patchSmsMessagesByUniqueIds([uid], { status: 'unknown' });
        await pollStatus([uid]);
        const after = await loadPilotMessageRow(a.supabase, a.campaignId, a.message.czuid);
        const outcome = classifyNotifymeDeliveryStatus(after && after.status);
        if (outcome === 'delivered') {
          return { ok: true, unique_id: uid, delivery: 'delivered_after_retry_poll', block_auto_resend: false };
        }
        if (outcome === 'not_received') {
          return {
            ok: false,
            unique_id: uid,
            delivery: 'not_received_confirmed',
            block_auto_resend: false,
            may_retry_same_unique_id: true,
          };
        }
        return {
          ok: false,
          unique_id: uid,
          delivery: 'unknown',
          block_auto_resend: true,
          reason: 'notifyme_delivery_unknown',
        };
      }
      throw mapped;
    }
  }

  return insertDeliverAndReconcileSingle(a.campaignId, a.message, {});
}

module.exports = {
  sendPilot10MessageWithNotifymeReconcile,
  resumePilot10UnknownDelivery,
  loadPilotMessageRow,
};
