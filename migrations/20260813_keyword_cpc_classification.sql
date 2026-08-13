-- Additive classification columns for Keyword Planner opportunity tiers.
-- Apply manually in Supabase.

BEGIN;

ALTER TABLE public.keyword_cpc_estimates
  ADD COLUMN IF NOT EXISTS classification_status text NULL,
  ADD COLUMN IF NOT EXISTS efficiency_score numeric NULL,
  ADD COLUMN IF NOT EXISTS classification_version text NULL;

ALTER TABLE public.discovered_term_cpc_estimates
  ADD COLUMN IF NOT EXISTS classification_status text NULL,
  ADD COLUMN IF NOT EXISTS efficiency_score numeric NULL,
  ADD COLUMN IF NOT EXISTS classification_version text NULL;

COMMENT ON COLUMN public.keyword_cpc_estimates.classification_status IS
  'Opportunity tier for this estimate within its sync_run_id (keyword_opportunity_v1).';

COMMENT ON COLUMN public.keyword_cpc_estimates.efficiency_score IS
  'avg_monthly_searches / (high_top_of_page_bid_raw / 1e6); null when discarded or bid invalid.';

COMMENT ON COLUMN public.keyword_cpc_estimates.classification_version IS
  'Classifier algorithm id, e.g. keyword_opportunity_v1. Frozen for that run.';

COMMENT ON COLUMN public.discovered_term_cpc_estimates.classification_status IS
  'Opportunity tier for this estimate within its sync_run_id (keyword_opportunity_v1).';

COMMENT ON COLUMN public.discovered_term_cpc_estimates.efficiency_score IS
  'avg_monthly_searches / (high_top_of_page_bid_raw / 1e6); null when discarded or bid invalid.';

COMMENT ON COLUMN public.discovered_term_cpc_estimates.classification_version IS
  'Classifier algorithm id, e.g. keyword_opportunity_v1. Frozen for that run.';

CREATE INDEX IF NOT EXISTS idx_keyword_cpc_estimates_classification_status
  ON public.keyword_cpc_estimates (classification_status);

CREATE INDEX IF NOT EXISTS idx_discovered_term_cpc_estimates_classification_status
  ON public.discovered_term_cpc_estimates (classification_status);

COMMIT;
