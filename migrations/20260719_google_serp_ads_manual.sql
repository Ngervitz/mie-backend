-- Manual Google SERP HTML imports (Phase 1 — no scraper).
-- Nico saves a real Google search page (Ctrl+S) and uploads the .html;
-- we parse [data-text-ad="1"] blocks and archive the raw file.
--
-- Bucket (create once in Supabase Storage as PRIVATE):
--   id/name: serp-html-imports
--   public: false
-- The importer also attempts createBucket on first use if missing.

BEGIN;

CREATE TABLE IF NOT EXISTS public.google_serp_ads_manual (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_term text NOT NULL,
  date date NOT NULL,
  advertiser_name text NULL,
  advertiser_domain text NULL,
  ad_title text NOT NULL,
  ad_description text NULL,
  destination_url text NULL,
  position integer NOT NULL,
  raw_html_storage_path text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_google_serp_ads_manual_imported_at
  ON public.google_serp_ads_manual (imported_at DESC);

CREATE INDEX IF NOT EXISTS idx_google_serp_ads_manual_date_term
  ON public.google_serp_ads_manual (date DESC, search_term);

CREATE INDEX IF NOT EXISTS idx_google_serp_ads_manual_storage_path
  ON public.google_serp_ads_manual (raw_html_storage_path);

COMMIT;
