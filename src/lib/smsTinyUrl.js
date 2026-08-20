'use strict';

const crypto = require('crypto');
const logger = require('./logger');

/**
 * Owned SMS short links (sms_short_links + GET /s/:code).
 * Preview uses a fixed UTM campaign UUID and an in-process cache keyed by
 * trimmed destination_url so the same preview destination is not shortened twice.
 * Real campaign sends must call shortenWithTinyUrl(finalUrl) with the campaign UUID
 * in the composed URL and must not reuse preview shorts.
 */

const DEFAULT_SHORT_LINK_BASE =
  'https://mie-backend-production.up.railway.app';
const SHORT_CODE_LENGTH = 6;
const SHORT_CODE_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SHORT_INSERT_RETRIES = 8;

/** Fixed UUID for preview UTM only — never used as a real campaign id. */
const PREVIEW_UTM_CAMPAIGN_UUID = '00000000-0000-4000-8000-000000000001';

const PREVIEW_SHORT_CACHE_MAX = 256;
const previewShortCache = new Map();
const previewShortInflight = new Map();

function looksLikeHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * Preserve existing query params; set/overwrite utm_source, utm_medium, utm_campaign.
 */
function composeFinalUrl(destinationUrl, campaignUuid) {
  const url = new URL(String(destinationUrl).trim());
  url.searchParams.set('utm_source', 'sms');
  url.searchParams.set('utm_medium', 'sms');
  url.searchParams.set('utm_campaign', String(campaignUuid));
  return url.toString();
}

function getShortLinkBaseUrl() {
  const raw = process.env.SMS_SHORT_LINK_BASE_URL;
  const trimmed =
    raw != null ? String(raw).trim().replace(/\/+$/, '') : '';
  return trimmed || DEFAULT_SHORT_LINK_BASE;
}

function composePublicShortUrl(shortCode) {
  return getShortLinkBaseUrl() + '/s/' + String(shortCode);
}

function generateShortCode(length) {
  const n = Number.isFinite(length) && length > 0 ? length : SHORT_CODE_LENGTH;
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += SHORT_CODE_ALPHABET[crypto.randomInt(SHORT_CODE_ALPHABET.length)];
  }
  return out;
}

function isUniqueViolation(error) {
  if (!error) return false;
  if (String(error.code || '') === '23505') return true;
  if (Number(error.status) === 409) return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('duplicate') || msg.includes('unique');
}

function fallback(kind, reason) {
  logger.warn('SMS shortener fallback', { kind: kind, provider: 'mie' });
  return { shortUrl: null, reason: reason, kind: kind };
}

async function lookupExistingShort(supabase, longUrl) {
  const { data, error } = await supabase
    .from('sms_short_links')
    .select('short_code')
    .eq('destination_url', longUrl)
    .maybeSingle();
  if (error || !data || !data.short_code) return null;
  return String(data.short_code);
}

/**
 * Create or reuse an owned short link for the already-composed destination URL.
 * Preview: campaign_id stays NULL (preview UUID is not an sms_campaigns row).
 * Send: insert with campaign_id NULL, then attachShortLinkCampaignId after the campaign row exists.
 * Never throws — callers must fall back to the long URL.
 */
async function shortenWithTinyUrl(longUrl) {
  const dest = String(longUrl || '').trim();
  if (!looksLikeHttpUrl(dest)) {
    return fallback('shortener_invalid_response', 'invalid destination_url');
  }
  try {
    const supabase = require('../clients/supabase');
    const existing = await lookupExistingShort(supabase, dest);
    if (existing) {
      return {
        shortUrl: composePublicShortUrl(existing),
        reason: null,
        kind: null,
      };
    }

    for (let attempt = 0; attempt < SHORT_INSERT_RETRIES; attempt += 1) {
      const code = generateShortCode(SHORT_CODE_LENGTH);
      const { data, error } = await supabase
        .from('sms_short_links')
        .insert({
          short_code: code,
          destination_url: dest,
          campaign_id: null,
        })
        .select('short_code')
        .limit(1);

      if (!error && data && data[0] && data[0].short_code) {
        return {
          shortUrl: composePublicShortUrl(data[0].short_code),
          reason: null,
          kind: null,
        };
      }

      if (isUniqueViolation(error)) {
        const raced = await lookupExistingShort(supabase, dest);
        if (raced) {
          return {
            shortUrl: composePublicShortUrl(raced),
            reason: null,
            kind: null,
          };
        }
        continue;
      }

      return fallback('shortener_error', 'sms_short_links insert failed');
    }

    return fallback('shortener_error', 'sms_short_links code collision');
  } catch (_err) {
    return fallback('shortener_error', 'sms_short_links request failed');
  }
}

