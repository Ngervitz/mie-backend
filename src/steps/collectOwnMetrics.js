const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const env = require('../config/env');
const logger = require('../lib/logger');
const { shiftDateUtc } = require('../activity/dates');

const SOURCE = 'meta_marketing_api';
const MAX_PAGES = 100;
const ACCOUNT_TIME_ZONE = 'America/Montevideo';
/**
 * Lead ad sets optimize OFFSITE_CONVERSIONS for pixel custom event form_step_3
 * (pixel 1966482200899899). Insights reports that result on `conversions`, not as
 * the standard `lead` action and not as the aggregate `offsite_conversion.fb_pixel_custom`.
 * The account has no custom conversion id.
 */
const META_CPL_ACTION_TYPE = 'offsite_conversion.fb_pixel_custom.form_step_3';
const UPSERT_CONFLICT = 'entity_id,campaign_id,metric_date';

// Ayer y hoy en la zona de la cuenta. El día en curso se actualiza; el anterior
// sigue abierto a ajustes de atribución. time_increment=1 evita mezclarlos.

function parseFloatOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

/** Calendar date in the ad account timezone. `now` is injectable for tests. */
function calendarDateInZone(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Yesterday and today in America/Montevideo.
 * At 01:30Z the UTC date is already the next day, while Uruguay is still on the previous one.
 */
function resolveMontevideoReportingRange(now = new Date()) {
  const today = calendarDateInZone(ACCOUNT_TIME_ZONE, now);
  return { since: shiftDateUtc(today, -1), until: today };
}

/** Exact action_type match. A shorter prefix such as fb_pixel_custom does not match. */
function countExactActionType(list, actionType) {
  if (!Array.isArray(list)) return null;
  const hit = list.find((action) => action && action.action_type === actionType);
  if (!hit) return null;
  return parseFloatOrNull(hit.value);
}

/**
 * Application Success for these campaigns is form_step_3.
 * Prefer the conversions array. Do not add the actions array on top.
 * Null when that exact type is absent.
 */
function metaApplicationSuccessCount(row) {
  if (!row || typeof row !== 'object') return null;
  const fromConversions = countExactActionType(row.conversions, META_CPL_ACTION_TYPE);
  if (fromConversions !== null) return fromConversions;
  return countExactActionType(row.actions, META_CPL_ACTION_TYPE);
}

function metaApplicationSuccessValue(row) {
  if (!row || typeof row !== 'object') return null;
  const fromConversionValues = countExactActionType(
    row.conversion_values,
    META_CPL_ACTION_TYPE,
  );
  if (fromConversionValues !== null) return fromConversionValues;
  return countExactActionType(row.action_values, META_CPL_ACTION_TYPE);
}

function buildSuccessRawJson({
  reportingDate,
  reportingRange,
  campaignsFound,
  metricsInserted,
}) {
  return {
    reportingDate,
    reportingRange: {
      since: reportingRange.since,
      until: reportingRange.until,
    },
    campaignsFound,
    metricsInserted,
    noCampaignsFound: campaignsFound === 0,
  };
}

/**
 * Defensive failure payload: never throw while serializing; preserve diagnostics;
 * always enrich with reportingDate/reportingRange when available.
 */
function buildFailureRawJson(err, reportingDate, reportingRange) {
  const base = {
    reportingDate: reportingDate || null,
    reportingRange: reportingRange
      ? { since: reportingRange.since, until: reportingRange.until }
      : null,
  };

  try {
    const payload = {
      ...base,
      message: err && err.message != null ? String(err.message) : 'unknown',
    };

    if (err && err.metaBody !== undefined) {
      try {
        JSON.stringify(err.metaBody);
        payload.metaError = err.metaBody;
      } catch (serErr) {
        payload.error_raw = String(err.metaBody);
      }
    }

    JSON.stringify(payload);
    return payload;
  } catch (outerErr) {
    return {
      ...base,
      error_raw:
        err && err.message != null
          ? String(err.message)
          : String(err),
    };
  }
}

async function resolveSelfEntityId() {
  const { data, error } = await supabase
    .from('monitored_entities')
    .select('id, name')
    .eq('is_self', true)
    .limit(1);

  if (error) {
    throw new Error(`Failed to load self entity: ${error.message}`);
  }
  if (!data || !data.length || !data[0].id) {
    throw new Error('No monitored_entities row with is_self=true');
  }
  return { entityId: data[0].id, entityName: data[0].name };
}

async function insertRun({ runId, entityId }) {
  const startedAt = new Date().toISOString();
  const { error } = await supabase.from('own_ad_metric_runs').insert({
    run_id: runId,
    entity_id: entityId,
    source: SOURCE,
    started_at: startedAt,
    status: 'running',
  });
  if (error) {
    throw new Error(`Failed to insert own_ad_metric_runs: ${error.message}`);
  }
  return startedAt;
}

async function finishRun({ runId, status, rawJson }) {
  const finishedAt = new Date().toISOString();
  const payload = {
    finished_at: finishedAt,
    status,
  };
  if (rawJson !== undefined) {
    payload.raw_json = rawJson;
  }
  const { error } = await supabase
    .from('own_ad_metric_runs')
    .update(payload)
    .eq('run_id', runId);
  if (error) {
    throw new Error(`Failed to update own_ad_metric_runs: ${error.message}`);
  }
  return finishedAt;
}

function buildInsightsUrl({ version, adAccountId, reportingRange, after }) {
  const params = new URLSearchParams({
    level: 'campaign',
    fields: [
      'campaign_id',
      'campaign_name',
      'spend',
      'impressions',
      'clicks',
      'actions',
      'action_values',
      'conversions',
      'conversion_values',
      'frequency',
      'reach',
      'quality_ranking',
      'engagement_rate_ranking',
      'conversion_rate_ranking',
      'date_start',
    ].join(','),
    time_increment: '1',
    time_range: JSON.stringify({
      since: reportingRange.since,
      until: reportingRange.until,
    }),
    limit: '100',
  });
  if (after) {
    params.set('after', after);
  }
  return `https://graph.facebook.com/${version}/${adAccountId}/insights?${params.toString()}`;
}

/**
 * Fetch one Insights page. Token goes in Authorization header so paging.next
 * is less likely to embed access_token; we still never log/persist next URLs.
 */
async function fetchInsightsPage({ url, accessToken, pageNumber }) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`Meta Insights page ${pageNumber}: invalid JSON (${res.status})`);
  }

  if (!res.ok) {
    const msg =
      (body && body.error && body.error.message) ||
      `HTTP ${res.status}`;
    const err = new Error(`Meta Insights page ${pageNumber} failed: ${msg}`);
    err.metaBody = body;
    throw err;
  }

  return body;
}

