'use strict';

/**
 * Operator: seven-recipient affiliate invite emails (controlled join tokens).
 *
 * Default: dry-run (no DB writes, no tokens, no queue).
 *
 *   node scripts/send-affiliate-invite-pilot7-emails.js
 *   node scripts/send-affiliate-invite-pilot7-emails.js --preflight
 *   node scripts/send-affiliate-invite-pilot7-emails.js --send
 *   node scripts/send-affiliate-invite-pilot7-emails.js --send --enqueue-only
 *
 * --preflight: dry-run + Supabase recipient/suppression/duplicate checks (read-only).
 *
 * Authorized real send requires ALL of:
 *   ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH=true
 *   EMAIL_CAMPAIGNS_FROM configured
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   interactive confirmation (type yes)
 *
 * Does not modify Railway env. See validateAffiliatePilot7JoinEnv() for join window vars.
 */

const readline = require('readline');

function parseArgs(argv) {
  return {
    send: argv.indexOf('--send') !== -1,
    enqueueOnly: argv.indexOf('--enqueue-only') !== -1,
    preflight: argv.indexOf('--preflight') !== -1,
  };
}

function assertEmailDispatchAllowed(sendMode) {
  if (!sendMode) return;
  if (String(process.env.ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH || '').trim() !== 'true') {
    throw new Error('ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH=true is required for --send');
  }
}

function assertSupabaseConfigured() {
  if (!process.env.SUPABASE_URL || !String(process.env.SUPABASE_URL).trim()) {
    throw new Error('SUPABASE_URL is required for --send or --preflight');
  }
  if (
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    !String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim()
  ) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for --send or --preflight');
  }
}

function printJoinWindowChecklist() {
  const {
    validateAffiliatePilot7JoinEnv,
    pilot7AllowlistCsv,
  } = require('../src/lib/affiliateInvitePilot7Roster');
  const joinEnv = validateAffiliatePilot7JoinEnv();
  process.stdout.write('\nJoin/OTP window checklist (Railway — not applied by this script):\n');
  process.stdout.write('  AFFILIATE_JOIN_ENABLED=true\n');
  process.stdout.write('  AFFILIATE_TX_SMS_ENABLED=true (+ NOTIFYME / campaign id as prod)\n');
  process.stdout.write('  AFFILIATE_JOIN_PILOT_CI unset (remove Nelson-only lock)\n');
  process.stdout.write(
    '  AFFILIATE_JOIN_PILOT_ALLOWLIST=' + pilot7AllowlistCsv() + '\n',
  );
  process.stdout.write('  AFFILIATE_JOIN_PILOT_SMS_PHONE unset (funnel celular per CI)\n');
  process.stdout.write('  ' + JSON.stringify(joinEnv) + '\n');
}

function promptSendConfirmation(input, output) {
  const { PILOT7_RECIPIENTS } = require('../src/lib/affiliateInvitePilot7Roster');
  const { PILOT7_CAMPAIGN_NAME } = require('../src/lib/affiliateInvitePilot7Dispatch');
  const rl = readline.createInterface({ input: input, output: output });
  return new Promise(function (resolve) {
    let settled = false;
    function finish(answer) {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(String(answer == null ? '' : answer).trim() === 'yes');
    }
    output.write('Recipients (' + PILOT7_RECIPIENTS.length + '):\n');
    for (let i = 0; i < PILOT7_RECIPIENTS.length; i += 1) {
      const r = PILOT7_RECIPIENTS[i];
      output.write(
        '  ' + r.ci + ' ' + r.email + ' [' + r.cohort + ']\n',
      );
    }
    output.write('Campaign: ' + PILOT7_CAMPAIGN_NAME + '\n');
    output.write('Seven invite tokens will be minted (one per CI) and enqueued.\n');
    rl.question('Type yes to enqueue and process the email queue: ', finish);
    rl.once('close', function () {
      finish('');
    });
  });
}

function stubEnvForDryRunIfNeeded() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }
  const envPath = require.resolve('../src/config/env');
  if (require.cache[envPath]) return;
  require.cache[envPath] = {
    id: envPath,
    filename: envPath,
    loaded: true,
    exports: {
      port: 3000,
      nodeEnv: 'test',
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'dry-run-stub',
      apifyToken: 'dry-run-stub',
      apifyActorId: 'dry-run-stub',
      sessionSecret: 'dry-run-stub',
      emailUnsubscribeHmacSecret:
        process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET || 'dry-run-unsub-stub',
      emailPublicBaseUrl: process.env.EMAIL_PUBLIC_BASE_URL || null,
    },
  };
}

async function runDryRun(opts) {
  require('dotenv').config({ quiet: true });
  stubEnvForDryRunIfNeeded();
  const { runPilot7DryRunPreflight } = require('../src/lib/affiliateInvitePilot7Dispatch');
  const { readCampaignsFrom } = require('../src/services/email-campaigns/payloadSnapshot');
  const from = readCampaignsFrom();

  let supabase = null;
  if (opts.preflight) {
    assertSupabaseConfigured();
    supabase = require('../src/clients/supabase');
  }

  const result = await runPilot7DryRunPreflight(supabase, {
    from: from || 'Janus <dry-run@example.invalid>',
    publicBaseUrl: process.env.EMAIL_PUBLIC_BASE_URL,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  printJoinWindowChecklist();
  if (!from) {
    process.stdout.write(
      '\nSet EMAIL_CAMPAIGNS_FROM locally to validate real From in --send preflight.\n',
    );
  }
  if (!result.ok) {
    process.exit(2);
  }
}

async function runSend(sendOpts) {
  const {
    dispatchPilot7InviteEmails,
    findPilot7CampaignWithRecipients,
    detectDuplicateDispatch,
    mintPilot7InviteTokens,
  } = require('../src/lib/affiliateInvitePilot7Dispatch');
  const { readCampaignsFrom } = require('../src/services/email-campaigns/payloadSnapshot');

  assertEmailDispatchAllowed(true);
  assertSupabaseConfigured();
  const from = readCampaignsFrom();
  if (!from) {
    throw new Error('EMAIL_CAMPAIGNS_FROM is not configured');
  }

  const accepted = await promptSendConfirmation(process.stdin, process.stderr);
  if (!accepted) {
    throw new Error('send cancelled');
  }

  const supabase = require('../src/clients/supabase');

  const existing = await findPilot7CampaignWithRecipients(supabase);
  const dup = detectDuplicateDispatch(existing.recipients);
  if (dup.duplicate) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          errorReason: 'pilot7_dispatch_already_queued_or_sent',
          existing_campaign_id: existing.campaign && existing.campaign.id,
          blocking: dup.blocking,
        },
        null,
        2,
      ) + '\n',
    );
    process.exit(2);
  }

  const minted = await mintPilot7InviteTokens(supabase);
  if (!minted.ok) {
    throw new Error(minted.errorReason || 'pilot7_token_mint_failed');
  }

  const result = await dispatchPilot7InviteEmails(supabase, {
    joinTokensByKey: minted.joinTokensByKey,
    from: from,
    publicBaseUrl: process.env.EMAIL_PUBLIC_BASE_URL,
    processQueue: !sendOpts.enqueueOnly,
  });

  if (!result.ok) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(2);
  }

  const safeOut = Object.assign({}, result, {
    invites: minted.invites,
  });
  process.stdout.write(JSON.stringify(safeOut, null, 2) + '\n');
  printJoinWindowChecklist();
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.send) {
    require('dotenv').config({ quiet: true });
    await runSend(args);
  } else {
    await runDryRun(args);
  }
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write(String(err && err.message ? err.message : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runDryRun,
};
