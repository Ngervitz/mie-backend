'use strict';

/**
 * ELM runtime configuration (read from process.env, no defaults for business mappings).
 *
 * Business mappings are EMPTY by default so every case fails closed until ELM confirms:
 * - ELM_ACTIVITY_TYPE_MAP_JSON     CZ relacion_laboral code → ELM activityType value
 * - ELM_SOURCE_BRAND_BY_BASE_JSON  JANUS provenance base (sms source_system) → brand sent as source
 * - ELM_DATE_OF_BIRTH_FORMAT       one of DATE_OF_BIRTH_FORMATS
 * - ELM_MOBILE_PHONE_FORMAT        one of MOBILE_PHONE_FORMATS
 *
 * Technical defaults (conservative, not business values; override by env):
 * - ELM_HTTP_TIMEOUT_MS            default 30000 (future transport timeout)
 * - ELM_IN_FLIGHT_LEASE_SECONDS    default 300; always >= timeout + LEASE_MARGIN_SECONDS so a
 *                                  normal call finishes before its in_flight can expire.
 */

const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_IN_FLIGHT_LEASE_SECONDS = 300;
const LEASE_MARGIN_SECONDS = 60;
const MAX_LEASE_SECONDS = 86400;

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
    sourceBrandByBase: parseStringMap(env.ELM_SOURCE_BRAND_BY_BASE_JSON),
    dateOfBirthFormat: oneOf(env.ELM_DATE_OF_BIRTH_FORMAT, DATE_OF_BIRTH_FORMATS),
    mobilePhoneFormat: oneOf(env.ELM_MOBILE_PHONE_FORMAT, MOBILE_PHONE_FORMATS),
  });
}

module.exports = {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_IN_FLIGHT_LEASE_SECONDS,
  LEASE_MARGIN_SECONDS,
  DATE_OF_BIRTH_FORMATS,
  MOBILE_PHONE_FORMATS,
  parseStringMap,
  readElmConfig,
};
