-- Coverage-gap suggestions + SEO landing drafts (MetaDash Fase D).
-- Schema audit 2026-07-17: no existing tables named search_term_discoveries,
-- confirmed_search_terms or seo_landing_drafts. Score columns use numeric,
-- consistent with search_trends.interest_index.

BEGIN;

-- Append-only capture of Google Trends related-queries discovery runs.
-- The suggestions UI reads ONLY from here (never triggers live Trends calls).
CREATE TABLE IF NOT EXISTS public.search_term_discoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed text NOT NULL,
  term text NOT NULL,
  query_type text NOT NULL,          -- 'top' | 'rising'
  score numeric NULL,                -- relative 0-100 (top) or growth % (rising)
  formatted_value text NULL,         -- e.g. '+3.900 %'
  raw_json jsonb NULL,
  discovered_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_term_discoveries_term
  ON public.search_term_discoveries (term, discovered_at DESC);

-- Human triage decisions over discovered terms.
CREATE TABLE IF NOT EXISTS public.confirmed_search_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL,
  term_type text NOT NULL,           -- 'generic' | 'competitor_candidate'
  decision text NOT NULL,            -- 'monitor_trends' | 'added_as_competitor' | 'discarded'
  source_seed text NULL,             -- Trends discovery seed the term came from
  discovered_score numeric NULL,     -- top/rising score at time of discovery
  entity_id uuid NULL REFERENCES public.monitored_entities(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One decision per term (a re-decision should update, not duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS confirmed_search_terms_term_key
  ON public.confirmed_search_terms (term);

-- Draft SEO landings generated for terms decided as 'monitor_trends'.
-- NEVER auto-published: status transitions past 'draft' are human actions.
CREATE TABLE IF NOT EXISTS public.seo_landing_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id uuid NOT NULL REFERENCES public.confirmed_search_terms(id),
  html_content text NULL,            -- NULL when status='failed'
  storage_path text NULL,            -- key of the .html file in Supabase Storage
  status text NOT NULL DEFAULT 'draft',  -- 'draft' | 'reviewed' | 'published' | 'failed'
  generation_error text NULL,
  generated_at timestamptz NULL,
  reviewed_at timestamptz NULL,
  published_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_landing_drafts_term_id
  ON public.seo_landing_drafts (term_id, created_at DESC);

COMMIT;
