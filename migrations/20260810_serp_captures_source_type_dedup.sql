-- SERP captures: distinguish HTML manual vs Serper JSON, and split dedup rules.
--
-- HTML manual: unique file_hash (global among html_manual) — same as before.
-- Serper JSON: unique (file_hash, date) — same content allowed on different days.
--
-- Apply manually in Supabase SQL editor.

BEGIN;

ALTER TABLE public.google_serp_captures
  ADD COLUMN IF NOT EXISTS source_type text;

UPDATE public.google_serp_captures
SET source_type = 'html_manual'
WHERE source_type IS NULL;

-- Existing Serper imports live under serp-json-imports/ — reclassify before indexes.
UPDATE public.google_serp_captures
SET source_type = 'serper_json'
WHERE storage_path LIKE 'serp-json-imports/%';

ALTER TABLE public.google_serp_captures
  ALTER COLUMN source_type SET DEFAULT 'html_manual';

ALTER TABLE public.google_serp_captures
  ALTER COLUMN source_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'google_serp_captures_source_type_check'
  ) THEN
    ALTER TABLE public.google_serp_captures
      ADD CONSTRAINT google_serp_captures_source_type_check
      CHECK (source_type IN ('html_manual', 'serper_json'));
  END IF;
END $$;

-- Drop global UNIQUE(file_hash) — name from original migration.
ALTER TABLE public.google_serp_captures
  DROP CONSTRAINT IF EXISTS google_serp_captures_file_hash_key;

-- HTML: one file_hash ever (among html_manual rows).
CREATE UNIQUE INDEX IF NOT EXISTS google_serp_captures_html_file_hash_uidx
  ON public.google_serp_captures (file_hash)
  WHERE source_type = 'html_manual';

-- Serper: one file_hash per calendar date (among serper_json rows).
CREATE UNIQUE INDEX IF NOT EXISTS google_serp_captures_serper_file_hash_date_uidx
  ON public.google_serp_captures (file_hash, date)
  WHERE source_type = 'serper_json';

COMMIT;
