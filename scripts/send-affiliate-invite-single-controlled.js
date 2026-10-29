'use strict';

/**
 * Operator: single affiliate invite email (one CI, pilot7 template + issueInviteToken).
 *
 *   node scripts/send-affiliate-invite-single-controlled.js --preflight
 *   ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH=true node scripts/send-affiliate-invite-single-controlled.js --send
 *
 * Does not modify Railway env (set AFFILIATE_JOIN_PILOT_ALLOWLIST separately).
 *
 * Template source must be the tracked UTF-8 file (git checkout), never materialized
 * via PowerShell pipes/Out-File — that produces Latin-1 mojibake (particip├í, etc.).
 */

const readline = require('readline');
const { EMAIL_AUDIENCE_MODES } = require('../src/services/email-campaigns/audienceMode');
const {
  buildRecipientPayloadSnapshot,
  readCampaignsFrom,
} = require('../src/services/email-campaigns/payloadSnapshot');
const { processQueue } = require('../src/services/email-campaigns/processor');
const { issueInviteToken, getActiveAffiliateByCi } = require('../src/lib/affiliateOptIn');
const { ciExistsInFunnel } = require('../src/lib/affiliateOptInDbHelpers');
const { parseCi } = require('../src/lib/affiliateDirectory');
const { resolveAffiliateSmsPhone, normalizeDigits } = require('../src/lib/affiliatePhoneResolve');
const { maskAffiliatePhone } = require('../src/lib/affiliateJoinContract');
const {
  AFFILIATE_INVITE_EMAIL_SUBJECT,
  buildAffiliateJoinUrl,
  buildAffiliateTermsUrl,
  buildAffiliateInviteHeroImageUrl,
  renderAffiliateInviteEmail,
  readPublicBaseUrl,
} = require('../src/lib/affiliateInviteEmail');
const { pilot7AllowlistCsv } = require('../src/lib/affiliateInvitePilot7Roster');
const { NELSON_JOIN_TOKEN_PLACEHOLDER } = require('../src/lib/affiliateInviteControlledSend');

const TARGET_CI = 10768808;
const TARGET_EMAIL = 'nico@copanel.uy';
const EXPECTED_PHONE_MASK = '***0035';
const CAMPAIGN_NAME =
  'PILOT affiliate invite single CI 10768808 (controlled join token)';
const IDEMPOTENCY_KEY = 'affiliate-pilot-single:v1:10768808';
const CAMPAIGN_BODY_STUB =
  '<!-- DIRECTED affiliate single-CI pilot: per-recipient payload_html snapshot -->';

function parseArgs(argv) {
  return {
    send: argv.indexOf('--send') !== -1,
    preflight: argv.indexOf('--preflight') !== -1,
  };
}

function maskJoinUrl(url) {
  const s = String(url || '');
  const i = s.indexOf('?t=');
  if (i === -1) return s.replace(/\/affiliates\/join.*/, '/affiliates/join?t=***');
  return s.slice(0, i + 3) + '***';
}

function joinUrlDomain(url) {
  try {
    return new URL(String(url)).host;
  } catch (_e) {
    return null;
  }
}

async function findPriorSingleCampaign(supabase) {
  const { data: campaign, error: cErr } = await supabase
    .from('email_campaigns')
    .select('id, name, status, created_at')
    .eq('name', CAMPAIGN_NAME)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cErr) throw new Error('campaign lookup: ' + cErr.message);
  if (!campaign) return { campaign: null, recipients: [] };

  const { data: recipients, error: rErr } = await supabase
    .from('email_campaign_recipients')
    .select('id, email, status, idempotency_key, ci, sent_at, error_reason, provider_message_id')
    .eq('campaign_id', campaign.id);
  if (rErr) throw new Error('recipients lookup: ' + rErr.message);
  return { campaign: campaign, recipients: recipients || [] };
}

function detectDuplicate(recipients) {
  const list = recipients || [];
  const byKey = list.filter(function (r) {
    return r.idempotency_key === IDEMPOTENCY_KEY;
  });
  const blocking = byKey.filter(function (r) {
    return r.status === 'queued' || r.status === 'sent';
  });
  if (blocking.length) {
    return { duplicate: true, blocking: blocking };
  }
  return { duplicate: false };
}

