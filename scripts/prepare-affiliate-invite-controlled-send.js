'use strict';

/**
 * Prepare the two-recipient affiliate invite pilot (no send, no tokens, no DB writes).
 *
 *   node scripts/prepare-affiliate-invite-controlled-send.js
 *
 * Writes preview HTML + manifest under samples/email-drafts/.
 * At real send time: issueInviteToken(19118189) → replace placeholder in Nelson row only,
 * then insert email_campaign_recipients + POST /email/process-queue (operator step).
 */

const fs = require('fs');
const path = require('path');

process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET =
  process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET || 'prepare-script-local-secret';

const envPath = require.resolve('../src/config/env');
if (!require.cache[envPath]) {
  require.cache[envPath] = {
    id: envPath,
    filename: envPath,
    loaded: true,
    exports: {
      port: 3000,
      nodeEnv: 'test',
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'test',
      apifyToken: 'test',
      apifyActorId: 'test',
      sessionSecret: 'test-session',
      emailUnsubscribeHmacSecret: process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET,
      affiliateTermsVersion: null,
    },
  };
}

const {
  buildPilotInviteEmail,
  buildControlledPilotManifest,
  buildControlledPilotPayloadSnapshots,
  NELSON_JOIN_TOKEN_PLACEHOLDER,
} = require('../src/lib/affiliateInviteControlledSend');
const { AFFILIATE_INVITE_EMAIL_SUBJECT } = require('../src/lib/affiliateInviteEmail');
const { DEFAULT_TERMS_VERSION } = require('../src/lib/affiliateJoinContract');

const ROOT = path.resolve(__dirname, '..');
const DRAFTS = path.join(ROOT, 'samples', 'email-drafts');
const PUBLIC_BASE = process.env.EMAIL_PUBLIC_BASE_URL || 'https://s.credizona.net';
const FROM = process.env.EMAIL_CAMPAIGNS_FROM || '';

function main() {
  const manifest = buildControlledPilotManifest({ publicBaseUrl: PUBLIC_BASE });
  if (!manifest.ok) {
    throw new Error(manifest.errorReason || 'manifest_failed');
  }

  fs.mkdirSync(DRAFTS, { recursive: true });

  ['nelson', 'nico'].forEach(function (key) {
    const mail = buildPilotInviteEmail(key, { publicBaseUrl: PUBLIC_BASE });
    if (!mail.ok) throw new Error(mail.errorReason || 'render_failed');
    const outPath = path.join(
      DRAFTS,
      'affiliate-invite-controlled-' + key + '.preview.html',
    );
    fs.writeFileSync(outPath, mail.html, 'utf8');
  });

  const manifestPath = path.join(DRAFTS, 'affiliate-invite-controlled-manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      Object.assign({}, manifest, {
        prepared_at: new Date().toISOString(),
        email_public_base_url: PUBLIC_BASE,
        email_campaigns_from_configured: Boolean(FROM),
        nelson_token_placeholder: NELSON_JOIN_TOKEN_PLACEHOLDER,
        affiliate_terms_default: DEFAULT_TERMS_VERSION,
        send_not_executed: true,
      }),
      null,
      2,
    ) + '\n',
    'utf8',
  );

  let snapshotPreview = null;
  if (FROM) {
    const snaps = buildControlledPilotPayloadSnapshots({
      from: FROM,
      publicBaseUrl: PUBLIC_BASE,
    });
    if (snaps.ok) {
      snapshotPreview = snaps.rows.map(function (row) {
        return {
          key: row.key,
          email: row.email,
          payload_to: row.snapshot.payload_to,
          payload_from: row.snapshot.payload_from,
          payload_subject: row.snapshot.payload_subject,
          payload_html_length: row.snapshot.payload_html.length,
          join_token_pending: row.join_token_pending,
        };
      });
    }
  }

  process.stdout.write('Affiliate controlled invite — prepare only (no send)\n');
  process.stdout.write('Subject: ' + AFFILIATE_INVITE_EMAIL_SUBJECT + '\n');
  process.stdout.write('Terms default (join API): ' + DEFAULT_TERMS_VERSION + '\n');
  process.stdout.write('Manifest: ' + manifestPath + '\n');
  manifest.recipients.forEach(function (r) {
    process.stdout.write(
      '  - ' +
        r.key +
        ': ' +
        r.email +
        ' → ' +
        r.click_url +
        (r.join_token_pending ? ' (token pending)' : '') +
        '\n',
    );
  });
  if (!FROM) {
    process.stdout.write(
      '\nSet EMAIL_CAMPAIGNS_FROM locally to validate payload snapshots (optional).\n',
    );
  } else if (snapshotPreview) {
    process.stdout.write('\nPayload snapshot preview (from=' + FROM + '):\n');
    process.stdout.write(JSON.stringify(snapshotPreview, null, 2) + '\n');
  }
}

main();
