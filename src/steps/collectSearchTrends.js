const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

/**
 * Google Trends collector (capture-only).
 *
 * IMPORTANT INTERPRETATION NOTE: Google Trends returns a RELATIVE interest
 * index (0-100), normalized to each term's own maximum within the queried
 * window and geo. It is NOT absolute search volume, and values are not
 * strictly comparable across terms queried separately.
 *
 * There is no official API. This module calls the same undocumented
 * endpoints the unofficial libraries wrap (explore → widget token →
 * widgetdata/multiline). Known behavior: aggressive HTTP 429 rate limiting
 * even at low volume, occasional 4xx breakage when Google changes backends.
 * Mitigations: strictly sequential requests, inter-term delay, single retry
 * with a long backoff on 429, and per-term isolation (one bad term never
 * fails the whole run — partial success is expected and logged explicitly).
 */

const GENERIC_TERMS = ['préstamo rápido', 'limpiar clearing', 'crédito uruguay'];
const GEO = 'UY';
const TIMEFRAME = 'today 3-m'; // ~90 daily points per term
const HL = 'es';
const TZ = 180; // minutes west of UTC (UY = UTC-3)
const INTER_TERM_DELAY_MS = 4000;
const RATE_LIMIT_BACKOFF_MS = 30000;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'es-419,es;q=0.9',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Google prefixes JSON responses with ")]}'" (and variants) — strip it. */
function parseGoogleJson(text) {
  const idx = String(text).indexOf('{');
  if (idx === -1) throw new Error('No JSON object in Google response');
  return JSON.parse(String(text).slice(idx));
}

/**
 * Session cookie holder. Google often 429s the very first explore call and
 * hands back a NID cookie; retrying with that cookie usually succeeds.
 */
function createSession() {
  return { cookie: null };
}

async function googleGet(url, session) {
  const headers = { ...BROWSER_HEADERS };
  if (session.cookie) headers.Cookie = session.cookie;
  const res = await fetch(url, { headers });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const nid = setCookie.split(',').find((c) => c.trim().startsWith('NID='));
    if (nid) session.cookie = nid.split(';')[0].trim();
  }
  return res;
}

async function exploreTerm(term, session) {
  const req = {
    comparisonItem: [{ keyword: term, geo: GEO, time: TIMEFRAME }],
    category: 0,
    property: '',
  };
  const url =
    'https://trends.google.com/trends/api/explore?hl=' +
    HL +
    '&tz=' +
    TZ +
    '&req=' +
    encodeURIComponent(JSON.stringify(req));

  let res = await googleGet(url, session);
  if (res.status === 429) {
    // Verified live: the first explore 429 usually carries a NID cookie and
    // an immediate cookie-bearing retry succeeds; only back off long if no
    // cookie was handed back.
    const backoff = session.cookie ? 3000 : RATE_LIMIT_BACKOFF_MS;
    logger.info('Trends explore 429 — retrying once', { term, backoff });
    await sleep(backoff);
    res = await googleGet(url, session);
  }
  if (!res.ok) {
    throw new Error(`Trends explore failed (${res.status}) for "${term}"`);
  }

  const body = parseGoogleJson(await res.text());
  const widgets = Array.isArray(body.widgets) ? body.widgets : [];
  const timeseries = widgets.find((w) => w.id === 'TIMESERIES');
  if (!timeseries || !timeseries.token || !timeseries.request) {
    throw new Error(`Trends explore returned no TIMESERIES widget for "${term}"`);
  }
  return timeseries;
}

async function fetchTimeline(widget, session) {
  const url =
    'https://trends.google.com/trends/api/widgetdata/multiline?hl=' +
    HL +
    '&tz=' +
    TZ +
    '&req=' +
    encodeURIComponent(JSON.stringify(widget.request)) +
    '&token=' +
    encodeURIComponent(widget.token);

  let res = await googleGet(url, session);
  if (res.status === 429) {
    logger.info('Trends multiline 429 — backing off and retrying once');
    await sleep(RATE_LIMIT_BACKOFF_MS);
    res = await googleGet(url, session);
  }
  if (!res.ok) {
    throw new Error(`Trends multiline failed (${res.status})`);
  }

  const body = parseGoogleJson(await res.text());
  const points =
    body.default && Array.isArray(body.default.timelineData)
      ? body.default.timelineData
      : [];
  return points;
}

