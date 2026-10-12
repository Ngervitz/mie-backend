-- Remove the July 2026 Make.com backfill from own_ad_metrics and
-- enforce one row per entity, campaign and date.
--
-- Verified before writing this file (read-only):
--   run d4a56399-e005-42e3-885a-c2ee033e9437  source " make_facebook_insights"  77 rows
--   run 6a2a0188-2f3a-43ef-914c-7140eb327b5c  source " make_facebook_insights"  77 rows
--   native meta_marketing_api runs owned 0 metric rows
--   no foreign key references public.own_ad_metrics
--
-- Does NOT delete own_ad_metric_runs or any other table.
-- Apply manually in Supabase. Do not run from deploy.

BEGIN;

DELETE FROM public.own_ad_metrics
WHERE run_id IN (
  'd4a56399-e005-42e3-885a-c2ee033e9437'::uuid,
  '6a2a0188-2f3a-43ef-914c-7140eb327b5c'::uuid
);

DO $$
DECLARE
  leftover integer;
  dupes integer;
BEGIN
  SELECT count(*) INTO leftover
  FROM public.own_ad_metrics
  WHERE run_id IN (
    'd4a56399-e005-42e3-885a-c2ee033e9437'::uuid,
    '6a2a0188-2f3a-43ef-914c-7140eb327b5c'::uuid
  );
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'Make import rows still present: %', leftover;
  END IF;

  SELECT count(*) INTO dupes
  FROM (
    SELECT 1
    FROM public.own_ad_metrics
    GROUP BY entity_id, campaign_id, metric_date
    HAVING count(*) > 1
  ) d;
  IF dupes <> 0 THEN
    RAISE EXCEPTION 'Cannot add UNIQUE: % duplicate natural keys remain', dupes;
  END IF;
END $$;

ALTER TABLE public.own_ad_metrics
  ADD CONSTRAINT own_ad_metrics_entity_campaign_date_key
  UNIQUE (entity_id, campaign_id, metric_date);

COMMIT;
