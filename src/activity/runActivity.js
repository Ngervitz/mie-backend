const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  RULESET_VERSION,
  WINDOW_DAYS,
  MAX_BASELINE_BLOCKS,
  METRIC_TYPES,
  ALERT_SUPPRESSION_DAYS,
} = require('./constants');
const {
  isValidDateOnly,
  todayUtc,
  shiftDateUtc,
  daysBetween,
  toDateOnly,
} = require('./dates');
const {
  buildCurrentWindow,
  buildBaselineBlocks,
  isBlockCoverageValid,
  indexSnapshotsByDate,
} = require('./coverage');
const {
  confidenceLevelFromDays,
  countNewAdsInWindow,
  countReactivatedInWindow,
  countActiveAds,
  computeBaseline,
  evaluateChange,
} = require('./metrics');
const {
  resolveAntiFlapping,
  yesterdayExecutionDate,
} = require('./antiflap');

async function loadCompetitorEntities(entityId) {
  // PASO 0 decision: same as collect.js — exclude is_self; do NOT filter active.
  let query = supabase
    .from('monitored_entities')
    .select('id, name, is_self')
    .eq('is_self', false);

  if (entityId) {
    query = query.eq('id', entityId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load monitored_entities: ${error.message}`);
  }
  return data || [];
}

async function loadEntityAds(entityId) {
  const { data, error } = await supabase
    .from('ads')
    .select('id, first_seen_at, is_active')
    .eq('entity_id', entityId);

  if (error) {
    throw new Error(`Failed to load ads for entity ${entityId}: ${error.message}`);
  }
  return data || [];
}

async function loadReactivatedEvents(entityId, rangeStart, rangeEndExclusive) {
  const { data, error } = await supabase
    .from('events')
    .select('id, detected_at, event_type')
    .eq('entity_id', entityId)
    .eq('event_type', 'ad_reactivated')
    .gte('detected_at', rangeStart)
    .lt('detected_at', rangeEndExclusive);

  if (error) {
    throw new Error(`Failed to load events for entity ${entityId}: ${error.message}`);
  }
  return data || [];
}

async function loadSnapshots(entityId, rangeStart, rangeEndInclusive) {
  const { data, error } = await supabase
    .from('ad_snapshots')
    .select('id, status, snapshot_date, created_at')
    .eq('entity_id', entityId)
    .gte('snapshot_date', rangeStart)
    .lte('snapshot_date', rangeEndInclusive)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load ad_snapshots for entity ${entityId}: ${error.message}`);
  }
  return data || [];
}

/**
 * Latest activity_metrics row for entity + metric + execution_date.
 * Vigente = ORDER BY created_at DESC LIMIT 1.
 */
async function loadLatestMetricRow(entityId, metricType, executionDate) {
  const { data, error } = await supabase
    .from('activity_metrics')
    .select('*')
    .eq('entity_id', entityId)
    .eq('metric_type', metricType)
    .eq('execution_date', executionDate)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to load activity_metrics for entity ${entityId} date ${executionDate}: ${error.message}`,
    );
  }
  return data || null;
}

async function loadRecentAlerts(entityId, metricType, changeDirection, sinceDate, beforeDate) {
  if (!changeDirection) return [];

  const { data, error } = await supabase
    .from('activity_metrics')
    .select('execution_date, delta_value, change_direction, alert_emitted, created_at')
    .eq('entity_id', entityId)
    .eq('metric_type', metricType)
    .eq('alert_emitted', true)
    .eq('change_direction', changeDirection)
    .gte('execution_date', sinceDate)
    .lt('execution_date', beforeDate)
    .order('execution_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load recent alerts for entity ${entityId}: ${error.message}`);
  }

  // Keep latest row per execution_date only.
  const byDate = new Map();
  for (const row of data || []) {
    if (!byDate.has(row.execution_date)) {
      byDate.set(row.execution_date, row);
    }
  }
  return [...byDate.values()];
}

function minFirstSeenAt(ads) {
  let min = null;
  for (const ad of ads || []) {
    const d = toDateOnly(ad.first_seen_at);
    if (!d) continue;
    if (min === null || d < min) min = d;
  }
  return min;
}

function observedForBlock(metricType, ads, events, start, end) {
  if (metricType === METRIC_TYPES.NEW_ADS) {
    return countNewAdsInWindow(ads, start, end);
  }
  if (metricType === METRIC_TYPES.REACTIVATED_ADS) {
    return countReactivatedInWindow(events, start, end);
  }
  return null;
}

