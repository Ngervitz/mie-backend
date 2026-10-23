-- Etapa A: landings manuales en la misma tabla seo_landing_drafts.
-- Preparada para ejecución manual. No aplicar desde la aplicación ni desde este cambio.
--
-- Auditoría previa (migración 20260717_coverage_suggestions.sql y filas vivas):
--   seo_landing_drafts.term_id uuid NOT NULL REFERENCES confirmed_search_terms(id)
--   sin columnas origin, topic, slug, suggested_title, custom_instructions, content_json
-- Las filas existentes quedan origin='discovered', slug NULL y content_json NULL.
-- No se regenera su HTML.

BEGIN;

ALTER TABLE public.seo_landing_drafts
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'discovered',
  ADD COLUMN IF NOT EXISTS topic text NULL,
  ADD COLUMN IF NOT EXISTS suggested_title text NULL,
  ADD COLUMN IF NOT EXISTS custom_instructions text NULL,
  ADD COLUMN IF NOT EXISTS content_json jsonb NULL,
  ADD COLUMN IF NOT EXISTS slug text NULL;

ALTER TABLE public.seo_landing_drafts
  ALTER COLUMN term_id DROP NOT NULL;

ALTER TABLE public.seo_landing_drafts
  DROP CONSTRAINT IF EXISTS seo_landing_drafts_origin_check;

ALTER TABLE public.seo_landing_drafts
  ADD CONSTRAINT seo_landing_drafts_origin_check
  CHECK (origin IN ('discovered', 'manual'));

ALTER TABLE public.seo_landing_drafts
  DROP CONSTRAINT IF EXISTS seo_landing_drafts_origin_term_check;

ALTER TABLE public.seo_landing_drafts
  ADD CONSTRAINT seo_landing_drafts_origin_term_check
  CHECK (
    (origin = 'discovered' AND term_id IS NOT NULL)
    OR (
      origin = 'manual'
      AND term_id IS NULL
      AND topic IS NOT NULL
      AND length(btrim(topic)) > 0
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS seo_landing_drafts_slug_uidx
  ON public.seo_landing_drafts (slug)
  WHERE slug IS NOT NULL;

COMMIT;
