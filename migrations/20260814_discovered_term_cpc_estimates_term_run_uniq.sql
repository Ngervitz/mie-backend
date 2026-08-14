-- Prevent duplicate CPC snapshots for the same exact term within one sync run.
-- Comparison is exact on term_snapshot (accents/case matter): "tarjeta de crédito"
-- and "tarjeta de credito" remain two distinct keys.
-- Apply manually in Supabase SQL Editor.
--
-- Pre-check (expect 0 rows) before ALTER:
--   SELECT term_snapshot, sync_run_id, count(*) AS n
--   FROM public.discovered_term_cpc_estimates
--   GROUP BY term_snapshot, sync_run_id
--   HAVING count(*) > 1;

BEGIN;

ALTER TABLE public.discovered_term_cpc_estimates
  ADD CONSTRAINT discovered_term_cpc_estimates_term_run_uniq
  UNIQUE (term_snapshot, sync_run_id);

COMMENT ON CONSTRAINT discovered_term_cpc_estimates_term_run_uniq
  ON public.discovered_term_cpc_estimates IS
  'At most one estimate row per exact term_snapshot within a sync_run_id.';

COMMIT;
