-- MIE Activity V1 — validation queries

-- 1. Schema
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'activity_metrics'
ORDER BY ordinal_position;

-- 2. Latest run per entity/metric for a date (replace DATE)
SELECT DISTINCT ON (entity_id, metric_type)
  entity_id, metric_type, execution_date, observed_value,
  baseline_mean, baseline_std, delta_value, confidence_level,
  change_relevant, change_direction, alert_emitted,
  consecutive_change_days, coverage_valid, ruleset_version, created_at
FROM activity_metrics
WHERE execution_date = CURRENT_DATE
ORDER BY entity_id, metric_type, created_at DESC;

-- 3. confidence_level=none must not have change_relevant=true
SELECT COUNT(*) AS bad_none_changes
FROM activity_metrics
WHERE confidence_level = 'none' AND change_relevant IS TRUE;

-- 4. coverage_valid=false must not emit alerts
SELECT COUNT(*) AS bad_coverage_alerts
FROM activity_metrics
WHERE coverage_valid = false AND alert_emitted = true;

-- 5. empty status must not count as valid coverage day
-- (manual check: days whose latest snapshot is empty)
SELECT s.entity_id, s.snapshot_date, s.status, s.created_at
FROM ad_snapshots s
INNER JOIN (
  SELECT entity_id, snapshot_date, MAX(created_at) AS max_created
  FROM ad_snapshots
  GROUP BY entity_id, snapshot_date
) latest
  ON latest.entity_id = s.entity_id
 AND latest.snapshot_date = s.snapshot_date
 AND latest.max_created = s.created_at
WHERE s.status = 'empty'
ORDER BY s.snapshot_date DESC
LIMIT 50;

-- 6. Anti-flapping: compare today vs execution_date-1 for new_ads
WITH today AS (
  SELECT DISTINCT ON (entity_id)
    entity_id, execution_date, change_relevant, alert_emitted,
    consecutive_change_days, delta_value, created_at
  FROM activity_metrics
  WHERE metric_type = 'new_ads' AND execution_date = CURRENT_DATE
  ORDER BY entity_id, created_at DESC
),
yesterday AS (
  SELECT DISTINCT ON (entity_id)
    entity_id, execution_date, change_relevant, consecutive_change_days, delta_value
  FROM activity_metrics
  WHERE metric_type = 'new_ads' AND execution_date = CURRENT_DATE - 1
  ORDER BY entity_id, created_at DESC
)
SELECT t.entity_id,
       t.change_relevant AS today_change,
       y.change_relevant AS yesterday_change,
       t.alert_emitted,
       t.consecutive_change_days,
       t.delta_value AS today_delta,
       y.delta_value AS yesterday_delta
FROM today t
LEFT JOIN yesterday y ON y.entity_id = t.entity_id;

-- 7. Pronto+ / Anda spot-check (replace names if needed)
SELECT me.name, am.metric_type, am.observed_value, am.baseline_mean,
       am.delta_value, am.confidence_level, am.change_relevant,
       am.coverage_valid, am.ruleset_version, am.created_at
FROM activity_metrics am
JOIN monitored_entities me ON me.id = am.entity_id
WHERE me.name IN ('Pronto+', 'Anda')
  AND am.execution_date = CURRENT_DATE
ORDER BY me.name, am.metric_type, am.created_at DESC;

-- 8. Append-only: multiple rows same day allowed
SELECT entity_id, metric_type, execution_date, COUNT(*) AS runs
FROM activity_metrics
GROUP BY entity_id, metric_type, execution_date
HAVING COUNT(*) > 1
ORDER BY runs DESC;
