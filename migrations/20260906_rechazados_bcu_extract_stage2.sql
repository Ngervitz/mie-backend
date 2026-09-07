-- Rechazados BCU extract Stage 2: null-aware balances, snapshot extract meta,
-- llm_assisted source, extraction drafts table.
-- Apply manually in Supabase AFTER 20260903_rechazados_v0.sql.
-- Idempotent where practical. Does NOT convert legacy 0 → null.
-- Does NOT create purge cron/job. Draft retention policy deferred.

BEGIN;

-- =====================================================================
-- A. rejected_bcu_institutions — null-aware amounts
-- =====================================================================

ALTER TABLE public.rejected_bcu_institutions
  DROP CONSTRAINT IF EXISTS rejected_bcu_institutions_balances_nonneg_check;

-- Existing 8 → nullable; drop DEFAULT 0.
-- NO UPDATE of legacy 0 → null.
ALTER TABLE public.rejected_bcu_institutions
  ALTER COLUMN vigente_mn DROP NOT NULL,
  ALTER COLUMN vigente_mn DROP DEFAULT,
  ALTER COLUMN vigente_me DROP NOT NULL,
  ALTER COLUMN vigente_me DROP DEFAULT,
  ALTER COLUMN moroso_mn DROP NOT NULL,
  ALTER COLUMN moroso_mn DROP DEFAULT,
  ALTER COLUMN moroso_me DROP NOT NULL,
  ALTER COLUMN moroso_me DROP DEFAULT,
  ALTER COLUMN castigado_mn DROP NOT NULL,
  ALTER COLUMN castigado_mn DROP DEFAULT,
  ALTER COLUMN castigado_me DROP NOT NULL,
  ALTER COLUMN castigado_me DROP DEFAULT,
  ALTER COLUMN contingencias_mn DROP NOT NULL,
  ALTER COLUMN contingencias_mn DROP DEFAULT,
  ALTER COLUMN contingencias_me DROP NOT NULL,
  ALTER COLUMN contingencias_me DROP DEFAULT;

ALTER TABLE public.rejected_bcu_institutions
  ADD COLUMN IF NOT EXISTS vigente_no_autoliquidable_mn numeric NULL,
  ADD COLUMN IF NOT EXISTS vigente_no_autoliquidable_me numeric NULL,
  ADD COLUMN IF NOT EXISTS creditos_reestructurados_mn numeric NULL,
  ADD COLUMN IF NOT EXISTS creditos_reestructurados_me numeric NULL;

ALTER TABLE public.rejected_bcu_institutions
  DROP CONSTRAINT IF EXISTS rejected_bcu_institutions_balances_null_or_nonneg_check;

ALTER TABLE public.rejected_bcu_institutions
  ADD CONSTRAINT rejected_bcu_institutions_balances_null_or_nonneg_check CHECK (
    (vigente_mn IS NULL OR vigente_mn >= 0) AND
    (vigente_me IS NULL OR vigente_me >= 0) AND
    (moroso_mn IS NULL OR moroso_mn >= 0) AND
    (moroso_me IS NULL OR moroso_me >= 0) AND
    (castigado_mn IS NULL OR castigado_mn >= 0) AND
    (castigado_me IS NULL OR castigado_me >= 0) AND
    (contingencias_mn IS NULL OR contingencias_mn >= 0) AND
    (contingencias_me IS NULL OR contingencias_me >= 0) AND
    (vigente_no_autoliquidable_mn IS NULL OR vigente_no_autoliquidable_mn >= 0) AND
    (vigente_no_autoliquidable_me IS NULL OR vigente_no_autoliquidable_me >= 0) AND
    (creditos_reestructurados_mn IS NULL OR creditos_reestructurados_mn >= 0) AND
    (creditos_reestructurados_me IS NULL OR creditos_reestructurados_me >= 0)
  );

COMMENT ON COLUMN public.rejected_bcu_institutions.vigente_mn IS
  'MN vigente. null = absent/illegible under bcu_v1. Pre-nullable 0s are legacy (unknown semantics); not auto-converted to null.';

COMMENT ON COLUMN public.rejected_bcu_institutions.vigente_no_autoliquidable_mn IS
  'MN vigente no autoliquidable. null = absent/illegible.';

COMMENT ON COLUMN public.rejected_bcu_institutions.creditos_reestructurados_mn IS
  'MN créditos reestructurados. null = absent/illegible.';

-- =====================================================================
-- B. rejected_bcu_snapshots — extract metadata + source expand
-- =====================================================================

-- Historical rows must stay explicit manual (never null).
UPDATE public.rejected_bcu_snapshots
SET source = 'manual'
WHERE source IS NULL;

ALTER TABLE public.rejected_bcu_snapshots
  DROP CONSTRAINT IF EXISTS rejected_bcu_snapshots_source_check;

ALTER TABLE public.rejected_bcu_snapshots
  ADD CONSTRAINT rejected_bcu_snapshots_source_check
    CHECK (source IN ('manual', 'llm_assisted'));

-- source remains NOT NULL DEFAULT 'manual' (unchanged nullability).

