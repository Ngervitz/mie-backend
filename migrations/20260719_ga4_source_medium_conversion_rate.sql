-- GA4 capture: add source/medium breakdown + calculated conversion_rate.
--
-- Idempotency key grows from (date, channel_group, landing_page) to
-- (date, channel_group, landing_page, source, medium). Postgres UNIQUE
-- treats NULL as never-equal-to-NULL, so source/medium MUST be NOT NULL
-- (default '(not set)', matching the collector's dimension normalization)
-- before they can participate in the constraint. Safe sequential order:
-- add nullable -> backfill -> default -> not null -> swap constraint.

BEGIN;

-- 1. Add columns (nullable at first).
ALTER TABLE public.ga4_metrics
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS medium text,
  ADD COLUMN IF NOT EXISTS conversion_rate numeric NULL;

-- 2-3. Backfill existing rows (captured before the breakdown existed).
UPDATE public.ga4_metrics SET source = '(not set)' WHERE source IS NULL;
UPDATE public.ga4_metrics SET medium = '(not set)' WHERE medium IS NULL;

-- 4-5. Lock in default + NOT NULL so the unique key is always comparable.
ALTER TABLE public.ga4_metrics
  ALTER COLUMN source SET DEFAULT '(not set)',
  ALTER COLUMN source SET NOT NULL;
ALTER TABLE public.ga4_metrics
  ALTER COLUMN medium SET DEFAULT '(not set)',
  ALTER COLUMN medium SET NOT NULL;

-- 6. Swap the idempotency key to the 5-column combination.
DROP INDEX IF EXISTS public.ga4_metrics_day_key;
CREATE UNIQUE INDEX IF NOT EXISTS ga4_metrics_day_key
  ON public.ga4_metrics (date, channel_group, landing_page, source, medium);

-- conversion_rate: key_events / sessions, NULL when sessions is 0/absent
-- (never Infinity/NaN/fabricated 0) — computed by the collector, same
-- null-safety discipline as CTR/CPC in own-ads metrics.
COMMENT ON COLUMN public.ga4_metrics.conversion_rate IS
  'key_events / sessions (ratio). NULL when sessions = 0 or absent.';

COMMIT;
