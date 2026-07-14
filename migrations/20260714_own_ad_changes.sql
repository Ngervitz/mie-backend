-- Capture-only: Meta Ad Account activity history
-- Mirrors own_ad_metric_runs / own_ad_metrics lifecycle.
-- No business UNIQUE: deduplication deferred until real production payloads exist.

BEGIN;

CREATE TABLE IF NOT EXISTS public.own_ad_change_runs (
  run_id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES public.monitored_entities(id),
  source text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NULL,
  status text NOT NULL,
  raw_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.own_ad_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.own_ad_change_runs(run_id),
  entity_id uuid NOT NULL REFERENCES public.monitored_entities(id),
  -- Demonstrated AdActivity fields (Meta Business SDK AdActivity.Field)
  event_time timestamptz NULL,
  event_type text NULL,
  object_id text NULL,
  object_name text NULL,
  object_type text NULL,
  actor_id text NULL,
  actor_name text NULL,
  application_id text NULL,
  application_name text NULL,
  translated_event_type text NULL,
  date_time_in_timezone text NULL,
  extra_data text NULL,
  raw_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Deduplication intentionally deferred until real production payloads are available.
-- Technical PK only (id); no business UNIQUE constraints in this phase.

CREATE INDEX IF NOT EXISTS idx_own_ad_changes_event_time
  ON public.own_ad_changes (event_time DESC);

CREATE INDEX IF NOT EXISTS idx_own_ad_changes_run_id
  ON public.own_ad_changes (run_id);

COMMIT;
