-- ELM: explicit send origin of every process, stored when the process is created.
-- NOT APPLIED. Apply manually in Supabase AFTER 20261011_elm_manual_pre_reception_retry.sql and
-- BEFORE deploying the code that passes p_send_origin (step B, 20261013_elm_send_origin_strict.sql,
-- goes after that deploy). Idempotent.
--
-- send_origin (immutable, NOT NULL), never derived from the current CZ / Credizona state:
--   cz_automatic         trigger_origin cz_automatic (CDV → ELM automatic circuit)
--   rechazados_manual    trigger_origin janus_manual, "Enviar a ELM" from Rechazados
--   preaprobados_manual  trigger_origin janus_manual, "Enviar a ELM" from Preaprobados
--   janus_batch          trigger_origin janus_batch (not wired)
-- send_origin_source (immutable): how it was set
--   explicit             passed by the caller to elm_claim_process (p_send_origin)
--   legacy_default       caller without p_send_origin (code deployed before this migration);
--                        janus_manual → rechazados_manual, only possible until step B
--   backfill             process created before this migration (set here, once)
--
-- Backfill of existing processes, by trigger_origin only: until this migration the only manual
-- "Enviar a ELM" screen was Rechazados, so janus_manual → rechazados_manual. Safety stop: if
-- any existing janus_manual process belongs to a solicitud that was ever in CZ estado 8
-- (Preaprobados CDV cohort) the migration aborts instead of guessing.
-- The backfill does not touch updated_at or any other column.
--
-- elm_claim_process gains p_send_origin text DEFAULT NULL (old 10-argument overload dropped so
-- PostgREST calls stay unambiguous). Everything else in the claim is unchanged (CI lock through
-- elm_ci_lock_try, one process per solicitud).

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.elm_manual_retry_s1(bigint, integer, integer, integer, uuid)') IS NULL
     OR to_regprocedure('public.elm_ci_lock_try(bigint, bigint, uuid, text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'precondition_failed: apply 20261011_elm_manual_pre_reception_retry.sql first';
  END IF;
END;
$$;

DO $$
DECLARE
  v_ambiguous bigint[];
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'elm_lead_processes' AND column_name = 'send_origin')
     OR to_regclass('public.cz_funnel_solicitud_estados') IS NULL
     OR to_regclass('public.cz_funnel_solicitudes') IS NULL THEN
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT p.cz_solicitud_id ORDER BY p.cz_solicitud_id) INTO v_ambiguous
  FROM public.elm_lead_processes p
  WHERE p.trigger_origin = 'janus_manual'
    AND (EXISTS (SELECT 1 FROM public.cz_funnel_solicitud_estados e
                 WHERE e.cz_solicitud_id = p.cz_solicitud_id AND e.solicitudes_estados_id = 8)
         OR EXISTS (SELECT 1 FROM public.cz_funnel_solicitudes s
                    WHERE s.cz_id = p.cz_solicitud_id AND s.solicitudes_estados_id = 8));
  IF v_ambiguous IS NOT NULL THEN
    RAISE EXCEPTION 'send_origin_backfill_ambiguous: janus_manual processes of Preaprobados solicitudes %; decide their origin before applying', v_ambiguous;
  END IF;
END;
$$;

ALTER TABLE public.elm_lead_processes ADD COLUMN IF NOT EXISTS send_origin text NULL;
ALTER TABLE public.elm_lead_processes ADD COLUMN IF NOT EXISTS send_origin_source text NULL;

ALTER TABLE public.elm_lead_processes DISABLE TRIGGER trg_elm_lead_processes_updated_at;
UPDATE public.elm_lead_processes
SET send_origin = CASE trigger_origin
      WHEN 'cz_automatic' THEN 'cz_automatic'
      WHEN 'janus_batch' THEN 'janus_batch'
      WHEN 'janus_manual' THEN 'rechazados_manual'
    END,
    send_origin_source = 'backfill'
WHERE send_origin IS NULL;
ALTER TABLE public.elm_lead_processes ENABLE TRIGGER trg_elm_lead_processes_updated_at;

ALTER TABLE public.elm_lead_processes ALTER COLUMN send_origin SET NOT NULL;
ALTER TABLE public.elm_lead_processes ALTER COLUMN send_origin_source SET NOT NULL;

ALTER TABLE public.elm_lead_processes DROP CONSTRAINT IF EXISTS elm_lead_processes_send_origin_check;
ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_send_origin_check CHECK (
    (trigger_origin = 'cz_automatic' AND send_origin = 'cz_automatic')
    OR (trigger_origin = 'janus_batch' AND send_origin = 'janus_batch')
    OR (trigger_origin = 'janus_manual' AND send_origin IN ('rechazados_manual', 'preaprobados_manual'))
  );
ALTER TABLE public.elm_lead_processes DROP CONSTRAINT IF EXISTS elm_lead_processes_send_origin_source_check;
ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_send_origin_source_check
  CHECK (send_origin_source IN ('explicit', 'legacy_default', 'backfill'));

CREATE INDEX IF NOT EXISTS elm_lead_processes_send_origin_idx
  ON public.elm_lead_processes (send_origin);

