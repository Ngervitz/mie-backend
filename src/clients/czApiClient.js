/**
 * Credizona Funnel HTTP client (decode host + Bearer).
 * Base: https://www.credizona2.decode.uy/api
 * Auth: Authorization: Bearer ${CZ_API_BEARER_TOKEN}
 *
 * Never log the bearer or Authorization header.
 * Do not follow redirects as the normal auth path (apex/www can drop Authorization).
 */

const CZ_API_BASE = 'https://www.credizona2.decode.uy/api';
const DEFAULT_TIMEOUT_MS = 30000;
const INITIAL_SINCE = '2020-01-01T00:00:00Z';
const MAX_PAGES_PER_RUN = 50;

function resolveBearerToken() {
  // Trim at read time (same pattern as IG / optionalTrimmedEnv). Not in env.js —
  // CZ funnel reads the secret at call time so missing token does not crash boot.
  const token = String(process.env.CZ_API_BEARER_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      'CZ_API_BEARER_TOKEN is not configured — set it to sync Credizona funnel data',
    );
  }
  return token;
}

/**
 * TEMP safe diagnostic for CZ_API_BEARER_TOKEN (no secret values).
 * Compares RAW env vs trimmed; never returns the token or recoverable fragments.
 */
function getCzApiBearerTokenDiagnostic() {
  const rawEnv = process.env.CZ_API_BEARER_TOKEN;
  if (rawEnv == null || rawEnv === '') {
    return {
      present: false,
      rawLength: 0,
      trimmedLength: 0,
      length: 0,
      hasLeadingWhitespace: false,
      hasTrailingWhitespace: false,
      containsSpace: false,
      containsTab: false,
      containsNewline: false,
      containsCarriageReturn: false,
      containsLiteralBackslashN: false,
      containsLiteralBackslashR: false,
      containsQuotesAtEdges: false,
      containsNonAscii: false,
      trimChangedLength: false,
    };
  }

  const raw = String(rawEnv);
  const trimmed = raw.trim();
  let containsNonAscii = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      containsNonAscii = true;
      break;
    }
  }

  return {
    present: true,
    rawLength: raw.length,
    trimmedLength: trimmed.length,
    length: raw.length,
    hasLeadingWhitespace: raw !== raw.trimStart(),
    hasTrailingWhitespace: raw !== raw.trimEnd(),
    containsSpace: trimmed.includes(' '),
    containsTab: trimmed.includes('\t'),
    containsNewline: /[\r\n]/.test(raw) || trimmed.includes('\n'),
    containsCarriageReturn: trimmed.includes('\r') || raw.includes('\r'),
    containsLiteralBackslashN: trimmed.includes('\\n'),
    containsLiteralBackslashR: trimmed.includes('\\r'),
    containsQuotesAtEdges:
      trimmed.startsWith("'") ||
      trimmed.startsWith('"') ||
      trimmed.endsWith("'") ||
      trimmed.endsWith('"'),
    containsNonAscii,
    trimChangedLength: trimmed.length !== raw.length,
  };
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs]
 */
async function fetchWithTimeout(url, init, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET one page for a CZ funnel endpoint.
 * @param {string} path  e.g. '/cdv_granted_loans'
 * @param {string} since opaque cursor / ISO since
 * @returns {Promise<{ items: object[], hasMore: boolean, nextSince: string|null }>}
 */
async function fetchCzPage(path, since) {
  const token = resolveBearerToken();
  const sinceParam = since || INITIAL_SINCE;
  const url = new URL(
    `${CZ_API_BASE}${path.startsWith('/') ? path : `/${path}`}`,
  );
  url.searchParams.set('since', sinceParam);

  let response;
  try {
    response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    const aborted =
      err &&
      (err.name === 'AbortError' ||
        /aborted|abort/i.test(String(err && err.message)));
    throw new Error(
      aborted
        ? `CZ API timeout (${path})`
        : `CZ API network error (${path}): ${err && err.message ? err.message : 'unknown'}`,
    );
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(
        `CZ API non-JSON (HTTP ${response.status}) on ${path}`,
      );
    }
  }

  if (!response.ok) {
    const msg =
      (payload && (payload.msg || payload.error || payload.message)) ||
      `HTTP ${response.status}`;
    throw new Error(`CZ API ${path} failed: ${String(msg).slice(0, 300)}`);
  }

  const data = payload && payload.data && typeof payload.data === 'object'
    ? payload.data
    : {};
  const items = Array.isArray(data.items) ? data.items : [];
  const hasMore = data.hasMore === true;
  const nextSince =
    data.nextSince != null && String(data.nextSince).trim()
      ? String(data.nextSince).trim()
      : null;

  return { items, hasMore, nextSince };
}

/**
 * Paginate until hasMore=false or safety limits.
 * @param {string} path
 * @param {string|null} initialSince
 * @param {{ maxPages?: number }} [opts]
 */
async function fetchAllCzPages(path, initialSince, opts = {}) {
  const maxPages = opts.maxPages != null ? opts.maxPages : MAX_PAGES_PER_RUN;
  let since = initialSince || INITIAL_SINCE;
  let pages = 0;
  let itemsFetched = 0;
  /** @type {object[]} */
  const allItems = [];
  let lastNextSince = null;
  let hasMore = true;

  while (hasMore) {
    if (pages >= maxPages) {
      return {
        items: allItems,
        pagesFetched: pages,
        itemsFetched,
        nextSince: lastNextSince || since,
        hitPageLimit: true,
        incomplete: true,
      };
    }

    const page = await fetchCzPage(path, since);
    pages += 1;
    itemsFetched += page.items.length;
    for (const item of page.items) allItems.push(item);

    if (page.nextSince) {
      if (page.nextSince === since) {
        // Cursor did not advance — stop to avoid infinite loop.
        hasMore = false;
        lastNextSince = page.nextSince;
        break;
      }
      lastNextSince = page.nextSince;
      since = page.nextSince;
    } else {
      lastNextSince = since;
      hasMore = false;
      break;
    }

    hasMore = page.hasMore === true;
    if (!page.nextSince) hasMore = false;
  }

  return {
    items: allItems,
    pagesFetched: pages,
    itemsFetched,
    nextSince: lastNextSince,
    hitPageLimit: false,
    incomplete: false,
  };
}

module.exports = {
  CZ_API_BASE,
  INITIAL_SINCE,
  MAX_PAGES_PER_RUN,
  resolveBearerToken,
  getCzApiBearerTokenDiagnostic,
  fetchCzPage,
  fetchAllCzPages,
};