async function fetchAllCampaignRows({
  version,
  adAccountId,
  accessToken,
  reportingRange,
}) {
  const rows = [];
  const seenCursors = new Set();
  let after = null;
  let pageNumber = 0;

  while (true) {
    pageNumber += 1;
    if (pageNumber > MAX_PAGES) {
      throw new Error(`Meta Insights pagination exceeded max pages (${MAX_PAGES})`);
    }

    const url = buildInsightsUrl({
      version,
      adAccountId,
      reportingRange,
      after,
    });
    const body = await fetchInsightsPage({ url, accessToken, pageNumber });
    const pageRows = Array.isArray(body.data) ? body.data : [];
    rows.push(...pageRows);

    logger.info('Meta Insights page processed', {
      pageNumber,
      recordsProcessed: pageRows.length,
      totalRecords: rows.length,
    });

    const next = body.paging && body.paging.next;
    if (!next) {
      break;
    }

    const cursor =
      body.paging &&
      body.paging.cursors &&
      body.paging.cursors.after
        ? String(body.paging.cursors.after)
        : null;

    if (!cursor) {
      throw new Error(
        `Meta Insights page ${pageNumber}: paging.next present without cursors.after`,
      );
    }
    if (seenCursors.has(cursor)) {
      throw new Error(
        `Meta Insights page ${pageNumber}: repeated pagination cursor detected`,
      );
    }
    seenCursors.add(cursor);
    after = cursor;
  }

  return rows;
}

function mapRowToMetric({ row, entityId, runId }) {
  // `actions` stores only form_step_3. The original actions and conversions stay in raw_json.
  return {
    entity_id: entityId,
    run_id: runId,
    campaign_id: row.campaign_id != null ? String(row.campaign_id) : null,
    campaign_name: row.campaign_name != null ? String(row.campaign_name) : null,
    metric_date: row.date_start != null ? String(row.date_start) : null,
    spend: parseFloatOrNull(row.spend),
    impressions: parseIntOrNull(row.impressions),
    clicks: parseIntOrNull(row.clicks),
    frequency: parseFloatOrNull(row.frequency),
    actions: metaApplicationSuccessCount(row),
    actions_value: metaApplicationSuccessValue(row),
    raw_json: row,
  };
}

