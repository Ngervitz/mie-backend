const { google } = require('googleapis');
const logger = require('../lib/logger');
const { todayUtc, shiftDateUtc } = require('../activity/dates');

/**
 * Google Search Console capture (capture-only).
 *
 * Auth: reuses the EXISTING GA4_SERVICE_ACCOUNT_JSON credential (same service
 * account mie-ga4-reader@..., added to Search Console with Restricted read
 * access). No duplicate credential/env var. Same private_key \n normalization
 * as collectGa4Metrics. The parsed credentials are never logged or persisted.
 *
 * Phase 1 (this file initially): runSearchConsoleAudit() — a read-only
 * diagnostic that answers the 6 audit questions against the real property
 * (sites.list, latency discovery, response shape, pagination behavior).
 * Touches no tables.
 */

const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const AUDIT_DIMENSIONS = ['date', 'query', 'page', 'country', 'device'];

function buildAuth() {
  const rawJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is not configured');
  }
  let credentials;
  try {
    credentials = JSON.parse(rawJson);
  } catch (err) {
    // Never include the raw value in the error — it contains the private key.
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is missing client_email/private_key');
  }
  // Railway commonly stores literal \n sequences instead of real newlines.
  credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');

  // Current documented googleapis pattern for service-account credentials
  // with explicit scopes (google.auth.fromJSON exists but does not take
  // scopes for JWT clients in this flow; GoogleAuth({credentials, scopes})
  // is the standard supported path in googleapis v173).
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [SEARCH_CONSOLE_SCOPE],
  });
}

function buildClient() {
  return google.searchconsole({ version: 'v1', auth: buildAuth() });
}

/**
 * Read-only Phase 1 audit. Answers, with real API responses:
 *  2. exact siteUrl + permissionLevel via sites.list
 *  3. real data latency via a date-dimension query over the last 10 days
 *  4. real row/field shape with all 5 dimensions
 *  5. real pagination behavior (rowLimit/startRow, stop condition)
 */
async function runSearchConsoleAudit() {
  const searchconsole = buildClient();

  // --- 2. sites.list: exact siteUrl + access confirmation ---
  const sitesRes = await searchconsole.sites.list({});
  const sites = (sitesRes.data && sitesRes.data.siteEntry) || [];
  const siteUrl = sites.length ? sites[0].siteUrl : null;

  const audit = {
    sitesList: sites,
    confirmedSiteUrl: siteUrl,
  };

  if (!siteUrl) {
    return { ...audit, error: 'sites.list returned no accessible properties' };
  }

  // --- 3. latency discovery: date-only query, last 10 days ---
  const today = todayUtc();
  const latencyRes = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: shiftDateUtc(today, -10),
      endDate: today,
      dimensions: ['date'],
      rowLimit: 25,
    },
  });
  const latencyRows = (latencyRes.data && latencyRes.data.rows) || [];
  const datesWithData = latencyRows.map((r) => r.keys[0]).sort();
  const latestDateWithData = datesWithData.length
    ? datesWithData[datesWithData.length - 1]
    : null;
  audit.latency = {
    queriedRange: { startDate: shiftDateUtc(today, -10), endDate: today },
    datesReturned: latencyRows.map((r) => ({
      date: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
    })),
    latestDateWithData,
    lagDaysBehindToday: latestDateWithData
      ? Math.round(
          (Date.parse(today) - Date.parse(latestDateWithData)) / 86400000,
        )
      : null,
    responseAggregationType: latencyRes.data ? latencyRes.data.responseAggregationType : null,
  };

  if (!latestDateWithData) {
    return { ...audit, note: 'No data in the last 10 days; shape/pagination checks skipped' };
  }

  // --- 4. real field shape with all 5 dimensions ---
  const shapeRes = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: latestDateWithData,
      endDate: latestDateWithData,
      dimensions: AUDIT_DIMENSIONS,
      rowLimit: 10,
    },
  });
  const shapeRows = (shapeRes.data && shapeRes.data.rows) || [];
  audit.shape = {
    reportingDate: latestDateWithData,
    requestedDimensions: AUDIT_DIMENSIONS,
    topLevelResponseKeys: Object.keys(shapeRes.data || {}),
    rowFieldNames: shapeRows.length ? Object.keys(shapeRows[0]) : [],
    keysLengthPerRow: shapeRows.map((r) => (Array.isArray(r.keys) ? r.keys.length : null)),
    anyRowMissingKeys: shapeRows.some(
      (r) => !Array.isArray(r.keys) || r.keys.length !== AUDIT_DIMENSIONS.length,
    ),
    sampleRows: shapeRows.slice(0, 5),
    rowCount: shapeRows.length,
  };

  // --- 5. pagination behavior: tiny rowLimit + startRow walk ---
  const pages = [];
  let startRow = 0;
  const PAGE = 5;
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const pageRes = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: latestDateWithData,
        endDate: latestDateWithData,
        dimensions: AUDIT_DIMENSIONS,
        rowLimit: PAGE,
        startRow,
      },
    });
    const rows = (pageRes.data && pageRes.data.rows) || [];
    pages.push({
      startRow,
      rowLimit: PAGE,
      rowsReturned: rows.length,
      rowsFieldPresent: Object.prototype.hasOwnProperty.call(pageRes.data || {}, 'rows'),
      firstKey: rows.length ? rows[0].keys : null,
    });
    if (!rows.length) break;
    startRow += rows.length;
  }
  audit.pagination = {
    pageWalk: pages,
    stopCondition: 'rows absent/empty => end of result set; startRow += rows.length per page',
    documentedMaxRowLimit: 25000,
  };

  // --- 6. quota (documented; API has no per-response quota object) ---
  audit.quota = {
    perSiteQueryLoad: '1,200 QPM per site / 40,000 QPD (documented Search Console API limits)',
    note:
      'searchanalytics.query returns no quota object in responses (unlike GA4 propertyQuota). ' +
      'A single daily pull with pagination consumes a handful of queries per day — far below limits.',
  };

  logger.info('Search Console audit completed', {
    siteUrl,
    latestDateWithData,
    shapeRowCount: audit.shape.rowCount,
  });
  return audit;
}

module.exports = {
  runSearchConsoleAudit,
};
