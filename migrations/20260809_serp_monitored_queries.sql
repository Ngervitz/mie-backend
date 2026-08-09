-- Catalog of SERP search queries for monitoring / Serper automation.
-- Display text preserved in query_text; uniqueness via query_text_normalized
-- (same rules as google_serp_captures.search_term_normalized).

BEGIN;

CREATE TABLE IF NOT EXISTS public.serp_monitored_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text text NOT NULL,
  query_text_normalized text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT serp_monitored_queries_query_text_normalized_key
    UNIQUE (query_text_normalized),
  CONSTRAINT serp_monitored_queries_query_text_nonempty
    CHECK (char_length(trim(query_text)) > 0),
  CONSTRAINT serp_monitored_queries_normalized_nonempty
    CHECK (char_length(trim(query_text_normalized)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_serp_monitored_queries_active_created
  ON public.serp_monitored_queries (active, created_at DESC);

-- Idempotent seed (8 business queries). ON CONFLICT DO NOTHING on normalized.
INSERT INTO public.serp_monitored_queries (
  query_text,
  query_text_normalized,
  active
)
VALUES
  ('prestamo abitab', 'prestamo abitab', true),
  ('prestamo con cedula', 'prestamo con cedula', true),
  ('prestamo con recibo de sueldo', 'prestamo con recibo de sueldo', true),
  ('prestamo estando en clearing', 'prestamo estando en clearing', true),
  ('prestamo solo con cedula', 'prestamo solo con cedula', true),
  ('prestamos con cedula', 'prestamos con cedula', true),
  ('prestamos con clearing', 'prestamos con clearing', true),
  ('préstamo pronto', 'prestamo pronto', true)
ON CONFLICT (query_text_normalized) DO NOTHING;

COMMIT;
