-- S2 contract correction (ELM confirmed: HTTP 200 + success true + result null = referred).
--
-- Defines the predicate, one extra guard transition, an append-only audit table, and
-- elm_reconcile_s2_success_true(). Applying this file does NOT update any process and does
-- NOT call ELM or emit any event. Run the function only after an explicit authorization.
--
-- Depends on 20261009_elm_phase3b_operations.sql (the guard replaced here is that function,
-- plus the single transition below). Later migrations do not replace this guard.
--
-- Historical predicate (stricter than the forward parser): s2 unknown, HTTP 200,
-- elm_response_undocumented, boolean success true, result key present and JSON null,
-- s2_completed_at set. An absent result is accepted on new responses only.

BEGIN;

CREATE OR REPLACE FUNCTION public.elm_s2_success_true_null_result(p public.elm_lead_processes)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT p.s2_http_status = 200
    AND p.s2_error_code = 'elm_response_undocumented'
    AND p.s2_completed_at IS NOT NULL
    AND jsonb_typeof(p.s2_response) = 'object'
    AND p.s2_response ? 'success'
    AND p.s2_response->'success' = 'true'::jsonb
    AND p.s2_response ? 'result'
    AND p.s2_response->'result' = 'null'::jsonb;
$$;

COMMENT ON FUNCTION public.elm_s2_success_true_null_result(public.elm_lead_processes) IS
  'Stored S2 body matches the confirmed ELM contract (boolean success true, result JSON null). Does not match an absent result key.';

-- Replaces the 3B guard. Same rules, plus unknown -> referred when the stored row matches
-- elm_s2_success_true_null_result, referred_at is set to the original s2_completed_at, and
-- every S2 result column (including the original error code and the response body) is unchanged.
CREATE OR REPLACE FUNCTION public.elm_lead_processes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_s1_retry boolean;
  v_s2_retry boolean;
  v_s2_contract boolean;
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
  v_s2_contract :=
    OLD.s2_status = 'unknown'
    AND NEW.s2_status = 'referred'
    AND public.elm_s2_success_true_null_result(OLD)
    AND NEW.referred_at IS NOT DISTINCT FROM OLD.s2_completed_at
    AND (NEW.s2_response, NEW.s2_http_status, NEW.s2_result_message, NEW.s2_started_at,
         NEW.s2_completed_at, NEW.s2_latency_ms, NEW.s2_error_code, NEW.s2_error_detail,
         NEW.s2_attempts, NEW.s2_lease_expires_at)
       IS NOT DISTINCT FROM
       (OLD.s2_response, OLD.s2_http_status, OLD.s2_result_message, OLD.s2_started_at,
        OLD.s2_completed_at, OLD.s2_latency_ms, OLD.s2_error_code, OLD.s2_error_detail,
        OLD.s2_attempts, OLD.s2_lease_expires_at);

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
      OR v_s2_contract
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

  -- Manual resolution: once, only for an active referral or an uncertain step, never together
  -- with any ELM/provider/GRANTED change.
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

CREATE TABLE IF NOT EXISTS public.elm_s2_contract_reconcile (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  elm_process_id   uuid NOT NULL REFERENCES public.elm_lead_processes (id),
  cz_solicitud_id  bigint NOT NULL,
  rule             text NOT NULL CHECK (rule = 's2_success_true_result_null'),
  s2_completed_at  timestamptz NOT NULL,
  referred_at      timestamptz NOT NULL,
  reconciled_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT elm_s2_contract_reconcile_process_unique UNIQUE (elm_process_id)
);

COMMENT ON TABLE public.elm_s2_contract_reconcile IS
  'One row per process regularized from S2 unknown to referred under the success-true/result-null contract. Append-only. Does not replace s2_response.';

DROP TRIGGER IF EXISTS trg_elm_s2_contract_reconcile_guard ON public.elm_s2_contract_reconcile;
CREATE TRIGGER trg_elm_s2_contract_reconcile_guard
  BEFORE UPDATE OR DELETE ON public.elm_s2_contract_reconcile
  FOR EACH ROW EXECUTE FUNCTION public.elm_append_only_guard();

-- Updates only rows that already match the historical predicate. Sets referred_at to the
-- original s2_completed_at. Leaves the response, HTTP status, error code, and S2 timestamps
-- unchanged. A second call updates zero rows.
CREATE OR REPLACE FUNCTION public.elm_reconcile_s2_success_true()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH updated AS (
    UPDATE public.elm_lead_processes p
    SET s2_status = 'referred',
        referred_at = p.s2_completed_at
    WHERE p.s2_status = 'unknown'
      AND p.referred_at IS NULL
      AND public.elm_s2_success_true_null_result(p)
    RETURNING p.id, p.cz_solicitud_id, p.s2_completed_at, p.referred_at
  ),
  audited AS (
    INSERT INTO public.elm_s2_contract_reconcile (
      elm_process_id, cz_solicitud_id, rule, s2_completed_at, referred_at
    )
    SELECT id, cz_solicitud_id, 's2_success_true_result_null', s2_completed_at, referred_at
    FROM updated
    RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM audited;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.elm_reconcile_s2_success_true() IS
  'Regularize stored S2 responses that are HTTP 200, boolean success true, and result JSON null. Does not call ELM and does not emit events. Idempotent.';

ALTER TABLE public.elm_s2_contract_reconcile ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.elm_s2_contract_reconcile FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.elm_s2_contract_reconcile TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.elm_s2_contract_reconcile FROM service_role;

REVOKE ALL ON FUNCTION public.elm_s2_success_true_null_result(public.elm_lead_processes) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_s2_success_true_null_result(public.elm_lead_processes) TO service_role;

REVOKE ALL ON FUNCTION public.elm_reconcile_s2_success_true() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_reconcile_s2_success_true() TO service_role;

COMMIT;