ALTER TABLE public.rejected_bcu_snapshots
  ADD COLUMN IF NOT EXISTS currency_view_selected text NULL,
  ADD COLUMN IF NOT EXISTS extraction_contract_version text NULL,
  ADD COLUMN IF NOT EXISTS document_ci_raw text NULL,
  ADD COLUMN IF NOT EXISTS summary jsonb NULL,
  ADD COLUMN IF NOT EXISTS summary_validation_status text NULL,
  ADD COLUMN IF NOT EXISTS summary_validation jsonb NULL;

ALTER TABLE public.rejected_bcu_snapshots
  DROP CONSTRAINT IF EXISTS rejected_bcu_snapshots_currency_view_check;

ALTER TABLE public.rejected_bcu_snapshots
  ADD CONSTRAINT rejected_bcu_snapshots_currency_view_check CHECK (
    currency_view_selected IS NULL OR currency_view_selected IN (
      'MN_PESOS_ME_PESOS',
      'MN_PESOS_ME_USD',
      'MN_USD_ME_USD',
      'UNKNOWN'
    )
  );

-- Same vocabulary as Stage 1 SUMMARY_DETAIL cell status.
-- NULL = reconciliation not applicable (e.g. manual snapshot without LLM summary).
ALTER TABLE public.rejected_bcu_snapshots
  DROP CONSTRAINT IF EXISTS rejected_bcu_snapshots_summary_validation_status_check;

ALTER TABLE public.rejected_bcu_snapshots
  ADD CONSTRAINT rejected_bcu_snapshots_summary_validation_status_check CHECK (
    summary_validation_status IS NULL OR summary_validation_status IN (
      'MATCH',
      'MISMATCH',
      'NOT_COMPARABLE'
    )
  );

COMMENT ON COLUMN public.rejected_bcu_snapshots.summary IS
  'Independent BCU summary block (bcu_v1 rubros). Not derived by summing institutions.';

COMMENT ON COLUMN public.rejected_bcu_snapshots.summary_validation_status IS
  'Stage 1 SUMMARY_DETAIL aggregate: MATCH | MISMATCH | NOT_COMPARABLE. NULL = no applicable reconciliation (e.g. manual).';

COMMENT ON COLUMN public.rejected_bcu_snapshots.summary_validation IS
  'Optional machine-readable gate findings (reason_codes, paths). Not a substitute for human confirm.';

COMMENT ON COLUMN public.rejected_bcu_snapshots.source IS
  'manual = operator form; llm_assisted = confirmed after LLM draft. Historical rows are manual.';

-- =====================================================================
-- C. rejected_bcu_extraction_drafts
-- Retention TTLs deferred: expires_at / purge_after nullable; no pending-expires CHECK; no cron.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.rejected_bcu_extraction_drafts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ci                          bigint NOT NULL,
  status                      text NOT NULL DEFAULT 'pending_review',
  -- file (draft-owned path; no CI in path)
  storage_path                text NULL,
  original_filename           text NULL,
  content_type                text NULL,
  file_size_bytes             integer NULL,
  -- payloads
  extraction_json             jsonb NOT NULL,
  validation_json             jsonb NOT NULL,
  extraction_contract_version text NOT NULL DEFAULT 'bcu_v1',
  currency_view_selected      text NULL,
  document_ci_raw             text NULL,
  -- linkage after confirm
  confirmed_snapshot_id       uuid NULL
    REFERENCES public.rejected_bcu_snapshots (id) ON DELETE SET NULL,
  -- audit / retention hooks (policy deferred; no job in this migration)
  created_by                  uuid NULL
    REFERENCES public.dashboard_users (id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  expires_at                  timestamptz NULL,
  abandoned_at                timestamptz NULL,
  confirmed_at                timestamptz NULL,
  purge_after                 timestamptz NULL,
  CONSTRAINT rejected_bcu_extraction_drafts_status_check CHECK (
    status IN ('pending_review', 'confirmed', 'abandoned', 'expired')
  ),
  CONSTRAINT rejected_bcu_extraction_drafts_file_size_check CHECK (
    file_size_bytes IS NULL OR file_size_bytes >= 0
  ),
  CONSTRAINT rejected_bcu_extraction_drafts_currency_view_check CHECK (
    currency_view_selected IS NULL OR currency_view_selected IN (
      'MN_PESOS_ME_PESOS',
      'MN_PESOS_ME_USD',
      'MN_USD_ME_USD',
      'UNKNOWN'
    )
  ),
  CONSTRAINT rejected_bcu_extraction_drafts_confirmed_snapshot_check CHECK (
    status <> 'confirmed' OR confirmed_snapshot_id IS NOT NULL
  )
);

COMMENT ON TABLE public.rejected_bcu_extraction_drafts IS
  'LLM-assisted BCU extraction drafts pending human review. Not confirmed facts. Retention/purge policy deferred; expires_at and purge_after are nullable hooks for a future job.';

CREATE INDEX IF NOT EXISTS idx_rejected_bcu_extraction_drafts_ci_created
  ON public.rejected_bcu_extraction_drafts (ci, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rejected_bcu_extraction_drafts_status_expires
  ON public.rejected_bcu_extraction_drafts (status, expires_at)
  WHERE status = 'pending_review';

CREATE INDEX IF NOT EXISTS idx_rejected_bcu_extraction_drafts_purge_after
  ON public.rejected_bcu_extraction_drafts (purge_after)
  WHERE purge_after IS NOT NULL;

COMMIT;
