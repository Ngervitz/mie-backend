-- Uruguay economic calendar (capture-only): holidays + BPS payment windows.
-- Not consumed by any brief/analysis yet.

BEGIN;

CREATE TABLE IF NOT EXISTS public.economic_calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,          -- 'holiday' | 'bps_payment'
  title text NOT NULL,
  date_start date NOT NULL,
  date_end date NULL,                -- for ranges (Semana de Turismo, BPS windows)
  description text NULL,
  source text NOT NULL,              -- 'calculated' | 'bps_scrape'
  raw_text text NULL,                -- original snippet for auditability
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: re-running the holiday calculation or the monthly BPS scrape
-- must upsert against this key instead of inserting duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS economic_calendar_events_dedup_key
  ON public.economic_calendar_events (event_type, date_start, title, source);

CREATE INDEX IF NOT EXISTS idx_economic_calendar_events_date_start
  ON public.economic_calendar_events (date_start);

COMMIT;
