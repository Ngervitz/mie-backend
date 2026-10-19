-- CZ 2056 only: ELM asked to resend S1 after HTTP 400 MODULE_DOES_NOT_EXIST.
-- Applied in Supabase as schema_migrations 20261019185004 (elm_s1_module_missing_retry),
-- after elm_admin_provider_resend and the gestion_send audit action.
-- Does not send to ELM. One transaction: archive the unknown attempt, put the SAME
-- process back in S1 in_flight with the frozen request, reuse the reserved CI lock.
-- Any other solicitud or error is refused and writes nothing.
--
-- elm_step_attempts may store this archived unknown attempt. technical_error rows are unchanged.

BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  IF to_regprocedure('public.elm_ci_lock_try(bigint, bigint, uuid, text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'precondition_failed: apply 20261010_provider_fallback_c1_events.sql first';
  END IF;
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'elm_step_attempts'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
      AND pg_get_constraintdef(con.oid) NOT ILIKE '%unknown%'
  LOOP
    EXECUTE format('ALTER TABLE public.elm_step_attempts DROP CONSTRAINT %I', r.conname);
  END LOOP;
END;
$$;

ALTER TABLE public.elm_step_attempts
  DROP CONSTRAINT IF EXISTS elm_step_attempts_status_check;
ALTER TABLE public.elm_step_attempts
  ADD CONSTRAINT elm_step_attempts_status_check
  CHECK (status IN ('technical_error', 'unknown'));

COMMENT ON CONSTRAINT elm_step_attempts_status_check ON public.elm_step_attempts IS
  'technical_error: ordinary retry archive. unknown: only the CZ 2056 MODULE_DOES_NOT_EXIST S1 archive.';

CREATE OR REPLACE FUNCTION public.elm_s1_module_missing_retry(
  p_cz_solicitud_id bigint,
  p_expected_attempts integer,
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
  v_lock public.elm_ci_send_locks%ROWTYPE;
  v_try jsonb;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'elm_ops_actor_required';
  END IF;
  IF p_cz_solicitud_id IS NULL OR p_cz_solicitud_id <> 2056 THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'not_this_case');
  END IF;
  IF p_expected_attempts IS NULL OR p_expected_attempts < 1 THEN
    RAISE EXCEPTION 'elm_invalid_expected_attempts';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'elm_invalid_lease_seconds';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('elm_ci_send_lock:50562896', 0));
  SELECT * INTO v FROM public.elm_lead_processes WHERE cz_solicitud_id = 2056 FOR UPDATE;
  IF NOT FOUND OR v.ci <> 50562896 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v.s1_attempts <> p_expected_attempts THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;
  IF v.ops_resolved_at IS NOT NULL OR v.disbursed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'closed');
  END IF;
  IF v.trigger_origin IS DISTINCT FROM 'janus_manual'
     OR v.s1_status IS DISTINCT FROM 'unknown'
     OR v.s1_http_status IS DISTINCT FROM 400
     OR v.s1_error_code IS DISTINCT FROM 'elm_http_error'
     OR v.s2_status IS DISTINCT FROM 'not_started'
     OR v.s2_request IS NOT NULL
     OR v.s1_request IS NULL
     OR COALESCE(v.s1_response::text, '') NOT LIKE '%MODULE_DOES_NOT_EXIST%' THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'not_module_missing');
  END IF;

  SELECT * INTO v_lock
  FROM public.elm_ci_send_locks
  WHERE cz_solicitud_id = 2056 AND state = 'reserved'
  FOR UPDATE;
  IF NOT FOUND OR v_lock.ci <> v.ci THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'lock_not_reserved');
  END IF;

  v_try := public.elm_ci_lock_try(v.ci, v.cz_solicitud_id, NULL, 'janus_manual', NULL);
  IF v_try ->> 'status' IS DISTINCT FROM 'held' OR v_try ->> 'state' IS DISTINCT FROM 'reserved' THEN
    RAISE EXCEPTION 'elm_s1_module_missing_retry_must_reuse_reserved_lock';
  END IF;

  INSERT INTO public.elm_step_attempts (
    elm_process_id, cz_solicitud_id, step, attempt_no, status, http_status, result_message,
    error_code, error_detail, response, started_at, completed_at
  ) VALUES (
    v.id, v.cz_solicitud_id, 's1', v.s1_attempts, 'unknown', v.s1_http_status, v.s1_result_message,
    v.s1_error_code, v.s1_error_detail, v.s1_response, v.s1_started_at, v.s1_completed_at
  );

  PERFORM set_config('elm.provider_admin_resend', 'on', true);
  UPDATE public.elm_lead_processes p
  SET s1_status = 'in_flight',
      s1_attempts = p.s1_attempts + 1,
      s1_response = NULL,
      s1_http_status = NULL,
      s1_result_message = NULL,
      s1_completed_at = NULL,
      s1_latency_ms = NULL,
      s1_error_code = NULL,
      s1_error_detail = NULL,
      s1_started_at = now(),
      s1_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  WHERE p.id = v.id
    AND p.s1_request IS NOT DISTINCT FROM v.s1_request
  RETURNING p.* INTO v;

  INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
  VALUES ('elm_process', v.id, v.cz_solicitud_id, 'retried', p_actor_user_id, jsonb_build_object(
    'step', 's1',
    'kind', 's1_module_missing',
    'archived_attempt', v.s1_attempts - 1,
    'attempt', v.s1_attempts,
    'http_status', 400,
    'error_code', 'MODULE_DOES_NOT_EXIST',
    'lock_id', v_try ->> 'lock_id',
    'lock_status', v_try ->> 'status',
    'lock_state', v_try ->> 'state',
    's2', 'withheld'
  ));

  RETURN jsonb_build_object('status', 'retried', 'process', to_jsonb(v), 'lock', v_try);
END;
$$;

COMMENT ON FUNCTION public.elm_s1_module_missing_retry(bigint, integer, integer, uuid) IS
  'CZ 2056 / CI 50562896 only. Archives the HTTP 400 MODULE_DOES_NOT_EXIST S1 and rearms the same process and frozen request on the reserved lock. Does not send, does not start S2, does not create a process.';

REVOKE ALL ON FUNCTION public.elm_s1_module_missing_retry(bigint, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_s1_module_missing_retry(bigint, integer, integer, uuid) TO service_role;

COMMIT;