async function computeEntityMetrics({ entity, executionDate }) {
  const entityId = entity.id;
  const { currentWindowStart, currentWindowEnd } = buildCurrentWindow(executionDate);
  const baselineBlocks = buildBaselineBlocks(currentWindowStart);

  const oldestBaselineStart = baselineBlocks.length
    ? baselineBlocks[baselineBlocks.length - 1].start
    : currentWindowStart;
  const snapshotRangeEnd = shiftDateUtc(currentWindowEnd, -1);

  const [ads, events, snapshots] = await Promise.all([
    loadEntityAds(entityId),
    loadReactivatedEvents(entityId, oldestBaselineStart, currentWindowEnd),
    loadSnapshots(entityId, oldestBaselineStart, snapshotRangeEnd),
  ]);

  const snapshotsByDate = indexSnapshotsByDate(snapshots);
  const coverageValid = isBlockCoverageValid(
    snapshotsByDate,
    currentWindowStart,
    currentWindowEnd,
  );

  const firstSeen = minFirstSeenAt(ads);
  const daysOfHistory = firstSeen === null
    ? 0
    : Math.max(0, daysBetween(firstSeen, executionDate));
  const confidenceLevel = confidenceLevelFromDays(daysOfHistory);

  const validBaselineBlocks = baselineBlocks.filter((block) =>
    isBlockCoverageValid(snapshotsByDate, block.start, block.end));

  const rows = [];

  // --- new_ads ---
  {
    const metricType = METRIC_TYPES.NEW_ADS;
    const observedValue = countNewAdsInWindow(ads, currentWindowStart, currentWindowEnd);
    const blockValues = validBaselineBlocks.map((b) =>
      observedForBlock(metricType, ads, events, b.start, b.end));
    const { baselineMean, baselineStd } = computeBaseline(blockValues);

    let changeRelevant = false;
    let changeDirection = null;
    let deltaValue = baselineMean === null ? null : Math.abs(observedValue - baselineMean);

    if (!coverageValid) {
      changeRelevant = null;
      changeDirection = null;
    } else {
      const evaluated = evaluateChange({
        observedValue,
        baselineMean,
        baselineStd,
        confidenceLevel,
        coverageValid: true,
      });
      changeRelevant = evaluated.changeRelevant;
      changeDirection = evaluated.changeDirection;
      deltaValue = evaluated.deltaValue;
    }

    let alertEmitted = false;
    let consecutiveChangeDays = 0;

    if (coverageValid && changeRelevant !== null) {
      const yesterdayDate = yesterdayExecutionDate(executionDate);
      const yesterdayRow = await loadLatestMetricRow(entityId, metricType, yesterdayDate);
      const suppressionStart = shiftDateUtc(executionDate, -ALERT_SUPPRESSION_DAYS);
      const recentAlerts = changeDirection
        ? await loadRecentAlerts(
          entityId,
          metricType,
          changeDirection,
          suppressionStart,
          executionDate,
        )
        : [];

      const flap = resolveAntiFlapping({
        executionDate,
        changeRelevantToday: Boolean(changeRelevant),
        changeDirectionToday: changeDirection,
        deltaValueToday: deltaValue,
        yesterdayRow,
        recentAlertsSameDirection: recentAlerts,
      });

      alertEmitted = flap.alertEmitted;
      consecutiveChangeDays = flap.consecutiveChangeDays;
    }

    rows.push({
      entity_id: entityId,
      execution_date: executionDate,
      current_window_start: currentWindowStart,
      current_window_end: currentWindowEnd,
      metric_type: metricType,
      observed_value: observedValue,
      baseline_mean: baselineMean,
      baseline_std: baselineStd,
      delta_value: deltaValue,
      days_of_history: daysOfHistory,
      confidence_level: confidenceLevel,
      change_relevant: changeRelevant,
      change_direction: changeDirection,
      alert_emitted: alertEmitted,
      consecutive_change_days: consecutiveChangeDays,
      coverage_valid: coverageValid,
      ruleset_version: RULESET_VERSION,
    });
  }

  // --- reactivated_ads (observed + baseline; no change alerts) ---
  {
    const metricType = METRIC_TYPES.REACTIVATED_ADS;
    const observedValue = countReactivatedInWindow(events, currentWindowStart, currentWindowEnd);
    const blockValues = validBaselineBlocks.map((b) =>
      observedForBlock(metricType, ads, events, b.start, b.end));
    const { baselineMean, baselineStd } = computeBaseline(blockValues);
    const deltaValue = baselineMean === null ? null : Math.abs(observedValue - baselineMean);

    rows.push({
      entity_id: entityId,
      execution_date: executionDate,
      current_window_start: currentWindowStart,
      current_window_end: currentWindowEnd,
      metric_type: metricType,
      observed_value: observedValue,
      baseline_mean: baselineMean,
      baseline_std: baselineStd,
      delta_value: deltaValue,
      days_of_history: daysOfHistory,
      confidence_level: confidenceLevel,
      change_relevant: coverageValid ? false : null,
      change_direction: null,
      alert_emitted: false,
      consecutive_change_days: 0,
      coverage_valid: coverageValid,
      ruleset_version: RULESET_VERSION,
    });
  }

  // --- persistence (point-in-time; no baseline / window semantics for value) ---
  {
    const metricType = METRIC_TYPES.PERSISTENCE;
    const observedValue = countActiveAds(ads);

    rows.push({
      entity_id: entityId,
      execution_date: executionDate,
      current_window_start: currentWindowStart,
      current_window_end: currentWindowEnd,
      metric_type: metricType,
      observed_value: observedValue,
      baseline_mean: null,
      baseline_std: null,
      delta_value: null,
      days_of_history: daysOfHistory,
      confidence_level: confidenceLevel,
      change_relevant: false,
      change_direction: null,
      alert_emitted: false,
      consecutive_change_days: 0,
      coverage_valid: true,
      ruleset_version: RULESET_VERSION,
    });
  }

  return {
    entityId,
    entityName: entity.name,
    executionDate,
    currentWindowStart,
    currentWindowEnd,
    coverageValid,
    daysOfHistory,
    confidenceLevel,
    validBaselineBlocks: validBaselineBlocks.length,
    rows,
  };
}

