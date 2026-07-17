-- GA4 Data API capture (capture-only phase): daily traffic broken down by
-- default channel group + landing page. NOT wired into any brief/analysis.
--
-- Zero vs null discipline (same as CTR/CPC elsewhere): key_events is NULL
-- only when GA4 omitted the metric from the row payload; an explicit "0"
-- from the API is stored as 0 (a real measurement).
--
-- landing_page: GA4's own empty/unset values are normalized to the literal
-- string '(not set)' before insert so the idempotency key below is stable
-- (NULLs would not collide in a UNIQUE constraint).

BEGIN;

CREATE TABLE IF NOT EXISTS public.ga4_metric_runs (
  run_id uuid PRIMARY KEY,
  reporting_date date NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NULL,
  status text NOT NULL,              -- 'running' | 'success' | 'failed'
  rows_count integer NULL,
  error_message text NULL,
  raw_json jsonb NULL,               -- includes propertyQuota consumption
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ga4_metric_runs_date
  ON public.ga4_metric_runs (reporting_date, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ga4_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  channel_group text NOT NULL,
  landing_page text NULL,            -- normalized: never '' — '(not set)' instead
  sessions integer NULL,
  total_users integer NULL,
  key_events numeric NULL,           -- NULL = metric absent from payload, 0 = measured zero
  raw_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: a retry for the same day upserts, never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS ga4_metrics_day_key
  ON public.ga4_metrics (date, channel_group, landing_page);

COMMIT;
