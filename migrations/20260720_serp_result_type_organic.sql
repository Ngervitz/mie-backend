-- SERP import: distinguish paid ads vs organic web results in the same table.
-- Historical rows default to result_type='ad'.

BEGIN;

ALTER TABLE public.google_serp_ads_manual
  ADD COLUMN IF NOT EXISTS result_type text;

UPDATE public.google_serp_ads_manual
SET result_type = 'ad'
WHERE result_type IS NULL;

ALTER TABLE public.google_serp_ads_manual
  ALTER COLUMN result_type SET DEFAULT 'ad';

ALTER TABLE public.google_serp_ads_manual
  ALTER COLUMN result_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'google_serp_ads_manual_result_type_check'
  ) THEN
    ALTER TABLE public.google_serp_ads_manual
      ADD CONSTRAINT google_serp_ads_manual_result_type_check
      CHECK (result_type IN ('ad', 'organic'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_google_serp_ads_manual_capture_result
  ON public.google_serp_ads_manual (capture_id, result_type);

-- Placement for organic rows (independent of ad top/bottom).
ALTER TABLE public.google_serp_ads_manual
  DROP CONSTRAINT IF EXISTS google_serp_ads_manual_placement_check;

ALTER TABLE public.google_serp_ads_manual
  ADD CONSTRAINT google_serp_ads_manual_placement_check
  CHECK (placement IN ('top', 'bottom', 'unknown', 'organic'));

-- confirmed_search_terms.decision has no DB CHECK in the original migration
-- (only a comment). Pending SERP unmatched domains use decision='pending'
-- so they can surface in the Pendientes triage queue until a human decides.

COMMIT;