async function persistMetricRows(rows) {
  if (!rows.length) return { inserted: 0 };

  const { error } = await supabase.from('activity_metrics').insert(rows);
  if (error) {
    throw new Error(`Failed to insert activity_metrics: ${error.message}`);
  }
  return { inserted: rows.length };
}

async function runActivity({ entityId, executionDate: inputDate } = {}) {
  const executionDate = inputDate ? String(inputDate) : todayUtc();

  if (!isValidDateOnly(executionDate)) {
    throw new Error(`Invalid executionDate: ${executionDate}. Use YYYY-MM-DD.`);
  }

  logger.info('Activity V1 started', {
    executionDate,
    rulesetVersion: RULESET_VERSION,
    ...(entityId && { entityId }),
  });

  const entities = await loadCompetitorEntities(entityId);
  const results = [];
  let inserted = 0;
  let failed = 0;

  for (const entity of entities) {
    try {
      const computed = await computeEntityMetrics({ entity, executionDate });
      await persistMetricRows(computed.rows);
      inserted += computed.rows.length;
      results.push({
        entityId: computed.entityId,
        entityName: computed.entityName,
        coverageValid: computed.coverageValid,
        daysOfHistory: computed.daysOfHistory,
        confidenceLevel: computed.confidenceLevel,
        validBaselineBlocks: computed.validBaselineBlocks,
        metrics: computed.rows.map((r) => ({
          metric_type: r.metric_type,
          observed_value: r.observed_value,
          baseline_mean: r.baseline_mean,
          baseline_std: r.baseline_std,
          delta_value: r.delta_value,
          change_relevant: r.change_relevant,
          change_direction: r.change_direction,
          alert_emitted: r.alert_emitted,
          consecutive_change_days: r.consecutive_change_days,
          coverage_valid: r.coverage_valid,
        })),
      });
    } catch (err) {
      failed += 1;
      logger.error('Activity V1 entity failed', {
        entityId: entity.id,
        entityName: entity.name,
        error: err.message,
      });
    }
  }

  const summary = {
    status: 'activity_complete',
    rulesetVersion: RULESET_VERSION,
    executionDate,
    entitiesProcessed: results.length,
    entitiesFailed: failed,
    rowsInserted: inserted,
    windowDays: WINDOW_DAYS,
    maxBaselineBlocks: MAX_BASELINE_BLOCKS,
    results,
  };

  logger.info('Activity V1 finished', {
    executionDate,
    entitiesProcessed: results.length,
    entitiesFailed: failed,
    rowsInserted: inserted,
  });

  return summary;
}

module.exports = {
  runActivity,
  computeEntityMetrics,
  loadCompetitorEntities,
  buildCurrentWindow,
};