async function validateTarget(supabase) {
  const { normalizeEmail, isEmailCurrentlySuppressed } = require('../src/services/email-campaigns/processor');
  const ci = parseCi(TARGET_CI);
  if (ci == null) return { ok: false, reason: 'invalid_ci' };

  const aff = await getActiveAffiliateByCi(supabase, ci);
  if (aff) return { ok: false, reason: 'already_active_affiliate' };

  const inFunnel = await ciExistsInFunnel(supabase, ci);
  if (!inFunnel) return { ok: false, reason: 'not_in_funnel' };

  const { data: sols, error: solErr } = await supabase
    .from('cz_funnel_solicitudes')
    .select('email')
    .eq('ci', ci)
    .not('email', 'is', null)
    .order('fecha_reg', { ascending: false, nullsFirst: false })
    .limit(1);
  if (solErr) throw solErr;
  const funnelEmail = sols && sols[0] && sols[0].email ? String(sols[0].email).trim() : '';
  const funnelNorm = normalizeEmail(funnelEmail);
  const targetNorm = normalizeEmail(TARGET_EMAIL);
  if (!funnelNorm || funnelNorm !== targetNorm) {
    return {
      ok: false,
      reason: 'funnel_email_mismatch',
      funnel_email: funnelEmail ? funnelEmail.replace(/(.{2}).*@/, '$1***@') : null,
    };
  }

  const phone = await resolveAffiliateSmsPhone(supabase, ci);
  const masked = maskAffiliatePhone(phone);
  if (masked !== EXPECTED_PHONE_MASK) {
    return { ok: false, reason: 'phone_mask_mismatch', phone_masked: masked };
  }

  const suppressed = await isEmailCurrentlySuppressed(targetNorm);
  if (suppressed) return { ok: false, reason: 'email_suppressed' };

  const { data: tokens, error: tokErr } = await supabase
    .from('affiliate_invite_tokens')
    .select('id, status, expires_at, created_at')
    .eq('ci', ci)
    .eq('status', 'issued')
    .order('created_at', { ascending: false })
    .limit(3);
  if (tokErr) throw tokErr;

  return {
    ok: true,
    ci: ci,
    phone_masked: masked,
    issued_invites: (tokens || []).map(function (t) {
      return { id: t.id, status: t.status, expires_at: t.expires_at };
    }),
  };
}

function buildEmailSnapshot(from, publicBase, rawToken) {
  const joinUrl = buildAffiliateJoinUrl(rawToken, publicBase);
  const rendered = renderAffiliateInviteEmail({
    publicBaseUrl: publicBase,
    joinUrl: joinUrl,
    termsUrl: buildAffiliateTermsUrl(publicBase),
    heroImageUrl: buildAffiliateInviteHeroImageUrl(publicBase),
  });
  if (!rendered.ok) {
    throw new Error(rendered.errorReason || 'render_failed');
  }
  if (rendered.html.indexOf(NELSON_JOIN_TOKEN_PLACEHOLDER) !== -1) {
    throw new Error('placeholder_leaked_in_html');
  }
  const snap = buildRecipientPayloadSnapshot({
    to: TARGET_EMAIL,
    from: from,
    subject: AFFILIATE_INVITE_EMAIL_SUBJECT,
    bodyHtml: rendered.html,
    purpose: null,
    template_vars: {},
  });
  return { joinUrl: joinUrl, snapshot: snap };
}

async function runPreflight(supabase) {
  const target = await validateTarget(supabase);
  const prior = await findPriorSingleCampaign(supabase);
  const dup = detectDuplicate(prior.recipients);
  const allowlistCsv = pilot7AllowlistCsv() + ',' + String(TARGET_CI);
  return {
    ok: target.ok && !dup.duplicate,
    target: target,
    duplicate_dispatch: dup,
    prior_campaign_id: prior.campaign && prior.campaign.id,
    suggested_allowlist: allowlistCsv,
    public_base_url: readPublicBaseUrl(process.env.EMAIL_PUBLIC_BASE_URL),
    from_configured: Boolean(readCampaignsFrom()),
  };
}

function promptSendConfirmation(input, output) {
  const rl = readline.createInterface({ input: input, output: output });
  return new Promise(function (resolve) {
    let settled = false;
    function finish(answer) {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(String(answer == null ? '' : answer).trim() === 'yes');
    }
    output.write('Single affiliate invite send\n');
    output.write('  CI: ' + String(TARGET_CI) + '\n');
    output.write('  Email: ' + TARGET_EMAIL + '\n');
    output.write('  Campaign: ' + CAMPAIGN_NAME + '\n');
    rl.question('Type yes to mint token and send: ', finish);
    rl.once('close', function () {
      finish('');
    });
  });
}

