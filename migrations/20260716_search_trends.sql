-- Google Trends capture (Fase D, capture-only; not consumed by analysis yet).
-- interest_index is Google's RELATIVE interest index (0-100, normalized to the
-- term's own max within the queried window) — NOT absolute search volume.

BEGIN;

CREATE TABLE IF NOT EXISTS public.search_trends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL,
  term_type text NOT NULL,           -- 'generic' | 'competitor'
  entity_id uuid NULL REFERENCES public.monitored_entities(id),
  date date NOT NULL,
  interest_index numeric NULL,
  raw_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: re-running the collector upserts against (term, date).
CREATE UNIQUE INDEX IF NOT EXISTS search_trends_term_date_key
  ON public.search_trends (term, date);

CREATE INDEX IF NOT EXISTS idx_search_trends_date
  ON public.search_trends (date);

COMMIT;
