-- OPTIONAL — apply only after PASO 0 audit confirms no duplicate apify_run_id rows.
-- See scripts/audit-run-history-paso0.sql query #2.
-- If this migration fails with "duplicate key", do not force it; resolve duplicates separately.

CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_snapshots_apify_run_id_unique
  ON public.ad_snapshots (apify_run_id)
  WHERE apify_run_id IS NOT NULL;
