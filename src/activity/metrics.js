const {
  CONFIDENCE_NONE_MAX_DAYS,
  CONFIDENCE_LOW_MAX_DAYS,
  CONFIDENCE_MEDIUM_MAX_DAYS,
  MIN_BLOCKS_FOR_MEAN,
  MIN_BLOCKS_FOR_STD,
  MIN_ABSOLUTE_DELTA,
  MIN_PERCENT_DELTA,
  STD_MULTIPLIER,
  STD_FLOOR,
} = require('./constants');
const { toDateOnly } = require('./dates');

function confidenceLevelFromDays(daysOfHistory) {
  const d = Math.max(0, Number(daysOfHistory) || 0);
  if (d <= CONFIDENCE_NONE_MAX_DAYS) return 'none';
  if (d <= CONFIDENCE_LOW_MAX_DAYS) return 'low';
  if (d <= CONFIDENCE_MEDIUM_MAX_DAYS) return 'medium';
  return 'high';
}

function countNewAdsInWindow(ads, windowStart, windowEnd) {
  let count = 0;
  for (const ad of ads || []) {
    const firstSeen = toDateOnly(ad.first_seen_at);
    if (!firstSeen) continue;
    if (firstSeen >= windowStart && firstSeen < windowEnd) {
      count += 1;
    }
  }
  return count;
}

function countReactivatedInWindow(events, windowStart, windowEnd) {
  let count = 0;
  for (const event of events || []) {
    const detectedAt = toDateOnly(event.detected_at);
    if (!detectedAt) continue;
    if (detectedAt >= windowStart && detectedAt < windowEnd) {
      count += 1;
    }
  }
  return count;
}

function countActiveAds(ads) {
  let count = 0;
  for (const ad of ads || []) {
    if (ad.is_active === true) {
      count += 1;
    }
  }
  return count;
}

function mean(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

function sampleStd(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + ((v - m) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeBaseline(blockValues) {
  if (blockValues.length < MIN_BLOCKS_FOR_MEAN) {
    return { baselineMean: null, baselineStd: null };
  }

  const baselineMean = mean(blockValues);
  const baselineStd = blockValues.length >= MIN_BLOCKS_FOR_STD
    ? sampleStd(blockValues)
    : null;

  return { baselineMean, baselineStd };
}

/**
 * Change detection for new_ads only.
 * Returns { changeRelevant, changeDirection, deltaValue }.
 */
function evaluateChange({
  observedValue,
  baselineMean,
  baselineStd,
  confidenceLevel,
  coverageValid,
}) {
  const deltaValue = baselineMean === null || baselineMean === undefined
    ? null
    : Math.abs(observedValue - baselineMean);

  if (!coverageValid || confidenceLevel === 'none' || baselineMean === null) {
    return {
      changeRelevant: false,
      changeDirection: null,
      deltaValue,
    };
  }

  const absDelta = Math.abs(observedValue - baselineMean);
  const cond1 = absDelta >= MIN_ABSOLUTE_DELTA;
  const cond2 = absDelta / Math.max(baselineMean, 1) >= MIN_PERCENT_DELTA;

  let cond3 = true;
  if (confidenceLevel === 'medium' || confidenceLevel === 'high') {
    if (baselineStd === null || baselineStd === undefined) {
      cond3 = true; // condition 3 not evaluated without std
    } else {
      cond3 = absDelta >= Math.max(STD_FLOOR, baselineStd * STD_MULTIPLIER);
    }
  }

  // low: only 1 and 2; medium/high: 1, 2, and 3 (when std available)
  let changeRelevant = cond1 && cond2;
  if (confidenceLevel === 'medium' || confidenceLevel === 'high') {
    if (baselineStd !== null && baselineStd !== undefined) {
      changeRelevant = changeRelevant && cond3;
    }
  }

  let changeDirection = null;
  if (changeRelevant) {
    changeDirection = observedValue >= baselineMean ? 'increased' : 'decreased';
  }

  return { changeRelevant, changeDirection, deltaValue };
}

module.exports = {
  confidenceLevelFromDays,
  countNewAdsInWindow,
  countReactivatedInWindow,
  countActiveAds,
  computeBaseline,
  evaluateChange,
  mean,
  sampleStd,
};
