'use strict';

/**
 * Shared NotifyMe poll helpers for manual POST /sms/campaigns/:id/poll
 * and the sms_notifyme_poll cron job.
 *
 * Cutoff: sms_campaigns.created_at (schema has no sent_at).
 * Verified campaign statuses: sending | sent | partial_error | error.
 * Verified terminal message status for status-poll skip: DELIVERED only.
 */

const supabaseDefault = require('../clients/supabase');
const {
  pollStatus,
  pollResponses,
  NotifymeError,
  assertUniqueIdString,
} = require('../services/notifyme-client');

const CANDIDATE_CAMPAIGN_STATUSES = Object.freeze([
  'sending',
  'sent',
  'partial_error',
]);

/** Only confirmed terminal status for skipping getMessagesStatus. */
const TERMINAL_MESSAGE_STATUSES_FOR_STATUS_POLL = Object.freeze(['DELIVERED']);

/**
 * Anti-histórico V1: poll campaigns created within this window.
 * Rationale: schema has created_at on sms_campaigns (no sent_at).
 * 72h covers multi-day PENDING + late replies without scanning old error/sent history.
 */
const AUTO_POLL_CUTOFF_HOURS = 72;

const SMS_CAMPAIGN_SELECT =
  'id, name, created_at, total_messages, status, destination_url, utm_campaign_value, short_url, campaign_series_id';

const SMS_MESSAGE_SELECT =
  'unique_id, campaign_id, submission_order, phone, text, scheduled_at, status, delivered_at, fail_reason, response_text, response_received_at, last_polled_at, source_system, source_record_id, contact_id, czuid, created_at';

function getSupabase(override) {
  return override || supabaseDefault;
}

function isTerminalForStatusPoll(status) {
  return TERMINAL_MESSAGE_STATUSES_FOR_STATUS_POLL.indexOf(String(status)) !== -1;
}

/**
 * Unique IDs to send to getMessagesStatus.
 * Skips DELIVERED when skipDelivered is true.
 */
function selectStatusPollUniqueIds(messages, skipDelivered) {
  const rows = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.unique_id == null) continue;
    if (skipDelivered && isTerminalForStatusPoll(row.status)) continue;
    out.push(assertUniqueIdString(String(row.unique_id), 'status poll load'));
  }
  return out;
}

/**
 * Unique IDs to send to getMessagesResponse.
 * Includes DELIVERED — replies may arrive after delivery.
 */
function selectResponsePollUniqueIds(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.unique_id == null) continue;
    out.push(assertUniqueIdString(String(row.unique_id), 'response poll load'));
  }
  return out;
}

/**
 * Auto-job eligibility (pure).
 * Excludes status='error'. Requires created_at within cutoffHours.
 */
function isCampaignEligibleForAutoPoll(campaign, now, cutoffHours) {
  if (!campaign || typeof campaign !== 'object') return false;
  if (campaign.status === 'error') return false;
  if (CANDIDATE_CAMPAIGN_STATUSES.indexOf(campaign.status) === -1) {
    return false;
  }
  if (campaign.created_at == null || campaign.created_at === '') return false;
  const createdMs = new Date(campaign.created_at).getTime();
  if (Number.isNaN(createdMs)) return false;
  const hours =
    cutoffHours != null && Number.isFinite(Number(cutoffHours))
      ? Number(cutoffHours)
      : AUTO_POLL_CUTOFF_HOURS;
  const cutoffMs = hours * 60 * 60 * 1000;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (Number.isNaN(nowMs)) return false;
  return nowMs - createdMs <= cutoffMs;
}

function autoPollCutoffIso(now, cutoffHours) {
  const hours =
    cutoffHours != null && Number.isFinite(Number(cutoffHours))
      ? Number(cutoffHours)
      : AUTO_POLL_CUTOFF_HOURS;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  return new Date(nowMs - hours * 60 * 60 * 1000).toISOString();
}

