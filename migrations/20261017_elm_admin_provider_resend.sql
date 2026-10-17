-- Gestión ELM: provider-authorized full cycle reset (same solicitud, archived history).
-- NOT APPLIED. Apply AFTER 20261010_provider_fallback_c1_events.sql and preferably
-- 20261016_elm_gestion_send_audit.sql (gestion_send audit action).
-- Idempotent: patches elm_lead_processes_guard + adds elm_admin_provider_resend.
--
-- One transaction per call: advisory CI lock, row lock, archive terminal S1/S2 attempts,
-- reset the SAME process for a new S1+S2 cycle (new s1_request from caller), ONE
-- elm_ci_lock_try reservation (monthly quota rules unchanged). Never deletes the process row.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.elm_ci_lock_try(bigint, bigint, uuid, text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'precondition_failed: apply 20261010_provider_fallback_c1_events.sql first';
  END IF;
END;
$$;

-- Allow controlled wide reset while SET LOCAL elm.provider_admin_resend = 'on'.
CREATE OR REPLACE FUNCTION public.elm_lead_processes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_s1_retry boolean;
  v_s2_retry boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'elm_lead_processes rows cannot be deleted (one process per solicitud)';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.s1_status NOT IN ('not_started', 'in_flight') OR NEW.s2_status <> 'not_started'
       OR NEW.referred_at IS NOT NULL THEN
      RAISE EXCEPTION 'elm_lead_processes insert must start at s1 not_started/in_flight';
    END IF;
    IF (NEW.s1_status <> 'in_flight' AND NEW.s1_lease_expires_at IS NOT NULL)
       OR NEW.s2_lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'elm_lease_only_while_in_flight';
    END IF;
    IF NEW.ops_resolved_at IS NOT NULL OR NEW.ops_resolution_code IS NOT NULL THEN
      RAISE EXCEPTION 'elm_ops_resolution_not_on_insert';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND current_setting('elm.provider_admin_resend', true) = 'on' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.cz_solicitud_id IS DISTINCT FROM OLD.cz_solicitud_id
       OR NEW.ci IS DISTINCT FROM OLD.ci
       OR NEW.source_brand IS DISTINCT FROM OLD.source_brand
       OR NEW.trigger_origin IS DISTINCT FROM OLD.trigger_origin
       OR NEW.commercial_origin IS DISTINCT FROM OLD.commercial_origin
       OR NEW.cz_estado_id_at_start IS DISTINCT FROM OLD.cz_estado_id_at_start
       OR NEW.lrw_id_at_start IS DISTINCT FROM OLD.lrw_id_at_start
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'elm_lead_processes identity/origin columns are immutable';
    END IF;
    IF (NEW.s1_status <> 'in_flight' AND NEW.s1_lease_expires_at IS NOT NULL)
       OR (NEW.s2_status <> 'in_flight' AND NEW.s2_lease_expires_at IS NOT NULL) THEN
      RAISE EXCEPTION 'elm_lease_only_while_in_flight';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.cz_solicitud_id IS DISTINCT FROM OLD.cz_solicitud_id
     OR NEW.ci IS DISTINCT FROM OLD.ci
     OR NEW.source_brand IS DISTINCT FROM OLD.source_brand
     OR NEW.commercial_origin IS DISTINCT FROM OLD.commercial_origin
     OR NEW.trigger_origin IS DISTINCT FROM OLD.trigger_origin
     OR NEW.cz_estado_id_at_start IS DISTINCT FROM OLD.cz_estado_id_at_start
     OR NEW.lrw_id_at_start IS DISTINCT FROM OLD.lrw_id_at_start
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'elm_lead_processes identity/origin columns are immutable';
  END IF;

  IF OLD.s1_request IS NOT NULL AND NEW.s1_request IS DISTINCT FROM OLD.s1_request THEN
    RAISE EXCEPTION 'elm_lead_processes.s1_request is frozen once set';
  END IF;
  IF OLD.s2_request IS NOT NULL AND NEW.s2_request IS DISTINCT FROM OLD.s2_request THEN
    RAISE EXCEPTION 'elm_lead_processes.s2_request is frozen once set';
  END IF;
  IF OLD.referred_at IS NOT NULL AND NEW.referred_at IS DISTINCT FROM OLD.referred_at THEN
    RAISE EXCEPTION 'elm_lead_processes.referred_at is immutable once set';
  END IF;

  v_s1_retry := OLD.s1_status = 'technical_error' AND NEW.s1_status = 'in_flight';
  v_s2_retry := OLD.s2_status = 'technical_error' AND NEW.s2_status = 'in_flight';

  IF NEW.s1_status IS DISTINCT FROM OLD.s1_status THEN
    IF NOT (
      (OLD.s1_status = 'not_started' AND NEW.s1_status = 'in_flight')
      OR (OLD.s1_status = 'in_flight'
          AND NEW.s1_status IN ('eligible', 'rejected', 'unknown', 'technical_error'))
      OR v_s1_retry
    ) THEN
      RAISE EXCEPTION 'elm_illegal_s1_transition: % -> %', OLD.s1_status, NEW.s1_status;
    END IF;
  END IF;
  IF NEW.s1_status = 'in_flight' AND OLD.s1_status IS DISTINCT FROM 'in_flight' THEN
    IF NEW.s1_attempts <> OLD.s1_attempts + 1 THEN
      RAISE EXCEPTION 'elm_s1_attempt_must_increment';
    END IF;
  ELSIF NEW.s1_attempts IS DISTINCT FROM OLD.s1_attempts THEN
    RAISE EXCEPTION 'elm_s1_attempts_only_change_on_start';
  END IF;
  IF OLD.s1_status NOT IN ('not_started', 'in_flight') AND NOT v_s1_retry
     AND (NEW.s1_response, NEW.s1_http_status, NEW.s1_result_message, NEW.s1_started_at,
          NEW.s1_completed_at, NEW.s1_latency_ms, NEW.s1_error_code, NEW.s1_error_detail)
         IS DISTINCT FROM
         (OLD.s1_response, OLD.s1_http_status, OLD.s1_result_message, OLD.s1_started_at,
          OLD.s1_completed_at, OLD.s1_latency_ms, OLD.s1_error_code, OLD.s1_error_detail) THEN
    RAISE EXCEPTION 'elm_lead_processes s1 result is frozen once terminal';
  END IF;

  IF NEW.s2_status IS DISTINCT FROM OLD.s2_status THEN
    IF NOT (
      (OLD.s2_status = 'not_started' AND NEW.s2_status = 'in_flight')
      OR (OLD.s2_status = 'in_flight'
          AND NEW.s2_status IN ('referred', 'rejected', 'unknown', 'technical_error'))
      OR v_s2_retry
    ) THEN
      RAISE EXCEPTION 'elm_illegal_s2_transition: % -> %', OLD.s2_status, NEW.s2_status;
    END IF;
  END IF;
  IF NEW.s2_status = 'in_flight' AND OLD.s2_status IS DISTINCT FROM 'in_flight' THEN
    IF NEW.s2_attempts <> OLD.s2_attempts + 1 THEN
      RAISE EXCEPTION 'elm_s2_attempt_must_increment';
    END IF;
  ELSIF NEW.s2_attempts IS DISTINCT FROM OLD.s2_attempts THEN
    RAISE EXCEPTION 'elm_s2_attempts_only_change_on_start';
  END IF;
  IF OLD.s2_status NOT IN ('not_started', 'in_flight') AND NOT v_s2_retry
     AND (NEW.s2_response, NEW.s2_http_status, NEW.s2_result_message, NEW.s2_started_at,
          NEW.s2_completed_at, NEW.s2_latency_ms, NEW.s2_error_code, NEW.s2_error_detail)
         IS DISTINCT FROM
         (OLD.s2_response, OLD.s2_http_status, OLD.s2_result_message, OLD.s2_started_at,
          OLD.s2_completed_at, OLD.s2_latency_ms, OLD.s2_error_code, OLD.s2_error_detail) THEN
    RAISE EXCEPTION 'elm_lead_processes s2 result is frozen once terminal';
  END IF;

  IF (NEW.s1_status <> 'in_flight' AND NEW.s1_lease_expires_at IS NOT NULL)
     OR (NEW.s2_status <> 'in_flight' AND NEW.s2_lease_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'elm_lease_only_while_in_flight';
  END IF;
  IF NEW.s1_lease_expires_at IS DISTINCT FROM OLD.s1_lease_expires_at
     AND NEW.s1_status IS NOT DISTINCT FROM OLD.s1_status THEN
    RAISE EXCEPTION 'elm_s1_lease_immutable_while_in_flight';
  END IF;
  IF NEW.s2_lease_expires_at IS DISTINCT FROM OLD.s2_lease_expires_at
     AND NEW.s2_status IS NOT DISTINCT FROM OLD.s2_status THEN
    RAISE EXCEPTION 'elm_s2_lease_immutable_while_in_flight';
  END IF;

  IF OLD.ops_resolved_at IS NOT NULL THEN
    IF (NEW.ops_resolution_code, NEW.ops_resolution_note, NEW.ops_resolved_at)
       IS DISTINCT FROM (OLD.ops_resolution_code, OLD.ops_resolution_note, OLD.ops_resolved_at)
       OR (NEW.ops_resolved_by IS DISTINCT FROM OLD.ops_resolved_by AND NEW.ops_resolved_by IS NOT NULL) THEN
      RAISE EXCEPTION 'elm_ops_resolution_immutable';
    END IF;
    IF v_s1_retry OR v_s2_retry THEN
      RAISE EXCEPTION 'elm_resolved_process_cannot_retry';
    END IF;
  ELSIF NEW.ops_resolved_at IS NOT NULL THEN
    IF NOT (OLD.s2_status IN ('referred', 'unknown') OR OLD.s1_status = 'unknown') THEN
      RAISE EXCEPTION 'elm_ops_resolution_not_applicable';
    END IF;
    IF (NEW.s1_status, NEW.s2_status, NEW.disbursed_at, NEW.disbursed_amount, NEW.provider_status,
        NEW.provider_status_at, NEW.granted_event_id, NEW.referred_at)
       IS DISTINCT FROM
       (OLD.s1_status, OLD.s2_status, OLD.disbursed_at, OLD.disbursed_amount, OLD.provider_status,
        OLD.provider_status_at, OLD.granted_event_id, OLD.referred_at) THEN
      RAISE EXCEPTION 'elm_ops_resolution_must_not_change_state';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.elm_admin_provider_resend(
  p_cz_solicitud_id bigint,
  p_expected_updated_at timestamptz,
  p_provider_reference text,
  p_s1_request jsonb,
  p_lease_seconds integer,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.elm_lead_processes%ROWTYPE;
  v_ci bigint;
  v_lock jsonb;
  v_ref text;
  v_archived_cycle jsonb;
  v_prev_s1_attempts integer;
  v_prev_s2_attempts integer;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'elm_ops_actor_required';
  END IF;
  IF p_cz_solicitud_id IS NULL OR p_cz_solicitud_id <= 0 THEN
    RAISE EXCEPTION 'elm_invalid_cz_solicitud_id';
  END IF;
  v_ref := btrim(COALESCE(p_provider_reference, ''));
  IF char_length(v_ref) < 4 OR char_length(v_ref) > 200 THEN
    RAISE EXCEPTION 'elm_invalid_provider_reference';
  END IF;
  IF p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'elm_invalid_expected_updated_at';
  END IF;
  IF p_s1_request IS NULL OR p_s1_request = 'null'::jsonb THEN
    RAISE EXCEPTION 'elm_invalid_s1_request';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'elm_invalid_lease_seconds';
  END IF;

  SELECT ci INTO v_ci FROM public.elm_lead_processes WHERE cz_solicitud_id = p_cz_solicitud_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('elm_ci_send_lock:' || v_ci::text, 0));
  SELECT * INTO v FROM public.elm_lead_processes WHERE cz_solicitud_id = p_cz_solicitud_id FOR UPDATE;

  IF v.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;
  IF v.disbursed_at IS NOT NULL OR v.granted_event_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'disbursed');
  END IF;
  IF v.s1_status = 'in_flight' OR v.s2_status = 'in_flight' THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'in_flight');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.elm_ops_audit_events e
    WHERE e.cz_solicitud_id = v.cz_solicitud_id
      AND e.action = 'gestion_send'
      AND e.detail ->> 'provider_reference' = v_ref
      AND e.created_at > now() - interval '24 hours'
  ) THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'duplicate_provider_reference');
  END IF;

  v_lock := public.elm_ci_lock_try(v.ci, v.cz_solicitud_id, NULL, 'janus_manual', NULL);
  IF v_lock ->> 'status' = 'blocked' THEN
    RETURN jsonb_build_object('status', 'blocked', 'lock', v_lock);
  END IF;

  v_prev_s1_attempts := v.s1_attempts;
  v_prev_s2_attempts := v.s2_attempts;
  v_archived_cycle := jsonb_build_object(
    's1', jsonb_build_object(
      'attempt_no', v.s1_attempts,
      'status', v.s1_status,
      'http_status', v.s1_http_status,
      'result_message', v.s1_result_message,
      'error_code', v.s1_error_code,
      'started_at', v.s1_started_at,
      'completed_at', v.s1_completed_at
    ),
    's2', jsonb_build_object(
      'attempt_no', v.s2_attempts,
      'status', v.s2_status,
      'http_status', v.s2_http_status,
      'result_message', v.s2_result_message,
      'error_code', v.s2_error_code,
      'started_at', v.s2_started_at,
      'completed_at', v.s2_completed_at,
      'referred_at', v.referred_at
    )
  );

  PERFORM set_config('elm.provider_admin_resend', 'on', true);

  IF v.s1_status = 'technical_error' AND v.s1_attempts >= 1 THEN
    INSERT INTO public.elm_step_attempts (
      elm_process_id, cz_solicitud_id, step, attempt_no, status, http_status, result_message,
      error_code, error_detail, response, started_at, completed_at
    ) VALUES (
      v.id, v.cz_solicitud_id, 's1', v.s1_attempts, 'technical_error', v.s1_http_status, v.s1_result_message,
      v.s1_error_code, v.s1_error_detail, v.s1_response, v.s1_started_at, v.s1_completed_at
    );
  END IF;
  IF v.s2_status = 'technical_error' AND v.s2_attempts >= 1 THEN
    INSERT INTO public.elm_step_attempts (
      elm_process_id, cz_solicitud_id, step, attempt_no, status, http_status, result_message,
      error_code, error_detail, response, started_at, completed_at
    ) VALUES (
      v.id, v.cz_solicitud_id, 's2', v.s2_attempts, 'technical_error', v.s2_http_status, v.s2_result_message,
      v.s2_error_code, v.s2_error_detail, v.s2_response, v.s2_started_at, v.s2_completed_at
    );
  END IF;

  UPDATE public.elm_lead_processes p
  SET s2_status = 'not_started',
      s2_attempts = 0,
      s2_request = NULL,
      s2_response = NULL,
      s2_http_status = NULL,
      s2_result_message = NULL,
      s2_started_at = NULL,
      s2_completed_at = NULL,
      s2_latency_ms = NULL,
      s2_error_code = NULL,
      s2_error_detail = NULL,
      s2_lease_expires_at = NULL,
      referred_at = NULL,
      provider_status = NULL,
      provider_status_at = NULL,
      last_postback_event_id = NULL,
      last_postback_at = NULL,
      ops_resolution_code = NULL,
      ops_resolution_note = NULL,
      ops_resolved_at = NULL,
      ops_resolved_by = NULL,
      s1_status = 'not_started',
      s1_attempts = 0,
      s1_response = NULL,
      s1_http_status = NULL,
      s1_result_message = NULL,
      s1_started_at = NULL,
      s1_completed_at = NULL,
      s1_latency_ms = NULL,
      s1_error_code = NULL,
      s1_error_detail = NULL,
      s1_lease_expires_at = NULL,
      s1_request = NULL
  WHERE p.id = v.id
  RETURNING p.* INTO v;

  UPDATE public.elm_lead_processes p
  SET s1_status = 'in_flight',
      s1_attempts = p.s1_attempts + 1,
      s1_request = p_s1_request,
      s1_started_at = now(),
      s1_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  WHERE p.id = v.id
  RETURNING p.* INTO v;

  INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
  VALUES ('elm_process', v.id, v.cz_solicitud_id, 'gestion_send', p_actor_user_id, jsonb_build_object(
    'kind', 'provider_admin_resend',
    'provider_reference', v_ref,
    'archived_cycle', v_archived_cycle,
    'archived_s1_attempt', v_prev_s1_attempts,
    'archived_s2_attempt', v_prev_s2_attempts,
    's1_attempt', v.s1_attempts,
    'lock_id', v_lock ->> 'lock_id',
    'lock_status', v_lock ->> 'status',
    'lock_month', v_lock ->> 'month_key'
  ));

  RETURN jsonb_build_object('status', 'ready', 'process', to_jsonb(v), 'lock', v_lock);
END;
$$;

COMMENT ON FUNCTION public.elm_admin_provider_resend(bigint, timestamptz, text, jsonb, integer, uuid) IS
  'Gestión ELM: ELM-authorized full S1+S2 cycle on the same process. CI lock before any write; prior cycle in audit (archived_cycle); technical_error steps also in elm_step_attempts. Never deletes the process row.';

REVOKE ALL ON FUNCTION public.elm_admin_provider_resend(bigint, timestamptz, text, jsonb, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_admin_provider_resend(bigint, timestamptz, text, jsonb, integer, uuid) TO service_role;

COMMIT;
