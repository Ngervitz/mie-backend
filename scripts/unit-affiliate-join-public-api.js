'use strict';

/**
 * node scripts/unit-affiliate-join-public-api.js
 * Public /affiliates/v1/* — security, permissions, idempotency, errors.
 */

const assert = require('assert');
const { hashOtp } = require('../src/lib/affiliateOtp');
const { hashInviteToken } = require('../src/lib/affiliateInviteToken');
const { verifySessionToken } = require('../src/lib/affiliateJoinSession');
const { isIpRateLimited, resetForTests, IP_MAX } = require('../src/lib/affiliateJoinRateLimit');
const {
  startLocalAffiliateJoinServer,
} = require('./affiliate-join-local-server');

const SESSION_SECRET = 'unit-affiliate-join-session-secret-xx';
const OTP_SECRET = 'unit-affiliate-otp-hmac-secret-xxxxx';
const TERMS = 'affiliate_v2';
const CI = 12345678;
const PHONE = '099123456';

async function post(base, path, body, headers) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_e) {
    json = null;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function get(base, path, headers) {
  const res = await fetch(base + path, {
    method: 'GET',
    headers: headers || {},
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_e) {
    json = null;
  }
  return { status: res.status, body: json };
}

function assertNoLeak(obj) {
  const s = JSON.stringify(obj);
  assert.ok(s.indexOf(String(CI)) === -1, 'CI leaked');
  assert.ok(s.indexOf(PHONE) === -1, 'phone leaked');
  assert.ok(s.indexOf('invite_token') === -1 || obj.invite_token === undefined);
}

async function main() {
  resetForTests();
  process.env.AFFILIATE_JOIN_ENABLED = 'true';
  const h = await startLocalAffiliateJoinServer({ joinEnabled: true });
  const base = h.base;
  const store = h.store;

  store.addSolicitud({ ci: CI, celular: PHONE });
  const invite = store.addInvite({ ci: CI });

  const bad = await post(base, '/invite/validate', { invite_token: 'invalid' });
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(bad.body, { ok: false });
  assertNoLeak(bad.body);

  const val = await post(base, '/invite/validate', { invite_token: invite.raw });
  assert.strictEqual(val.status, 200);
  assert.strictEqual(val.body.ok, true);
  assert.ok(val.body.session_token);
  assert.strictEqual(val.body.phone_masked, '***3456');
  assert.strictEqual(val.body.terms_version, TERMS);
  assertNoLeak(val.body);

  const tokenRow = store.tables.affiliate_invite_tokens[0];
  assert.strictEqual(tokenRow.status, 'issued', 'validate must not consume invite');

  const noAccept = await post(
    base,
    '/terms/accept',
    { session_token: val.body.session_token, terms_version: TERMS, accept: false },
  );
  assert.strictEqual(noAccept.status, 400);

  const accepted = await post(base, '/terms/accept', {
    session_token: val.body.session_token,
    terms_version: TERMS,
    accept: true,
  });
  assert.strictEqual(accepted.status, 200);
  assert.ok(accepted.body.session_token);

  const otpSend = await post(base, '/otp/send', {
    session_token: accepted.body.session_token,
  });
  assert.strictEqual(otpSend.status, 200);
  assert.ok(otpSend.body.session_token);

  const challenge = store.tables.affiliate_otp_challenges[0];
  assert.ok(challenge);
  const plainOtp = '654321';
  challenge.otp_hash = hashOtp(plainOtp, OTP_SECRET);

  const badOtp = await post(base, '/otp/verify', {
    session_token: otpSend.body.session_token,
    otp: '000000',
  });
  assert.strictEqual(badOtp.status, 400);
  assert.deepStrictEqual(badOtp.body, { ok: false });

  const verified = await post(base, '/otp/verify', {
    session_token: otpSend.body.session_token,
    otp: plainOtp,
  });
  assert.strictEqual(verified.status, 200);
  assert.ok(verified.body.session_token);
  assert.strictEqual(verified.body.referral_url, undefined);

  assert.strictEqual(tokenRow.status, 'consumed');
  assert.strictEqual(store.tables.affiliates.length, 1);
  const code = store.tables.affiliates[0].code;
  assert.ok(code);

  const noLink = await get(base, '/link');
  assert.strictEqual(noLink.status, 400);

  const link = await get(base, '/link', {
    'X-Affiliate-Join-Session': verified.body.session_token,
  });
  assert.strictEqual(link.status, 200);
  assert.strictEqual(link.body.referral_url, 'https://s.credizona.net/a/' + code);
  assertNoLeak(link.body);

  const sessionCheck = verifySessionToken(
    verified.body.session_token,
    SESSION_SECRET,
    new Date(),
  );
  assert.strictEqual(sessionCheck.ok, true);
  assert.strictEqual(sessionCheck.session.vf, true);

  const invite2 = store.addInvite({ ci: 87654321 });
  store.addSolicitud({ ci: 87654321, celular: '098111222' });
  const v2 = await post(base, '/invite/validate', { invite_token: invite2.raw });
  const a2 = await post(base, '/terms/accept', {
    session_token: v2.body.session_token,
    terms_version: TERMS,
    accept: true,
  });
  const s2 = await post(base, '/otp/send', { session_token: a2.body.session_token });
  const ch2 = store.tables.affiliate_otp_challenges.find(function (c) {
    return c.ci === 87654321;
  });
  ch2.otp_hash = hashOtp('111111', OTP_SECRET);
  const done = await post(base, '/otp/verify', {
    session_token: s2.body.session_token,
    otp: '111111',
  });
  assert.strictEqual(done.status, 200);

  const dup = await post(base, '/otp/verify', {
    session_token: s2.body.session_token,
    otp: '111111',
  });
  assert.strictEqual(dup.status, 400);

  const cfg = await get(base, '/config');
  assert.strictEqual(cfg.status, 200);
  assert.strictEqual(cfg.body.join_enabled, true);
  assert.strictEqual(cfg.body.terms_version, TERMS);

  await h.close();

  const hOff = await startLocalAffiliateJoinServer({ joinEnabled: false });
  const offBase = hOff.base;
  const blocked = await post(offBase, '/invite/validate', { invite_token: invite.raw });
  assert.strictEqual(blocked.status, 403);
  assert.deepStrictEqual(blocked.body, { ok: false });
  const cfgOff = await get(offBase, '/config');
  assert.strictEqual(cfgOff.body.join_enabled, false);
  await hOff.close();

  resetForTests();
  const fakeReq = { socket: { remoteAddress: '203.0.113.9' } };
  const now = Date.now();
  let limited = false;
  for (let i = 0; i <= IP_MAX; i += 1) {
    if (isIpRateLimited(fakeReq, now + i)) {
      limited = true;
      break;
    }
  }
  assert.strictEqual(limited, true);

  console.log('unit-affiliate-join-public-api: ok');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
