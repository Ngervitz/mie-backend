-- AI Visibility — análisis de menciones de Credizona (manual).
-- Apply manually in Supabase. Does not touch weekly runner / providers.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_visibility_credizona_analysis (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  response_id BIGINT NOT NULL REFERENCES public.ai_visibility_responses(id),
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  classification TEXT CHECK (
    classification IN (
      'recomendada',
      'mencionada',
      'comparada',
      'desaconsejada',
      'informacion_insuficiente'
    )
  ),
  sentiment TEXT CHECK (
    sentiment IN ('positivo', 'neutral', 'negativo')
  ),
  attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  error_code TEXT,
  model_name TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  raw_analysis TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (
      status = 'success'
      AND classification IS NOT NULL
      AND sentiment IS NOT NULL
      AND error IS NULL
    )
    OR (
      status = 'error'
      AND classification IS NULL
      AND sentiment IS NULL
      AND error IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_visibility_credizona_analysis_response
  ON public.ai_visibility_credizona_analysis (response_id);

CREATE INDEX IF NOT EXISTS idx_ai_visibility_credizona_analysis_status
  ON public.ai_visibility_credizona_analysis (status, analyzed_at DESC);

COMMIT;
