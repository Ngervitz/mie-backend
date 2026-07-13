-- Prerequisite: daily_knowledge multi-kind support for Own Ads Brief.
-- Audited live constraint (2026-07-13): duplicate insert returned
--   duplicate key value violates unique constraint "daily_knowledge_pkey"
-- So UNIQUE(date) is the PRIMARY KEY named daily_knowledge_pkey (not a separate UNIQUE index).

BEGIN;

-- 1) Add kind with default for new rows
ALTER TABLE public.daily_knowledge
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'competitor';

-- 2) Backfill any NULL kind (defensive; NOT NULL DEFAULT should already cover)
UPDATE public.daily_knowledge
SET kind = 'competitor'
WHERE kind IS NULL OR kind = '';

-- 3) Drop the audited primary-key unique on date alone
ALTER TABLE public.daily_knowledge
  DROP CONSTRAINT daily_knowledge_pkey;

-- 4) New uniqueness: one row per (date, kind)
ALTER TABLE public.daily_knowledge
  ADD CONSTRAINT daily_knowledge_date_kind_key UNIQUE (date, kind);

COMMIT;

-- Verification (run after migrate):
-- SELECT kind, COUNT(*) FROM public.daily_knowledge GROUP BY kind;
-- SELECT COUNT(*) AS rows_missing_competitor
-- FROM public.daily_knowledge
-- WHERE kind IS DISTINCT FROM 'competitor';
