'use strict';

/**
 * Local controlled prepare for affiliate SMS pilot 10 (dry-run by default).
 *
 *   node scripts/prepare-affiliate-invite-sms-pilot10-controlled.js
 */

require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const {
  prepareAffiliateInviteSmsPilot10Batch,
  isPilot10SendAuthorized,
} = require('../src/lib/affiliateInviteSmsPilot10Orchestration');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required.');
    process.exit(2);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const batch = await prepareAffiliateInviteSmsPilot10Batch(sb, new Date(), {
    dryRun: !isPilot10SendAuthorized({ dryRun: false }),
  });

  console.log(
    JSON.stringify(
      {
        send_authorized: isPilot10SendAuthorized({ dryRun: false }),
        batch: batch,
      },
      null,
      2,
    ),
  );
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