COMMENT ON COLUMN public.elm_lead_processes.send_origin IS
  'Where the send started: cz_automatic | rechazados_manual | preaprobados_manual | janus_batch. Set once at creation (elm_claim_process), immutable, never derived from the CZ state.';
COMMENT ON COLUMN public.elm_lead_processes.send_origin_source IS
  'How send_origin was set: explicit (caller) | legacy_default (caller before 20261012) | backfill (process created before 20261012).';

-- Immutable after insert; 'backfill' only through this migration.
CREATE OR REPLACE FUNCTION public.elm_lead_processes_send_origin_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.send_origin_source NOT IN ('explicit', 'legacy_default') THEN
      RAISE EXCEPTION 'elm_send_origin_source_invalid_on_insert';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.send_origin IS DISTINCT FROM OLD.send_origin
     OR NEW.send_origin_source IS DISTINCT FROM OLD.send_origin_source THEN
    RAISE EXCEPTION 'elm_lead_processes.send_origin is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_elm_lead_processes_send_origin_guard ON public.elm_lead_processes;
CREATE TRIGGER trg_elm_lead_processes_send_origin_guard
  BEFORE INSERT OR UPDATE OF send_origin, send_origin_source ON public.elm_lead_processes
  FOR EACH ROW EXECUTE FUNCTION public.elm_lead_processes_send_origin_guard();

DROP FUNCTION IF EXISTS public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text);
CREATE OR REPLACE FUNCTION public.elm_claim_process(
  p_cz_solicitud_id bigint,
  p_ci bigint,
  p_source_brand text,
  p_trigger_origin text,
  p_triggered_by_user_id uuid,
  p_cz_estado_id_at_start integer,
  p_lrw_id_at_start text,
  p_s1_request jsonb,
  p_lease_seconds integer,
  p_commercial_origin text DEFAULT NULL,
  p_send_origin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.elm_lead_processes%ROWTYPE;
  v_req_id uuid;
  v_lock jsonb;
  v_send_origin text := NULLIF(btrim(p_send_origin), '');
  v_send_origin_source text := 'explicit';
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'elm_invalid_lease_seconds';
  END IF;
  IF p_s1_request IS NULL OR jsonb_typeof(p_s1_request) <> 'object' THEN
    RAISE EXCEPTION 'elm_invalid_s1_request';
  END IF;
  IF p_trigger_origin = 'janus_manual' AND p_triggered_by_user_id IS NULL THEN
    RAISE EXCEPTION 'elm_manual_trigger_requires_user';
  END IF;
  IF v_send_origin IS NULL THEN
    v_send_origin := CASE p_trigger_origin
      WHEN 'cz_automatic' THEN 'cz_automatic'
      WHEN 'janus_batch' THEN 'janus_batch'
      WHEN 'janus_manual' THEN 'rechazados_manual'
    END;
    v_send_origin_source := 'legacy_default';
  END IF;
  IF NOT ((p_trigger_origin = 'cz_automatic' AND v_send_origin = 'cz_automatic')
          OR (p_trigger_origin = 'janus_batch' AND v_send_origin = 'janus_batch')
          OR (p_trigger_origin = 'janus_manual' AND v_send_origin IN ('rechazados_manual', 'preaprobados_manual'))) THEN
    RAISE EXCEPTION 'elm_invalid_send_origin';
  END IF;

  SELECT * INTO v_row FROM public.elm_lead_processes WHERE cz_solicitud_id = p_cz_solicitud_id;
  IF FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'process', to_jsonb(v_row));
  END IF;

  SELECT f.id INTO v_req_id FROM public.provider_fallback_requests f
  WHERE f.cz_solicitud_id = p_cz_solicitud_id AND f.ci = p_ci;
  v_lock := public.elm_ci_lock_try(p_ci, p_cz_solicitud_id, v_req_id, p_trigger_origin, NULL);
  IF v_lock ->> 'status' = 'blocked' THEN
    RETURN jsonb_build_object('claimed', false, 'process', NULL, 'blocked', v_lock);
  END IF;

  INSERT INTO public.elm_lead_processes (
    cz_solicitud_id, ci, source_brand, commercial_origin, trigger_origin, triggered_by_user_id,
    send_origin, send_origin_source,
    cz_estado_id_at_start, lrw_id_at_start,
    s1_status, s1_attempts, s1_request, s1_started_at, s1_lease_expires_at
  )
  VALUES (
    p_cz_solicitud_id, p_ci, p_source_brand, NULLIF(btrim(p_commercial_origin), ''), p_trigger_origin,
    p_triggered_by_user_id, v_send_origin, v_send_origin_source,
    p_cz_estado_id_at_start, p_lrw_id_at_start,
    'in_flight', 1, p_s1_request, now(), now() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT (cz_solicitud_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true, 'process', to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.elm_lead_processes WHERE cz_solicitud_id = p_cz_solicitud_id;
  RETURN jsonb_build_object('claimed', false, 'process', to_jsonb(v_row));
END;
$$;

COMMENT ON FUNCTION public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text, text) IS
  'Single entry point for every new ELM process (S1): CI lock + insert in one transaction. p_send_origin is stored as send_origin (immutable); NULL only from code deployed before 20261012 (legacy_default).';

REVOKE ALL ON FUNCTION public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text, text) TO service_role;

COMMIT;
