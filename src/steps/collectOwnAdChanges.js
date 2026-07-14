const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const env = require('../config/env');
const logger = require('../lib/logger');
const { todayUtc, shiftDateUtc } = require('../activity/dates');

const SOURCE = 'meta_marketing_api';
const MAX_PAGES = 100;

// Demonstrated AdActivity fields from Meta Business SDK
// (facebook_business/adobjects/adactivity.py — Field enum).
const ACTIVITY_FIELDS = [
  'event_time',
  'event_type',
  'object_id',
  'object_name',
  'object_type',
  'actor_id',
  'actor_name',
  'application_id',
  'application_name',
  'translated_event_type',
  'date_time_in_timezone',
  'extra_data',
].join(',');

/** Previous closed reporting day — same UTC helpers as collectOwnMetrics. */
function resolvePreviousClosedReportingDay() {
  return shiftDateUtc(todayUtc(), -1);
}

/** YYYY-MM-DD → Unix seconds at 00:00:00 UTC (Activities edge uses since/until). */
function dateOnlyToUnixStartUtc(dateStr) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

function buildSuccessRawJson({
  reportingDate,
  reportingRange,
  changesFound,
  eventsInserted,
}) {
  return {
    reportingDate,
    reportingRange: {
      since: reportingRange.since,
      until: reportingRange.until,
    },
    changesFound,
    eventsInserted,
    noChangesFound: changesFound === 0,
  };
}

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
        err && err.message != null ? String(err.message) : String(err),
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
  const { error } = await supabase.from('own_ad_change_runs').insert({
    run_id: runId,
    entity_id: entityId,
    source: SOURCE,
    started_at: startedAt,
    status: 'running',
  });
  if (error) {
    throw new Error(`Failed to insert own_ad_change_runs: ${error.message}`);
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
    .from('own_ad_change_runs')
    .update(payload)
    .eq('run_id', runId);
  if (error) {
    throw new Error(`Failed to update own_ad_change_runs: ${error.message}`);
  }
  return finishedAt;
}

function buildActivitiesUrl({
  version,
  adAccountId,
  reportingRange,
  after,
}) {
  // Ad Account /activities uses since/until (unix), not Insights time_range JSON.
  // reportingRange dates (YYYY-MM-DD) match collectOwnMetrics calendar convention;
  // API window is [startOf(since), startOf(until+1)) in UTC.
  const sinceUnix = dateOnlyToUnixStartUtc(reportingRange.since);
  const untilUnix = dateOnlyToUnixStartUtc(
    shiftDateUtc(reportingRange.until, 1),
  );

  const params = new URLSearchParams({
    fields: ACTIVITY_FIELDS,
    since: String(sinceUnix),
    until: String(untilUnix),
    limit: '100',
  });
  if (after) {
    params.set('after', after);
  }
  return `https://graph.facebook.com/${version}/${adAccountId}/activities?${params.toString()}`;
}

async function fetchActivitiesPage({ url, accessToken, pageNumber }) {
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
    throw new Error(
      `Meta Activities page ${pageNumber}: invalid JSON (${res.status})`,
    );
  }

  if (!res.ok) {
    const msg =
      (body && body.error && body.error.message) || `HTTP ${res.status}`;
    const err = new Error(
      `Meta Activities page ${pageNumber} failed: ${msg}`,
    );
    err.metaBody = body;
    throw err;
  }

  return body;
}

/**
 * Option A: fetch every page into memory first.
 * Insert only after pagination completes successfully (atomic run guarantee).
 */
async function fetchAllActivityRows({
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
      throw new Error(
        `Meta Activities pagination exceeded max pages (${MAX_PAGES})`,
      );
    }

    const url = buildActivitiesUrl({
      version,
      adAccountId,
      reportingRange,
      after,
    });
    const body = await fetchActivitiesPage({ url, accessToken, pageNumber });
    const pageRows = Array.isArray(body.data) ? body.data : [];
    rows.push(...pageRows);

    // Never log paging.next (may embed access_token).
    logger.info('Meta Activities page processed', {
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
        `Meta Activities page ${pageNumber}: paging.next present without cursors.after`,
      );
    }
    if (seenCursors.has(cursor)) {
      throw new Error(
        `Meta Activities page ${pageNumber}: repeated pagination cursor detected`,
      );
    }
    seenCursors.add(cursor);
    after = cursor;
  }

  return rows;
}

/** Meta AdActivity.event_time is unix seconds; store as timestamptz ISO. */
function normalizeEventTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  const asString = String(value).trim();
  if (/^\d+$/.test(asString)) {
    return new Date(Number(asString) * 1000).toISOString();
  }
  const parsed = Date.parse(asString);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return null;
}

