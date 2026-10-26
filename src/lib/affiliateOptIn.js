'use strict';

/**
 * Affiliate invite token + OTP opt-in (service-role I/O).
 * Invite tokens are not consumed when resolved for landing — only after OTP success.
 */

const {
  hashInviteToken,
  generateRawInviteToken,
  inviteExpiresAt,
  isInviteTokenUsable,
} = require('./affiliateInviteToken');
const {
  generateOtpCode,
  hashOtp,
  otpExpiresAt,
  canSendOtp,
  isOtpChallengeVerifiable,
  verifyOtpCode,
  sendsInLast24h,
  MAX_VERIFY_ATTEMPTS,
} = require('./affiliateOtp');
const { generateAffiliateCode, MAX_GENERATION_ATTEMPTS } = require('./affiliateCode');
const { planAffiliateLandingOptInInsert, parseCi } = require('./affiliateDirectory');
const { queueAffiliateTransactionalSms } = require('./affiliateTransactionalSms');
const { schemaMissing, ciExistsInFunnel } = require('./affiliateOptInDbHelpers');
const { resolveAffiliateSmsPhone } = require('./affiliatePhoneResolve');
const { buildReferralUrl } = require('./affiliateJoinContract');

const AFFILIATE_COLUMNS =
  'id, code, status, is_test, ci, accepted_at, acceptance_channel, terms_version, acceptance_evidence, created_at';

function uniqueViolation(err) {
  const code = err && err.code != null ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : '';
  return code === '23505' || /duplicate key|unique/i.test(msg);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} ci
 * @param {string|Date} now
 */
async function issueInviteToken(supabase, ci, now) {
  const parsed = parseCi(ci);
  if (parsed == null) {
    return { ok: false, status: 400, error: 'CI inválida' };
  }
  const exists = await ciExistsInFunnel(supabase, parsed);
  if (!exists) {
    return { ok: false, status: 400, error: 'La CI no tiene solicitudes en JANUS' };
  }

  const acceptedAt = now instanceof Date ? now.toISOString() : String(now);
  const expires = inviteExpiresAt(acceptedAt);

  await supabase
    .from('affiliate_invite_tokens')
    .update({
      status: 'revoked',
      revoked_at: acceptedAt,
      updated_at: acceptedAt,
    })
    .eq('ci', parsed)
    .eq('status', 'issued');

  const raw = generateRawInviteToken();
  const tokenHash = hashInviteToken(raw);

  const { data, error } = await supabase
    .from('affiliate_invite_tokens')
    .insert({
      token_hash: tokenHash,
      ci: parsed,
      status: 'issued',
      expires_at: expires,
    })
    .select('id, ci, status, issued_at, expires_at')
    .single();

  if (error) {
    if (schemaMissing(error)) {
      return { ok: false, status: 503, error: 'affiliate_join_not_ready' };
    }
    throw error;
  }

  return {
    ok: true,
    token: raw,
    invite: data,
  };
}

/**
 * Resolve invite for landing bootstrap. Does not consume the token.
 */
async function loadInviteById(supabase, inviteId) {
  const { data, error } = await supabase
    .from('affiliate_invite_tokens')
    .select('id, ci, status, expires_at, consumed_at')
    .eq('id', inviteId)
    .maybeSingle();
  if (error) {
    if (schemaMissing(error)) {
      return { ok: false, status: 503, error: 'affiliate_join_not_ready' };
    }
    throw error;
  }
  if (!data) return { ok: false, status: 400, error: 'invite_invalid' };
  return { ok: true, invite: data };
}

async function resolveInviteToken(supabase, rawToken, now) {
  const hash = hashInviteToken(rawToken);
  const { data, error } = await supabase
    .from('affiliate_invite_tokens')
    .select('id, ci, status, expires_at, consumed_at')
    .eq('token_hash', hash)
    .maybeSingle();

  if (error) {
    if (schemaMissing(error)) {
      return { ok: false, status: 503, error: 'affiliate_join_not_ready' };
    }
    throw error;
  }
  if (!data || !isInviteTokenUsable(data, now)) {
    return { ok: false, status: 400, error: 'invite_invalid' };
  }
  return { ok: true, invite: data };
}

/**
 * Validate invite for public bootstrap. Does not consume the token.
 */
