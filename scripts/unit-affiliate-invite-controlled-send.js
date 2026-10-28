'use strict';

/**
 * node scripts/unit-affiliate-invite-controlled-send.js
 */

const assert = require('assert');

process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';

const envPath = require.resolve('../src/config/env');
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
    emailUnsubscribeHmacSecret: 'test-email-unsubscribe-secret',
    affiliateTermsVersion: null,
  },
};

const {
  NELSON_JOIN_TOKEN_PLACEHOLDER,
  PILOT_NELSON,
  PILOT_NICO,
  resolvePilotClickUrl,
  buildPilotInviteEmail,
  buildControlledPilotPayloadSnapshots,
  buildControlledPilotManifest,
} = require('../src/lib/affiliateInviteControlledSend');
const { AFFILIATE_INVITE_EMAIL_SUBJECT } = require('../src/lib/affiliateInviteEmail');
const { DEFAULT_TERMS_VERSION, resolveConfiguredTermsVersion, buildReferralUrl } = require('../src/lib/affiliateJoinContract');

assert.strictEqual(AFFILIATE_INVITE_EMAIL_SUBJECT, 'Ganá plata con Credizona');
assert.strictEqual(DEFAULT_TERMS_VERSION, 'affiliate_v3');
assert.strictEqual(resolveConfiguredTermsVersion(undefined), 'affiliate_v3');
assert.strictEqual(resolveConfiguredTermsVersion('affiliate_v3'), 'affiliate_v3');
assert.strictEqual(resolveConfiguredTermsVersion('affiliate_v1'), 'affiliate_v1');
assert.strictEqual(resolveConfiguredTermsVersion('affiliate_v2'), 'affiliate_v2');
assert.strictEqual(resolveConfiguredTermsVersion('not valid!'), 'affiliate_v3');

const nelsonUrl = resolvePilotClickUrl('nelson', { publicBaseUrl: 'https://s.credizona.net' });
assert.ok(nelsonUrl.indexOf('/affiliates/join?t=') !== -1);
assert.ok(nelsonUrl.indexOf(encodeURIComponent(NELSON_JOIN_TOKEN_PLACEHOLDER)) !== -1);

const nelsonReal = resolvePilotClickUrl('nelson', {
  publicBaseUrl: 'https://s.credizona.net',
  nelsonJoinToken: 'secret-token-x',
});
assert.ok(nelsonReal.indexOf(encodeURIComponent('secret-token-x')) !== -1);
assert.ok(nelsonReal.indexOf(NELSON_JOIN_TOKEN_PLACEHOLDER) === -1);

const nicoUrl = resolvePilotClickUrl('nico', { referralOrigin: 'https://s.credizona.net' });
assert.strictEqual(nicoUrl, buildReferralUrl('6SNY5C3NR5', 'https://s.credizona.net'));
assert.ok(nicoUrl.indexOf('/affiliates/join') === -1);

const nelsonMail = buildPilotInviteEmail('nelson', { publicBaseUrl: 'https://s.credizona.net' });
assert.strictEqual(nelsonMail.ok, true);
assert.strictEqual(nelsonMail.email, PILOT_NELSON.email);
assert.strictEqual(nelsonMail.ci, PILOT_NELSON.ci);
assert.strictEqual(nelsonMail.join_token_pending, true);
assert.ok(nelsonMail.html.indexOf('affiliate_v3') !== -1);

const nicoMail = buildPilotInviteEmail('nico', { publicBaseUrl: 'https://s.credizona.net' });
assert.strictEqual(nicoMail.ok, true);
assert.strictEqual(nicoMail.email, PILOT_NICO.email);
assert.strictEqual(nicoMail.kind, 'existing_referral');
assert.ok(nicoMail.html.indexOf(nicoUrl) !== -1);

const manifest = buildControlledPilotManifest({ publicBaseUrl: 'https://s.credizona.net' });
assert.strictEqual(manifest.ok, true);
assert.strictEqual(manifest.recipients.length, 2);

const snaps = buildControlledPilotPayloadSnapshots({
  from: 'Janus <noreply@credizona.com.uy>',
  publicBaseUrl: 'https://s.credizona.net',
});
assert.strictEqual(snaps.ok, true);
assert.strictEqual(snaps.rows.length, 2);
assert.strictEqual(snaps.rows[0].snapshot.payload_to, PILOT_NELSON.email);
assert.strictEqual(snaps.rows[1].snapshot.payload_to, PILOT_NICO.email);
assert.strictEqual(snaps.rows[0].join_token_pending, true);
assert.strictEqual(snaps.rows[1].join_token_pending, false);

const badFrom = buildControlledPilotPayloadSnapshots({ from: '' });
assert.strictEqual(badFrom.ok, false);

console.log('unit-affiliate-invite-controlled-send: ok');