/** Last row wins for the same entity, campaign and date inside one Meta response. */
function collapseMetricRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = [row.entity_id, row.campaign_id, row.metric_date].join('\u0000');
    byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

async function upsertMetrics(rows) {
  const deduped = collapseMetricRows(rows);
  if (!deduped.length) return { upserted: 0 };
  const { error } = await supabase.from('own_ad_metrics').upsert(deduped, {
    onConflict: UPSERT_CONFLICT,
  });
  if (error) {
    throw new Error(`Failed to upsert own_ad_metrics: ${error.message}`);
  }
  return { upserted: deduped.length };
}

/**
 * Collect prior-day Meta Marketing insights for Credizona (is_self).
 * Optional overrides support isolated auth-failure tests without changing Railway secrets.
 *
 * @param {{ accessToken?: string, adAccountId?: string, apiVersion?: string }} [options]
 */
async function collectOwnMetrics(options = {}) {
  const accessToken = options.accessToken || env.metaMarketingApiToken;
  const adAccountId = options.adAccountId || env.metaAdAccountId;
  const apiVersion = options.apiVersion || env.metaMarketingApiVersion || 'v25.0';

  if (!accessToken) {
    throw new Error('META_MARKETING_API_TOKEN is not configured');
  }
  if (!adAccountId) {
    throw new Error('META_AD_ACCOUNT_ID is not configured');
  }

  const reportingRange = resolveMontevideoReportingRange();
  const reportingDate = reportingRange.until;

  const { entityId, entityName } = await resolveSelfEntityId();
  const runId = randomUUID();

  logger.info('Meta own-metrics collect started', {
    runId,
    entityId,
    entityName,
    apiVersion,
    reportingDate,
    reportingRange,
    timeZone: ACCOUNT_TIME_ZONE,
    note: 'Yesterday and today in America/Montevideo, one row per campaign and date.',
  });

  await insertRun({ runId, entityId });

  try {
    const campaignRows = await fetchAllCampaignRows({
      version: apiVersion,
      adAccountId,
      accessToken,
      reportingRange,
    });

    if (!campaignRows.length) {
      logger.info('No campaigns found.', {
        runId,
        entityId,
        reportingDate,
      });
    }

    const metricRows = campaignRows.map((row) =>
      mapRowToMetric({ row, entityId, runId }));

    const { upserted } = await upsertMetrics(metricRows);
    const successRawJson = buildSuccessRawJson({
      reportingDate,
      reportingRange,
      campaignsFound: campaignRows.length,
      metricsInserted: upserted,
    });
    const finishedAt = await finishRun({
      runId,
      status: 'success',
      rawJson: successRawJson,
    });

    const summary = {
      status: 'meta_own_metrics_complete',
      runId,
      entityId,
      entityName,
      campaignsFound: campaignRows.length,
      rowsInserted: upserted,
      reportingDate,
      reportingRange,
      finishedAt,
      timeZone: ACCOUNT_TIME_ZONE,
    };

    logger.info('Meta own-metrics collect finished', {
      runId,
      campaignsFound: campaignRows.length,
      rowsInserted: upserted,
      reportingDate,
      status: 'success',
    });

    return summary;
  } catch (err) {
    const errorPayload = buildFailureRawJson(err, reportingDate, reportingRange);

    try {
      await finishRun({
        runId,
        status: 'failed',
        rawJson: errorPayload,
      });
    } catch (finishErr) {
      logger.error('Meta own-metrics failed to mark run failed', {
        runId,
        error: finishErr && finishErr.message ? finishErr.message : 'unknown',
      });
    }

    logger.error('Meta own-metrics collect failed', {
      runId,
      error: errorPayload.message || errorPayload.error_raw || 'unknown',
      reportingDate,
    });

    throw err;
  }
}

module.exports = {
  collectOwnMetrics,
  parseFloatOrNull,
  parseIntOrNull,
  mapRowToMetric,
  metaApplicationSuccessCount,
  countExactActionType,
  collapseMetricRows,
  upsertMetrics,
  resolveMontevideoReportingRange,
  calendarDateInZone,
  buildInsightsUrl,
  ACCOUNT_TIME_ZONE,
  META_CPL_ACTION_TYPE,
  UPSERT_CONFLICT,
  buildSuccessRawJson,
  buildFailureRawJson,
  MAX_PAGES,
};
