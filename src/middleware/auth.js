/**
 * Shared-password era → per-user dashboard auth (HMAC session cookie).
 * Cookie payload: { user_id, issuedAt } only — never permissions / is_admin.
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
  '/market-patterns',
  '/ml-notes',
  '/jobs',
  '/reports',
];

function authConfigured() {
  return !!env.sessionSecret;
}

/**
 * @param {string} userId
 * @returns {string}
 */
function createSessionToken(userId) {
  const payloadObj = {
    user_id: String(userId),
    issuedAt: Date.now(),
  };
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
 * @returns {{ userId: string, issuedAt: number }|null}
 */
function verifySessionToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;

  let expected;
  try {
    expected = crypto
      .createHmac('sha256', env.sessionSecret)
      .update(payload)
      .digest('base64url');
  } catch {
    return null;
  }

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const issuedAt =
    parsed && typeof parsed.issuedAt === 'number' ? parsed.issuedAt : NaN;
  const userId =
    parsed && parsed.user_id != null ? String(parsed.user_id).trim() : '';
  if (!userId || !Number.isFinite(issuedAt)) return null;
  if (Date.now() - issuedAt > SESSION_TTL_MS) return null;
  return { userId, issuedAt };
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
  if (req.method === 'POST' && pathname === '/admin/bootstrap-first-admin') {
    return true;
  }
  return false;
}

/**
 * Authenticate external cron (e.g. cron-job.org) via X-Cron-Key.
 * Only succeeds when CRON_SECRET is set and matches (timing-safe).
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isValidCronKey(req) {
  const secret = env.cronSecret;
  if (!secret) return false;
  const provided = req.headers && req.headers['x-cron-key'];
  if (typeof provided !== 'string' || !provided) return false;
  return safeEqualPassword(provided, secret);
}

/**
 * Global auth gate. Fail closed if SESSION_SECRET missing.
 * On success sets req.dashboardUserId (string) for session cookies.
 * Cron bypass sets req.dashboardAuthViaCron = true (no user id).
 */
function requireAuth(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({ error: 'Login no configurado' });
  }

  if (isAllowlisted(req)) {
    return next();
  }

  // Cron bypass: any path, no session cookie required.
  if (isValidCronKey(req)) {
    req.dashboardAuthViaCron = true;
    return next();
  }

  const token = readCookie(req, COOKIE_NAME);
  const session = token ? verifySessionToken(token) : null;
  if (session) {
    req.dashboardUserId = session.userId;
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
  isValidCronKey,
};
