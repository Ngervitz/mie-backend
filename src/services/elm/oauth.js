'use strict';

/**
 * OAuth 1.0 request signing for NetSuite RESTlets (Token-Based Authentication), HMAC-SHA256.
 * Pure functions: no I/O, no logging. Callers supply nonce and timestamp.
 *
 * Signature base string (RFC 5849 §3.4.1):
 *   METHOD & enc(base URI) & enc(normalized params)
 *   - base URI: lowercase scheme/host, no default port, path, no query.
 *   - params: oauth_* (without oauth_signature and realm) + URL query params (script, deploy).
 *     A JSON body is not a form body, so it is never part of the signature.
 *   - normalization: percent-encode name and value, sort by name then value, join "n=v" with "&".
 * Key: enc(consumer secret) & enc(token secret).
 * Header: OAuth realm="<account>", oauth_* params (values percent-encoded), oauth_signature.
 *   realm = NetSuite account id; it is sent but never signed.
 */

const crypto = require('crypto');

const SIGNATURE_METHOD = 'HMAC-SHA256';
const OAUTH_VERSION = '1.0';

const RESTLET_HOST_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.restlets\.api\.netsuite\.com$/;

/** RFC 3986 unreserved characters are kept; everything else is %XX (UTF-8, uppercase hex). */
function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

/**
 * @param {string} rawUrl
 * @returns {{ baseUri: string, queryParams: Array<[string, string]> }}
 */
function splitUrl(rawUrl) {
  const u = new URL(String(rawUrl));
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  const host = u.hostname.toLowerCase();
  const defaultPort = (scheme === 'https' && u.port === '443') || (scheme === 'http' && u.port === '80');
  const port = u.port && !defaultPort ? ':' + u.port : '';
  const queryParams = [];
  for (const [k, v] of u.searchParams) queryParams.push([k, v]);
  return { baseUri: scheme + '://' + host + port + u.pathname, queryParams: queryParams };
}

/** @param {Array<[string, string]>} params */
function normalizeParams(params) {
  return params
    .map(function (p) {
      return [percentEncode(p[0]), percentEncode(p[1])];
    })
    .sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return 0;
    })
    .map(function (p) {
      return p[0] + '=' + p[1];
    })
    .join('&');
}

/**
 * @param {string} method
 * @param {string} url
 * @param {Record<string, string>} oauthParams oauth_* without oauth_signature
 */
function signatureBaseString(method, url, oauthParams) {
  const { baseUri, queryParams } = splitUrl(url);
  const params = queryParams.concat(
    Object.entries(oauthParams).filter(function (e) {
      return e[0] !== 'oauth_signature' && e[0] !== 'realm';
    }),
  );
  return [
    String(method).toUpperCase(),
    percentEncode(baseUri),
    percentEncode(normalizeParams(params)),
  ].join('&');
}

function signingKey(consumerSecret, tokenSecret) {
  return percentEncode(consumerSecret) + '&' + percentEncode(tokenSecret);
}

function hmacSha256Base64(baseString, key) {
  return crypto.createHmac('sha256', key).update(baseString, 'utf8').digest('base64');
}

/**
 * NetSuite account id (realm) from a RESTlet host: "1234567-sb1.restlets.api.netsuite.com" →
 * "1234567_SB1". Not a RESTlet host → null.
 * @param {string} rawUrl
 */
function realmFromRestletUrl(rawUrl) {
  let host;
  try {
    host = new URL(String(rawUrl)).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
  const m = RESTLET_HOST_RE.exec(host);
  return m ? m[1].replace(/-/g, '_').toUpperCase() : null;
}

/**
 * @param {{
 *   method: string,
 *   url: string,
 *   realm: string,
 *   consumerKey: string,
 *   consumerSecret: string,
 *   tokenId: string,
 *   tokenSecret: string,
 *   nonce: string,
 *   timestamp: number,
 * }} input
 * @returns {string} Authorization header value
 */
function buildAuthorizationHeader(input) {
  const oauth = {
    oauth_consumer_key: input.consumerKey,
    oauth_token: input.tokenId,
    oauth_signature_method: SIGNATURE_METHOD,
    oauth_timestamp: String(input.timestamp),
    oauth_nonce: input.nonce,
    oauth_version: OAUTH_VERSION,
  };
  const base = signatureBaseString(input.method, input.url, oauth);
  const signature = hmacSha256Base64(base, signingKey(input.consumerSecret, input.tokenSecret));
  const parts = ['realm="' + percentEncode(input.realm) + '"'];
  for (const [k, v] of Object.entries(oauth)) parts.push(k + '="' + percentEncode(v) + '"');
  parts.push('oauth_signature="' + percentEncode(signature) + '"');
  return 'OAuth ' + parts.join(', ');
}

module.exports = {
  SIGNATURE_METHOD,
  OAUTH_VERSION,
  RESTLET_HOST_RE,
  percentEncode,
  splitUrl,
  normalizeParams,
  signatureBaseString,
  signingKey,
  hmacSha256Base64,
  realmFromRestletUrl,
  buildAuthorizationHeader,
};
