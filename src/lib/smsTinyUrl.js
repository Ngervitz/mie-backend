'use strict';

const logger = require('./logger');

/**
 * Cleanuri shortening for SMS campaign links.
 * Preview uses a fixed UTM campaign UUID and an in-process cache keyed by
 * trimmed destination_url so the same preview destination is not shortened twice.
 * Real campaign sends must call shortenWithTinyUrl(finalUrl) with the campaign UUID
 * and must not reuse preview shorts.
 */

const SHORTEN_TIMEOUT_MS = 10000;

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

function fallback(kind, reason) {
  logger.warn('SMS shortener fallback', { kind: kind, provider: 'cleanuri' });
  return { shortUrl: null, reason: reason, kind: kind };
}

/**
 * Shorten a URL via Cleanuri (POST form-urlencoded).
 * Returns { shortUrl, reason, kind } — kind is set on fallback only.
 * Never throws — callers must fall back to the long URL.
 */
async function shortenWithTinyUrl(longUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHORTEN_TIMEOUT_MS);
  try {
    const endpoint = 'https://cleanuri.com/api/v1/shorten';
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'url=' + encodeURIComponent(longUrl),
    });
    const raw = String((await res.text()) || '').trim();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_err) {
      parsed = null;
    }

    if (!res.ok) {
      return fallback('shortener_error', 'cleanuri HTTP ' + String(res.status));
    }
    if (!parsed || typeof parsed !== 'object') {
      return fallback('shortener_invalid_response', 'cleanuri non-json body');
    }
    if (parsed.error != null && String(parsed.error).trim() !== '') {
      return fallback('shortener_error', 'cleanuri error field');
    }
    const resultUrl =
      parsed.result_url != null ? String(parsed.result_url).trim() : '';
    if (!looksLikeHttpUrl(resultUrl)) {
      return fallback(
        'shortener_invalid_response',
        'cleanuri missing or invalid result_url',
      );
    }
    return { shortUrl: resultUrl, reason: null, kind: null };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return fallback(
        'shortener_timeout',
        'cleanuri timeout after ' + String(SHORTEN_TIMEOUT_MS) + 'ms',
      );
    }
    return fallback('shortener_error', 'cleanuri request failed');
  } finally {
    clearTimeout(timer);
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
  looksLikeHttpUrl,
  composeFinalUrl,
  shortenWithTinyUrl,
  getOrCreatePreviewShortUrl,
  clearPreviewShortCache,
};
