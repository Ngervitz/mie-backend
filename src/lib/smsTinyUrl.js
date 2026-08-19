'use strict';

/**
 * TinyURL shortening for SMS campaign links.
 * Preview uses a fixed UTM campaign UUID and an in-process cache keyed by
 * trimmed destination_url so the same preview destination never hits TinyURL twice.
 * Real campaign sends must call shortenWithTinyUrl(finalUrl) with the campaign UUID
 * and must not reuse preview shorts.
 */

const TINYURL_TIMEOUT_MS = 4000;

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

/**
 * Shorten a URL via TinyURL public API.
 * Returns { shortUrl } on success, or { shortUrl: null, reason } on any failure.
 * Never throws — callers must fall back to the long URL.
 */
async function shortenWithTinyUrl(longUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TINYURL_TIMEOUT_MS);
  try {
    const endpoint =
      'https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl);
    const res = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'text/plain' },
    });
    if (!res.ok) {
      return {
        shortUrl: null,
        reason: `TinyURL HTTP ${res.status}`,
      };
    }
    const text = String((await res.text()) || '').trim();
    if (!text || !/^https?:\/\//i.test(text)) {
      return {
        shortUrl: null,
        reason: 'TinyURL returned empty or non-URL body',
      };
    }
    return { shortUrl: text, reason: null };
  } catch (err) {
    const reason =
      err && err.name === 'AbortError'
        ? `TinyURL timeout after ${TINYURL_TIMEOUT_MS}ms`
        : err && err.message
          ? String(err.message)
          : 'TinyURL request failed';
    return { shortUrl: null, reason };
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
 * the cached short and does not call TinyURL again.
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
          : 'TinyURL request failed',
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
          : 'TinyURL request failed',
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
