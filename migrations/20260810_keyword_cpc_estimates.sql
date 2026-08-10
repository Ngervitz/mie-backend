-- Keyword Planner CPC / volume snapshots for serp_monitored_queries.
-- Append-only: no unique that blocks a second sync run (historial).
-- Double-fire of the job may insert another snapshot set (same pattern as
-- serp content dedupe / liquidity upsert — data-level, not job_locks).
-- Apply manually in Supabase.

BEGIN;

CREATE TABLE IF NOT EXISTS public.keyword_cpc_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitored_query_id uuid NOT NULL
    REFERENCES public.serp_monitored_queries (id)
    ON DELETE CASCADE,
  query_text_snapshot text NOT NULL,
  avg_monthly_searches bigint NULL,
  low_top_of_page_bid_raw bigint NULL,
  high_top_of_page_bid_raw bigint NULL,
  currency_code text NULL,
  competition_level text NULL,
  sync_run_id uuid NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keyword_cpc_estimates_query_text_snapshot_nonempty
    CHECK (char_length(trim(query_text_snapshot)) > 0)
);

COMMENT ON TABLE public.keyword_cpc_estimates IS
  'Append-only Keyword Planner snapshots (GenerateKeywordHistoricalMetrics). Bid columns store API raw micros; currency_code from customer account when available.';

COMMENT ON COLUMN public.keyword_cpc_estimates.low_top_of_page_bid_raw IS
  'Raw low_top_of_page_bid_micros from the API (no unit conversion).';

COMMENT ON COLUMN public.keyword_cpc_estimates.high_top_of_page_bid_raw IS
  'Raw high_top_of_page_bid_micros from the API (no unit conversion).';

COMMENT ON COLUMN public.keyword_cpc_estimates.sync_run_id IS
  'Shared UUID for all rows written by one POST /jobs/run-keyword-cpc-sync invocation (corrida). Not unique — identifies a run only.';

CREATE INDEX IF NOT EXISTS idx_keyword_cpc_estimates_query_fetched
  ON public.keyword_cpc_estimates (monitored_query_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_keyword_cpc_estimates_sync_run
  ON public.keyword_cpc_estimates (sync_run_id);

CREATE INDEX IF NOT EXISTS idx_keyword_cpc_estimates_fetched_at
  ON public.keyword_cpc_estimates (fetched_at DESC);

COMMIT;
