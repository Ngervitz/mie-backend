'use strict';

/**
 * Operator: two-recipient affiliate invite emails (Nelson + Nico).
 *
 * Default: dry-run (no DB writes, no tokens, no queue).
 *
 *   node scripts/send-affiliate-invite-pilot-emails.js
 *   node scripts/send-affiliate-invite-pilot-emails.js --send
 *   node scripts/send-affiliate-invite-pilot-emails.js --send --enqueue-only
 *
 * Authorized real send requires ALL of:
 *   ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH=true
 *   EMAIL_CAMPAIGNS_FROM configured
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   interactive confirmation (type yes)
 *
 * Email dispatch is independent of affiliate join / OTP SMS:
 *   - This script does NOT set AFFILIATE_JOIN_ENABLED or AFFILIATE_TX_SMS_ENABLED.
 *   - Nelson invite token is minted only during --send (revokes prior issued tokens for his CI).
 *
 * ── Temporary join + OTP window (Railway / prod — operator, after deploy) ──
 * 1. Deploy code + hero JPG; AFFILIATE_TERMS_VERSION unset or affiliate_v2.
 * 2. Send emails (this script --send) while join/SMS still off if you only need inbox first.
 * 3. For Nelson opt-in test, set concurrently for the window:
 *      AFFILIATE_JOIN_ENABLED=true
 *      AFFILIATE_JOIN_PILOT_CI=19118189
 *      AFFILIATE_JOIN_PILOT_SMS_PHONE=59893885859
 *      AFFILIATE_TX_SMS_ENABLED=true  (+ AFFILIATE_TX_SMS_CAMPAIGN_ID, OTP secrets as already used)
 * 4. Nelson completes join; Nico uses /a/6SNY5C3NR5 only (no new registration).
 * 5. Revert: AFFILIATE_JOIN_ENABLED=false, AFFILIATE_TX_SMS_ENABLED=false,
 *    unset AFFILIATE_JOIN_PILOT_CI and AFFILIATE_JOIN_PILOT_SMS_PHONE.
 *
 * Does not commit, deploy, or modify historical affiliate consent rows.
 */

const readline = require('readline');

function parseArgs(argv) {
  const send = argv.indexOf('--send') !== -1;
  const enqueueOnly = argv.indexOf('--enqueue-only') !== -1;
  return { send: send, enqueueOnly: enqueueOnly };
}

function assertEmailDispatchAllowed(sendMode) {
  if (!sendMode) return;
  if (String(process.env.ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH || '').trim() !== 'true') {
    throw new Error('ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH=true is required for --send');
  }
}

function assertSupabaseConfigured() {
  if (!process.env.SUPABASE_URL || !String(process.env.SUPABASE_URL).trim()) {
    throw new Error('SUPABASE_URL is required for --send');
  }
  if (
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    !String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim()
  ) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for --send');
  }
}

function promptSendConfirmation(input, output) {
  const { PILOT_NELSON, PILOT_NICO } = require('../src/lib/affiliateInviteControlledSend');
  const { PILOT_CAMPAIGN_NAME } = require('../src/lib/affiliateInvitePilotDispatch');
  const rl = readline.createInterface({ input: input, output: output });
  return new Promise(function (resolve) {
    let settled = false;
    function finish(answer) {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(String(answer == null ? '' : answer).trim() === 'yes');
    }
    output.write('Recipients:\n');
    output.write('  Nelson: ' + PILOT_NELSON.email + ' (CI ' + PILOT_NELSON.ci + ')\n');
    output.write('  Nico:   ' + PILOT_NICO.email + ' (referral /a/' + PILOT_NICO.referral_code + ')\n');
    output.write('Campaign: ' + PILOT_CAMPAIGN_NAME + '\n');
    output.write('A new Nelson invite token will be minted and enqueued.\n');
    rl.question('Type yes to enqueue and process the email queue: ', finish);
    rl.once('close', function () {
      finish('');
    });
  });
}

