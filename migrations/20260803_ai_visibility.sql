-- AI Visibility (Janus) — Fase 1: prompts semanales + respuestas por proveedor.
-- Apply manually in Supabase. Does not touch EmailProvider / CZLeadSource.

BEGIN;

-- Competitor aliases for deterministic mention matching.
ALTER TABLE public.monitored_entities
  ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Reuse shared updated_at helper (idempotent; same body as Instagram/CZ migrations).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.ai_visibility_prompts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN ('descubrimiento', 'elegibilidad', 'comparacion', 'marca')
  ),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_visibility_prompts_text
  ON public.ai_visibility_prompts (text);

DROP TRIGGER IF EXISTS trg_ai_visibility_prompts_updated_at ON public.ai_visibility_prompts;
CREATE TRIGGER trg_ai_visibility_prompts_updated_at
  BEFORE UPDATE ON public.ai_visibility_prompts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.ai_visibility_responses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prompt_id BIGINT NOT NULL REFERENCES public.ai_visibility_prompts(id),
  prompt_text_snapshot TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (
    provider IN ('openai', 'gemini', 'anthropic', 'perplexity')
  ),
  model_name TEXT NOT NULL,
  week_of DATE NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'success', 'error', 'not_configured')
  ),
  raw_response TEXT,
  error TEXT,
  error_code TEXT,
  http_status INTEGER,
  mentions_credizona BOOLEAN,
  mentioned_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'success' AND raw_response IS NOT NULL AND error IS NULL)
    OR (status IN ('error', 'not_configured') AND raw_response IS NULL AND error IS NOT NULL)
    OR (status = 'pending' AND raw_response IS NULL AND error IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_visibility_response
  ON public.ai_visibility_responses (prompt_id, provider, model_name, week_of);

CREATE INDEX IF NOT EXISTS idx_ai_visibility_responses_week
  ON public.ai_visibility_responses (week_of DESC);

CREATE INDEX IF NOT EXISTS idx_ai_visibility_responses_provider
  ON public.ai_visibility_responses (provider, week_of DESC);

INSERT INTO public.ai_visibility_prompts (text, category) VALUES
('¿Cuáles son las mejores opciones de préstamos personales en Uruguay?', 'descubrimiento'),
('¿Dónde puedo pedir un préstamo rápido en Montevideo?', 'descubrimiento'),
('Necesito plata urgente. ¿Qué opciones de préstamos tengo en Uruguay?', 'descubrimiento'),
('¿Qué empresas de préstamos personales son confiables en Uruguay?', 'descubrimiento'),
('¿Qué préstamos personales se pueden solicitar completamente online en Uruguay?', 'descubrimiento'),
('¿Qué apps o páginas web son confiables para pedir préstamos en Uruguay?', 'descubrimiento'),
('Tengo antecedentes negativos en el Clearing. ¿Qué opciones de crédito puedo evaluar en Uruguay?', 'elegibilidad'),
('¿Puedo conseguir un préstamo en Uruguay si no tengo recibo de sueldo?', 'elegibilidad'),
('¿Qué requisitos piden normalmente para sacar un préstamo personal en Uruguay?', 'elegibilidad'),
('¿Dónde puedo pedir un préstamo en Uruguay si ya me rechazaron en otra financiera?', 'elegibilidad'),
('Compará las principales empresas de préstamos personales en Uruguay.', 'comparacion'),
('¿Qué préstamo personal en Uruguay tiene menores intereses y costos?', 'comparacion'),
('¿En qué debería fijarme para comparar préstamos personales en Uruguay?', 'comparacion'),
('¿Qué es Credizona y cómo funciona?', 'marca'),
('¿Credizona es confiable para pedir un préstamo en Uruguay?', 'marca')
ON CONFLICT (text) DO NOTHING;

COMMIT;
