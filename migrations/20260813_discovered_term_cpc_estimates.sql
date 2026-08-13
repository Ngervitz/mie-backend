-- Keyword Planner CPC / volume snapshots for Trends discoveries (Pendientes).
-- Append-only. Separate from keyword_cpc_estimates (which FKs serp_monitored_queries).
-- Apply manually in Supabase.

BEGIN;

CREATE TABLE IF NOT EXISTS public.discovered_term_cpc_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id uuid NOT NULL
    REFERENCES public.search_term_discoveries (id)
    ON DELETE CASCADE,
  term_snapshot text NOT NULL,
  avg_monthly_searches bigint NULL,
  low_top_of_page_bid_raw bigint NULL,
  high_top_of_page_bid_raw bigint NULL,
  currency_code text NULL,
  competition_level text NULL,
  sync_run_id uuid NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovered_term_cpc_estimates_term_snapshot_nonempty
    CHECK (char_length(trim(term_snapshot)) > 0)
);

COMMENT ON TABLE public.discovered_term_cpc_estimates IS
  'Append-only Keyword Planner snapshots for search_term_discoveries (pending Trends queue). Bid columns store API raw micros.';

COMMENT ON COLUMN public.discovered_term_cpc_estimates.low_top_of_page_bid_raw IS
  'Raw low_top_of_page_bid_micros from the API (no unit conversion).';

COMMENT ON COLUMN public.discovered_term_cpc_estimates.high_top_of_page_bid_raw IS
  'Raw high_top_of_page_bid_micros from the API (no unit conversion).';

COMMENT ON COLUMN public.discovered_term_cpc_estimates.sync_run_id IS
  'Shared UUID for all rows written by one discovered-term CPC sync run.';

CREATE INDEX IF NOT EXISTS idx_discovered_term_cpc_estimates_discovery_fetched
  ON public.discovered_term_cpc_estimates (discovery_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovered_term_cpc_estimates_term_fetched
  ON public.discovered_term_cpc_estimates (term_snapshot, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovered_term_cpc_estimates_sync_run
  ON public.discovered_term_cpc_estimates (sync_run_id);

CREATE INDEX IF NOT EXISTS idx_discovered_term_cpc_estimates_fetched_at
  ON public.discovered_term_cpc_estimates (fetched_at DESC);

COMMIT;
