-- AI Visibility — candidatos heurísticos en negrita Markdown (manual).
-- Apply manually in Supabase. No backfill: historical rows keep [].

BEGIN;

ALTER TABLE public.ai_visibility_responses
  ADD COLUMN IF NOT EXISTS unknown_candidates JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
