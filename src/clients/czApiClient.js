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
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ items: object[], hasMore: boolean, nextSince: string|null }>}
 */
async function fetchCzPage(path, since, opts = {}) {
  const token = resolveBearerToken();
  const sinceParam = since || INITIAL_SINCE;
  const url = new URL(
    `${CZ_API_BASE}${path.startsWith('/') ? path : `/${path}`}`,
  );
  url.searchParams.set('since', sinceParam);

  let response;
  try {
    response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
    );
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
 * ISO cursor one second earlier (UTC, no millis), or null if unparseable.
 * CZ filters `updated > since` at second precision, so since = tip - 1s
 * re-reads every row sharing the tip second.
 * @param {string} since
 * @returns {string|null}
 */
function overlapSince(since) {
  const ms = Date.parse(String(since || ''));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Paginate until hasMore=false or safety limits.
 *
 * boundaryOverlap: request each next page from nextSince - 1s and dedupe by
 * item.id, so rows sharing the page-boundary second are not skipped by CZ's
 * strict `updated > since`. Returned items are unique by id (last fetch wins).
 * resumeSince is the since to pass on a follow-up call to continue a partial run.
 *
 * @param {string} path
 * @param {string|null} initialSince
 * @param {{ maxPages?: number, timeoutMs?: number, boundaryOverlap?: boolean }} [opts]
 *   timeoutMs applies per page
 */
async function fetchAllCzPages(path, initialSince, opts = {}) {
  const maxPages = opts.maxPages != null ? opts.maxPages : MAX_PAGES_PER_RUN;
  const boundaryOverlap = opts.boundaryOverlap === true;
  let since = initialSince || INITIAL_SINCE;
  let pages = 0;
  let itemsFetched = 0;
  let boundaryStalls = 0;
  /** @type {object[]} */
  const allItems = [];
  /** @type {Map<string, number>} */
  const indexById = new Map();
  let lastNextSince = null;
  let hasMore = true;

  function collect(item) {
    if (!boundaryOverlap || !item || item.id == null) {
      allItems.push(item);
      return;
    }
    const key = String(item.id);
    if (indexById.has(key)) {
      allItems[indexById.get(key)] = item;
      return;
    }
    indexById.set(key, allItems.length);
    allItems.push(item);
  }

  while (hasMore) {
    if (pages >= maxPages) {
      return {
        items: allItems,
        pagesFetched: pages,
        itemsFetched,
        nextSince: lastNextSince || since,
        resumeSince: since,
        boundaryStalls,
        hitPageLimit: true,
        incomplete: true,
      };
    }

    const page = await fetchCzPage(path, since, { timeoutMs: opts.timeoutMs });
    pages += 1;
    itemsFetched += page.items.length;
    for (const item of page.items) collect(item);

    hasMore = page.hasMore === true;

    if (page.nextSince) {
      lastNextSince = page.nextSince;
      if (boundaryOverlap && hasMore) {
        const overlapped = overlapSince(page.nextSince);
        if (overlapped && overlapped !== since) {
          since = overlapped;
          continue;
        }
        // Whole page inside one second (>= page size rows share it):
        // overlap cannot progress, fall back to strict nextSince.
        boundaryStalls += 1;
      }
      if (page.nextSince === since) {
        // Cursor did not advance — stop to avoid infinite loop.
        hasMore = false;
        break;
      }
      since = page.nextSince;
    } else {
      lastNextSince = since;
      hasMore = false;
      break;
    }
  }

  return {
    items: allItems,
    pagesFetched: pages,
    itemsFetched,
    nextSince: lastNextSince,
    resumeSince: null,
    boundaryStalls,
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
  overlapSince,
};
