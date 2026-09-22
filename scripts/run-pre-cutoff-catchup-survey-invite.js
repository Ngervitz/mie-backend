'use strict';

/**
 * Pre-cutoff catch-up runner CLI (frozen 112 CZ IDs).
 *
 * Default: --dry-run (no writes).
 *   node scripts/run-pre-cutoff-catchup-survey-invite.js --dry-run
 *   node scripts/run-pre-cutoff-catchup-survey-invite.js --execute
 *
 * Does NOT call processQueue. Does NOT materialize STEP1.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const {
  runPreCutoffCatchupSurveyInvite,
} = require('../src/lib/rejectedSurveyInvitePreCutoffCatchup');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function parseArgs(argv) {
  const args = { dryRun: true, execute: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--execute') {
      args.execute = true;
      args.dryRun = false;
    } else if (argv[i] === '--dry-run') {
      args.dryRun = true;
      args.execute = false;
    }
  }
  return args;
}

(async function main() {
  const args = parseArgs(process.argv);
  const summary = await runPreCutoffCatchupSurveyInvite(getSupabase(), {
    dryRun: args.dryRun,
    stopOnError: true,
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
