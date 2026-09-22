-- CZ funnel encuestas: persist individual answers + analytic fields from GET /encuestas.
-- Additive only. Does not alter PK, existing rows, or completion semantics.
-- Idempotent. No backfill.

BEGIN;

ALTER TABLE public.cz_funnel_encuestas
  ADD COLUMN IF NOT EXISTS tipo text,
  ADD COLUMN IF NOT EXISTS estado text,
  ADD COLUMN IF NOT EXISTS p1 text,
  ADD COLUMN IF NOT EXISTS p2 text,
  ADD COLUMN IF NOT EXISTS p3 text,
  ADD COLUMN IF NOT EXISTS p4 text,
  ADD COLUMN IF NOT EXISTS p5 text,
  ADD COLUMN IF NOT EXISTS p6 text,
  ADD COLUMN IF NOT EXISTS p7 text,
  ADD COLUMN IF NOT EXISTS p8 text,
  ADD COLUMN IF NOT EXISTS p9 text,
  ADD COLUMN IF NOT EXISTS p10 text,
  ADD COLUMN IF NOT EXISTS bloque_1_score_v2 numeric,
  ADD COLUMN IF NOT EXISTS bloque_2_score_v2 numeric,
  ADD COLUMN IF NOT EXISTS bloque_3_score_v2 numeric,
  ADD COLUMN IF NOT EXISTS bloque_4_score_v2 numeric,
  ADD COLUMN IF NOT EXISTS segmentacion_base text,
  ADD COLUMN IF NOT EXISTS b_plus integer,
  ADD COLUMN IF NOT EXISTS version_cuestionario integer,
  ADD COLUMN IF NOT EXISTS canal_origen text;

COMMENT ON COLUMN public.cz_funnel_encuestas.tipo IS
  'CZ /encuestas tipo (e.g. prestamo-rechazado). Raw text; no CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.estado IS
  'CZ /encuestas estado (e.g. completada). Raw text; no CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p1 IS
  'CZ encuesta answer p1. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p2 IS
  'CZ encuesta answer p2. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p3 IS
  'CZ encuesta answer p3. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p4 IS
  'CZ encuesta answer p4. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p5 IS
  'CZ encuesta answer p5. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p6 IS
  'CZ encuesta answer p6. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p7 IS
  'CZ encuesta answer p7. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p8 IS
  'CZ encuesta answer p8. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p9 IS
  'CZ encuesta answer p9. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.p10 IS
  'CZ encuesta answer p10. Observed A/B/C/D; stored as text without CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.bloque_1_score_v2 IS
  'CZ bloque_1_score_v2 numeric subscore.';
COMMENT ON COLUMN public.cz_funnel_encuestas.bloque_2_score_v2 IS
  'CZ bloque_2_score_v2 numeric subscore.';
COMMENT ON COLUMN public.cz_funnel_encuestas.bloque_3_score_v2 IS
  'CZ bloque_3_score_v2 numeric subscore.';
COMMENT ON COLUMN public.cz_funnel_encuestas.bloque_4_score_v2 IS
  'CZ bloque_4_score_v2 numeric subscore.';
COMMENT ON COLUMN public.cz_funnel_encuestas.segmentacion_base IS
  'CZ segmentacion_base (observed A/B/C). Raw text; no CHECK.';
COMMENT ON COLUMN public.cz_funnel_encuestas.b_plus IS
  'CZ b_plus flag. Observed 0/1 integer; stored as integer (not boolean).';
COMMENT ON COLUMN public.cz_funnel_encuestas.version_cuestionario IS
  'CZ version_cuestionario integer.';
COMMENT ON COLUMN public.cz_funnel_encuestas.canal_origen IS
  'CZ canal_origen (e.g. web). Raw text; no CHECK.';

COMMIT;
