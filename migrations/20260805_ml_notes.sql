-- Notas manuales para corridas y predicciones ML.
-- Aplicar manualmente en Supabase.

BEGIN;

CREATE TABLE public.ml_run_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_version TEXT NOT NULL,
  note TEXT NOT NULL CHECK (char_length(note) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.ml_entity_week_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id UUID NOT NULL REFERENCES public.monitored_entities(id),
  week_of DATE NOT NULL,
  note TEXT NOT NULL CHECK (char_length(note) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ml_run_notes_version
  ON public.ml_run_notes (model_version);

CREATE INDEX idx_ml_entity_week_notes_lookup
  ON public.ml_entity_week_notes (entity_id, week_of);

COMMIT;
