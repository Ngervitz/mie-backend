-- CDV estado 8 → ELM: elm_claim_process must accept trigger_origin cdv_estado_8 with its own send_origin.
-- Production already has send_origin / send_origin_source; this migration is safe to re-apply.

BEGIN;

ALTER TABLE public.elm_ci_send_locks
  DROP CONSTRAINT IF EXISTS elm_ci_send_locks_origin_check;

ALTER TABLE public.elm_ci_send_locks
  ADD CONSTRAINT elm_ci_send_locks_origin_check
  CHECK (trigger_origin IN ('janus_manual', 'janus_batch', 'cz_automatic', 'cdv_estado_8'));

ALTER TABLE public.elm_lead_processes
  DROP CONSTRAINT IF EXISTS elm_lead_processes_send_origin_check;

ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_send_origin_check
  CHECK (
    (trigger_origin = 'cz_automatic' AND send_origin = 'cz_automatic')
    OR (trigger_origin = 'janus_batch' AND send_origin = 'janus_batch')
    OR (
      trigger_origin = 'janus_manual'
      AND send_origin = ANY (ARRAY['rechazados_manual'::text, 'preaprobados_manual'::text])
    )
    OR (trigger_origin = 'cdv_estado_8' AND send_origin = 'cdv_estado_8')
  );

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
  p_commercial_origin text DEFAULT NULL::text,
  p_send_origin text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
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
      WHEN 'cdv_estado_8' THEN 'cdv_estado_8'
    END;
    v_send_origin_source := 'legacy_default';
  END IF;
  IF NOT (
    (p_trigger_origin = 'cz_automatic' AND v_send_origin = 'cz_automatic')
    OR (p_trigger_origin = 'janus_batch' AND v_send_origin = 'janus_batch')
    OR (
      p_trigger_origin = 'janus_manual'
      AND v_send_origin IN ('rechazados_manual', 'preaprobados_manual')
    )
    OR (p_trigger_origin = 'cdv_estado_8' AND v_send_origin = 'cdv_estado_8')
  ) THEN
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
$function$;

REVOKE ALL ON FUNCTION public.elm_claim_process(
  bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_claim_process(
  bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text, text
) TO service_role;

COMMIT;