/**
 * Auction pressure — competitor Ad Library activity vs own CPM.
 * Own side stays explicitly null until own_ad_metrics has enough recent history.
 */

const supabase = require('../clients/supabase');
const { shiftDateUtc } = require('../activity/dates');

const BASELINE_DAYS = 30;
const MIN_OWN_HISTORY_DAYS = 7;
const ACTIVITY_METRIC_TYPES = ['persistence', 'new_ads', 'reactivated_ads'];

function isValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function safeRatio(numerator, denominator) {
  if (
    numerator == null ||
    denominator == null ||
    !Number.isFinite(Number(numerator)) ||
    !Number.isFinite(Number(denominator)) ||
    Number(denominator) === 0
  ) {
    return null;
  }
  return Number(numerator) / Number(denominator);
}

function enumerateInclusiveDates(fromDate, toDate) {
  const out = [];
  let cur = fromDate;
  while (cur <= toDate) {
    out.push(cur);
    cur = shiftDateUtc(cur, 1);
  }
  return out;
}

/**
 * Keep the latest created_at row per (entity_id, metric_type, execution_date).
 */
function pickVigenteActivityRows(rows) {
  const best = new Map();
  for (const row of rows || []) {
    if (!ACTIVITY_METRIC_TYPES.includes(row.metric_type)) continue;
    const key = `${row.entity_id}|${row.metric_type}|${row.execution_date}`;
    const prev = best.get(key);
    if (!prev || String(row.created_at) > String(prev.created_at)) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

/**
 * Daily market activity = sum(persistence + new_ads + reactivated_ads)
 * across all competitor entities (vigente rows only).
 */
function buildDailyCompetitorActivity(vigenteRows) {
  const byDate = new Map();
  for (const row of vigenteRows) {
    const date = row.execution_date;
    const value =
      row.observed_value != null && Number.isFinite(Number(row.observed_value))
        ? Number(row.observed_value)
        : 0;
    byDate.set(date, (byDate.get(date) || 0) + value);
  }
  return byDate;
}

function meanOfValues(values) {
  if (!values.length) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

async function loadCompetitorActivityRows(windowFrom, windowTo) {
  const { data, error } = await supabase
    .from('activity_metrics')
    .select(
      'entity_id, execution_date, metric_type, observed_value, created_at',
    )
    .gte('execution_date', windowFrom)
    .lte('execution_date', windowTo)
    .in('metric_type', ACTIVITY_METRIC_TYPES)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load activity_metrics: ${error.message}`);
  }
  return data || [];
}

async function resolveSelfEntityId() {
  const { data, error } = await supabase
    .from('monitored_entities')
    .select('id')
    .eq('is_self', true)
    .limit(1);

  if (error) {
    throw new Error(`Failed to load self entity: ${error.message}`);
  }
  if (!data || !data.length || !data[0].id) {
    throw new Error('No monitored_entities row with is_self=true');
  }
  return data[0].id;
}

async function loadOwnAdMetricRows(entityId, windowFrom, windowTo) {
  const { data, error } = await supabase
    .from('own_ad_metrics')
    .select('metric_date, spend, impressions')
    .eq('entity_id', entityId)
    .gte('metric_date', windowFrom)
    .lte('metric_date', windowTo)
    .order('metric_date', { ascending: true });

  if (error) {
    throw new Error(`Failed to load own_ad_metrics: ${error.message}`);
  }
  return data || [];
}

/**
 * Aggregate spend/impressions per metric_date, then CPM when impressions > 0.
 * Days with only zero impressions are not counted as CPM history.
 */
function buildDailyOwnCpm(rows) {
  const totals = new Map();
  for (const row of rows || []) {
    const date = row.metric_date;
    if (!date) continue;
    const prev = totals.get(date) || { spend: 0, impressions: 0 };
    if (row.spend != null && Number.isFinite(Number(row.spend))) {
      prev.spend += Number(row.spend);
    }
    if (row.impressions != null && Number.isFinite(Number(row.impressions))) {
      prev.impressions += Number(row.impressions);
    }
    totals.set(date, prev);
  }

  const cpmByDate = new Map();
  for (const [date, tot] of totals.entries()) {
    if (tot.impressions <= 0) continue;
    const cpm = (tot.spend / tot.impressions) * 1000;
    if (!Number.isFinite(cpm)) continue;
    cpmByDate.set(date, cpm);
  }
  return cpmByDate;
}

function computeCompetitorSide(dailyActivity, date, windowFrom) {
  const todayActivity =
    dailyActivity.has(date) && Number.isFinite(dailyActivity.get(date))
      ? dailyActivity.get(date)
      : null;

  const baselineValues = [];
  for (const day of enumerateInclusiveDates(windowFrom, date)) {
    if (!dailyActivity.has(day)) continue;
    const v = dailyActivity.get(day);
    if (Number.isFinite(v)) baselineValues.push(v);
  }

  const baselineMean = meanOfValues(baselineValues);
  const competitorPressureRatio = safeRatio(todayActivity, baselineMean);

  return {
    competitorPressureRatio,
    competitorActivityToday: todayActivity,
    competitorActivityBaselineMean: baselineMean,
    competitorDaysWithData: baselineValues.length,
  };
}

function computeOwnCpmSide(cpmByDate, date, windowFrom) {
  const historyDates = [];
  for (const day of enumerateInclusiveDates(windowFrom, date)) {
    if (cpmByDate.has(day)) historyDates.push(day);
  }

  const daysWithHistory = historyDates.length;
  const cpmToday = cpmByDate.has(date) ? cpmByDate.get(date) : null;
  const baselineMean = meanOfValues(historyDates.map((d) => cpmByDate.get(d)));

  // Never invent a CPM when history is thin or today is missing.
  if (daysWithHistory < MIN_OWN_HISTORY_DAYS || cpmToday == null) {
    return {
      ownCpmRatio: null,
      ownCpmToday: null,
      ownCpmBaselineMean: null,
      ownDaysWithData: daysWithHistory,
      ownSideReady: false,
    };
  }

  return {
    ownCpmRatio: safeRatio(cpmToday, baselineMean),
    ownCpmToday: cpmToday,
    ownCpmBaselineMean: baselineMean,
    ownDaysWithData: daysWithHistory,
    ownSideReady: true,
  };
}

/**
 * @param {{ date?: string }} [opts]
 * @returns {Promise<object>}
 */
async function computeAuctionPressure({ date: inputDate } = {}) {
  const date = inputDate ? String(inputDate) : new Date().toISOString().split('T')[0];
  if (!isValidDateOnly(date)) {
    throw new Error(`Invalid date: ${date}. Use YYYY-MM-DD.`);
  }

  const windowFrom = shiftDateUtc(date, -(BASELINE_DAYS - 1));
  const windowTo = date;

  const [activityRows, selfEntityId] = await Promise.all([
    loadCompetitorActivityRows(windowFrom, windowTo),
    resolveSelfEntityId(),
  ]);
  const ownRows = await loadOwnAdMetricRows(selfEntityId, windowFrom, windowTo);

  const dailyActivity = buildDailyCompetitorActivity(
    pickVigenteActivityRows(activityRows),
  );
  const competitor = computeCompetitorSide(dailyActivity, date, windowFrom);

  const cpmByDate = buildDailyOwnCpm(ownRows);
  const own = computeOwnCpmSide(cpmByDate, date, windowFrom);

  const bothReady =
    competitor.competitorPressureRatio != null && own.ownCpmRatio != null;

  // Combined only when both sides exist — simple mean of the two ratios.
  const auctionPressureIndex = bothReady
    ? (competitor.competitorPressureRatio + own.ownCpmRatio) / 2
    : null;

  let status;
  if (competitor.competitorPressureRatio == null && !own.ownSideReady) {
    status = 'insufficient_data';
  } else if (!own.ownSideReady) {
    status = 'insufficient_own_data';
  } else if (competitor.competitorPressureRatio == null) {
    status = 'insufficient_competitor_data';
  } else {
    status = 'ok';
  }

  return {
    date,
    window: { from: windowFrom, to: windowTo, days: BASELINE_DAYS },
    status,
    competitorPressureRatio: competitor.competitorPressureRatio,
    ownCpmRatio: own.ownCpmRatio,
    auctionPressureIndex,
    detail: {
      competitorActivityToday: competitor.competitorActivityToday,
      competitorActivityBaselineMean: competitor.competitorActivityBaselineMean,
      competitorDaysWithData: competitor.competitorDaysWithData,
      ownCpmToday: own.ownCpmToday,
      ownCpmBaselineMean: own.ownCpmBaselineMean,
      ownDaysWithData: own.ownDaysWithData,
      minOwnHistoryDays: MIN_OWN_HISTORY_DAYS,
    },
  };
}

module.exports = {
  computeAuctionPressure,
  BASELINE_DAYS,
  MIN_OWN_HISTORY_DAYS,
};
