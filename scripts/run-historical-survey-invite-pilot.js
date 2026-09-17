'use strict';

/**
 * Historical survey-invite pilot CLI (authorized 10 only).
 *
 * Default: --dry-run (no writes).
 *   node scripts/run-historical-survey-invite-pilot.js --dry-run
 *   node scripts/run-historical-survey-invite-pilot.js --execute
 *
 * Does NOT flip EMAIL_PROVIDER_MODE. Does NOT call processQueue.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const {
  runHistoricalSurveyInvitePilot,
} = require('../src/lib/rejectedSurveyInviteHistoricalPilot');

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
  const summary = await runHistoricalSurveyInvitePilot(getSupabase(), {
    dryRun: args.dryRun,
    stopOnError: true,
  });
  const outPath = path.join(__dirname, '_tmp-historical-pilot-dry.json');
  require('fs').writeFileSync(outPath, JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (summary.aborted || summary.ok === false) process.exitCode = 2;
})().catch(function (err) {
  console.error(
    JSON.stringify({
      status: 'ERROR',
      error: err && err.message ? err.message : String(err),
    }),
  );
  process.exit(1);
});
