const { randomUUID } = require('crypto');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { todayUtc, shiftDateUtc } = require('../activity/dates');

/**
 * GA4 Data API capture (capture-only): pulls yesterday's (closed day, same
 * reporting-date philosophy as collectOwnMetrics) sessions / totalUsers /
 * keyEvents broken down by sessionDefaultChannelGroup +
 * landingPagePlusQueryString, and upserts into ga4_metrics.
 *
 * NOT wired into metaBranch or any brief/analysis logic — manual/standalone
 * trigger only (/jobs/run-ga4-metrics).
 *
 * Auth: GA4_SERVICE_ACCOUNT_JSON (full service-account JSON as a string) +
 * GA4_PROPERTY_ID. The parsed credentials object and private_key are NEVER
 * logged or persisted anywhere.
 */

const METRICS = ['sessions', 'totalUsers', 'keyEvents'];
const DIMENSIONS = ['sessionDefaultChannelGroup', 'landingPagePlusQueryString'];
const PAGE_SIZE = 10000;
const MAX_PAGES = 20;

// GA4 renders unset dimension values in a few localized/legacy spellings;
// normalize all of them (plus empty strings) to the canonical '(not set)'
// so the (date, channel_group, landing_page) idempotency key stays stable.
const UNSET_VALUES = new Set(['', '(not set)', '(none)', '(not provided)']);

function normalizeDimensionValue(value) {
  const str = value === null || value === undefined ? '' : String(value).trim();
  return UNSET_VALUES.has(str) ? '(not set)' : str;
}

function getPropertyId() {
  const id = String(process.env.GA4_PROPERTY_ID || '').trim();
  if (!id) {
    throw new Error('GA4_PROPERTY_ID is not configured');
  }
  return id;
}

function buildGa4Client() {
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

  return new BetaAnalyticsDataClient({ credentials });
}

/** Previous closed reporting day — same UTC helpers as the rest of MIE. */
function resolvePreviousClosedReportingDay() {
  return shiftDateUtc(todayUtc(), -1);
}

/**
 * Zero vs null discipline (same principle as CTR/CPC elsewhere): a metric
 * cell present with an explicit value — including "0" — is a real
 * measurement and stores as a number. Only a genuinely absent/empty cell
 * (e.g. GA4 omitted the metric for that row) stores as null.
 */
function metricCellToNumber(metricValues, index) {
  const cell = Array.isArray(metricValues) ? metricValues[index] : undefined;
  if (!cell || cell.value === undefined || cell.value === null || cell.value === '') {
    return null;
  }
  const n = Number(cell.value);
  return Number.isFinite(n) ? n : null;
}

function mapResponseRows(response, reportingDate) {
  const metricIndex = {};
  (response.metricHeaders || []).forEach((h, i) => {
    metricIndex[h.name] = i;
  });
  const dimensionIndex = {};
  (response.dimensionHeaders || []).forEach((h, i) => {
    dimensionIndex[h.name] = i;
  });

  return (response.rows || []).map((row) => {
    const dims = row.dimensionValues || [];
    const mets = row.metricValues || [];
    const channelGroup = normalizeDimensionValue(
      dims[dimensionIndex.sessionDefaultChannelGroup]
        ? dims[dimensionIndex.sessionDefaultChannelGroup].value
        : '',
    );
    const landingPage = normalizeDimensionValue(
      dims[dimensionIndex.landingPagePlusQueryString]
        ? dims[dimensionIndex.landingPagePlusQueryString].value
        : '',
    );

    const toNumber = (name) =>
      metricIndex[name] === undefined ? null : metricCellToNumber(mets, metricIndex[name]);

    const sessions = toNumber('sessions');
    const totalUsers = toNumber('totalUsers');

    return {
      date: reportingDate,
      channel_group: channelGroup,
      landing_page: landingPage,
      sessions: sessions === null ? null : Math.trunc(sessions),
      total_users: totalUsers === null ? null : Math.trunc(totalUsers),
      key_events: toNumber('keyEvents'),
      raw_json: {
        dimensionValues: dims.map((d) => d.value),
        metricValues: mets.map((m) => m.value),
      },
    };
  });
}

function quotaSummary(propertyQuota) {
  if (!propertyQuota) return null;
  const pick = (q) => (q ? { consumed: q.consumed, remaining: q.remaining } : null);
  return {
    tokensPerDay: pick(propertyQuota.tokensPerDay),
    tokensPerHour: pick(propertyQuota.tokensPerHour),
    concurrentRequests: pick(propertyQuota.concurrentRequests),
    serverErrorsPerProjectPerHour: pick(propertyQuota.serverErrorsPerProjectPerHour),
    potentiallyThresholdedRequestsPerHour: pick(
      propertyQuota.potentiallyThresholdedRequestsPerHour,
    ),
  };
}

async function fetchAllRows(client, property, reportingDate) {
  const allRows = [];
  let offset = 0;
  let page = 0;
  let lastQuota = null;
  let totalRowCount = 0;

  while (true) {
    page += 1;
    if (page > MAX_PAGES) {
      throw new Error(`GA4 runReport pagination exceeded max pages (${MAX_PAGES})`);
    }

    const [response] = await client.runReport({
      property,
      dateRanges: [{ startDate: reportingDate, endDate: reportingDate }],
      dimensions: DIMENSIONS.map((name) => ({ name })),
      metrics: METRICS.map((name) => ({ name })),
      limit: PAGE_SIZE,
      offset,
      returnPropertyQuota: true,
    });

    allRows.push(...mapResponseRows(response, reportingDate));
    lastQuota = quotaSummary(response.propertyQuota);
    totalRowCount = Number(response.rowCount || 0);

    logger.info('GA4 runReport page processed', {
      page,
      pageRows: (response.rows || []).length,
      totalRowCount,
      quota: lastQuota,
    });

    offset += PAGE_SIZE;
    if (allRows.length >= totalRowCount || (response.rows || []).length === 0) {
      break;
    }
  }

  return { rows: allRows, totalRowCount, quota: lastQuota };
}