async function bootstrapInviteForPublic(supabase, rawToken, now) {
  const resolved = await resolveInviteToken(supabase, rawToken, now);
  if (!resolved.ok) return resolved;

  const invite = resolved.invite;
  const ci = Number(invite.ci);
  const existing = await getActiveAffiliateByCi(supabase, ci);
  if (existing) {
    return { ok: false, status: 400, error: 'invite_invalid' };
  }

  const phone = await resolveAffiliateSmsPhone(supabase, ci);
  if (!phone) {
    return { ok: false, status: 400, error: 'invite_invalid' };
  }

  return { ok: true, invite: invite, phone: phone };
}

async function getActiveAffiliateByCi(supabase, ci) {
  const { data, error } = await supabase
    .from('affiliates')
    .select(AFFILIATE_COLUMNS)
    .eq('ci', ci)
    .eq('is_test', false)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function expireAffiliateOtpChallenge(supabase, challengeId, at) {
  const acceptedAt = at instanceof Date ? at.toISOString() : String(at);
  await supabase
    .from('affiliate_otp_challenges')
    .update({
      status: 'expired',
      updated_at: acceptedAt,
    })
    .eq('id', challengeId)
    .eq('status', 'pending');
}

async function loadRecentOtpChallengesForCi(supabase, ci) {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('affiliate_otp_challenges')
    .select('id, send_count, last_sent_at, created_at')
    .eq('ci', ci)
    .gte('created_at', since);
  if (error) throw error;
  return data || [];
}

/**
 * @param {object} deps
 * @param {string} deps.otpHmacSecret
 * @param {function} [deps.queueSms]
 */
async function requestOtpForInviteRecord(supabase, invite, phone, now, deps) {
  if (!invite || !isInviteTokenUsable(invite, now)) {
    return { ok: false, status: 400, error: 'invite_invalid' };
  }

  const ci = Number(invite.ci);
  const existing = await getActiveAffiliateByCi(supabase, ci);
  if (existing) {
    return {
      ok: false,
      status: 400,
      error: 'invite_invalid',
    };
  }

  const recent = await loadRecentOtpChallengesForCi(supabase, ci);
  const sendCount24h = sendsInLast24h(recent, now);
  const lastSent = recent.length
    ? recent.reduce(function (best, row) {
        const t = Date.parse(String(row.last_sent_at || row.created_at));
        if (!Number.isFinite(t)) return best;
        if (!best || t > best) return t;
        return best;
      }, null)
    : null;
  const sendCheck = canSendOtp(now, lastSent ? new Date(lastSent).toISOString() : null, sendCount24h);
  if (!sendCheck.ok) {
    return {
      ok: false,
      status: 429,
      error: sendCheck.reason,
      retry_after_ms: sendCheck.retry_after_ms || null,
    };
  }

  const acceptedAt = now instanceof Date ? now.toISOString() : String(now);
  const code = generateOtpCode();
  const otpHash = hashOtp(code, deps.otpHmacSecret);

  await supabase
    .from('affiliate_otp_challenges')
    .update({
      status: 'expired',
      updated_at: acceptedAt,
    })
    .eq('invite_token_id', invite.id)
    .eq('status', 'pending');

  const { data: challenge, error } = await supabase
    .from('affiliate_otp_challenges')
    .insert({
      invite_token_id: invite.id,
      ci: ci,
      otp_hash: otpHash,
      status: 'pending',
      expires_at: otpExpiresAt(acceptedAt),
      attempt_count: 0,
      max_attempts: MAX_VERIFY_ATTEMPTS,
      send_count: 1,
      last_sent_at: acceptedAt,
    })
    .select('id, expires_at')
    .single();

  if (error) {
    if (schemaMissing(error)) {
      return { ok: false, status: 503, error: 'affiliate_join_not_ready' };
    }
    throw error;
  }

  let sms;
  try {
    sms = await (deps.queueSms || queueAffiliateTransactionalSms)({
      kind: 'otp',
      phone: phone,
      text: 'Credizona: tu codigo de afiliados es ' + code + '. Valido 5 minutos.',
      ci: ci,
      sourceRecordId: challenge.id,
      dryRun: deps.dryRun,
      sendBatch: deps.sendBatch,
    });
  } catch (_sendErr) {
    await expireAffiliateOtpChallenge(supabase, challenge.id, now);
    return { ok: false, status: 503, error: 'sms_failed' };
  }

  if (!sms.ok) {
    await expireAffiliateOtpChallenge(supabase, challenge.id, now);
    return { ok: false, status: 503, error: sms.error || 'sms_failed' };
  }

  return {
    ok: true,
    challenge_id: challenge.id,
    expires_at: challenge.expires_at,
    sms: sms,
  };
}

async function requestOtpForInvite(supabase, rawToken, phone, now, deps) {
  const resolved = await resolveInviteToken(supabase, rawToken, now);
  if (!resolved.ok) return resolved;
  return requestOtpForInviteRecord(supabase, resolved.invite, phone, now, deps);
}

async function requestOtpForInviteId(supabase, inviteId, phone, now, deps) {
  const loaded = await loadInviteById(supabase, inviteId);
  if (!loaded.ok) return loaded;
  if (!isInviteTokenUsable(loaded.invite, now)) {
    return { ok: false, status: 400, error: 'invite_invalid' };
  }
  return requestOtpForInviteRecord(supabase, loaded.invite, phone, now, deps);
}

async function insertAffiliateWithGeneratedCode(supabase, plan, acceptedAt) {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const code = generateAffiliateCode();
    const rowPlan = planAffiliateLandingOptInInsert(
      {
        ci: plan.ci,
        code: code,
        terms_version: plan.terms_version,
        invite_token_id: plan.invite_token_id,
        otp_challenge_id: plan.otp_challenge_id,
      },
      acceptedAt,
    );
    if (!rowPlan.ok) return rowPlan;

    const { data, error } = await supabase
      .from('affiliates')
      .insert(rowPlan.row)
      .select(AFFILIATE_COLUMNS)
      .single();

    if (!error) {
      return { ok: true, affiliate: data };
    }
    if (uniqueViolation(error)) {
      const msg = error.message ? String(error.message) : '';
      if (/affiliates_ci_unique|affiliates.*ci/i.test(msg)) {
        const existing = await getActiveAffiliateByCi(supabase, plan.ci);
        if (existing) {
          return { ok: true, affiliate: existing, idempotent: true };
        }
        return { ok: false, status: 409, error: 'CI ya registrada' };
      }
      continue;
    }
    if (schemaMissing(error)) {
      return { ok: false, status: 503, error: 'affiliates_identity_not_ready' };
    }
    throw error;
  }
  return { ok: false, status: 500, error: 'No se pudo generar un código único' };
}

