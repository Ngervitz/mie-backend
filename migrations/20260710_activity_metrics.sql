-- MIE Activity V1 — activity_metrics (append-only)
-- One row per (entity, execution_date, metric_type) calculation run.
-- No UNIQUE: multiple runs same day allowed; vigente = ORDER BY created_at DESC.

CREATE TABLE IF NOT EXISTS public.activity_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES public.monitored_entities(id),
  execution_date date NOT NULL,
  current_window_start date NOT NULL,
  current_window_end date NOT NULL,
  metric_type text NOT NULL
    CHECK (metric_type IN ('new_ads', 'reactivated_ads', 'persistence')),
  observed_value integer NOT NULL,
  baseline_mean double precision NULL,
  baseline_std double precision NULL,
  delta_value double precision NULL,
  days_of_history integer NOT NULL,
  confidence_level text NOT NULL
    CHECK (confidence_level IN ('none', 'low', 'medium', 'high')),
  change_relevant boolean NULL,
  change_direction text NULL
    CHECK (change_direction IS NULL OR change_direction IN ('increased', 'decreased')),
  alert_emitted boolean NOT NULL DEFAULT false,
  consecutive_change_days integer NOT NULL DEFAULT 0,
  coverage_valid boolean NOT NULL,
  ruleset_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_metrics_entity_exec_created
  ON public.activity_metrics (entity_id, execution_date, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_metrics_entity_metric_exec_created
  ON public.activity_metrics (entity_id, metric_type, execution_date, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_metrics_exec_created
  ON public.activity_metrics (execution_date, created_at DESC);

COMMENT ON TABLE public.activity_metrics IS
  'MIE Activity V1 append-only metrics. Vigente por día: ORDER BY created_at DESC. ruleset_version pins the formula used at write time.';
