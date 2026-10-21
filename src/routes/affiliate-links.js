'use strict';

/**
 * Public affiliate redirect.
 * GET  /a/:code → insert affiliate_clicks, 302 with utm_source=referral and cz_click.
 * HEAD /a/:code → no insert.
 * Unknown or inactive code → 302 to AFFILIATE_DEST_URL with no click and no extra params.
 * Missing AFFILIATE_IP_HASH_SECRET → log, no click, 302 without cz_click.
 * Supabase lookup or insert failure → log, 302 to the clean destination.
 * Missing or invalid AFFILIATE_DEST_URL → 503. No invented destination.
 *
 * Mount before requireAuth. Does not use marketing_impacts or marketing_impact_events.
 * Uses the service-role client in src/clients/supabase.js.
 *
 * No per-IP rate limit. POST /tracking/events allows 60 requests per minute per
 * socket address, and this service does not set trust proxy, so that address is
 * often Railway's edge. A shared carrier NAT would trip the same cap. SMS and
 * email redirects are also unmetered. Bots are stored as ordinary clicks.
 * Affiliates with is_test = true never generate prizes. This route does not pay them.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../lib/logger');
const env = require('../config/env');
const {
  CODE_RE,
  UA_MAX,
  REFERER_MAX,
  readDestUrl,
  hashIp,
  clientAddress,
  clip,
  trackedUrl,
} = require('../lib/affiliateRedirect');

const router = express.Router();

function destUrl() {
  return readDestUrl(env.affiliateDestUrl);
}

function hashSecret() {
  const raw = env.affiliateIpHashSecret;
  const key = raw == null ? '' : String(raw).trim();
  return key || null;
}

function sendUnavailable(res) {
  res.set('Cache-Control', 'private, no-store');
  return res.status(503).type('text/plain').send('unavailable');
}

function sendClean(res, dest) {
  res.set('Cache-Control', 'private, no-store');
  return res.redirect(302, dest);
}

function logRedirectError(reason, code) {
  logger.error('affiliate redirect failed closed to the clean destination', {
    kind: 'affiliate_redirect_error',
    reason: reason,
    code: code,
  });
}

async function lookupAffiliate(code) {
  const supabase = require('../clients/supabase');
  const { data, error } = await supabase
    .from('affiliates')
    .select('id, status')
    .eq('code', code)
    .maybeSingle();
  if (error) {
    const err = new Error('affiliate_lookup_failed');
    err.reason = 'affiliate_lookup_failed';
    throw err;
  }
  if (!data || !data.id) return null;
  return data;
}

router.head('/a/:code', async function (req, res) {
  const dest = destUrl();
  if (!dest) return sendUnavailable(res);

  const code = String((req.params && req.params.code) || '').trim();
  if (!CODE_RE.test(code)) return sendClean(res, dest);

  try {
    const affiliate = await lookupAffiliate(code);
    const status =
      affiliate && affiliate.status != null ? String(affiliate.status) : '';
    if (status !== 'active') return sendClean(res, dest);
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).end();
  } catch (err) {
    logRedirectError(
      err && err.reason ? err.reason : 'affiliate_lookup_failed',
      code,
    );
    return sendClean(res, dest);
  }
});

router.get('/a/:code', async function (req, res) {
  const dest = destUrl();
  if (!dest) return sendUnavailable(res);

  const code = String((req.params && req.params.code) || '').trim();
  if (!CODE_RE.test(code)) return sendClean(res, dest);

  const secret = hashSecret();
  if (!secret) {
    logger.error(
      'AFFILIATE_IP_HASH_SECRET is missing; affiliate click was not recorded',
      {
        kind: 'affiliate_redirect_error',
        reason: 'affiliate_ip_hash_secret_missing',
        code: code,
      },
    );
    return sendClean(res, dest);
  }

  let affiliate;
  try {
    affiliate = await lookupAffiliate(code);
  } catch (err) {
    logRedirectError(
      err && err.reason ? err.reason : 'affiliate_lookup_failed',
      code,
    );
    return sendClean(res, dest);
  }

  const status =
    affiliate && affiliate.status != null ? String(affiliate.status) : '';
  if (!affiliate || status !== 'active') return sendClean(res, dest);

  const clickId = crypto.randomUUID();
  const address = clientAddress(req);
  const row = {
    click_id: clickId,
    affiliate_id: String(affiliate.id),
    occurred_at: new Date().toISOString(),
    user_agent: clip(req.get('user-agent'), UA_MAX),
    ip_hash: hashIp(address, secret),
    referer: clip(req.get('referer'), REFERER_MAX),
  };

  try {
    const supabase = require('../clients/supabase');
    const { error } = await supabase.from('affiliate_clicks').insert(row);
    if (error) {
      logRedirectError('affiliate_click_insert_failed', code);
      return sendClean(res, dest);
    }
  } catch (_err) {
    logRedirectError('affiliate_click_insert_failed', code);
    return sendClean(res, dest);
  }

  let location;
  try {
    location = trackedUrl(dest, clickId);
  } catch (_err) {
    logRedirectError('affiliate_dest_build_failed', code);
    return sendClean(res, dest);
  }

  res.set('Cache-Control', 'private, no-store');
  return res.redirect(302, location);
});

module.exports = router;
