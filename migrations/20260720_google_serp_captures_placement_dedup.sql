-- Google SERP import improvements:
--   1) google_serp_captures (one row per uploaded HTML / search event)
--   2) google_serp_ads_manual.capture_id FK + placement
--   3) Backfill the existing "prestamos con cedula" import (6 ads)
--
-- file_hash for the known sample (SHA256 of samples/prestamos con cedula - Google Search.html):
--   2b454155ac4e2e92bd9089c98da495e945dad83d33515ed394c8f0bd08762973

BEGIN;

CREATE TABLE IF NOT EXISTS public.google_serp_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_term text NOT NULL,
  date date NOT NULL,
  storage_path text NOT NULL,
  file_hash text NOT NULL,
  parse_status text NOT NULL,
  ads_found integer NOT NULL DEFAULT 0,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_serp_captures_file_hash_key UNIQUE (file_hash),
  CONSTRAINT google_serp_captures_parse_status_check
    CHECK (parse_status IN ('success', 'no_ads_found', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_google_serp_captures_imported_at
  ON public.google_serp_captures (imported_at DESC);

CREATE INDEX IF NOT EXISTS idx_google_serp_captures_date_term
  ON public.google_serp_captures (date DESC, search_term);

-- New columns on ads table (nullable first for backfill).
ALTER TABLE public.google_serp_ads_manual
  ADD COLUMN IF NOT EXISTS capture_id uuid NULL;

ALTER TABLE public.google_serp_ads_manual
  ADD COLUMN IF NOT EXISTS placement text NULL;

-- Restrict placement values (allow NULL during backfill; we'll set NOT NULL-ish via check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'google_serp_ads_manual_placement_check'
  ) THEN
    ALTER TABLE public.google_serp_ads_manual
      ADD CONSTRAINT google_serp_ads_manual_placement_check
      CHECK (placement IS NULL OR placement IN ('top', 'bottom', 'unknown'));
  END IF;
END $$;

-- Backfill: one capture for the existing real import (6 ads, same storage_path).
WITH existing AS (
  SELECT
    MIN(imported_at) AS imported_at,
    MIN(search_term) AS search_term,
    MIN(date) AS date,
    MIN(raw_html_storage_path) AS storage_path,
    COUNT(*)::integer AS ads_found
  FROM public.google_serp_ads_manual
  WHERE capture_id IS NULL
    AND raw_html_storage_path =
      'serp-html-imports/1784508079165-8b8c9b9f-56b7-4364-9d32-08aaa68dddd1.html'
),
ins AS (
  INSERT INTO public.google_serp_captures (
    search_term,
    date,
    storage_path,
    file_hash,
    parse_status,
    ads_found,
    imported_at
  )
  SELECT
    e.search_term,
    e.date,
    e.storage_path,
    '2b454155ac4e2e92bd9089c98da495e945dad83d33515ed394c8f0bd08762973',
    'success',
    e.ads_found,
    e.imported_at
  FROM existing e
  WHERE e.storage_path IS NOT NULL
  ON CONFLICT (file_hash) DO UPDATE
    SET storage_path = EXCLUDED.storage_path
  RETURNING id, storage_path
)
UPDATE public.google_serp_ads_manual a
SET capture_id = i.id
FROM ins i
WHERE a.raw_html_storage_path = i.storage_path
  AND a.capture_id IS NULL;

-- Placement for that known capture (audit: #tads / data-hb=t vs data-hb=b).
UPDATE public.google_serp_ads_manual
SET placement = CASE
  WHEN position BETWEEN 1 AND 4 THEN 'top'
  WHEN position IN (5, 6) THEN 'bottom'
  ELSE 'unknown'
END
WHERE raw_html_storage_path =
  'serp-html-imports/1784508079165-8b8c9b9f-56b7-4364-9d32-08aaa68dddd1.html'
  AND (placement IS NULL OR placement = 'unknown');

-- Default any leftover ads without placement.
UPDATE public.google_serp_ads_manual
SET placement = 'unknown'
WHERE placement IS NULL;

-- If there are still ads without a capture (shouldn't happen for the known import),
-- refuse to proceed to NOT NULL — leave capture_id nullable only if empty table edge case.
-- For the known 6 rows, enforce NOT NULL + FK now.

DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM public.google_serp_ads_manual
  WHERE capture_id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Cannot set capture_id NOT NULL: % google_serp_ads_manual rows still lack capture_id',
      orphan_count;
  END IF;
END $$;

ALTER TABLE public.google_serp_ads_manual
  ALTER COLUMN capture_id SET NOT NULL;

ALTER TABLE public.google_serp_ads_manual
  ALTER COLUMN placement SET NOT NULL;

ALTER TABLE public.google_serp_ads_manual
  ALTER COLUMN placement SET DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'google_serp_ads_manual_capture_id_fkey'
  ) THEN
    ALTER TABLE public.google_serp_ads_manual
      ADD CONSTRAINT google_serp_ads_manual_capture_id_fkey
      FOREIGN KEY (capture_id)
      REFERENCES public.google_serp_captures (id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_google_serp_ads_manual_capture_id
  ON public.google_serp_ads_manual (capture_id);

COMMIT;