async function consumeInviteToken(supabase, inviteId, now) {
  const acceptedAt = now instanceof Date ? now.toISOString() : String(now);
  const { error: updateErr } = await supabase
    .from('affiliate_invite_tokens')
    .update({
      status: 'consumed',
      consumed_at: acceptedAt,
      updated_at: acceptedAt,
    })
    .eq('id', inviteId)
    .eq('status', 'issued');
  if (updateErr) throw updateErr;

  const { data, error } = await supabase
    .from('affiliate_invite_tokens')
    .select('id, status, consumed_at')
    .eq('id', inviteId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== 'consumed') return null;
  return data;
}

/**
 * Verify OTP and register affiliate for a resolved invite. Consumes invite on success.
 */
async function verifyOtpAndRegisterForInvite(
  supabase,
  invite,
  challengeId,
  otpCode,
  termsVersion,
  phone,
  now,
  deps,
) {
  if (!invite || !isInviteTokenUsable(invite, now)) {
    return { ok: false, status: 400, error: 'invite_invalid' };
  }

  const ci = Number(invite.ci);

  const existing = await getActiveAffiliateByCi(supabase, ci);
  if (existing) {
    await consumeInviteToken(supabase, invite.id, now);
    return {
      ok: true,
      idempotent: true,
      affiliate: existing,
      referral_code: existing.code,
      referral_url: buildReferralUrl(existing.code, deps.referralOrigin),
    };
  }

  const { data: challenge, error: loadErr } = await supabase
    .from('affiliate_otp_challenges')
    .select(
      'id, invite_token_id, ci, otp_hash, status, expires_at, attempt_count, max_attempts',
    )
    .eq('id', challengeId)
    .maybeSingle();

  if (loadErr) {
    if (schemaMissing(loadErr)) {
      return { ok: false, status: 503, error: 'affiliate_join_not_ready' };
    }
    throw loadErr;
  }
  if (!challenge || String(challenge.invite_token_id) !== String(invite.id)) {
    return { ok: false, status: 400, error: 'challenge_invalid' };
  }
  if (Number(challenge.ci) !== ci) {
    return { ok: false, status: 400, error: 'challenge_invalid' };
  }

  if (!isOtpChallengeVerifiable(challenge, now)) {
    return { ok: false, status: 400, error: 'challenge_expired' };
  }

  const acceptedAt = now instanceof Date ? now.toISOString() : String(now);
  const match = verifyOtpCode(otpCode, challenge, deps.otpHmacSecret);
  if (!match) {
    const attempts = Number(challenge.attempt_count) + 1;
    const max = Number(challenge.max_attempts);
    const locked = attempts >= max;
    await supabase
      .from('affiliate_otp_challenges')
      .update({
        attempt_count: attempts,
        status: locked ? 'locked' : 'pending',
        updated_at: acceptedAt,
      })
      .eq('id', challenge.id);
    return {
      ok: false,
      status: 400,
      error: locked ? 'otp_locked' : 'otp_invalid',
      attempts_remaining: locked ? 0 : max - attempts,
    };
  }

  await supabase
    .from('affiliate_otp_challenges')
    .update({
      status: 'verified',
      verified_at: acceptedAt,
      updated_at: acceptedAt,
    })
    .eq('id', challenge.id);

  const inserted = await insertAffiliateWithGeneratedCode(
    supabase,
    {
      ci: ci,
      terms_version: termsVersion,
      invite_token_id: invite.id,
      otp_challenge_id: challenge.id,
    },
    acceptedAt,
  );
  if (!inserted.ok) return inserted;

  const consumed = await consumeInviteToken(supabase, invite.id, now);
  if (!consumed) {
    return { ok: false, status: 409, error: 'invite_already_consumed' };
  }

  const affiliate = inserted.affiliate;
  const referralUrl = buildReferralUrl(affiliate.code, deps.referralOrigin);

  if (phone) {
    await (deps.queueSms || queueAffiliateTransactionalSms)({
      kind: 'welcome',
      phone: phone,
      text: 'Credizona: ya sos afiliado. Tu enlace para compartir: ' + referralUrl,
      ci: ci,
      sourceRecordId: affiliate.id,
      dryRun: deps.dryRun,
      sendBatch: deps.sendBatch,
    });
  }

  return {
    ok: true,
    affiliate: affiliate,
    referral_code: affiliate.code,
    referral_url: referralUrl,
    idempotent: inserted.idempotent === true,
  };
}

