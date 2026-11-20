-- CDV estado 8 → ELM automation queue (no C1 / no CZ state events).
-- Seeds current estado-8 cohort as skipped_historical so only new entries after deploy enqueue.

BEGIN;

ALTER TABLE public.elm_lead_processes
  DROP CONSTRAINT IF EXISTS elm_lead_processes_trigger_origin_check;

ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_trigger_origin_check
  CHECK (trigger_origin IN ('janus_manual', 'janus_batch', 'cz_automatic', 'cdv_estado_8'));

CREATE TABLE IF NOT EXISTS public.cdv_estado8_elm_queue (
  cz_solicitud_id bigint PRIMARY KEY,
  fechahora_estado8 timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NULL,
  last_error text NULL,
  elm_process_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cdv_estado8_elm_queue_status_check
    CHECK (status IN (
      'pending',
      'processing',
      'completed',
      'failed',
      'skipped_historical',
      'skipped_excluded',
      'skipped_hold',
      'skipped_ineligible'
    )),
  CONSTRAINT cdv_estado8_elm_queue_attempts_nonneg CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cdv_estado8_elm_queue_status
  ON public.cdv_estado8_elm_queue (status, fechahora_estado8);

COMMENT ON TABLE public.cdv_estado8_elm_queue IS
  'One row per CZ solicitud that entered CDV estado 8. pending/failed retry on funnel sync; skipped_* terminal.';

CREATE OR REPLACE FUNCTION public.cdv_estado8_elm_queue_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cdv_estado8_elm_queue_updated_at ON public.cdv_estado8_elm_queue;
CREATE TRIGGER trg_cdv_estado8_elm_queue_updated_at
  BEFORE UPDATE ON public.cdv_estado8_elm_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.cdv_estado8_elm_queue_touch_updated_at();

-- Idempotent enqueue: only the first estado-8 observation per solicitud.
CREATE OR REPLACE FUNCTION public.cdv_estado8_elm_try_enqueue(
  p_cz_solicitud_id bigint,
  p_fechahora_estado8 timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted boolean := false;
BEGIN
  IF p_cz_solicitud_id IS NULL OR p_cz_solicitud_id <= 0 THEN
  RETURN false;
  END IF;
  IF p_fechahora_estado8 IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.cdv_estado8_elm_queue (cz_solicitud_id, fechahora_estado8, status)
  VALUES (p_cz_solicitud_id, p_fechahora_estado8, 'pending')
  ON CONFLICT (cz_solicitud_id) DO NOTHING;
  v_inserted := FOUND;
  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION public.cdv_estado8_elm_try_enqueue(bigint, timestamptz) IS
  'Returns true only when a new pending row is created (not historical / not duplicate cz_id).';

-- Seed: never auto-process the cohort that already had estado 8 at migration time.
INSERT INTO public.cdv_estado8_elm_queue (cz_solicitud_id, fechahora_estado8, status)
SELECT DISTINCT ON (h.cz_solicitud_id)
  h.cz_solicitud_id,
  COALESCE(h.fechahora_src, now()),
  'skipped_historical'
FROM public.cz_funnel_solicitud_estados h
WHERE h.solicitudes_estados_id = 8
ORDER BY h.cz_solicitud_id, h.fechahora_src ASC NULLS LAST
ON CONFLICT (cz_solicitud_id) DO NOTHING;

INSERT INTO public.cdv_estado8_elm_queue (cz_solicitud_id, fechahora_estado8, status)
SELECT
  s.cz_id,
  COALESCE(s.fecha_reg, s.updated_at_src, now()),
  'skipped_historical'
FROM public.cz_funnel_solicitudes s
WHERE s.solicitudes_estados_id = 8
ON CONFLICT (cz_solicitud_id) DO NOTHING;

ALTER TABLE public.cdv_estado8_elm_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cdv_estado8_elm_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cdv_estado8_elm_queue TO service_role;

REVOKE ALL ON FUNCTION public.cdv_estado8_elm_try_enqueue(bigint, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cdv_estado8_elm_try_enqueue(bigint, timestamptz) TO service_role;

COMMIT;