async function loadCampaignById(campaignId, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase
    .from('sms_campaigns')
    .select(SMS_CAMPAIGN_SELECT)
    .eq('id', campaignId)
    .limit(1);
  if (error) {
    throw new NotifymeError(`Failed to load campaign: ${error.message}`, {
      kind: 'database',
      status: 500,
    });
  }
  return data && data[0] ? data[0] : null;
}

async function loadCampaignMessages(campaignId, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase
    .from('sms_messages')
    .select(SMS_MESSAGE_SELECT)
    .eq('campaign_id', campaignId)
    .order('submission_order', { ascending: true });
  if (error) {
    throw new NotifymeError(`Failed to load sms_messages: ${error.message}`, {
      kind: 'database',
      status: 500,
    });
  }
  return data || [];
}

/**
 * List campaigns for automatic poll.
 * status IN (sending, sent, partial_error) AND created_at >= cutoff.
 * Explicitly never includes status='error'.
 */
async function listAutoPollCampaigns(opts) {
  const options = opts || {};
  const supabase = getSupabase(options.supabase);
  const now = options.now || new Date();
  const cutoffHours =
    options.cutoffHours != null ? options.cutoffHours : AUTO_POLL_CUTOFF_HOURS;
  const cutoffIso = autoPollCutoffIso(now, cutoffHours);

  const { data, error } = await supabase
    .from('sms_campaigns')
    .select('id, name, created_at, total_messages, status')
    .in('status', CANDIDATE_CAMPAIGN_STATUSES.slice())
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`listAutoPollCampaigns failed: ${error.message}`);
  }
  return data || [];
}

/**
 * Poll status + responses for one campaign.
 *
 * @param {string} campaignId
 * @param {{
 *   skipDeliveredForStatus?: boolean,
 *   supabase?: object,
 *   pollStatusFn?: Function,
 *   pollResponsesFn?: Function,
 * }} [opts]
 *   skipDeliveredForStatus — auto job true (skip DELIVERED for getMessagesStatus).
 *     Manual endpoint passes false to preserve prior “poll all IDs” status behavior.
 */
async function pollCampaignNotifyme(campaignId, opts) {
  const options = opts || {};
  const skipDeliveredForStatus = options.skipDeliveredForStatus === true;
  const statusFn = options.pollStatusFn || pollStatus;
  const responsesFn = options.pollResponsesFn || pollResponses;

  const campaign = await loadCampaignById(campaignId, options.supabase);
  if (!campaign) {
    const err = new NotifymeError('Campaign not found', {
      kind: 'validation',
      status: 404,
    });
    throw err;
  }

  const messages = await loadCampaignMessages(campaignId, options.supabase);
  const statusIds = selectStatusPollUniqueIds(messages, skipDeliveredForStatus);
  const responseIds = selectResponsePollUniqueIds(messages);

  let statusSummary = { requested: 0, returned: 0, updated: 0 };
  let responseSummary = { requested: 0, returned: 0, updated: 0 };

  if (statusIds.length > 0) {
    statusSummary = await statusFn(statusIds);
  }
  if (responseIds.length > 0) {
    responseSummary = await responsesFn(responseIds);
  }

  const refreshedMessages = await loadCampaignMessages(
    campaignId,
    options.supabase,
  );

  return {
    campaign: campaign,
    messages: refreshedMessages,
    status_poll: statusSummary,
    response_poll: responseSummary,
    status_ids_requested: statusIds.length,
    response_ids_requested: responseIds.length,
    skipped_delivered_for_status:
      skipDeliveredForStatus
        ? messages.length - statusIds.length
        : 0,
  };
}

module.exports = {
  CANDIDATE_CAMPAIGN_STATUSES,
  TERMINAL_MESSAGE_STATUSES_FOR_STATUS_POLL,
  AUTO_POLL_CUTOFF_HOURS,
  SMS_CAMPAIGN_SELECT,
  isTerminalForStatusPoll,
  selectStatusPollUniqueIds,
  selectResponsePollUniqueIds,
  isCampaignEligibleForAutoPoll,
  autoPollCutoffIso,
  listAutoPollCampaigns,
  pollCampaignNotifyme,
  loadCampaignById,
  loadCampaignMessages,
};
