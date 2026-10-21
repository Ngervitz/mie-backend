'use strict';

/**
 * Pure helpers for GET/HEAD /a/:code.
 * Does not read marketing_impacts. Does not persist.
 */

const crypto = require('crypto');

const CODE_RE = /^[A-Za-z0-9]{4,32}$/;
const UA_MAX = 512;
const REFERER_MAX = 2048;

function readDestUrl(raw) {
  const trimmed = raw == null ? '' : String(raw).trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch (_err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}

/**
 * HMAC-SHA256 hex. Empty ip or empty secret → null. Never returns the raw IP.
 * @param {unknown} ip
 * @param {unknown} secret
 * @returns {string|null}
 */
function hashIp(ip, secret) {
  const value = ip == null ? '' : String(ip).trim();
  const key = secret == null ? '' : String(secret).trim();
  if (!value || !key) return null;
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

/**
 * First X-Forwarded-For hop, otherwise the socket address.
 * The value is only an input to hashIp. Callers must not persist it.
 * @param {import('express').Request} req
 * @returns {string}
 */
function clientAddress(req) {
  const header = req && req.headers ? req.headers['x-forwarded-for'] : null;
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && raw.trim()) {
    const first = raw.split(',')[0].trim();
    if (first) return first;
  }
  const sock = req && req.socket && req.socket.remoteAddress;
  return sock ? String(sock) : '';
}

function clip(raw, max) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/**
 * Configured destination plus exactly utm_source=referral and cz_click.
 * Existing query params and the hash are kept.
 * @param {string} dest
 * @param {string} clickId
 * @returns {string}
 */
function trackedUrl(dest, clickId) {
  const url = new URL(dest);
  url.searchParams.set('utm_source', 'referral');
  url.searchParams.set('cz_click', clickId);
  return url.toString();
}

module.exports = {
  CODE_RE,
  UA_MAX,
  REFERER_MAX,
  readDestUrl,
  hashIp,
  clientAddress,
  clip,
  trackedUrl,
};
