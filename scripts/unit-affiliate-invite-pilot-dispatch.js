'use strict';

/**
 * node scripts/unit-affiliate-invite-pilot-dispatch.js
 */

const assert = require('assert');

process.env.EMAIL_CAMPAIGNS_FROM = 'Janus <noreply@credizona.com.uy>';
process.env.EMAIL_UNSUBSCRIBE_HMAC_SECRET = 'test-email-unsubscribe-secret';
process.env.EMAIL_PUBLIC_BASE_URL = 'https://s.credizona.net';

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
    emailPublicBaseUrl: 'https://s.credizona.net',
  },
};

const {
  NELSON_JOIN_TOKEN_PLACEHOLDER,
  PILOT_NICO,
} = require('../src/lib/affiliateInviteControlledSend');
const {
  assertHtmlHasNoInvitePlaceholder,
  buildPilotDispatchPlan,
  detectDuplicateDispatch,
  pilotIdempotencyKey,
} = require('../src/lib/affiliateInvitePilotDispatch');

assert.throws(function () {
  assertHtmlHasNoInvitePlaceholder(
    'https://join?t=' + NELSON_JOIN_TOKEN_PLACEHOLDER,
    'test',
  );
});

const dryPlan = buildPilotDispatchPlan({
  from: 'Janus <noreply@credizona.com.uy>',
});
assert.strictEqual(dryPlan.ok, true);
assert.strictEqual(dryPlan.nelson_join_token_pending, true);
assert.strictEqual(dryPlan.rows.length, 2);

const realPlan = buildPilotDispatchPlan({
  from: 'Janus <noreply@credizona.com.uy>',
  nelsonJoinToken: 'real-secret-token-value',
});
assert.strictEqual(realPlan.ok, true);
assert.strictEqual(realPlan.nelson_join_token_pending, false);
assert.ok(
  realPlan.rows[0].snapshot.payload_html.indexOf(
    encodeURIComponent('real-secret-token-value'),
  ) !== -1,
);
assert.ok(
  realPlan.rows[1].snapshot.payload_html.indexOf('/a/' + PILOT_NICO.referral_code) !==
    -1,
);

assert.strictEqual(pilotIdempotencyKey('nelson'), 'affiliate-pilot-2rec:v1:nelson');

const dup = detectDuplicateDispatch([
  { email: 'a@b.com', status: 'sent', id: 1, idempotency_key: 'x' },
]);
assert.strictEqual(dup.duplicate, true);

const noDup = detectDuplicateDispatch([{ email: 'a@b.com', status: 'failed', id: 2 }]);
assert.strictEqual(noDup.duplicate, false);

const {
  assertEmailDispatchAllowed,
  parseArgs,
} = require('./send-affiliate-invite-pilot-emails');

assert.strictEqual(parseArgs(['node', 'x']).send, false);
assert.strictEqual(parseArgs(['node', 'x', '--send']).send, true);
assert.throws(function () {
  assertEmailDispatchAllowed(true);
});

process.env.ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH = 'true';
assert.doesNotThrow(function () {
  assertEmailDispatchAllowed(true);
});
delete process.env.ALLOW_AFFILIATE_PILOT_EMAIL_DISPATCH;

console.log('unit-affiliate-invite-pilot-dispatch: ok');
