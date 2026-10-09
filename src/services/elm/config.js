'use strict';

/**
 * ELM runtime configuration (read from process.env, no defaults for business mappings).
 *
 * Business mappings are EMPTY by default so every case fails closed until ELM confirms:
 * - ELM_ACTIVITY_TYPE_MAP_JSON     CZ relacion_laboral code → ELM activityType value
 * - ELM_DATE_OF_BIRTH_FORMAT       one of DATE_OF_BIRTH_FORMATS
 * - ELM_MOBILE_PHONE_FORMAT        one of MOBILE_PHONE_FORMATS
 * `source` is not configurable: always ELM_SOURCE ('copanel'). TrackingId (S2 only) is always
 * cz_solicitud_id.
 *
 * Transport (readElmTransportConfig; env only, never in code/tests/docs/logs):
 * - ELM_CLIENT_ENABLED             only "true" (case-insensitive) enables the real client. Default OFF.
 * - ELM_SERVICE_1_URL / ELM_SERVICE_2_URL   NetSuite RESTlet URLs (same account)
 * - ELM_CONSUMER_KEY / ELM_CONSUMER_SECRET / ELM_TOKEN_ID / ELM_TOKEN_SECRET   OAuth 1.0 TBA
 *
 * Technical defaults (conservative, not business values; override by env):
 * - ELM_HTTP_TIMEOUT_MS            default 30000 (per-call transport timeout)
 * - ELM_IN_FLIGHT_LEASE_SECONDS    default 300; always >= timeout + LEASE_MARGIN_SECONDS so a
 *                                  normal call finishes before its in_flight can expire.
 *
 * Technical retry (only technical_error, never unknown):
 * - ELM_RETRY_SAFE_ERROR_CODES     comma list of error codes proven side-effect free on ELM's
 *                                  side. EMPTY by default → nothing is retried automatically.
 * - ELM_TECHNICAL_RETRY_MAX_ATTEMPTS   total attempts per step incl. the first (default 3, max 10)
 * - ELM_TECHNICAL_RETRY_BACKOFF_SECONDS base backoff (default 300), doubled per attempt
 * - ELM_TECHNICAL_RETRY_BACKOFF_MAX_SECONDS cap (default 21600)
 */

const { realmFromRestletUrl } = require('./oauth');

const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_IN_FLIGHT_LEASE_SECONDS = 300;
const LEASE_MARGIN_SECONDS = 60;
const MAX_LEASE_SECONDS = 86400;
const DEFAULT_TECHNICAL_RETRY_MAX_ATTEMPTS = 3;
const MAX_TECHNICAL_RETRY_ATTEMPTS = 10;
const DEFAULT_TECHNICAL_RETRY_BACKOFF_SECONDS = 300;
const DEFAULT_TECHNICAL_RETRY_BACKOFF_MAX_SECONDS = 21600;

const DATE_OF_BIRTH_FORMATS = Object.freeze([
  'D/M/YYYY',
  'DD/MM/YYYY',
  'M/D/YYYY',
  'MM/DD/YYYY',
  'YYYY-MM-DD',
]);

/** uy_local_0 → 09XXXXXXX ; uy_598 → 5989XXXXXXX */
const MOBILE_PHONE_FORMATS = Object.freeze(['uy_local_0', 'uy_598']);

function positiveInt(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * JSON object of non-empty string → non-empty string. Anything else → {}.
 * @param {unknown} raw
 * @returns {Readonly<Record<string, string>>}
 */
function parseStringMap(raw) {
  if (raw == null || String(raw).trim() === '') return Object.freeze({});
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return Object.freeze({});
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.freeze({});
  }
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    const key = String(k).trim();
    if (!key || typeof v !== 'string' || v.trim() === '') continue;
    out[key] = v.trim();
  }
  return Object.freeze(out);
}

function oneOf(raw, allowed) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return allowed.includes(s) ? s : null;
}

const ERROR_CODE_RE = /^[a-z0-9_]{1,100}$/;

/** @returns {readonly string[]} */
function codeList(raw) {
  if (raw == null || String(raw).trim() === '') return Object.freeze([]);
  const out = [];
  for (const part of String(raw).split(',')) {
    const s = part.trim();
    if (ERROR_CODE_RE.test(s) && !out.includes(s)) out.push(s);
  }
  return Object.freeze(out);
}

/**
 * @param {Record<string, string|undefined>} [source]
 */
function readElmConfig(source) {
  const env = source || process.env;
  const httpTimeoutMs = positiveInt(env.ELM_HTTP_TIMEOUT_MS, DEFAULT_HTTP_TIMEOUT_MS);
  const minLease = Math.ceil(httpTimeoutMs / 1000) + LEASE_MARGIN_SECONDS;
  const requestedLease = positiveInt(
    env.ELM_IN_FLIGHT_LEASE_SECONDS,
    DEFAULT_IN_FLIGHT_LEASE_SECONDS,
  );
  const inFlightLeaseSeconds = Math.min(
    Math.max(requestedLease, minLease),
    MAX_LEASE_SECONDS,
  );
  return Object.freeze({
    httpTimeoutMs: httpTimeoutMs,
    inFlightLeaseSeconds: inFlightLeaseSeconds,
    activityTypeMap: parseStringMap(env.ELM_ACTIVITY_TYPE_MAP_JSON),
    dateOfBirthFormat: oneOf(env.ELM_DATE_OF_BIRTH_FORMAT, DATE_OF_BIRTH_FORMATS),
    mobilePhoneFormat: oneOf(env.ELM_MOBILE_PHONE_FORMAT, MOBILE_PHONE_FORMATS),
    retrySafeErrorCodes: codeList(env.ELM_RETRY_SAFE_ERROR_CODES),
    technicalRetryMaxAttempts: Math.min(
      positiveInt(env.ELM_TECHNICAL_RETRY_MAX_ATTEMPTS, DEFAULT_TECHNICAL_RETRY_MAX_ATTEMPTS),
      MAX_TECHNICAL_RETRY_ATTEMPTS,
    ),
    technicalRetryBackoffSeconds: positiveInt(
      env.ELM_TECHNICAL_RETRY_BACKOFF_SECONDS,
      DEFAULT_TECHNICAL_RETRY_BACKOFF_SECONDS,
    ),
    technicalRetryBackoffMaxSeconds: positiveInt(
      env.ELM_TECHNICAL_RETRY_BACKOFF_MAX_SECONDS,
      DEFAULT_TECHNICAL_RETRY_BACKOFF_MAX_SECONDS,
    ),
  });
}