function timelinePointToRow(point, { term, termType, entityId }) {
  // point.time is unix seconds; formattedTime/formattedAxisTime also present.
  const timeSec = Number(point.time);
  if (!Number.isFinite(timeSec)) return null;
  const date = new Date(timeSec * 1000).toISOString().split('T')[0];

  const value =
    Array.isArray(point.value) && Number.isFinite(Number(point.value[0]))
      ? Number(point.value[0])
      : null;

  return {
    term,
    term_type: termType,
    entity_id: entityId || null,
    date,
    interest_index: value,
    raw_json: point,
  };
}

async function resolveCompetitorTerms() {
  const { data, error } = await supabase
    .from('monitored_entities')
    .select('id, name')
    .eq('is_self', false)
    .eq('active', true);

  if (error) {
    throw new Error(`Failed to load competitor entities: ${error.message}`);
  }
  return (data || [])
    .filter((row) => row.name && String(row.name).trim())
    .map((row) => ({
      term: String(row.name).trim(),
      termType: 'competitor',
      entityId: row.id,
    }));
}

/**
 * Human-confirmed terms from the coverage-suggestions triage
 * (confirmed_search_terms, decision='monitor_trends'). Resolved fresh each
 * run, same as competitors. Best-effort: if the table doesn't exist yet
 * (migration not applied), the collector keeps working with the base lists.
 */
async function resolveConfirmedTerms() {
  const { data, error } = await supabase
    .from('confirmed_search_terms')
    .select('term')
    .eq('decision', 'monitor_trends');

  if (error) {
    logger.warn('Failed to load confirmed_search_terms — continuing without them', {
      error: error.message,
    });
    return [];
  }
  return (data || [])
    .filter((row) => row.term && String(row.term).trim())
    .map((row) => ({
      term: String(row.term).trim(),
      termType: 'generic',
      entityId: null,
    }));
}

async function upsertRows(rows) {
  if (!rows.length) return 0;
  const { error } = await supabase
    .from('search_trends')
    .upsert(rows, { onConflict: 'term,date' });
  if (error) {
    throw new Error(`Failed to upsert search_trends: ${error.message}`);
  }
  return rows.length;
}

/**
 * Sequential run over generic + dynamic competitor terms.
 * Per-term failures are logged and collected; the run continues.
 */
async function collectSearchTrends() {
  const competitorTerms = await resolveCompetitorTerms();
  const confirmedTerms = await resolveConfirmedTerms();

  // Union of: 3 original generic terms + confirmed monitor_trends terms +
  // dynamic competitors — deduplicated case-insensitively (first wins).
  const seen = new Set();
  const terms = [];
  for (const t of [
    ...GENERIC_TERMS.map((term) => ({ term, termType: 'generic', entityId: null })),
    ...confirmedTerms,
    ...competitorTerms,
  ]) {
    const key = t.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }

  logger.info('Search trends collect started', {
    totalTerms: terms.length,
    generic: GENERIC_TERMS.length,
    confirmed: confirmedTerms.length,
    competitors: competitorTerms.length,
    geo: GEO,
    timeframe: TIMEFRAME,
  });

  const session = createSession();
  const succeeded = [];
  const failed = [];
  let rowsUpserted = 0;

  for (let i = 0; i < terms.length; i += 1) {
    const t = terms[i];
    if (i > 0) await sleep(INTER_TERM_DELAY_MS);

    try {
      const widget = await exploreTerm(t.term, session);
      await sleep(1000);
      const points = await fetchTimeline(widget, session);
      const rows = points
        .map((p) => timelinePointToRow(p, t))
        .filter(Boolean);
      const inserted = await upsertRows(rows);
      rowsUpserted += inserted;
      succeeded.push({ term: t.term, points: rows.length });
      logger.info('Trends term collected', {
        term: t.term,
        termType: t.termType,
        points: rows.length,
      });
    } catch (err) {
      const message = err && err.message ? err.message : 'unknown';
      failed.push({ term: t.term, error: message });
      logger.error('Trends term failed — continuing with remaining terms', {
        term: t.term,
        termType: t.termType,
        error: message,
      });
    }
  }

  const summary = {
    totalTerms: terms.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    rowsUpserted,
    succeeded,
    failed,
    geo: GEO,
    timeframe: TIMEFRAME,
  };

  logger.info('Search trends collect finished', {
    totalTerms: summary.totalTerms,
    succeededCount: summary.succeededCount,
    failedCount: summary.failedCount,
    rowsUpserted,
  });

  return summary;
}

module.exports = {
  collectSearchTrends,
  resolveCompetitorTerms,
  GENERIC_TERMS,
  GEO,
  TIMEFRAME,
};
