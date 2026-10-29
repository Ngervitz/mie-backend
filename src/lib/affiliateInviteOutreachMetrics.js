'use strict';

/**
 * Read-only aggregates for affiliate invitation outreach (email + SMS JT).
 * Does not mint tokens or send messages.
 */

const AFFILIATE_INVITE_IDEMPOTENCY_LIKE = 'affiliate-pilot%';

const AFFILIATE_EMAIL_INVITE_CLICKS = Object.freeze({
  measured: false,
  label: 'No medidos',
  reason: 'pilot7_direct_join_url_without_marketing_impact',
});

const AFFILIATE_SMS_SOURCE_SYSTEM = 'affiliate_invite_sms';
const AFFILIATE_SMS_INVITE_PURPOSE = 'affiliate_program_invite';

async function countExactHead(supabase, table, applyFilters) {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (applyFilters) query = applyFilters(query);
  const { count, error } = await query;
  if (error) throw error;
  return typeof count === 'number' ? count : null;
}

function isSchemaMissing(err) {
  const code = err && err.code != null ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : '';
  return (
    code === '42703' ||
    code === '42P01' ||
    /does not exist/i.test(msg) ||
    /vertical/i.test(msg)
  );
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function loadAffiliateSmsInviteCampaignIds(supabase) {
  const { data, error } = await supabase
    .from('sms_campaigns')
    .select('id')
    .eq('vertical', 'affiliates')
    .eq('purpose', AFFILIATE_SMS_INVITE_PURPOSE);
  if (error) throw error;
  return (data || []).map(function (row) {
    return String(row.id);
  });
}

async function countAffiliateSmsSent(supabase, campaignIds) {
  if (!campaignIds.length) return 0;
  return countExactHead(supabase, 'sms_messages', function (q) {
    return q.in('campaign_id', campaignIds);
  });
}

async function countAffiliateSmsDelivered(supabase, campaignIds) {
  if (!campaignIds.length) return 0;
  return countExactHead(supabase, 'sms_messages', function (q) {
    return q
      .in('campaign_id', campaignIds)
      .not('delivered_at', 'is', null)
      .eq('status', 'DELIVERED');
  });
}

async function countAffiliateSmsUniqueInviteClicks(supabase, campaignIds) {
  if (!campaignIds.length) return 0;
  const { data: msgs, error: mErr } = await supabase
    .from('sms_messages')
    .select('marketing_impact_id')
    .in('campaign_id', campaignIds)
    .not('marketing_impact_id', 'is', null);
  if (mErr) throw mErr;
  const impactIds = [];
  const seen = new Set();
  (msgs || []).forEach(function (row) {
    if (!row || !row.marketing_impact_id) return;
    const id = String(row.marketing_impact_id);
    if (seen.has(id)) return;
    seen.add(id);
    impactIds.push(id);
  });
  if (!impactIds.length) return 0;

  let unique = 0;
  for (let i = 0; i < impactIds.length; i += 100) {
    const slice = impactIds.slice(i, i + 100);
    const { data: ev, error: eErr } = await supabase
      .from('marketing_impact_events')
      .select('impact_id')
      .in('impact_id', slice)
      .eq('event_name', 'click');
    if (eErr) throw eErr;
    const clicked = new Set();
    (ev || []).forEach(function (row) {
      if (row && row.impact_id) clicked.add(String(row.impact_id));
    });
    unique += clicked.size;
  }
  return unique;
}

async function countAffiliatesRegisteredFromSmsInvite(supabase, campaignIds) {
  if (!campaignIds.length) return 0;
  const { data: msgs, error: mErr } = await supabase
    .from('sms_messages')
    .select('source_record_id, czuid')
    .in('campaign_id', campaignIds)
    .eq('source_system', AFFILIATE_SMS_SOURCE_SYSTEM);
  if (mErr) throw mErr;
  const inviteIds = new Set();
  (msgs || []).forEach(function (row) {
    if (row.source_record_id) inviteIds.add(String(row.source_record_id));
  });
  if (!inviteIds.size) return 0;

  const { data: tokens, error: tErr } = await supabase
    .from('affiliate_invite_tokens')
    .select('id, ci, status')
    .in('id', Array.from(inviteIds))
    .eq('status', 'consumed');
  if (tErr) throw tErr;

  const { data: affs, error: aErr } = await supabase
    .from('affiliates')
    .select('ci, status, is_test')
    .eq('is_test', false)
    .neq('status', 'inactive');
  if (aErr) throw aErr;
  const affByCi = new Map();
  (affs || []).forEach(function (a) {
    affByCi.set(Number(a.ci), a);
  });

  let count = 0;
  (tokens || []).forEach(function (tok) {
    if (affByCi.has(Number(tok.ci))) count += 1;
  });
  return count;
}

async function aggregateAffiliateInviteOutreach(supabase, countEmailSentFn) {
  const countEmailSent = countEmailSentFn;
  const email_sent =
    typeof countEmailSent === 'function'
      ? await countEmailSent(supabase)
      : null;

  let smsCampaignIds = [];
  try {
    smsCampaignIds = await loadAffiliateSmsInviteCampaignIds(supabase);
  } catch (err) {
    if (isSchemaMissing(err)) {
      return {
        email: {
          invitations_sent: email_sent,
          invite_clicks: AFFILIATE_EMAIL_INVITE_CLICKS,
        },
        sms: {
          available: false,
          invitations_sent: null,
          delivered: null,
          invite_clicks_unique: null,
          affiliates_registered: null,
        },
        referral_link_clicks_note:
          'affiliate_clicks table counts personal referral link traffic, not program invitations',
      };
    }
    throw err;
  }

  const [sms_sent, sms_delivered, sms_clicks, sms_registered] = await Promise.all([
    countAffiliateSmsSent(supabase, smsCampaignIds),
    countAffiliateSmsDelivered(supabase, smsCampaignIds),
    countAffiliateSmsUniqueInviteClicks(supabase, smsCampaignIds),
    countAffiliatesRegisteredFromSmsInvite(supabase, smsCampaignIds),
  ]);

  return {
    email: {
      invitations_sent: email_sent,
      invite_clicks: AFFILIATE_EMAIL_INVITE_CLICKS,
    },
    sms: {
      available: true,
      campaign_count: smsCampaignIds.length,
      invitations_sent: sms_sent,
      delivered: sms_delivered,
      invite_clicks_unique: sms_clicks,
      affiliates_registered: sms_registered,
    },
    referral_link_clicks_note:
      'affiliate_clicks table counts personal referral link traffic, not program invitations',
  };
}

module.exports = {
  AFFILIATE_INVITE_IDEMPOTENCY_LIKE,
  AFFILIATE_EMAIL_INVITE_CLICKS,
  AFFILIATE_SMS_SOURCE_SYSTEM,
  AFFILIATE_SMS_INVITE_PURPOSE,
  aggregateAffiliateInviteOutreach,
  loadAffiliateSmsInviteCampaignIds,
  countAffiliateSmsSent,
  countAffiliateSmsDelivered,
  countAffiliateSmsUniqueInviteClicks,
  countAffiliatesRegisteredFromSmsInvite,
};
