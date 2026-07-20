-- Allow placement='organic' for organic SERP rows (result_type='organic').
-- Prior CHECK only allowed top | bottom | unknown.

BEGIN;

ALTER TABLE public.google_serp_ads_manual
  DROP CONSTRAINT IF EXISTS google_serp_ads_manual_placement_check;

ALTER TABLE public.google_serp_ads_manual
  ADD CONSTRAINT google_serp_ads_manual_placement_check
  CHECK (placement IN ('top', 'bottom', 'unknown', 'organic'));

COMMIT;
