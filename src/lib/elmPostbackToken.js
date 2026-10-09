'use strict';

/**
 * Shared-token authentication for ELM → JANUS postbacks (POST /elm/postback).
 *
 * Header: X-Credizona-Postback-Token: <hex token>
 * Env (read on every request, never cached, never logged):
 *   ELM_POSTBACK_TOKEN_CURRENT   required
 *   ELM_POSTBACK_TOKEN_PREVIOUS  optional; also accepted while a rotation is in progress
 *
 * A configured token must be hex (case-insensitive), even length, 64..256 chars (≥ 32 random
 * bytes), not trivially repetitive, and different from every other JANUS secret (the token is
 * shared with a third party). If CURRENT is missing or ANY configured token fails → the whole
 * configuration is rejected → 503 (fail closed; never falls back to the remaining token).
 *
 * A presented token that is missing, malformed or does not match → 401 with one generic code.
 * Matching is constant-time (crypto.timingSafeEqual on equal-length buffers) against every
 * configured token, without early exit.
 */

const crypto = require('crypto');
const { CODES } = require('../services/elm/constants');

const HEADER = 'x-credizona-postback-token';
const CURRENT_VAR = 'ELM_POSTBACK_TOKEN_CURRENT';
const PREVIOUS_VAR = 'ELM_POSTBACK_TOKEN_PREVIOUS';
const MIN_HEX_CHARS = 64;
const MAX_HEX_CHARS = 256;
const HEX_RE = /^[0-9a-f]+$/;
const MIN_DISTINCT_HEX_DIGITS = 8;
const OTHER_SECRET_VARS = Object.freeze([
  'SESSION_SECRET',
  'CRON_SECRET',
  'CZ_TRACKING_HMAC_SECRET',
  'CZ_MIPLAN_HANDOFF_HMAC_SECRET',
  'CZ_PROVIDER_FALLBACK_HMAC_SECRET',
  'MIPLAN_HANDOFF_REDEEM_SECRET',
  'MIPLAN_JANUS_EXPORT_SECRET',
  'EMAIL_UNSUBSCRIBE_HMAC_SECRET',
]);

/** @returns {string|null} lowercase hex when well-formed, else null */
function normalizeToken(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.toLowerCase();
  if (s.length < MIN_HEX_CHARS || s.length > MAX_HEX_CHARS || s.length % 2 !== 0) return null;
  if (!HEX_RE.test(s)) return null;
  return s;
}

function trimmedEnv(env, name) {
  const v = env[name];
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ ok: boolean, reason: string|null, tokens: Buffer[] }}
 */
function loadTokens(env) {
  const current = trimmedEnv(env, CURRENT_VAR);
  if (!current) return { ok: false, reason: 'token_current_missing', tokens: [] };
  const previous = trimmedEnv(env, PREVIOUS_VAR);
  const others = new Set(OTHER_SECRET_VARS.map((n) => trimmedEnv(env, n)).filter(Boolean).map((s) => s.toLowerCase()));
  const tokens = [];
  for (const [label, raw] of [['current', current], ['previous', previous]]) {
    if (raw == null) continue;
    const t = normalizeToken(raw);
    if (!t) return { ok: false, reason: 'token_' + label + '_invalid', tokens: [] };
    if (new Set(t).size < MIN_DISTINCT_HEX_DIGITS) return { ok: false, reason: 'token_' + label + '_weak', tokens: [] };
    if (others.has(t)) return { ok: false, reason: 'token_' + label + '_reused', tokens: [] };
    tokens.push(Buffer.from(t, 'utf8'));
  }
  return { ok: true, reason: null, tokens: tokens };
}

/**
 * Value-free view of the configuration (for ops checks and tests).
 * @param {Record<string, string|undefined>} [env]
 */
function describeElmPostbackTokenConfig(env) {
  const cfg = loadTokens(env || process.env);
  return { configured: cfg.ok, reason: cfg.reason, acceptedTokens: cfg.tokens.length };
}

function presentedToken(headers) {
  const raw = headers ? headers[HEADER] : undefined;
  if (raw == null || raw === '') return { token: null, reason: 'token_missing' };
  const t = normalizeToken(typeof raw === 'string' ? raw : null);
  if (!t) return { token: null, reason: 'token_malformed' };
  return { token: Buffer.from(t, 'utf8'), reason: null };
}

/**
 * @param {{ env?: Record<string, string|undefined> }} [opts] env defaults to process.env
 * @returns {(req: { headers?: object }) => Promise<{ ok: boolean, status?: number, code?: string, reason?: string }>}
 */
function createElmPostbackAuthenticator(opts) {
  const o = opts || {};
  return async function authenticateElmPostback(req) {
    const cfg = loadTokens(o.env || process.env);
    if (!cfg.ok) return { ok: false, status: 503, code: CODES.POSTBACK_AUTH_NOT_CONFIGURED, reason: cfg.reason };
    const presented = presentedToken(req && req.headers);
    if (!presented.token) {
      return { ok: false, status: 401, code: CODES.POSTBACK_UNAUTHORIZED, reason: presented.reason };
    }
    let matched = false;
    for (const t of cfg.tokens) {
      if (t.length === presented.token.length && crypto.timingSafeEqual(t, presented.token)) matched = true;
    }
    if (!matched) return { ok: false, status: 401, code: CODES.POSTBACK_UNAUTHORIZED, reason: 'token_mismatch' };
    return { ok: true };
  };
}

module.exports = {
  HEADER,
  CURRENT_VAR,
  PREVIOUS_VAR,
  MIN_HEX_CHARS,
  MAX_HEX_CHARS,
  OTHER_SECRET_VARS,
  createElmPostbackAuthenticator,
  describeElmPostbackTokenConfig,
};
