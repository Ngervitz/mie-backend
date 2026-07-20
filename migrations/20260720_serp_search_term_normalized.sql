-- Additive: normalized search term for grouping/comparison.
-- Original search_term display values are never rewritten.

BEGIN;

ALTER TABLE public.google_serp_captures
  ADD COLUMN IF NOT EXISTS search_term_normalized text;

-- Backfill (Spanish diacritics + whitespace). Future rows use the JS helper
-- normalizeSearchTerm() which also applies Unicode NFD stripping.
UPDATE public.google_serp_captures
SET search_term_normalized = lower(
  trim(
    regexp_replace(
      translate(
        search_term,
        'ÁÀÄÂÃáàäâãÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔÕóòöôõÚÙÜÛúùüûÑñÇç',
        'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'
      ),
      '\s+',
      ' ',
      'g'
    )
  )
)
WHERE search_term_normalized IS NULL
  AND search_term IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_google_serp_captures_term_normalized
  ON public.google_serp_captures (search_term_normalized);

COMMIT;
