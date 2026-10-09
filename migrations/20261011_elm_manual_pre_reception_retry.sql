-- ELM: manual retry of an S1 that failed BEFORE ELM received the lead.
-- NOT APPLIED. Apply manually in Supabase AFTER 20261010_provider_fallback_c1_events.sql.
-- Idempotent. Adds one function and widens one CHECK; no table, trigger or existing function
-- changes. The automatic path (elm_retry_step, provider fallback worker,
-- ELM_RETRY_SAFE_ERROR_CODES) is untouched.
--
-- Case: S1 technical_error with a pre-reception error code (elm_pre_reception_error_codes():
-- NetSuite rejected the authentication, HTTP 401/403, before the RESTlet ran). C1 settled the CI
-- lock as released / not_received (no monthly quota used). A released lock is frozen, so
-- elm_retry_step (needs a live lock) and elm_claim_process (one process per solicitud) both
-- refuse: the solicitud could never be sent again.
--
-- elm_manual_retry_s1 (operator action, janus_manual): in ONE transaction, under the per-CI
-- advisory lock and the process row lock,
--   1. re-checks that ELM provably never received the lead (elm_process_reception = 'none':
--      current and every archived S1 error are pre-reception; HTTP 401/403; S2 never started;
--      no consumed lock; not resolved by operations; not a CZ fallback process);
--   2. takes a NEW reservation through elm_ci_lock_try (same CI rules as a first send: active
--      referral, uncertain result, send in progress, monthly quota). The released lock stays as
--      history;
--   3. archives the failed attempt in elm_step_attempts;
--   4. moves the SAME process back to s1 in_flight (attempt + 1, same frozen s1_request);
--   5. records an 'retried' audit event.
-- Any error rolls the whole call back: no new lock, no archived attempt, no process change.
-- Refusals return a status before anything is written.
--
-- Returns jsonb:
--   {status:'retried', process, lock}
--   {status:'not_found'|'stale'|'not_pre_reception'|'attempts_exhausted'}
--   {status:'not_allowed', reason:'ops_resolved'|'automatic_origin'}
--   {status:'blocked', lock:{status:'blocked', block, related_cz_solicitud_id, ...}}

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.elm_ci_lock_try(bigint, bigint, uuid, text, timestamptz)') IS NULL
     OR to_regprocedure('public.elm_process_reception(public.elm_lead_processes)') IS NULL THEN
    RAISE EXCEPTION 'precondition_failed: apply 20261010_provider_fallback_c1_events.sql first';
  END IF;
END;
$$;

ALTER TABLE public.elm_ops_audit_events
  DROP CONSTRAINT IF EXISTS elm_ops_audit_events_action_check;
ALTER TABLE public.elm_ops_audit_events
  ADD CONSTRAINT elm_ops_audit_events_action_check
  CHECK (action IN ('created', 'assigned', 'unassigned', 'triaged', 'resolved', 'retried'));

CREATE OR REPLACE FUNCTION public.elm_manual_retry_s1(
  p_cz_solicitud_id bigint,
  p_expected_attempts integer,
  p_max_attempts integer,
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
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'elm_ops_actor_required';
  END IF;
  IF p_cz_solicitud_id IS NULL OR p_cz_solicitud_id <= 0 THEN
    RAISE EXCEPTION 'elm_invalid_cz_solicitud_id';
  END IF;
  IF p_expected_attempts IS NULL OR p_expected_attempts < 1 THEN
    RAISE EXCEPTION 'elm_invalid_expected_attempts';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'elm_invalid_max_attempts';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'elm_invalid_lease_seconds';
  END IF;

  SELECT ci INTO v_ci FROM public.elm_lead_processes WHERE cz_solicitud_id = p_cz_solicitud_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  -- Same order as every other writer of this CI: advisory lock first, then the process row.
  PERFORM pg_advisory_xact_lock(hashtextextended('elm_ci_send_lock:' || v_ci::text, 0));
  SELECT * INTO v FROM public.elm_lead_processes WHERE cz_solicitud_id = p_cz_solicitud_id FOR UPDATE;

  IF v.s1_attempts <> p_expected_attempts THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;
  IF v.ops_resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'ops_resolved');
  END IF;
  IF v.trigger_origin = 'cz_automatic'
     OR EXISTS (SELECT 1 FROM public.provider_fallback_requests f WHERE f.cz_solicitud_id = v.cz_solicitud_id) THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'automatic_origin');
  END IF;
  IF v.s1_status <> 'technical_error'
     OR v.s2_status <> 'not_started'
     OR v.s1_http_status IS NULL OR v.s1_http_status NOT IN (401, 403)
     OR public.elm_process_reception(v) <> 'none'
     OR EXISTS (SELECT 1 FROM public.elm_ci_send_locks l
                WHERE l.cz_solicitud_id = v.cz_solicitud_id AND l.state = 'consumed') THEN
    RETURN jsonb_build_object('status', 'not_pre_reception');
  END IF;
  IF v.s1_attempts >= p_max_attempts THEN
    RETURN jsonb_build_object('status', 'attempts_exhausted');
  END IF;

  v_lock := public.elm_ci_lock_try(v.ci, v.cz_solicitud_id, NULL, 'janus_manual', NULL);
  IF v_lock ->> 'status' = 'blocked' THEN
    RETURN jsonb_build_object('status', 'blocked', 'lock', v_lock);
  END IF;
  IF v_lock ->> 'status' = 'held' AND v_lock ->> 'state' <> 'reserved' THEN
    RETURN jsonb_build_object('status', 'not_pre_reception');
  END IF;

  INSERT INTO public.elm_step_attempts (
    elm_process_id, cz_solicitud_id, step, attempt_no, status, http_status, result_message,
    error_code, error_detail, response, started_at, completed_at
  ) VALUES (
    v.id, v.cz_solicitud_id, 's1', v.s1_attempts, v.s1_status, v.s1_http_status, v.s1_result_message,
    v.s1_error_code, v.s1_error_detail, v.s1_response, v.s1_started_at, v.s1_completed_at
  );

  UPDATE public.elm_lead_processes p
  SET s1_status = 'in_flight',
      s1_attempts = p.s1_attempts + 1,
      s1_response = NULL, s1_http_status = NULL, s1_result_message = NULL,
      s1_completed_at = NULL, s1_latency_ms = NULL, s1_error_code = NULL, s1_error_detail = NULL,
      s1_started_at = now(),
      s1_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  WHERE p.id = v.id
  RETURNING p.* INTO v;

  INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
  VALUES ('elm_process', v.id, v.cz_solicitud_id, 'retried', p_actor_user_id, jsonb_build_object(
    'step', 's1',
    'kind', 'pre_reception',
    'archived_attempt', v.s1_attempts - 1,
    'attempt', v.s1_attempts,
    'max_attempts', p_max_attempts,
    'lock_id', v_lock ->> 'lock_id',
    'lock_status', v_lock ->> 'status',
    'lock_month', v_lock ->> 'month_key'
  ));

  RETURN jsonb_build_object('status', 'retried', 'process', to_jsonb(v), 'lock', v_lock);
END;
$$;

COMMENT ON FUNCTION public.elm_manual_retry_s1(bigint, integer, integer, integer, uuid) IS
  'Operator retry of an S1 that ELM provably never received (pre-reception error). Same process, same frozen request, new CI reservation, archived attempt and audit event in one transaction. Never called by the automatic path.';

REVOKE ALL ON FUNCTION public.elm_manual_retry_s1(bigint, integer, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_manual_retry_s1(bigint, integer, integer, integer, uuid) TO service_role;

COMMIT;
