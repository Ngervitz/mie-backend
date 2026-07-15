-- Supporting index for event-type distinct labels (event_type + event_time DESC)
-- and filtered history queries on own_ad_changes.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_own_ad_changes_event_type_event_time
  ON public.own_ad_changes (event_type, event_time DESC);

COMMIT;
