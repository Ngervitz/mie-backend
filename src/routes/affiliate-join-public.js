'use strict';

/**
 * Public affiliate opt-in API (mounted BEFORE requireAuth at /affiliates).
 * Admin directory remains on /affiliates behind dashboard auth in server.js.
 *
 * Never log invite_token, session_token, OTP, CI, or full phone.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../lib/logger');
const env = require('../config/env');
const {
  DEFAULT_TERMS_VERSION,
  isValidTermsVersion,
  maskAffiliatePhone,
  buildReferralUrl,
  readReferralOrigin,
} = require('../lib/affiliateJoinContract');
const {
  mintPreOtpSession,
  withTermsAccepted,
  withChallenge,
  withVerified,
  verifySessionToken,
} = require('../lib/affiliateJoinSession');
const { isIpRateLimited, isCiRateLimited } = require('../lib/affiliateJoinRateLimit');
const {
  bootstrapInviteForPublic,
  requestOtpForInviteId,
  verifyOtpAndRegisterForInviteId,
  loadInviteById,
} = require('../lib/affiliateOptIn');
const { isInviteTokenUsable } = require('../lib/affiliateInviteToken');
const { resolveAffiliateSmsPhone } = require('../lib/affiliatePhoneResolve');
const { isAffiliateJoinEnabled } = require('../lib/affiliateJoinEnabled');

const router = express.Router();

function joinRegistrationDisabled(res) {
  if (isAffiliateJoinEnabled()) return false;
  return publicFail(res, 403);
}

function publicFail(res, status) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ ok: false });
}

function publicOk(res, body) {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json(Object.assign({ ok: true }, body));
}

function requestId(req, res) {
  const id = crypto.randomUUID();
  res.set('X-Request-Id', id);
  return id;
}

function readSessionSecret() {
  const raw = env.affiliateJoinSessionHmacSecret;
  return raw == null ? '' : String(raw).trim();
}

function readOtpSecret() {
  const raw = env.affiliateOtpHmacSecret;
  return raw == null ? '' : String(raw).trim();
}

function configuredTermsVersion() {
  const raw = env.affiliateTermsVersion;
  const v = raw == null || String(raw).trim() === '' ? DEFAULT_TERMS_VERSION : String(raw).trim();
  return isValidTermsVersion(v) ? v : DEFAULT_TERMS_VERSION;
}

function referralOrigin() {
  return readReferralOrigin(env.affiliatePublicReferralOrigin);
}

function optInDeps() {
  return {
    otpHmacSecret: readOtpSecret(),
    referralOrigin: referralOrigin(),
    dryRun: env.affiliateTxSmsEnabled !== true,
  };
}

function parseInviteTokenBody(body) {
  const token =
    body && body.invite_token != null
      ? String(body.invite_token).trim()
      : body && body.t != null
        ? String(body.t).trim()
        : '';
  if (!token) return null;
  return token;
}

function parseSessionToken(req, body) {
  const header = req.headers['x-affiliate-join-session'];
  if (header != null && String(header).trim()) {
    return String(header).trim();
  }
  if (body && body.session_token != null && String(body.session_token).trim()) {
    return String(body.session_token).trim();
  }
  return null;
}

function parseOtp(body) {
  if (body && body.otp != null) {
    const s = String(body.otp).trim();
    if (/^\d{6}$/.test(s)) return s;
  }
  return null;
}

router.get('/v1/config', function affiliateJoinConfig(req, res) {
  return publicOk(res, {
    join_enabled: isAffiliateJoinEnabled(),
    terms_version: configuredTermsVersion(),
  });
});

async function loadInviteForSession(supabase, session, now) {
  const loaded = await loadInviteById(supabase, session.i);
  if (!loaded.ok) return loaded;
  if (!isInviteTokenUsable(loaded.invite, now)) {
    return { ok: false, status: 400, error: 'invite_invalid' };
  }
  return loaded;
}

router.post('/v1/invite/validate', async function validateInvite(req, res) {
  const rid = requestId(req, res);
  const now = new Date();

  if (joinRegistrationDisabled(res)) return;

  if (isIpRateLimited(req, now.getTime())) {
    return publicFail(res, 429);
  }

  const sessionSecret = readSessionSecret();
  if (!sessionSecret) {
    logger.error('affiliate join public not configured', {
      kind: 'affiliate_join_public',
      reason: 'session_secret_missing',
      request_id: rid,
    });
    return publicFail(res, 503);
  }

  const inviteToken = parseInviteTokenBody(req.body);
  if (!inviteToken) {
    return publicFail(res, 400);
  }

  try {
    const supabase = require('../clients/supabase');
    const boot = await bootstrapInviteForPublic(supabase, inviteToken, now);
    if (!boot.ok) {
      if (boot.status >= 500) {
        logger.error('affiliate join validate failed', {
          kind: 'affiliate_join_public',
          reason: boot.error,
          request_id: rid,
        });
        return publicFail(res, 503);
      }
      return publicFail(res, 400);
    }

    if (isCiRateLimited(boot.invite.ci, now.getTime())) {
      return publicFail(res, 429);
    }

    const sessionToken = mintPreOtpSession(
      { invite_id: boot.invite.id },
      now,
      sessionSecret,
    );

    return publicOk(res, {
      session_token: sessionToken,
      phone_masked: maskAffiliatePhone(boot.phone),
      terms_version: configuredTermsVersion(),
    });
  } catch (err) {
    logger.error('affiliate join validate handler failed', {
      kind: 'affiliate_join_public',
      request_id: rid,
      message: err && err.message ? String(err.message).slice(0, 120) : null,
    });
    return publicFail(res, 503);
  }
});

router.post('/v1/terms/accept', async function acceptTerms(req, res) {
  const rid = requestId(req, res);
  const now = new Date();

  if (joinRegistrationDisabled(res)) return;

  if (isIpRateLimited(req, now.getTime())) {
    return publicFail(res, 429);
  }

  const sessionSecret = readSessionSecret();
  if (!sessionSecret) {
    return publicFail(res, 503);
  }

  const sessionRaw = parseSessionToken(req, req.body);
  if (!sessionRaw) {
    return publicFail(res, 400);
  }

  const verified = verifySessionToken(sessionRaw, sessionSecret, now);
  if (!verified.ok || verified.session.vf) {
    return publicFail(res, 400);
  }

  const body = req.body || {};
  if (body.accept !== true) {
    return publicFail(res, 400);
  }

  const termsVersion =
    body.terms_version != null ? String(body.terms_version).trim() : '';
  if (termsVersion !== configuredTermsVersion() || !isValidTermsVersion(termsVersion)) {
    return publicFail(res, 400);
  }

  try {
    const supabase = require('../clients/supabase');
    const inviteState = await loadInviteForSession(supabase, verified.session, now);
    if (!inviteState.ok) {
      return publicFail(res, inviteState.status === 503 ? 503 : 400);
    }

    if (isCiRateLimited(inviteState.invite.ci, now.getTime())) {
      return publicFail(res, 429);
    }

    const nextToken = withTermsAccepted(
      verified.session,
      termsVersion,
      now,
      sessionSecret,
    );

    return publicOk(res, { session_token: nextToken });
  } catch (err) {
    logger.error('affiliate join terms accept failed', {
      kind: 'affiliate_join_public',
      request_id: rid,
      message: err && err.message ? String(err.message).slice(0, 120) : null,
    });
    return publicFail(res, 503);
  }
});

router.post('/v1/otp/send', async function sendOtp(req, res) {
  const rid = requestId(req, res);
  const now = new Date();

  if (joinRegistrationDisabled(res)) return;

  if (isIpRateLimited(req, now.getTime())) {
    return publicFail(res, 429);
  }

  const sessionSecret = readSessionSecret();
  const otpSecret = readOtpSecret();
  if (!sessionSecret || !otpSecret) {
    return publicFail(res, 503);
  }

  const sessionRaw = parseSessionToken(req, req.body);
  if (!sessionRaw) {
    return publicFail(res, 400);
  }

  const verified = verifySessionToken(sessionRaw, sessionSecret, now);
  if (!verified.ok || verified.session.vf) {
    return publicFail(res, 400);
  }
  if (!verified.session.ta || !verified.session.tv) {
    return publicFail(res, 400);
  }
  if (verified.session.tv !== configuredTermsVersion()) {
    return publicFail(res, 400);
  }

  try {
    const supabase = require('../clients/supabase');
    const inviteState = await loadInviteForSession(supabase, verified.session, now);
    if (!inviteState.ok) {
      return publicFail(res, inviteState.status === 503 ? 503 : 400);
    }

    if (isCiRateLimited(inviteState.invite.ci, now.getTime())) {
      return publicFail(res, 429);
    }

    const phone = await resolveAffiliateSmsPhone(supabase, inviteState.invite.ci);
    if (!phone) {
      return publicFail(res, 400);
    }

    const otpResult = await requestOtpForInviteId(
      supabase,
      verified.session.i,
      phone,
      now,
      Object.assign({ otpHmacSecret: otpSecret }, optInDeps()),
    );

    if (!otpResult.ok) {
      if (otpResult.status === 429) {
        return publicFail(res, 429);
      }
      if (otpResult.status >= 500) {
        logger.error('affiliate join otp send failed', {
          kind: 'affiliate_join_public',
          reason: otpResult.error,
          request_id: rid,
        });
        return publicFail(res, 503);
      }
      return publicFail(res, 400);
    }

    const nextToken = withChallenge(
      verified.session,
      otpResult.challenge_id,
      now,
      sessionSecret,
    );

    return publicOk(res, { session_token: nextToken });
  } catch (err) {
    logger.error('affiliate join otp send handler failed', {
      kind: 'affiliate_join_public',
      request_id: rid,
      message: err && err.message ? String(err.message).slice(0, 120) : null,
    });
    return publicFail(res, 503);
  }
});

router.post('/v1/otp/verify', async function verifyOtp(req, res) {
  const rid = requestId(req, res);
  const now = new Date();

  if (joinRegistrationDisabled(res)) return;

  if (isIpRateLimited(req, now.getTime())) {
    return publicFail(res, 429);
  }

  const sessionSecret = readSessionSecret();
  const otpSecret = readOtpSecret();
  if (!sessionSecret || !otpSecret) {
    return publicFail(res, 503);
  }

  const sessionRaw = parseSessionToken(req, req.body);
  const otp = parseOtp(req.body);
  if (!sessionRaw || !otp) {
    return publicFail(res, 400);
  }

  const verified = verifySessionToken(sessionRaw, sessionSecret, now);
  if (!verified.ok) {
    return publicFail(res, 400);
  }
  if (!verified.session.ta || !verified.session.tv || !verified.session.c) {
    return publicFail(res, 400);
  }
  if (verified.session.tv !== configuredTermsVersion()) {
    return publicFail(res, 400);
  }

  try {
    const supabase = require('../clients/supabase');
    const inviteState = await loadInviteForSession(supabase, verified.session, now);
    if (!inviteState.ok) {
      return publicFail(res, inviteState.status === 503 ? 503 : 400);
    }

    if (isCiRateLimited(inviteState.invite.ci, now.getTime())) {
      return publicFail(res, 429);
    }

    const phone = await resolveAffiliateSmsPhone(supabase, inviteState.invite.ci);
    if (!phone) {
      return publicFail(res, 400);
    }

    const result = await verifyOtpAndRegisterForInviteId(
      supabase,
      verified.session.i,
      verified.session.c,
      otp,
      verified.session.tv,
      phone,
      now,
      Object.assign({ otpHmacSecret: otpSecret }, optInDeps()),
    );

    if (!result.ok) {
      if (result.status >= 500) {
        logger.error('affiliate join otp verify failed', {
          kind: 'affiliate_join_public',
          reason: result.error,
          request_id: rid,
        });
        return publicFail(res, 503);
      }
      return publicFail(res, 400);
    }

    const nextToken = withVerified(
      verified.session,
      result.referral_code,
      now,
      sessionSecret,
    );

    return publicOk(res, { session_token: nextToken });
  } catch (err) {
    logger.error('affiliate join otp verify handler failed', {
      kind: 'affiliate_join_public',
      request_id: rid,
      message: err && err.message ? String(err.message).slice(0, 120) : null,
    });
    return publicFail(res, 503);
  }
});

router.get('/v1/link', async function getLink(req, res) {
  const rid = requestId(req, res);
  const now = new Date();

  if (isIpRateLimited(req, now.getTime())) {
    return publicFail(res, 429);
  }

  const sessionSecret = readSessionSecret();
  if (!sessionSecret) {
    return publicFail(res, 503);
  }

  const sessionRaw = parseSessionToken(req, {});
  if (!sessionRaw) {
    return publicFail(res, 400);
  }

  const verified = verifySessionToken(sessionRaw, sessionSecret, now);
  if (!verified.ok || !verified.session.vf || !verified.session.ac) {
    return publicFail(res, 400);
  }

  return publicOk(res, {
    referral_url: buildReferralUrl(verified.session.ac, referralOrigin()),
  });
});

function jsonErrorHandler(err, req, res, next) {
  if (!err) return next();
  if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
    return publicFail(res, 413);
  }
  if (
    err.type === 'entity.parse.failed' ||
    err.status === 400 ||
    err instanceof SyntaxError
  ) {
    return publicFail(res, 400);
  }
  return next(err);
}

module.exports = router;
module.exports.jsonErrorHandler = jsonErrorHandler;