function printJoinWindowChecklist() {
  const { validateAffiliatePilotJoinEnv } = require('../src/lib/affiliateJoinPilotRoster');
  const joinEnv = validateAffiliatePilotJoinEnv();
  process.stdout.write('\nJoin/OTP window checklist (not applied by this script):\n');
  process.stdout.write(
    '  AFFILIATE_JOIN_ENABLED=true (separate from email dispatch)\n',
  );
  process.stdout.write(
    '  AFFILIATE_TX_SMS_ENABLED=true (separate from email dispatch)\n',
  );
  process.stdout.write('  ' + JSON.stringify(joinEnv) + '\n');
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

async function runDryRun() {
  require('dotenv').config({ quiet: true });
  stubEnvForDryRunIfNeeded();
  const { buildPilotDispatchPlan } = require('../src/lib/affiliateInvitePilotDispatch');
  const { NELSON_JOIN_TOKEN_PLACEHOLDER } = require('../src/lib/affiliateInviteControlledSend');
  const { readCampaignsFrom } = require('../src/services/email-campaigns/payloadSnapshot');
  const from = readCampaignsFrom();
  const plan = buildPilotDispatchPlan({
    from: from || 'Janus <dry-run@example.invalid>',
    publicBaseUrl: process.env.EMAIL_PUBLIC_BASE_URL,
  });
  if (!plan.ok) {
    throw new Error(plan.errorReason || 'dry_run_plan_failed');
  }

  const out = {
    mode: 'dry-run',
    send_executed: false,
    token_minted: false,
    campaign_name: plan.campaign_name,
    subject: plan.subject,
    from_configured: Boolean(from),
    public_base_url: plan.public_base_url,
    nelson_join_token_pending: plan.nelson_join_token_pending,
    nelson_token_placeholder: NELSON_JOIN_TOKEN_PLACEHOLDER,
    recipients: plan.manifest.recipients,
    affiliate_terms_default: 'affiliate_v2',
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  printJoinWindowChecklist();
  if (!from) {
    process.stdout.write(
      '\nSet EMAIL_CAMPAIGNS_FROM locally to validate real From in --send preflight.\n',
    );
  }
}

async function runSend(opts) {
  const {
    dispatchPilotInviteEmails,
    findPilotCampaignWithRecipients,
    detectDuplicateDispatch,
    mintNelsonPilotInviteToken,
  } = require('../src/lib/affiliateInvitePilotDispatch');
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

  const existing = await findPilotCampaignWithRecipients(supabase);
  const dup = detectDuplicateDispatch(existing.recipients);
  if (dup.duplicate) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          errorReason: 'pilot_dispatch_already_queued_or_sent',
          existing_campaign_id: existing.campaign && existing.campaign.id,
          blocking: dup.blocking,
        },
        null,
        2,
      ) + '\n',
    );
    process.exit(2);
  }

  const minted = await mintNelsonPilotInviteToken(supabase);
  if (!minted.ok) {
    throw new Error(minted.errorReason || 'nelson_token_mint_failed');
  }

  const result = await dispatchPilotInviteEmails(supabase, {
    nelsonJoinToken: minted.token,
    from: from,
    publicBaseUrl: process.env.EMAIL_PUBLIC_BASE_URL,
    processQueue: !opts.enqueueOnly,
  });

  if (!result.ok) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(2);
  }

  const safeOut = Object.assign({}, result, {
    nelson_invite: {
      invite_id: minted.invite_id,
      expires_at: minted.expires_at,
    },
  });
  delete safeOut.nelson_token;

  process.stdout.write(JSON.stringify(safeOut, null, 2) + '\n');
  printJoinWindowChecklist();
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.send) {
    require('dotenv').config({ quiet: true });
    await runSend(args);
  } else {
    await runDryRun();
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
  assertEmailDispatchAllowed,
  runDryRun,
};