async function attachShortLinkCampaignId(destinationUrl, campaignId) {
  const dest = String(destinationUrl || '').trim();
  const id = String(campaignId || '').trim();
  if (!dest || !id) return;
  try {
    const supabase = require('../clients/supabase');
    const { error } = await supabase
      .from('sms_short_links')
      .update({ campaign_id: id })
      .eq('destination_url', dest)
      .is('campaign_id', null);
    if (error) {
      logger.warn('SMS short link campaign_id attach failed', {
        kind: 'shortener_error',
        provider: 'mie',
      });
    }
  } catch (_err) {
    logger.warn('SMS short link campaign_id attach failed', {
      kind: 'shortener_error',
      provider: 'mie',
    });
  }
}

function rememberPreviewShort(destinationKey, shortUrl) {
  if (previewShortCache.has(destinationKey)) {
    previewShortCache.delete(destinationKey);
  }
  previewShortCache.set(destinationKey, shortUrl);
  while (previewShortCache.size > PREVIEW_SHORT_CACHE_MAX) {
    const oldest = previewShortCache.keys().next().value;
    previewShortCache.delete(oldest);
  }
}

function clearPreviewShortCache() {
  previewShortCache.clear();
  previewShortInflight.clear();
}

/**
 * Preview short for a destination URL. Same trimmed destination_url reuses
 * the cached short and does not call the shortener again.
 * Failures are not cached so a later preview can retry.
 *
 * @param {string} destinationUrl
 * @param {{ shorten?: typeof shortenWithTinyUrl }} [options]
 */
async function getOrCreatePreviewShortUrl(destinationUrl, options) {
  const key = String(destinationUrl || '').trim();
  const previewUrl = composeFinalUrl(key, PREVIEW_UTM_CAMPAIGN_UUID);
  const shorten =
    options && typeof options.shorten === 'function'
      ? options.shorten
      : shortenWithTinyUrl;

  if (previewShortCache.has(key)) {
    return {
      shortUrl: previewShortCache.get(key),
      cached: true,
      previewUrl,
      reason: null,
    };
  }

  if (previewShortInflight.has(key)) {
    const shortened = await previewShortInflight.get(key);
    if (previewShortCache.has(key)) {
      return {
        shortUrl: previewShortCache.get(key),
        cached: true,
        previewUrl,
        reason: null,
      };
    }
    const shortUrl =
      shortened && shortened.shortUrl ? shortened.shortUrl : null;
    return {
      shortUrl,
      cached: false,
      previewUrl,
      reason: shortUrl
        ? null
        : shortened && shortened.reason
          ? shortened.reason
          : 'shortener request failed',
    };
  }

  const pending = (async () => {
    const shortened = await shorten(previewUrl);
    if (shortened && shortened.shortUrl) {
      rememberPreviewShort(key, shortened.shortUrl);
    }
    return shortened;
  })();

  previewShortInflight.set(key, pending);
  try {
    const shortened = await pending;
    const shortUrl =
      shortened && shortened.shortUrl ? shortened.shortUrl : null;
    return {
      shortUrl,
      cached: false,
      previewUrl,
      reason: shortUrl
        ? null
        : shortened && shortened.reason
          ? shortened.reason
          : 'shortener request failed',
    };
  } finally {
    previewShortInflight.delete(key);
  }
}

module.exports = {
  PREVIEW_UTM_CAMPAIGN_UUID,
  SHORT_CODE_LENGTH,
  looksLikeHttpUrl,
  composeFinalUrl,
  composePublicShortUrl,
  generateShortCode,
  shortenWithTinyUrl,
  attachShortLinkCampaignId,
  getOrCreatePreviewShortUrl,
  clearPreviewShortCache,
};