/**
 * Verify OTP and register affiliate. Consumes invite token on success.
 */
async function verifyOtpAndRegisterAffiliate(
  supabase,
  rawToken,
  challengeId,
  otpCode,
  termsVersion,
  phone,
  now,
  deps,
) {
  const resolved = await resolveInviteToken(supabase, rawToken, now);
  if (!resolved.ok) return resolved;
  return verifyOtpAndRegisterForInvite(
    supabase,
    resolved.invite,
    challengeId,
    otpCode,
    termsVersion,
    phone,
    now,
    deps,
  );
}

async function verifyOtpAndRegisterForInviteId(
  supabase,
  inviteId,
  challengeId,
  otpCode,
  termsVersion,
  phone,
  now,
  deps,
) {
  const loaded = await loadInviteById(supabase, inviteId);
  if (!loaded.ok) return loaded;
  return verifyOtpAndRegisterForInvite(
    supabase,
    loaded.invite,
    challengeId,
    otpCode,
    termsVersion,
    phone,
    now,
    deps,
  );
}

module.exports = {
  issueInviteToken,
  loadInviteById,
  resolveInviteToken,
  bootstrapInviteForPublic,
  requestOtpForInvite,
  requestOtpForInviteRecord,
  requestOtpForInviteId,
  verifyOtpAndRegisterAffiliate,
  verifyOtpAndRegisterForInvite,
  verifyOtpAndRegisterForInviteId,
  getActiveAffiliateByCi,
};