function mapRowToChange({ row, entityId, runId }) {
  // Deduplication intentionally deferred until real production payloads are available.
  // Technical PK only; full API row persisted in raw_json.
  return {
    run_id: runId,
    entity_id: entityId,
    event_time: normalizeEventTime(row.event_time),
    event_type: row.event_type != null ? String(row.event_type) : null,
    object_id: row.object_id != null ? String(row.object_id) : null,
    object_name: row.object_name != null ? String(row.object_name) : null,
    object_type: row.object_type != null ? String(row.object_type) : null,
    actor_id: row.actor_id != null ? String(row.actor_id) : null,
    actor_name: row.actor_name != null ? String(row.actor_name) : null,
    application_id:
      row.application_id != null ? String(row.application_id) : null,
    application_name:
      row.application_name != null ? String(row.application_name) : null,
    translated_event_type:
      row.translated_event_type != null
        ? String(row.translated_event_type)
        : null,
    date_time_in_timezone:
      row.date_time_in_timezone != null
        ? String(row.date_time_in_timezone)
        : null,
    extra_data:
      row.extra_data != null
        ? typeof row.extra_data === 'string'
          ? row.extra_data
          : JSON.stringify(row.extra_data)
        : null,
    raw_json: row,
    created_at: new Date().toISOString(),
  };
}

async function insertChanges(rows) {
  if (!rows.length) return { inserted: 0 };
  const { error } = await supabase.from('own_ad_changes').insert(rows);
  if (error) {
    throw new Error(`Failed to insert own_ad_changes: ${error.message}`);
  }
  return { inserted: rows.length };
}

/**
 * Capture Meta Ad Account /activities for Credizona (is_self).
 * Capture-only — not consumed by Own Ads Brief in this phase.
 *
 * @param {{ accessToken?: string, adAccountId?: string, apiVersion?: string }} [options]
 */
async function collectOwnAdChanges(options = {}) {
  const accessToken = options.accessToken || env.metaMarketingApiToken;
  const adAccountId = options.adAccountId || env.metaAdAccountId;
  const apiVersion = options.apiVersion || env.metaMarketingApiVersion || 'v25.0';

  if (!accessToken) {
    throw new Error('META_MARKETING_API_TOKEN is not configured');
  }
  if (!adAccountId) {
    throw new Error('META_AD_ACCOUNT_ID is not configured');
  }

  const reportingDate = resolvePreviousClosedReportingDay();
  const reportingRange = { since: reportingDate, until: reportingDate };

  const { entityId, entityName } = await resolveSelfEntityId();
  const runId = randomUUID();

  logger.info('Meta own-ad-changes collect started', {
    runId,
    entityId,
    entityName,
    apiVersion,
    reportingDate,
    reportingRange,
  });

  await insertRun({ runId, entityId });

  try {
    const activityRows = await fetchAllActivityRows({
      version: apiVersion,
      adAccountId,
      accessToken,
      reportingRange,
    });

    if (!activityRows.length) {
      logger.info('No account activity changes found.', {
        runId,
        entityId,
        reportingDate,
      });
    }

    const changeRows = activityRows.map((row) =>
      mapRowToChange({ row, entityId, runId }));

    const { inserted } = await insertChanges(changeRows);
    const successRawJson = buildSuccessRawJson({
      reportingDate,
      reportingRange,
      changesFound: activityRows.length,
      eventsInserted: inserted,
    });
    const finishedAt = await finishRun({
      runId,
      status: 'success',
      rawJson: successRawJson,
    });

    const summary = {
      status: 'meta_own_ad_changes_complete',
      runId,
      entityId,
      entityName,
      changesFound: activityRows.length,
      eventsInserted: inserted,
      reportingDate,
      reportingRange,
      finishedAt,
    };

    logger.info('Meta own-ad-changes collect finished', {
      runId,
      changesFound: activityRows.length,
      eventsInserted: inserted,
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
      logger.error('Meta own-ad-changes failed to mark run failed', {
        runId,
        error: finishErr && finishErr.message ? finishErr.message : 'unknown',
      });
    }

    logger.error('Meta own-ad-changes collect failed', {
      runId,
      error: errorPayload.message || errorPayload.error_raw || 'unknown',
      reportingDate,
    });

    throw err;
  }
}

module.exports = {
  collectOwnAdChanges,
  resolvePreviousClosedReportingDay,
  buildSuccessRawJson,
  buildFailureRawJson,
  MAX_PAGES,
};
