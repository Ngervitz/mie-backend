'use strict';

/**
 * Controlled dispatch for affiliate SMS pilot 10 (dry-run unless env allows real send).
 *
 *   node scripts/send-affiliate-invite-sms-pilot10-controlled.js
 *   node scripts/send-affiliate-invite-sms-pilot10-controlled.js --dry-run
 */

require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const {
  dispatchAffiliateInviteSmsPilot10,
} = require('../src/lib/affiliateInviteSmsPilot10Dispatch');
const { isPilot10SendAuthorized } = require('../src/lib/affiliateInviteSmsPilot10Orchestration');
const { evaluateAffiliateSmsPilot10PreSendGates } = require('../src/lib/affiliateInviteSmsPilot10PreSendGates');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required.');
    process.exit(2);
  }

  const forceDry = process.argv.indexOf('--dry-run') !== -1;
  const dryRun = forceDry || !isPilot10SendAuthorized({ dryRun: false });

  const gates = evaluateAffiliateSmsPilot10PreSendGates(process.env);
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const out = await dispatchAffiliateInviteSmsPilot10(sb, {
    dryRun: dryRun,
    skipPreSendGates: dryRun,
  });

  console.log(
    JSON.stringify(
      {
        dry_run: dryRun,
        send_authorized: isPilot10SendAuthorized({ dryRun: false }),
        pre_send_gates: gates,
        result: out,
      },
      null,
      2,
    ),
  );

  if (!out.ok) process.exit(1);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
