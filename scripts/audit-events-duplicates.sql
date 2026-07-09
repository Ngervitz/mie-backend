-- Events deduplication audit (run in Supabase SQL Editor)

-- 1. Constraints on events
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.events'::regclass;

-- 2. Indexes on events
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'events';

-- 3. Duplicate rows (exact key)
SELECT entity_id, ad_id, event_type, detected_at, COUNT(*) AS cnt
FROM events
GROUP BY entity_id, ad_id, event_type, detected_at
HAVING COUNT(*) > 1
ORDER BY cnt DESC;

-- 4. Duplicates for new_ad / ad_reactivated only
SELECT entity_id, ad_id, event_type, detected_at, COUNT(*) AS cnt
FROM events
WHERE event_type IN ('new_ad', 'ad_reactivated')
  AND ad_id IS NOT NULL
GROUP BY entity_id, ad_id, event_type, detected_at
HAVING COUNT(*) > 1
ORDER BY cnt DESC;
