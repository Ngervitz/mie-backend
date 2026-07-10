// MIE Activity V1 — constants (heuristics, not statistically validated).
// RULESET_VERSION pins formulas at write time; never recompute old alerts with new rules.

const RULESET_VERSION = 'v1.0';

const WINDOW_DAYS = 7;
const MAX_BASELINE_BLOCKS = 12;
const MIN_BLOCKS_FOR_MEAN = 1;
const MIN_BLOCKS_FOR_STD = 4;

// Confidence by calendar age (execution_date - MIN(first_seen_at)), not coverage.
const CONFIDENCE_NONE_MAX_DAYS = 13; // 0–13 → none
const CONFIDENCE_LOW_MAX_DAYS = 34; // 14–34 → low
const CONFIDENCE_MEDIUM_MAX_DAYS = 55; // 35–55 → medium
// 56+ → high

// Change detection (new_ads only) — V1 heuristics.
const MIN_ABSOLUTE_DELTA = 3;
const MIN_PERCENT_DELTA = 0.5;
const STD_MULTIPLIER = 1.5;
const STD_FLOOR = 2;

// Anti-flapping
const ALERT_SUPPRESSION_DAYS = 7;
const ALERT_ESCALATION_FACTOR = 1.75;

const METRIC_TYPES = {
  NEW_ADS: 'new_ads',
  REACTIVATED_ADS: 'reactivated_ads',
  PERSISTENCE: 'persistence',
};

const VALID_SNAPSHOT_STATUSES = new Set(['success', 'empty_confirmed']);

module.exports = {
  RULESET_VERSION,
  WINDOW_DAYS,
  MAX_BASELINE_BLOCKS,
  MIN_BLOCKS_FOR_MEAN,
  MIN_BLOCKS_FOR_STD,
  CONFIDENCE_NONE_MAX_DAYS,
  CONFIDENCE_LOW_MAX_DAYS,
  CONFIDENCE_MEDIUM_MAX_DAYS,
  MIN_ABSOLUTE_DELTA,
  MIN_PERCENT_DELTA,
  STD_MULTIPLIER,
  STD_FLOOR,
  ALERT_SUPPRESSION_DAYS,
  ALERT_ESCALATION_FACTOR,
  METRIC_TYPES,
  VALID_SNAPSHOT_STATUSES,
};
