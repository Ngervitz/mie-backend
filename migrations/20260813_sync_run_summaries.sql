-- LLM comparative analysis summaries per CPC sync run.
-- Apply manually in Supabase.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sync_run_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid NOT NULL,
  source_table text NOT NULL,
  summary_text text NOT NULL,
  structured_analysis jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_new_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  classification_version text NULL,
  model_used text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_run_summaries_source_table_allowed
    CHECK (source_table IN (
      'keyword_cpc_estimates',
      'discovered_term_cpc_estimates'
    )),
  CONSTRAINT sync_run_summaries_summary_text_nonempty
    CHECK (char_length(trim(summary_text)) > 0),
  CONSTRAINT sync_run_summaries_sync_source_unique
    UNIQUE (sync_run_id, source_table)
);

COMMENT ON TABLE public.sync_run_summaries IS
  'Claude comparative analysis of a CPC sync_run (post classification). One row per (sync_run_id, source_table); upsert on re-run.';

COMMENT ON COLUMN public.sync_run_summaries.structured_analysis IS
  'comparative_analysis array from validated Claude JSON.';

COMMENT ON COLUMN public.sync_run_summaries.suggested_new_terms IS
  'Hypotheses only — not measured by Keyword Planner; never auto-inserted into catalogs.';

CREATE INDEX IF NOT EXISTS idx_sync_run_summaries_generated_at
  ON public.sync_run_summaries (generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_run_summaries_source
  ON public.sync_run_summaries (source_table, generated_at DESC);

COMMIT;
