'use strict';

const assert = require('assert');
const {
  hashInviteToken,
  generateRawInviteToken,
  inviteExpiresAt,
  isInviteTokenUsable,
  INVITE_TTL_MS,
} = require('../src/lib/affiliateInviteToken');
const {
  generateOtpCode,
  hashOtp,
  otpExpiresAt,
  canSendOtp,
  verifyOtpCode,
  OTP_TTL_MS,
  MAX_VERIFY_ATTEMPTS,
  RESEND_COOLDOWN_MS,
} = require('../src/lib/affiliateOtp');
const { generateAffiliateCode } = require('../src/lib/affiliateCode');
const { CODE_RE } = require('../src/lib/affiliateRedirect');
const {
  planAffiliateLandingOptInInsert,
  buildLandingOptInEvidence,
  LANDING_OPT_IN_CHANNEL,
} = require('../src/lib/affiliateDirectory');
const { isAffiliateTxSmsDryRun, queueAffiliateTransactionalSms } = require('../src/lib/affiliateTransactionalSms');
const {
  issueInviteToken,
  resolveInviteToken,
  requestOtpForInvite,
  verifyOtpAndRegisterAffiliate,
} = require('../src/lib/affiliateOptIn');

const SECRET = 'unit-test-otp-secret';
const NOW = '2026-10-26T15:00:00.000Z';

{
  const raw = generateRawInviteToken();
  assert.ok(raw.length >= 32);
  const h1 = hashInviteToken(raw);
  const h2 = hashInviteToken(raw);
  assert.strictEqual(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
}

{
  const exp = inviteExpiresAt(NOW);
  assert.strictEqual(
    Date.parse(exp) - Date.parse(NOW),
    INVITE_TTL_MS,
  );
  assert.strictEqual(
    isInviteTokenUsable(
      { status: 'issued', expires_at: exp },
      NOW,
    ),
    true,
  );
  assert.strictEqual(
    isInviteTokenUsable(
      { status: 'issued', expires_at: exp },
      exp,
    ),
    false,
  );
  assert.strictEqual(
    isInviteTokenUsable(
      { status: 'consumed', expires_at: exp },
      NOW,
    ),
    false,
  );
}

{
  const code = generateOtpCode();
  assert.match(code, /^\d{6}$/);
  const hash = hashOtp(code, SECRET);
  assert.strictEqual(verifyOtpCode(code, { otp_hash: hash }, SECRET), true);
  assert.strictEqual(verifyOtpCode('000000', { otp_hash: hash }, SECRET), false);
  const exp = otpExpiresAt(NOW);
  assert.strictEqual(Date.parse(exp) - Date.parse(NOW), OTP_TTL_MS);
}

{
  const ok = canSendOtp(NOW, null, 0);
  assert.strictEqual(ok.ok, true);
  const cool = canSendOtp(NOW, NOW, 0);
  assert.strictEqual(cool.ok, false);
  assert.strictEqual(cool.reason, 'resend_cooldown');
  assert.ok(cool.retry_after_ms > 0 && cool.retry_after_ms <= RESEND_COOLDOWN_MS);
  const limit = canSendOtp(NOW, null, 5);
  assert.strictEqual(limit.ok, false);
  assert.strictEqual(limit.reason, 'daily_send_limit');
}

{
  const code = generateAffiliateCode();
  assert.ok(CODE_RE.test(code));
}

{
  const ev = buildLandingOptInEvidence({
    invite_token_id: '11111111-1111-4111-8111-111111111111',
    otp_challenge_id: '22222222-2222-4222-8222-222222222222',
    terms_version: 'affiliate_v2',
  });
  assert.strictEqual(ev.ok, true);
  const plan = planAffiliateLandingOptInInsert(
    {
      ci: 12345678,
      code: 'ABCD2345',
      terms_version: 'affiliate_v2',
      invite_token_id: '11111111-1111-4111-8111-111111111111',
      otp_challenge_id: '22222222-2222-4222-8222-222222222222',
    },
    NOW,
  );
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.row.acceptance_channel, LANDING_OPT_IN_CHANNEL);
  assert.ok(plan.row.acceptance_evidence.indexOf('invite:') === 0);
}

assert.strictEqual(isAffiliateTxSmsDryRun({ dryRun: true }), true);
assert.strictEqual(isAffiliateTxSmsDryRun({ dryRun: false }), false);

