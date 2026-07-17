const logger = require('../lib/logger');

/**
 * Discovery tool: real "related queries" from Google Trends for a seed term.
 * Read-only — does NOT write to search_trends. Same unofficial endpoint
 * family as collectSearchTrends (explore → widget token), but the data
 * fetch goes to /widgetdata/relatedsearches instead of /multiline.
 *
 * Verified live: the explore response for a single keyword already includes
 * a RELATED_QUERIES widget (alongside TIMESERIES / GEO_MAP / RELATED_TOPICS),
 * so no different request pattern is needed for step 1. However, the
 * relatedsearches endpoint rate-limits MUCH harder than multiline (a probe
 * needed 4 attempts with escalating backoff before a 200), hence the longer
 * retry ladder here.
 */

const GEO = 'UY';
const TIMEFRAME = 'today 3-m';
const HL = 'es';
const TZ = 180;
// relatedsearches throttles much harder than multiline, and datacenter IPs
// (Railway) get hit harder than residential ones — observed in production:
// 3/4 seeds failed at a 5-attempt ceiling. This job is monthly and
// low-stakes, so patience beats speed: escalating backoff up to 10 attempts
// (~15.5 min worst case per seed).
const MAX_DATA_ATTEMPTS = 10;
const DATA_BACKOFF_SCHEDULE_MS = [
  15000, 30000, 45000, 60000, 90000, 120000, 150000, 180000, 210000,
];

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'es-419,es;q=0.9',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseGoogleJson(text) {
  const idx = String(text).indexOf('{');
  if (idx === -1) throw new Error('No JSON object in Google response');
  return JSON.parse(String(text).slice(idx));
}

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

async function exploreSeed(seed, session) {
  const req = {
    comparisonItem: [{ keyword: seed, geo: GEO, time: TIMEFRAME }],
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
    await sleep(session.cookie ? 3000 : 30000);
    res = await googleGet(url, session);
  }
  if (!res.ok) {
    throw new Error(`Trends explore failed (${res.status}) for seed "${seed}"`);
  }

  const body = parseGoogleJson(await res.text());
  const widget = (body.widgets || []).find((w) => w.id === 'RELATED_QUERIES');
  if (!widget || !widget.token || !widget.request) {
    throw new Error(`Trends explore returned no RELATED_QUERIES widget for seed "${seed}"`);
  }
  return widget;
}

async function fetchRelatedSearches(widget, session) {
  const url =
    'https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=' +
    HL +
    '&tz=' +
    TZ +
    '&req=' +
    encodeURIComponent(JSON.stringify(widget.request)) +
    '&token=' +
    encodeURIComponent(widget.token);

  for (let attempt = 1; attempt <= MAX_DATA_ATTEMPTS; attempt += 1) {
    const res = await googleGet(url, session);
    if (res.ok) return parseGoogleJson(await res.text());
    if (res.status !== 429) {
      throw new Error(`Trends relatedsearches failed (${res.status})`);
    }
    if (attempt === MAX_DATA_ATTEMPTS) {
      throw new Error(
        `Trends relatedsearches still throttled (429) after ${MAX_DATA_ATTEMPTS} attempts`
      );
    }
    const backoff =
      DATA_BACKOFF_SCHEDULE_MS[Math.min(attempt - 1, DATA_BACKOFF_SCHEDULE_MS.length - 1)];
    logger.info('Trends relatedsearches 429 — backing off', { attempt, backoff });
    await sleep(backoff);
  }
  throw new Error('unreachable');
}

function mapRankedList(list) {
  return ((list && list.rankedKeyword) || []).map((k) => ({
    query: k.query || null,
    value: Number.isFinite(Number(k.value)) ? Number(k.value) : null,
    formattedValue: k.formattedValue || null,
    link: k.link || null,
  }));
}

/**
 * Returns { seed, geo, timeframe, top: [...], rising: [...] }.
 * Google returns two ranked lists: index 0 = "top" (most common co-searched,
 * relative 0-100 scale), index 1 = "rising" (fastest-growing, value is a
 * growth percentage; "Breakout" terms come formatted as e.g. "+3.900 %").
 *
 * An optional pre-existing session can be passed so batch callers
 * (run-discovery-refresh) reuse the NID cookie established by earlier seeds
 * instead of re-triggering the fresh-session 429 on every seed.
 */
async function discoverRelatedQueries(seed, session = createSession()) {
  logger.info('Related queries discovery started', {
    seed,
    geo: GEO,
    timeframe: TIMEFRAME,
    reusedSession: Boolean(session.cookie),
  });

  const widget = await exploreSeed(seed, session);
  await sleep(1000);
  const body = await fetchRelatedSearches(widget, session);

  const lists = (body.default && body.default.rankedList) || [];
  const result = {
    seed,
    geo: GEO,
    timeframe: TIMEFRAME,
    top: mapRankedList(lists[0]),
    rising: mapRankedList(lists[1]),
  };

  logger.info('Related queries discovery finished', {
    seed,
    topCount: result.top.length,
    risingCount: result.rising.length,
  });

  return result;
}

module.exports = { discoverRelatedQueries, createSession };
