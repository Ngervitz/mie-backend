-- MIE Events deduplication (pre-Activity V1)
-- One row per (entity_id, ad_id, detected_at) for new_ad, ad_reactivated, ad_deactivated.
-- copy_changed is NOT included: multiple copy changes per ad/day remain valid.
--
-- Note: PostgREST cannot target partial UNIQUE indexes via ignoreDuplicates/onConflict
-- (no WHERE predicate). Application uses row-by-row insert with 23505 skip; these
-- indexes enforce dedup at DB level for concurrent writers.

-- Remove exact duplicates for covered types (keep row with smallest id / earliest insert).
DELETE FROM public.events a
USING public.events b
WHERE a.id > b.id
  AND a.entity_id = b.entity_id
  AND a.ad_id = b.ad_id
  AND a.ad_id IS NOT NULL
  AND a.event_type = b.event_type
  AND a.detected_at = b.detected_at
  AND a.event_type IN ('new_ad', 'ad_reactivated', 'ad_deactivated');

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_new_ad
  ON public.events (entity_id, ad_id, detected_at)
  WHERE event_type = 'new_ad' AND ad_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_reactivated
  ON public.events (entity_id, ad_id, detected_at)
  WHERE event_type = 'ad_reactivated' AND ad_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_deactivated
  ON public.events (entity_id, ad_id, detected_at)
  WHERE event_type = 'ad_deactivated' AND ad_id IS NOT NULL;