async function insertRun({ runId, reportingDate }) {
  const startedAt = new Date().toISOString();
  const { error } = await supabase.from('ga4_metric_runs').insert({
    run_id: runId,
    reporting_date: reportingDate,
    started_at: startedAt,
    status: 'running',
  });
  if (error) {
    throw new Error(`Failed to insert ga4_metric_runs: ${error.message}`);
  }
  return startedAt;
}

async function finishRun({ runId, status, rowsCount, errorMessage, rawJson }) {
  const payload = {
    finished_at: new Date().toISOString(),
    status,
    rows_count: rowsCount ?? null,
    error_message: errorMessage || null,
  };
  if (rawJson !== undefined) {
    payload.raw_json = rawJson;
  }
  const { error } = await supabase
    .from('ga4_metric_runs')
    .update(payload)
    .eq('run_id', runId);
  if (error) {
    logger.error('Failed to update ga4_metric_runs', { runId, error: error.message });
  }
}

async function collectGa4Metrics() {
  const propertyId = getPropertyId();
  const client = buildGa4Client();
  const property = `properties/${propertyId}`;
  const reportingDate = resolvePreviousClosedReportingDay();
  const runId = randomUUID();

  logger.info('GA4 metrics collect started', { runId, propertyId, reportingDate });
  await insertRun({ runId, reportingDate });

  try {
    const { rows, totalRowCount, quota } = await fetchAllRows(client, property, reportingDate);

    let upserted = 0;
    if (rows.length) {
      const { error } = await supabase
        .from('ga4_metrics')
        .upsert(rows, { onConflict: 'date,channel_group,landing_page' });
      if (error) {
        throw new Error(`Failed to upsert ga4_metrics: ${error.message}`);
      }
      upserted = rows.length;
    }

    await finishRun({
      runId,
      status: 'success',
      rowsCount: upserted,
      rawJson: { reportingDate, apiRowCount: totalRowCount, propertyQuota: quota },
    });

    const summary = {
      status: 'ga4_metrics_complete',
      runId,
      reportingDate,
      apiRowCount: totalRowCount,
      rowsUpserted: upserted,
      propertyQuota: quota,
    };
    logger.info('GA4 metrics collect finished', summary);
    return summary;
  } catch (err) {
    const message = err && err.message ? err.message : 'unknown';
    await finishRun({
      runId,
      status: 'failed',
      errorMessage: message,
      rawJson: { reportingDate },
    });
    logger.error('GA4 metrics collect failed', { runId, reportingDate, error: message });
    throw err;
  }
}

/**
 * Read-only diagnostic (Phase 1 audit): validates the exact dimensions +
 * metrics against the REAL property via getMetadata + checkCompatibility,
 * and issues one tiny runReport with returnPropertyQuota to report actual
 * quota consumption. Touches no tables.
 */
async function runGa4Audit(options = {}) {
  const propertyId = getPropertyId();
  const client = buildGa4Client();
  const property = `properties/${propertyId}`;

  const [metadata] = await client.getMetadata({ name: `${property}/metadata` });
  const findMetric = (name) => (metadata.metrics || []).find((m) => m.apiName === name);
  const findDimension = (name) =>
    (metadata.dimensions || []).find((d) => d.apiName === name);

  const metadataCheck = {};
  for (const name of METRICS) {
    const m = findMetric(name);
    metadataCheck[name] = m
      ? { found: true, uiName: m.uiName, deprecatedApiNames: m.deprecatedApiNames || [] }
      : { found: false };
  }
  for (const name of DIMENSIONS) {
    const d = findDimension(name);
    metadataCheck[name] = d ? { found: true, uiName: d.uiName } : { found: false };
  }

  const [compat] = await client.checkCompatibility({
    property,
    dimensions: DIMENSIONS.map((name) => ({ name })),
    metrics: METRICS.map((name) => ({ name })),
    compatibilityFilter: 'INCOMPATIBLE',
  });

  // Optional date override for diagnosis (e.g. GA4 processing-latency checks).
  const yesterday = resolvePreviousClosedReportingDay();
  const startDate = options.startDate || yesterday;
  const endDate = options.endDate || yesterday;
  const [testReport] = await client.runReport({
    property,
    dateRanges: [{ startDate, endDate }],
    dimensions: DIMENSIONS.map((name) => ({ name })),
    metrics: METRICS.map((name) => ({ name })),
    limit: 20,
    returnPropertyQuota: true,
  });

  return {
    propertyId,
    metadataCheck,
    incompatibleDimensions: (compat.dimensionCompatibilities || []).map(
      (d) => d.dimensionMetadata && d.dimensionMetadata.apiName,
    ),
    incompatibleMetrics: (compat.metricCompatibilities || []).map(
      (m) => m.metricMetadata && m.metricMetadata.apiName,
    ),
    testReport: {
      reportingDate: `${startDate}..${endDate}`,
      rowCount: Number(testReport.rowCount || 0),
      sampleRows: mapResponseRows(testReport, startDate).map(
        ({ raw_json, ...rest }) => rest,
      ),
      propertyQuota: quotaSummary(testReport.propertyQuota),
    },
  };
}

module.exports = {
  collectGa4Metrics,
  runGa4Audit,
  resolvePreviousClosedReportingDay,
  normalizeDimensionValue,
  metricCellToNumber,
  mapResponseRows,
};