/**
 * Wait before attempt n+1 after attempt n failed with a retry-safe technical_error.
 * @param {number} attemptsDone >= 1
 * @param {{ technicalRetryBackoffSeconds: number, technicalRetryBackoffMaxSeconds: number }} config
 */
function technicalRetryDelaySeconds(attemptsDone, config) {
  const n = Math.max(1, Math.floor(Number(attemptsDone) || 1));
  const base = config.technicalRetryBackoffSeconds;
  return Math.min(base * Math.pow(2, n - 1), config.technicalRetryBackoffMaxSeconds);
}

const TRANSPORT_URL_VARS = Object.freeze(['ELM_SERVICE_1_URL', 'ELM_SERVICE_2_URL']);
const TRANSPORT_CREDENTIAL_VARS = Object.freeze([
  'ELM_CONSUMER_KEY',
  'ELM_CONSUMER_SECRET',
  'ELM_TOKEN_ID',
  'ELM_TOKEN_SECRET',
]);
const RESTLET_PATH = '/app/site/hosting/restlet.nl';
const CREDENTIAL_RE = /^[\x21-\x7E]{1,512}$/;

/** NetSuite RESTlet URL: https, *.restlets.api.netsuite.com, restlet.nl?script=..&deploy=.. */
function restletUrl(raw) {
  if (raw == null || String(raw).trim() === '') return { missing: true, url: null, realm: null };
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch (_) {
    return { missing: false, url: null, realm: null };
  }
  const realm = realmFromRestletUrl(u.href);
  const ok =
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    !u.hash &&
    (u.port === '' || u.port === '443') &&
    realm != null &&
    u.pathname === RESTLET_PATH &&
    Boolean(u.searchParams.get('script')) &&
    Boolean(u.searchParams.get('deploy'));
  return ok ? { missing: false, url: u.href, realm: realm } : { missing: false, url: null, realm: null };
}

/**
 * Transport configuration for the real ELM client. Reports variable NAMES only (never values).
 * `credentials` is non-enumerable so it never ends up in JSON/log serialization.
 *
 * @param {Record<string, string|undefined>} [source]
 * @returns {{
 *   clientEnabled: boolean, ready: boolean, missing: string[], invalid: string[],
 *   realm: string|null, service1Url: string|null, service2Url: string|null,
 *   credentials?: { consumerKey: string, consumerSecret: string, tokenId: string, tokenSecret: string },
 * }}
 */
function readElmTransportConfig(source) {
  const env = source || process.env;
  const missing = [];
  const invalid = [];
  const s1 = restletUrl(env.ELM_SERVICE_1_URL);
  const s2 = restletUrl(env.ELM_SERVICE_2_URL);
  [[TRANSPORT_URL_VARS[0], s1], [TRANSPORT_URL_VARS[1], s2]].forEach(function (pair) {
    if (pair[1].missing) missing.push(pair[0]);
    else if (!pair[1].url) invalid.push(pair[0]);
  });
  if (s1.realm && s2.realm && s1.realm !== s2.realm) invalid.push('ELM_SERVICE_URLS_ACCOUNT_MISMATCH');

  const creds = {};
  const keys = ['consumerKey', 'consumerSecret', 'tokenId', 'tokenSecret'];
  TRANSPORT_CREDENTIAL_VARS.forEach(function (name, i) {
    const raw = env[name];
    if (raw == null || String(raw).trim() === '') {
      missing.push(name);
      return;
    }
    const v = String(raw).trim();
    if (!CREDENTIAL_RE.test(v)) invalid.push(name);
    else creds[keys[i]] = v;
  });

  const ready = missing.length === 0 && invalid.length === 0;
  const out = {
    clientEnabled: String(env.ELM_CLIENT_ENABLED == null ? '' : env.ELM_CLIENT_ENABLED).trim().toLowerCase() === 'true',
    ready: ready,
    missing: missing,
    invalid: invalid,
    realm: ready ? s1.realm : null,
    service1Url: ready ? s1.url : null,
    service2Url: ready ? s2.url : null,
  };
  if (ready) {
    Object.defineProperty(out, 'credentials', { value: Object.freeze(creds), enumerable: false });
  }
  return Object.freeze(out);
}

module.exports = {
  TRANSPORT_URL_VARS,
  TRANSPORT_CREDENTIAL_VARS,
  readElmTransportConfig,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_IN_FLIGHT_LEASE_SECONDS,
  LEASE_MARGIN_SECONDS,
  DATE_OF_BIRTH_FORMATS,
  MOBILE_PHONE_FORMATS,
  parseStringMap,
  readElmConfig,
  technicalRetryDelaySeconds,
};