(async function smsDryRun() {
  const res = await queueAffiliateTransactionalSms({
    kind: 'otp',
    phone: '099123456',
    text: 'test',
    ci: 1,
    sourceRecordId: 'x',
    dryRun: true,
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.dry_run, true);
  assert.strictEqual(res.queued, false);
})();

function createMockSupabase() {
  const state = {
    funnelCi: new Set([12345678]),
    tokens: [],
    challenges: [],
    affiliates: [],
  };

  const supabase = {
    from(table) {
      const ctx = { filters: [] };
      const api = {
        select() {
          return api;
        },
        eq(field, value) {
          ctx.filters.push({ field, value });
          return api;
        },
        gte(field, value) {
          ctx.filters.push({ field, value, op: 'gte' });
          return api;
        },
        limit() {
          return api;
        },
        order() {
          return api;
        },
        range() {
          return api;
        },
        update(patch) {
          ctx.patch = patch;
          return api;
        },
        insert(row) {
          ctx.insertRow = row;
          return api;
        },
        maybeSingle: () => run(),
        single: async () => {
          const res = await run();
          if (!res.data) throw new Error('single expected row');
          return res;
        },
        then(resolve, reject) {
          run().then(resolve, reject);
        },
      };

      async function run() {
        if (table === 'cz_funnel_solicitudes') {
          const ci = ctx.filters.find((f) => f.field === 'ci')?.value;
          return {
            data: state.funnelCi.has(ci) ? [{ cz_id: 1 }] : [],
            error: null,
          };
        }
        if (table === 'affiliate_invite_tokens') {
          if (ctx.insertRow) {
            const rec = Object.assign(
              {
                id: 'invite-' + state.tokens.length,
                issued_at: NOW,
              },
              ctx.insertRow,
            );
            state.tokens.push(rec);
            ctx.insertRow = null;
            return { data: rec, error: null };
          }
          if (ctx.patch) {
            state.tokens.forEach((t) => {
              const match = ctx.filters.every((f) => t[f.field] === f.value);
              if (match) Object.assign(t, ctx.patch);
            });
            ctx.patch = null;
            return { data: null, error: null };
          }
          const id = ctx.filters.find((f) => f.field === 'id')?.value;
          if (id) {
            return {
              data: state.tokens.find((t) => t.id === id) || null,
              error: null,
            };
          }
          const hash = ctx.filters.find((f) => f.field === 'token_hash')?.value;
          if (hash) {
            return {
              data: state.tokens.find((t) => t.token_hash === hash) || null,
              error: null,
            };
          }
        }
        if (table === 'affiliate_otp_challenges') {
          if (ctx.insertRow) {
            const rec = Object.assign(
              { id: 'chal-' + state.challenges.length },
              ctx.insertRow,
            );
            state.challenges.push(rec);
            ctx.insertRow = null;
            return { data: rec, error: null };
          }
          if (ctx.patch) {
            state.challenges.forEach((c) => {
              const match = ctx.filters.every((f) => c[f.field] === f.value);
              if (match) Object.assign(c, ctx.patch);
            });
            ctx.patch = null;
            return { data: null, error: null };
          }
          const id = ctx.filters.find((f) => f.field === 'id')?.value;
          if (id) {
            return {
              data: state.challenges.find((c) => c.id === id) || null,
              error: null,
            };
          }
          const ci = ctx.filters.find((f) => f.field === 'ci')?.value;
          if (ci) {
            return { data: state.challenges.filter((c) => c.ci === ci), error: null };
          }
        }
        if (table === 'affiliates') {
          if (ctx.insertRow) {
            if (state.affiliates.some((a) => a.ci === ctx.insertRow.ci)) {
              ctx.insertRow = null;
              return {
                data: null,
                error: { code: '23505', message: 'affiliates_ci_unique' },
              };
            }
            const rec = Object.assign(
              { id: 'af-1', created_at: NOW, is_test: false },
              ctx.insertRow,
            );
            state.affiliates.push(rec);
            ctx.insertRow = null;
            return { data: rec, error: null };
          }
          const ci = ctx.filters.find((f) => f.field === 'ci')?.value;
          const row = state.affiliates.find((a) => a.ci === ci) || null;
          if (row && ctx.filters.some((f) => f.field === 'is_test' && f.value === false)) {
            return { data: row.is_test ? null : row, error: null };
          }
          return { data: row, error: null };
        }
        return { data: null, error: null };
      }

      return api;
    },
  };

  return { supabase, state };
}

(async function flow() {
  const { supabase, state } = createMockSupabase();
  const issued = await issueInviteToken(supabase, 12345678, NOW);
  assert.strictEqual(issued.ok, true);
  const raw = issued.token;

  const open1 = await resolveInviteToken(supabase, raw, NOW);
  const open2 = await resolveInviteToken(supabase, raw, NOW);
  assert.strictEqual(open1.ok, true);
  assert.strictEqual(open2.ok, true);
  assert.strictEqual(
    state.tokens[0].status,
    'issued',
    'landing must not consume token',
  );

  const otpReq = await requestOtpForInvite(
    supabase,
    raw,
    '099111222',
    NOW,
    { otpHmacSecret: SECRET, dryRun: true },
  );
  assert.strictEqual(otpReq.ok, true);
  const challenge = state.challenges[0];
  const plainOtp = '123456';
  challenge.otp_hash = hashOtp(plainOtp, SECRET);

  const bad = await verifyOtpAndRegisterAffiliate(
    supabase,
    raw,
    otpReq.challenge_id,
    '000000',
    'affiliate_v2',
    '099111222',
    NOW,
    { otpHmacSecret: SECRET, dryRun: true },
  );
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, 'otp_invalid');

  const good = await verifyOtpAndRegisterAffiliate(
    supabase,
    raw,
    otpReq.challenge_id,
    plainOtp,
    'affiliate_v2',
    '099111222',
    NOW,
    { otpHmacSecret: SECRET, dryRun: true },
  );
  assert.strictEqual(good.ok, true);
  assert.ok(good.referral_code);
  assert.strictEqual(state.tokens[0].status, 'consumed');
  assert.strictEqual(state.affiliates.length, 1);

  const again = await verifyOtpAndRegisterAffiliate(
    supabase,
    raw,
    otpReq.challenge_id,
    plainOtp,
    'affiliate_v2',
    '099111222',
    NOW,
    { otpHmacSecret: SECRET, dryRun: true },
  );
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.error, 'invite_invalid');
})();

(async function idempotentCi() {
  const { supabase, state } = createMockSupabase();
  state.affiliates.push({
    id: 'existing',
    ci: 12345678,
    code: 'EXIST1',
    is_test: false,
    status: 'active',
  });
  const issued = await issueInviteToken(supabase, 12345678, NOW);
  const otpReq = await requestOtpForInvite(
    supabase,
    issued.token,
    '099111222',
    NOW,
    { otpHmacSecret: SECRET, dryRun: true },
  );
  assert.strictEqual(otpReq.ok, false);
  assert.strictEqual(otpReq.error, 'invite_invalid');
})();

console.log('unit-affiliate-opt-in-block1: ok');
