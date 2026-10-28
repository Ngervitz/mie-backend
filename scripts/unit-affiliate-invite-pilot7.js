'use strict';

/**
 * node scripts/unit-affiliate-invite-pilot7.js
 */

function stubEnvIfNeeded() {
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
      supabaseServiceRoleKey: 'stub',
      apifyToken: 'stub',
      apifyActorId: 'stub',
      sessionSecret: 'stub',
      emailUnsubscribeHmacSecret: 'stub',
      emailPublicBaseUrl: null,
    },
  };
}

stubEnvIfNeeded();

const assert = require('assert');
const {
  PILOT7_RECIPIENTS,
  AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS,
  pilot7AllowlistCsv,
} = require('../src/lib/affiliateInvitePilot7Roster');
const {
  JOIN_TOKEN_PLACEHOLDER,
  buildPilot7Manifest,
} = require('../src/lib/affiliateInvitePilot7Send');
const {
  buildPilot7DispatchPlan,
  pilot7IdempotencyKey,
  PILOT7_CAMPAIGN_NAME,
} = require('../src/lib/affiliateInvitePilot7Dispatch');
const { isCiAllowedForAffiliateJoin } = require('../src/lib/affiliateJoinPilot');

assert.strictEqual(PILOT7_RECIPIENTS.length, 7);
assert.strictEqual(AFFILIATE_PILOT7_AUTHORIZED_JOIN_CIS.length, 7);

const keys = new Set(PILOT7_RECIPIENTS.map(function (r) {
  return r.key;
}));
assert.strictEqual(keys.size, 7);

const emails = new Set(PILOT7_RECIPIENTS.map(function (r) {
  return r.email.toLowerCase();
}));
assert.strictEqual(emails.size, 7);

{
  const plan = buildPilot7DispatchPlan({
    from: 'Credizona <test@example.com>',
    publicBaseUrl: 'https://s.credizona.net',
    joinTokensByKey: null,
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.campaign_name, PILOT7_CAMPAIGN_NAME);
  assert.strictEqual(plan.rows.length, 7);
  assert.strictEqual(plan.join_tokens_pending, true);
  for (let i = 0; i < plan.rows.length; i += 1) {
    assert.strictEqual(plan.rows[i].join_token_pending, true);
    assert.ok(plan.rows[i].snapshot.payload_html.indexOf(JOIN_TOKEN_PLACEHOLDER) > 0);
    assert.ok(plan.rows[i].snapshot.payload_html.indexOf('/affiliates/join') > 0);
  }
}

{
  const fake = new Map();
  fake.set(PILOT7_RECIPIENTS[0].key, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const plan = buildPilot7DispatchPlan({
    from: 'Credizona <test@example.com>',
    publicBaseUrl: 'https://s.credizona.net',
    joinTokensByKey: fake,
  });
  assert.strictEqual(plan.ok, true);
  const first = plan.rows.find(function (r) {
    return r.key === PILOT7_RECIPIENTS[0].key;
  });
  assert.strictEqual(first.join_token_pending, false);
  assert.ok(first.snapshot.payload_html.indexOf(JOIN_TOKEN_PLACEHOLDER) === -1);
}

assert.strictEqual(
  pilot7IdempotencyKey('p54120325'),
  'affiliate-pilot-7rec:v1:p54120325',
);

const prevAllow = process.env.AFFILIATE_JOIN_PILOT_ALLOWLIST;
const prevPilotCi = process.env.AFFILIATE_JOIN_PILOT_CI;
delete process.env.AFFILIATE_JOIN_PILOT_CI;
process.env.AFFILIATE_JOIN_PILOT_ALLOWLIST = pilot7AllowlistCsv();
assert.strictEqual(isCiAllowedForAffiliateJoin(54120325), true);
assert.strictEqual(isCiAllowedForAffiliateJoin(19118189), false);
assert.strictEqual(isCiAllowedForAffiliateJoin(99999999), false);
if (prevAllow === undefined) delete process.env.AFFILIATE_JOIN_PILOT_ALLOWLIST;
else process.env.AFFILIATE_JOIN_PILOT_ALLOWLIST = prevAllow;
if (prevPilotCi === undefined) delete process.env.AFFILIATE_JOIN_PILOT_CI;
else process.env.AFFILIATE_JOIN_PILOT_CI = prevPilotCi;

process.stdout.write('unit-affiliate-invite-pilot7: ok\n');
