/**
 * Shared-password dashboard auth (HMAC session cookie).
 * No express-session / JWT libraries — Node crypto only.
 */

const crypto = require('crypto');
const env = require('../config/env');

const COOKIE_NAME = 'janus_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SEC = Math.floor(SESSION_TTL_MS / 1000);

const API_PATH_PREFIXES = [
  '/api',
  '/sms',
  '/email',
  '/ai-visibility',
  '/competitor-activity-predictions',
  '/jobs',
  '/reports',
];

function authConfigured() {
  return !!(env.dashboardLoginPassword && env.sessionSecret);
}

/**
 * @returns {string}
 */
function createSessionToken() {
  const payloadObj = { issuedAt: Date.now() };
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString(
    'base64url',
  );
  const sig = crypto
    .createHmac('sha256', env.sessionSecret)
    .update(payload)
    .digest('base64url');
  return payload + '.' + sig;
}

/**
 * @param {unknown} token
 * @returns {boolean}
 */
function verifySessionToken(token) {
  if (typeof token !== 'string' || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (!payload || !sig) return false;

  let expected;
  try {
    expected = crypto
      .createHmac('sha256', env.sessionSecret)
      .update(payload)
      .digest('base64url');
  } catch {
    return false;
  }

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  const issuedAt = parsed && typeof parsed.issuedAt === 'number' ? parsed.issuedAt : NaN;
  if (!Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > SESSION_TTL_MS) return false;
  return true;
}

/**
 * @param {import('express').Request} req
 * @param {string} name
 * @returns {string|null}
 */
function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (typeof header !== 'string' || !header) return null;
  const segments = header.split(';');
  for (const segment of segments) {
    const idx = segment.indexOf('=');
    if (idx === -1) continue;
    const key = segment.slice(0, idx).trim();
    if (key !== name) continue;
    const raw = segment.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
function isApiPath(pathname) {
  const path = pathname || '';
  for (const prefix of API_PATH_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/')) return true;
  }
  // /hugo API routes, but not /hugo.html or /hugo-brief.html
  if (path === '/hugo' || path.startsWith('/hugo/')) return true;
  return false;
}

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function wantsJsonUnauthorized(req) {
  const accept = String((req.headers && req.headers.accept) || '');
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return true;
  }
  const pathname = (req.path || '').split('?')[0];
  return isApiPath(pathname);
}

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isAllowlisted(req) {
  const pathname = (req.path || '').split('?')[0];
  if (req.method === 'GET' && pathname === '/login.html') return true;
  if (req.method === 'POST' && pathname === '/login') return true;
  if (req.method === 'POST' && pathname === '/logout') return true;
  return false;
}

/**
 * Global auth gate. Fail closed if env secrets missing.
 */
function requireAuth(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({ error: 'Login no configurado' });
  }

  if (isAllowlisted(req)) {
    return next();
  }

  const token = readCookie(req, COOKIE_NAME);
  if (token && verifySessionToken(token)) {
    return next();
  }

  if (wantsJsonUnauthorized(req)) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  return res.redirect(302, '/login.html');
}

/**
 * Constant-time string compare for passwords (handles unequal lengths).
 * @param {unknown} provided
 * @param {unknown} expected
 * @returns {boolean}
 */
function safeEqualPassword(provided, expected) {
  const a = Buffer.from(String(provided == null ? '' : provided), 'utf8');
  const b = Buffer.from(String(expected == null ? '' : expected), 'utf8');
  if (a.length !== b.length) {
    const dummy = crypto.createHash('sha256').update(a).digest();
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function buildSessionCookie(token, { clear = false } = {}) {
  const secure = env.nodeEnv === 'production';
  const parts = [
    COOKIE_NAME + '=' + (clear ? '' : encodeURIComponent(token)),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (clear) {
    parts.push('Max-Age=0');
  } else {
    parts.push('Max-Age=' + SESSION_MAX_AGE_SEC);
  }
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  createSessionToken,
  verifySessionToken,
  requireAuth,
  readCookie,
  safeEqualPassword,
  buildSessionCookie,
  authConfigured,
};
