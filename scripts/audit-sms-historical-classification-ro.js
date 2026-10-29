'use strict';

/**
 * Read-only: list all sms_campaigns with proposed vertical/purpose (id-based rules).
 *
 *   node scripts/audit-sms-historical-classification-ro.js
 */

require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const {
  buildHistoricalClassificationAudit,
  SMS_AFFILIATE_OTP_CAMPAIGN_IDS,
} = require('../src/lib/smsCampaignHistoricalRegistry');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for live audit.');
    process.exit(2);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb
    .from('sms_campaigns')
    .select('id, name, created_at, status, total_messages, destination_url, campaign_series_id')
    .order('created_at', { ascending: true });
  if (error) throw error;

  const audit = buildHistoricalClassificationAudit(data || []);
  audit.live_row_count = (data || []).length;
  audit.registry_otp_ids = SMS_AFFILIATE_OTP_CAMPAIGN_IDS;

  console.log(JSON.stringify(audit, null, 2));
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