async function runSend() {
  if (String(process.env.ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH || '').trim() !== 'true') {
    throw new Error('ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH=true is required for --send');
  }
  const from = readCampaignsFrom();
  if (!from) throw new Error('EMAIL_CAMPAIGNS_FROM is not configured');

  const accepted = await promptSendConfirmation(process.stdin, process.stderr);
  if (!accepted) throw new Error('send cancelled');

  require('dotenv').config({ quiet: true });
  const supabase = require('../src/clients/supabase');
  const publicBase = readPublicBaseUrl(process.env.EMAIL_PUBLIC_BASE_URL);

  const pre = await runPreflight(supabase);
  if (!pre.ok) {
    process.stdout.write(JSON.stringify(pre, null, 2) + '\n');
    process.exit(2);
  }

  const prior = await findPriorSingleCampaign(supabase);
  const dup = detectDuplicate(prior.recipients);
  if (dup.duplicate) {
    process.stdout.write(
      JSON.stringify({ ok: false, errorReason: 'duplicate_dispatch', blocking: dup.blocking }, null, 2) +
        '\n',
    );
    process.exit(2);
  }

  const now = new Date();
  const minted = await issueInviteToken(supabase, TARGET_CI, now);
  if (!minted.ok) {
    throw new Error(minted.error || 'issue_invite_failed');
  }

  const built = buildEmailSnapshot(from, publicBase, minted.token);

  const { data: campaign, error: cErr } = await supabase
    .from('email_campaigns')
    .insert({
      name: CAMPAIGN_NAME,
      subject: AFFILIATE_INVITE_EMAIL_SUBJECT,
      body_html: CAMPAIGN_BODY_STUB,
      audience_mode: EMAIL_AUDIENCE_MODES.DIRECTED,
      segment_id: null,
      segment_rules_snapshot: null,
      status: 'sending',
      recipient_count: 1,
    })
    .select('id, name, status')
    .single();
  if (cErr) throw new Error('campaign_insert:' + cErr.message);

  const snap = built.snapshot;
  const { error: rErr } = await supabase.from('email_campaign_recipients').insert({
    campaign_id: campaign.id,
    idempotency_key: IDEMPOTENCY_KEY,
    ci: String(TARGET_CI),
    email: snap.email,
    status: 'queued',
    purpose: null,
    template_vars: snap.template_vars || {},
    payload_to: snap.payload_to,
    payload_from: snap.payload_from,
    payload_subject: snap.payload_subject,
    payload_html: snap.payload_html,
    template_subject_snapshot: snap.template_subject_snapshot,
    template_body_html_snapshot: snap.template_body_html_snapshot,
  });
  if (rErr) throw new Error('recipients_insert:' + rErr.message);

  const queueSummary = await processQueue({ campaignId: campaign.id });

  const { data: recipient, error: recErr } = await supabase
    .from('email_campaign_recipients')
    .select('id, status, sent_at, error_reason, provider_message_id')
    .eq('campaign_id', campaign.id)
    .eq('idempotency_key', IDEMPOTENCY_KEY)
    .maybeSingle();
  if (recErr) throw recErr;

  const { data: inviteRow, error: invErr } = await supabase
    .from('affiliate_invite_tokens')
    .select('id, status, expires_at')
    .eq('id', minted.invite.id)
    .maybeSingle();
  if (invErr) throw invErr;

  const report = {
    ok: recipient && recipient.status === 'sent',
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    recipient: recipient,
    invite_token: inviteRow
      ? {
          id: inviteRow.id,
          status: inviteRow.status,
          expires_at: inviteRow.expires_at,
        }
      : null,
    join_link_domain: joinUrlDomain(built.joinUrl),
    join_link_masked: maskJoinUrl(built.joinUrl),
    process_queue: queueSummary,
    sms_not_sent: true,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.ok) process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv);
  require('dotenv').config({
    path: require('path').join(__dirname, '..', '.env'),
    quiet: true,
  });
  require('dotenv').config({
    path: 'C:/Users/Admin/Desktop/Mie Backend/mie-backend/.env',
    quiet: true,
  });

  if (args.send) {
    await runSend();
    return;
  }

  const supabase = require('../src/clients/supabase');
  const out = await runPreflight(supabase);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (!out.ok) process.exit(2);
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write(String(err && err.message ? err.message : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  TARGET_CI,
  CAMPAIGN_NAME,
  IDEMPOTENCY_KEY,
  runPreflight,
};
