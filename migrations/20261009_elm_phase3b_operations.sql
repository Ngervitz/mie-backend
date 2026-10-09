-- Fase 3B: operations on top of ELM 1A/1B and provider fallback 3A.
-- NOT APPLIED. Apply manually in Supabase AFTER, in this order:
--   20261007_elm_lead_processes.sql, 20261007_elm_postback_events.sql,
--   20261008_provider_fallback_requests.sql, then this file.
-- Idempotent. Reuses public.set_updated_at().
--
-- A. elm_lead_processes
--    - commercial_origin: commercial origin of the lead (SMS base label, NULL = organic or not
--      resolved). Tracking only; the ELM `source` sent is the constant 'copanel' (source_brand).
--    - s1_attempts / s2_attempts + elm_step_attempts: a step in technical_error may be retried
--      ONLY through elm_retry_step, ONLY when its stored error_code is in the caller-supplied
--      retry-safe list (explicit provider answer proven side-effect free) and below the limit.
--      unknown is never retried (no transition leaves unknown).
--    - ops_resolution_*: audited manual resolution of an active referral (s2 referred) or of an
--      uncertain step (unknown). Set once via elm_resolve_process; never changes ELM state,
--      provider status or GRANTED (disbursed_at only comes from the "Convertido" postback).
--    The 1A guard function is replaced (same rules + retry transition + resolution rules).
--    The 1B granted guard trigger is a separate trigger and is untouched.
-- B. elm_ops_audit_events: append-only audit of manual actions (processes and review cases).
-- C. provider_review_cases: one case per fallback request finalized as manual_review, created
--    in the same transaction as the outcome (no "en revisión" without a registered case).
-- D. provider_fallback_finalize replaced (adds review priority/due).
--
-- Access: backend only (service_role). RLS on, no policies, PUBLIC/anon/authenticated revoked.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. elm_lead_processes: new columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.elm_lead_processes
  ADD COLUMN IF NOT EXISTS commercial_origin   text NULL,
  ADD COLUMN IF NOT EXISTS s1_attempts         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS s2_attempts         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ops_resolution_code text NULL,
  ADD COLUMN IF NOT EXISTS ops_resolution_note text NULL,
  ADD COLUMN IF NOT EXISTS ops_resolved_by     uuid NULL REFERENCES public.dashboard_users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ops_resolved_at     timestamptz NULL;

-- Rows created before 3B (the 1A guard is still active here and does not watch these columns).
UPDATE public.elm_lead_processes SET s1_attempts = 1 WHERE s1_status <> 'not_started' AND s1_attempts = 0;
UPDATE public.elm_lead_processes SET s2_attempts = 1 WHERE s2_status <> 'not_started' AND s2_attempts = 0;

ALTER TABLE public.elm_lead_processes
  DROP CONSTRAINT IF EXISTS elm_lead_processes_s1_attempts_check;
ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_s1_attempts_check
  CHECK (s1_attempts BETWEEN 0 AND 20 AND (s1_status = 'not_started') = (s1_attempts = 0));
ALTER TABLE public.elm_lead_processes
  DROP CONSTRAINT IF EXISTS elm_lead_processes_s2_attempts_check;
ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_s2_attempts_check
  CHECK (s2_attempts BETWEEN 0 AND 20 AND (s2_status = 'not_started') = (s2_attempts = 0));
ALTER TABLE public.elm_lead_processes
  DROP CONSTRAINT IF EXISTS elm_lead_processes_commercial_origin_check;
ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_commercial_origin_check
  CHECK (commercial_origin IS NULL OR (btrim(commercial_origin) <> '' AND length(commercial_origin) <= 200));
ALTER TABLE public.elm_lead_processes
  DROP CONSTRAINT IF EXISTS elm_lead_processes_ops_resolution_check;
ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_ops_resolution_check
  CHECK (
    (ops_resolved_at IS NULL) = (ops_resolution_code IS NULL)
    AND (ops_resolution_code IS NULL OR (ops_resolution_note IS NOT NULL AND length(btrim(ops_resolution_note)) >= 10))
  );

COMMENT ON COLUMN public.elm_lead_processes.source_brand IS
  'Value sent as ELM `source` (3B: constant copanel). Not the commercial origin of the lead.';
COMMENT ON COLUMN public.elm_lead_processes.commercial_origin IS
  'Commercial origin of the lead for tracking (SMS base label). NULL = organic or not resolved. Never sent to ELM.';
COMMENT ON COLUMN public.elm_lead_processes.ops_resolution_code IS
  'Audited manual resolution (active referral closed / uncertain step reconciled). Once set, the process stops blocking new ELM sends for the same CI. Never sets GRANTED.';

CREATE INDEX IF NOT EXISTS idx_elm_lead_processes_active_referrals
  ON public.elm_lead_processes (referred_at)
  WHERE s2_status IN ('referred', 'unknown') AND ops_resolved_at IS NULL;

-- Archived attempts (written only by elm_retry_step before a technical_error step is reset).
CREATE TABLE IF NOT EXISTS public.elm_step_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  elm_process_id  uuid NOT NULL REFERENCES public.elm_lead_processes (id),
  cz_solicitud_id bigint NOT NULL,
  step            text NOT NULL CHECK (step IN ('s1', 's2')),
  attempt_no      integer NOT NULL CHECK (attempt_no >= 1),
  status          text NOT NULL CHECK (status = 'technical_error'),
  http_status     integer NULL,
  result_message  text NULL,
  error_code      text NULL,
  error_detail    text NULL,
  response        jsonb NULL,
  started_at      timestamptz NULL,
  completed_at    timestamptz NULL,
  archived_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT elm_step_attempts_unique UNIQUE (elm_process_id, step, attempt_no)
);

-- ---------------------------------------------------------------------------
-- A2. Guard (replaces the 1A function; same trigger).
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- A3. ELM RPCs replaced / added
-- ---------------------------------------------------------------------------

-- New argument p_commercial_origin. The old 9-argument overload is dropped so PostgREST calls
-- are never ambiguous.
DROP FUNCTION IF EXISTS public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer);
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
  p_commercial_origin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.elm_lead_processes%ROWTYPE;
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

  INSERT INTO public.elm_lead_processes (
    cz_solicitud_id, ci, source_brand, commercial_origin, trigger_origin, triggered_by_user_id,
    cz_estado_id_at_start, lrw_id_at_start,
    s1_status, s1_attempts, s1_request, s1_started_at, s1_lease_expires_at
  )
  VALUES (
    p_cz_solicitud_id, p_ci, p_source_brand, NULLIF(btrim(p_commercial_origin), ''), p_trigger_origin,
    p_triggered_by_user_id, p_cz_estado_id_at_start, p_lrw_id_at_start,
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

-- Same signature as 1A; now also counts the S2 attempt.
CREATE OR REPLACE FUNCTION public.elm_begin_s2(
  p_cz_solicitud_id bigint,
  p_s2_request jsonb,
  p_lease_seconds integer
)
RETURNS SETOF public.elm_lead_processes
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'elm_invalid_lease_seconds';
  END IF;
  IF p_s2_request IS NULL OR jsonb_typeof(p_s2_request) <> 'object' THEN
    RAISE EXCEPTION 'elm_invalid_s2_request';
  END IF;

  RETURN QUERY
  UPDATE public.elm_lead_processes p
  SET
    s2_status = 'in_flight',
    s2_attempts = 1,
    s2_request = p_s2_request,
    s2_started_at = now(),
    s2_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  WHERE p.cz_solicitud_id = p_cz_solicitud_id
    AND p.s1_status = 'eligible'
    AND p.s2_status = 'not_started'
    AND p.ops_resolved_at IS NULL
  RETURNING p.*;
END;
$$;

-- Retry of a technical_error step with the SAME frozen request. Atomic and idempotent:
-- the caller passes the attempt count it observed; a concurrent retry makes it a no-op.
CREATE OR REPLACE FUNCTION public.elm_retry_step(
  p_cz_solicitud_id bigint,
  p_step text,
  p_expected_attempts integer,
  p_max_attempts integer,
  p_retry_safe_error_codes text[],
  p_lease_seconds integer
)
RETURNS SETOF public.elm_lead_processes
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.elm_lead_processes%ROWTYPE;
BEGIN
  IF p_step NOT IN ('s1', 's2') THEN
    RAISE EXCEPTION 'elm_invalid_step';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'elm_invalid_lease_seconds';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'elm_invalid_max_attempts';
  END IF;

  SELECT * INTO v FROM public.elm_lead_processes
  WHERE cz_solicitud_id = p_cz_solicitud_id
  FOR UPDATE;
  IF NOT FOUND OR v.ops_resolved_at IS NOT NULL THEN
    RETURN;
  END IF;

  IF p_step = 's1' THEN
    IF v.s1_status <> 'technical_error' OR v.s1_attempts <> p_expected_attempts
       OR v.s1_attempts >= p_max_attempts
       OR v.s1_error_code IS NULL OR NOT (v.s1_error_code = ANY (COALESCE(p_retry_safe_error_codes, '{}'::text[]))) THEN
      RETURN;
    END IF;
    INSERT INTO public.elm_step_attempts (
      elm_process_id, cz_solicitud_id, step, attempt_no, status, http_status, result_message,
      error_code, error_detail, response, started_at, completed_at
    ) VALUES (
      v.id, v.cz_solicitud_id, 's1', v.s1_attempts, v.s1_status, v.s1_http_status, v.s1_result_message,
      v.s1_error_code, v.s1_error_detail, v.s1_response, v.s1_started_at, v.s1_completed_at
    );
    RETURN QUERY
    UPDATE public.elm_lead_processes p
    SET s1_status = 'in_flight',
        s1_attempts = p.s1_attempts + 1,
        s1_response = NULL, s1_http_status = NULL, s1_result_message = NULL,
        s1_completed_at = NULL, s1_latency_ms = NULL, s1_error_code = NULL, s1_error_detail = NULL,
        s1_started_at = now(),
        s1_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    WHERE p.id = v.id
    RETURNING p.*;
  ELSE
    IF v.s2_status <> 'technical_error' OR v.s2_attempts <> p_expected_attempts
       OR v.s2_attempts >= p_max_attempts
       OR v.s2_error_code IS NULL OR NOT (v.s2_error_code = ANY (COALESCE(p_retry_safe_error_codes, '{}'::text[]))) THEN
      RETURN;
    END IF;
    INSERT INTO public.elm_step_attempts (
      elm_process_id, cz_solicitud_id, step, attempt_no, status, http_status, result_message,
      error_code, error_detail, response, started_at, completed_at
    ) VALUES (
      v.id, v.cz_solicitud_id, 's2', v.s2_attempts, v.s2_status, v.s2_http_status, v.s2_result_message,
      v.s2_error_code, v.s2_error_detail, v.s2_response, v.s2_started_at, v.s2_completed_at
    );
    RETURN QUERY
    UPDATE public.elm_lead_processes p
    SET s2_status = 'in_flight',
        s2_attempts = p.s2_attempts + 1,
        s2_response = NULL, s2_http_status = NULL, s2_result_message = NULL,
        s2_completed_at = NULL, s2_latency_ms = NULL, s2_error_code = NULL, s2_error_detail = NULL,
        s2_started_at = now(),
        s2_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    WHERE p.id = v.id
    RETURNING p.*;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- B. Audit of manual actions (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.elm_ops_audit_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      text NOT NULL CHECK (entity_type IN ('elm_process', 'review_case')),
  entity_id        uuid NOT NULL,
  cz_solicitud_id  bigint NULL,
  action           text NOT NULL CHECK (action IN ('created', 'assigned', 'unassigned', 'triaged', 'resolved')),
  -- No FK: dashboard users are hard-deleted and this table is append-only; the id is kept as history.
  actor_user_id    uuid NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_elm_ops_audit_events_entity
  ON public.elm_ops_audit_events (entity_type, entity_id, created_at);

CREATE OR REPLACE FUNCTION public.elm_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_elm_ops_audit_events_guard ON public.elm_ops_audit_events;
CREATE TRIGGER trg_elm_ops_audit_events_guard
  BEFORE UPDATE OR DELETE ON public.elm_ops_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.elm_append_only_guard();
DROP TRIGGER IF EXISTS trg_elm_step_attempts_guard ON public.elm_step_attempts;
CREATE TRIGGER trg_elm_step_attempts_guard
  BEFORE UPDATE OR DELETE ON public.elm_step_attempts
  FOR EACH ROW EXECUTE FUNCTION public.elm_append_only_guard();

-- Manual resolution of an ELM process. Row lock serializes with postbacks, finish/retry RPCs.
-- p_expected_updated_at = the version the operator saw: any change since then → stale.
CREATE OR REPLACE FUNCTION public.elm_resolve_process(
  p_process_id uuid,
  p_expected_updated_at timestamptz,
  p_resolution_code text,
  p_note text,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.elm_lead_processes%ROWTYPE;
  v_kind text;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'elm_ops_actor_required';
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 10 OR length(p_note) > 2000 THEN
    RETURN jsonb_build_object('status', 'note_required');
  END IF;

  SELECT * INTO v FROM public.elm_lead_processes WHERE id = p_process_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v.ops_resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_resolved');
  END IF;
  IF p_expected_updated_at IS NULL OR v.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;
  IF v.s1_status = 'in_flight' OR v.s2_status = 'in_flight' THEN
    RETURN jsonb_build_object('status', 'in_flight');
  END IF;

  IF v.s2_status = 'referred' THEN
    v_kind := 'referral';
  ELSIF v.s2_status = 'unknown' THEN
    v_kind := 's2_unknown';
  ELSIF v.s1_status = 'unknown' THEN
    v_kind := 's1_unknown';
  ELSE
    RETURN jsonb_build_object('status', 'not_resolvable');
  END IF;

  IF NOT (
    (v_kind = 'referral' AND p_resolution_code IN
      ('provider_closed_no_loan', 'provider_loan_disbursed', 'customer_withdrew', 'other'))
    OR (v_kind = 's2_unknown' AND p_resolution_code IN
      ('provider_confirmed_not_received', 'provider_closed_no_loan', 'provider_loan_disbursed', 'other'))
    OR (v_kind = 's1_unknown' AND p_resolution_code IN
      ('provider_confirmed_not_received', 'provider_confirmed_no_referral', 'other'))
  ) THEN
    RETURN jsonb_build_object('status', 'invalid_resolution');
  END IF;
  IF p_resolution_code = 'provider_loan_disbursed' AND v.disbursed_at IS NULL THEN
    RETURN jsonb_build_object('status', 'evidence_required');
  END IF;

  UPDATE public.elm_lead_processes
  SET ops_resolution_code = p_resolution_code,
      ops_resolution_note = btrim(p_note),
      ops_resolved_by = p_actor_user_id,
      ops_resolved_at = now()
  WHERE id = v.id
  RETURNING * INTO v;

  INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
  VALUES ('elm_process', v.id, v.cz_solicitud_id, 'resolved', p_actor_user_id, jsonb_build_object(
    'kind', v_kind,
    'resolution_code', p_resolution_code,
    'note', btrim(p_note),
    's1_status', v.s1_status,
    's2_status', v.s2_status,
    'provider_status', v.provider_status,
    'disbursed', v.disbursed_at IS NOT NULL,
    'last_postback_event_id', v.last_postback_event_id
  ));

  RETURN jsonb_build_object('status', 'resolved', 'kind', v_kind, 'resolved_at', v.ops_resolved_at);
END;
$$;

-- ---------------------------------------------------------------------------
-- C. provider_review_cases
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_review_cases (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fallback_request_id      uuid NOT NULL REFERENCES public.provider_fallback_requests (id),
  cz_solicitud_id          bigint NOT NULL,
  ci                       bigint NOT NULL,
  elm_process_id           uuid NULL REFERENCES public.elm_lead_processes (id),
  related_cz_solicitud_id  bigint NULL,
  reason_code              text NOT NULL,
  priority                 text NOT NULL,
  due_at                   timestamptz NOT NULL,
  status                   text NOT NULL DEFAULT 'open',
  assigned_to              uuid NULL REFERENCES public.dashboard_users (id) ON DELETE SET NULL,
  assigned_at              timestamptz NULL,
  resolution_code          text NULL,
  resolution_note          text NULL,
  resolved_by              uuid NULL REFERENCES public.dashboard_users (id) ON DELETE SET NULL,
  resolved_at              timestamptz NULL,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provider_review_cases_request_key UNIQUE (fallback_request_id),
  CONSTRAINT provider_review_cases_priority_check CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  CONSTRAINT provider_review_cases_status_check CHECK (status IN ('open', 'resolved')),
  CONSTRAINT provider_review_cases_reason_check CHECK (btrim(reason_code) <> ''),
  CONSTRAINT provider_review_cases_assigned_check CHECK (assigned_to IS NULL OR assigned_at IS NOT NULL),
  CONSTRAINT provider_review_cases_resolved_check CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL AND resolution_code IS NOT NULL)
    AND (resolution_code IS NULL OR (resolution_note IS NOT NULL AND length(btrim(resolution_note)) >= 10))
  ),
  CONSTRAINT provider_review_cases_version_check CHECK (version >= 1)
);

COMMENT ON TABLE public.provider_review_cases IS
  'Manual review queue (Fase 3B). One case per provider_fallback_requests row finalized as manual_review; created in the same transaction. Backend-only.';

CREATE INDEX IF NOT EXISTS idx_provider_review_cases_open
  ON public.provider_review_cases (due_at)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_provider_review_cases_process
  ON public.provider_review_cases (elm_process_id);

CREATE OR REPLACE FUNCTION public.provider_review_cases_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_review_cases rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.resolution_code IS NOT NULL THEN
      RAISE EXCEPTION 'provider_review_cases insert must be open';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.fallback_request_id, NEW.cz_solicitud_id, NEW.ci, NEW.elm_process_id,
      NEW.related_cz_solicitud_id, NEW.reason_code, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.fallback_request_id, OLD.cz_solicitud_id, OLD.ci, OLD.elm_process_id,
      OLD.related_cz_solicitud_id, OLD.reason_code, OLD.created_at) THEN
    RAISE EXCEPTION 'provider_review_cases identity columns are immutable';
  END IF;
  IF NEW.version = OLD.version THEN
    -- Without a version bump only ON DELETE SET NULL of a dashboard user is accepted.
    IF (NEW.status, NEW.priority, NEW.due_at, NEW.assigned_at, NEW.resolution_code,
        NEW.resolution_note, NEW.resolved_at)
       IS DISTINCT FROM
       (OLD.status, OLD.priority, OLD.due_at, OLD.assigned_at, OLD.resolution_code,
        OLD.resolution_note, OLD.resolved_at)
       OR (NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL)
       OR (NEW.resolved_by IS DISTINCT FROM OLD.resolved_by AND NEW.resolved_by IS NOT NULL) THEN
      RAISE EXCEPTION 'provider_review_cases version must increment on every change';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'provider_review_cases resolved case is frozen';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'provider_review_cases version must increment by one';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_review_cases_guard ON public.provider_review_cases;
CREATE TRIGGER trg_provider_review_cases_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.provider_review_cases
  FOR EACH ROW EXECUTE FUNCTION public.provider_review_cases_guard();
DROP TRIGGER IF EXISTS trg_provider_review_cases_updated_at ON public.provider_review_cases;
CREATE TRIGGER trg_provider_review_cases_updated_at
  BEFORE UPDATE ON public.provider_review_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Finalize now also registers the review case when the outcome is manual_review.
DROP FUNCTION IF EXISTS public.provider_fallback_finalize(uuid, text, text, text, jsonb, uuid, bigint);
CREATE OR REPLACE FUNCTION public.provider_fallback_finalize(
  p_id uuid,
  p_worker_id text,
  p_outcome text,
  p_reason_code text,
  p_reason_detail jsonb,
  p_elm_process_id uuid,
  p_related_cz_solicitud_id bigint,
  p_review_priority text DEFAULT NULL,
  p_review_due_seconds integer DEFAULT NULL
)
RETURNS SETOF public.provider_fallback_requests
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.provider_fallback_requests%ROWTYPE;
  v_case_id uuid;
BEGIN
  IF p_outcome IS NULL
     OR p_outcome NOT IN ('referred', 'already_referred', 'rejected', 'not_eligible', 'manual_review') THEN
    RAISE EXCEPTION 'provider_fallback_invalid_outcome';
  END IF;
  IF p_reason_code IS NULL OR btrim(p_reason_code) = '' THEN
    RAISE EXCEPTION 'provider_fallback_reason_code_required';
  END IF;
  IF p_outcome = 'manual_review' THEN
    IF p_review_priority IS NULL OR p_review_priority NOT IN ('urgent', 'high', 'normal', 'low')
       OR p_review_due_seconds IS NULL OR p_review_due_seconds < 60 OR p_review_due_seconds > 2592000 THEN
      RAISE EXCEPTION 'provider_fallback_review_sla_required';
    END IF;
  ELSIF p_review_priority IS NOT NULL OR p_review_due_seconds IS NOT NULL THEN
    RAISE EXCEPTION 'provider_fallback_review_sla_only_for_manual_review';
  END IF;

  UPDATE public.provider_fallback_requests p
  SET
    exec_status = 'done',
    job_lease_owner = NULL,
    job_lease_expires_at = NULL,
    outcome = p_outcome,
    reason_code = left(p_reason_code, 100),
    reason_detail = p_reason_detail,
    elm_process_id = p_elm_process_id,
    related_cz_solicitud_id = p_related_cz_solicitud_id,
    finalized_at = now(),
    cz_delivery_status = 'pending'
  WHERE p.id = p_id
    AND p.exec_status = 'running'
    AND p.job_lease_owner = p_worker_id
    AND p.outcome = 'pending'
  RETURNING p.* INTO v;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_outcome = 'manual_review' THEN
    INSERT INTO public.provider_review_cases (
      fallback_request_id, cz_solicitud_id, ci, elm_process_id, related_cz_solicitud_id,
      reason_code, priority, due_at
    ) VALUES (
      v.id, v.cz_solicitud_id, v.ci, v.elm_process_id, v.related_cz_solicitud_id,
      v.reason_code, p_review_priority, now() + make_interval(secs => p_review_due_seconds)
    )
    RETURNING id INTO v_case_id;
    INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
    VALUES ('review_case', v_case_id, v.cz_solicitud_id, 'created', NULL,
            jsonb_build_object('reason_code', v.reason_code, 'priority', p_review_priority));
  END IF;

  RETURN NEXT v;
END;
$$;

-- Review case actions. p_expected_version = version the operator saw (optimistic lock).
CREATE OR REPLACE FUNCTION public.provider_review_assign(
  p_case_id uuid,
  p_expected_version integer,
  p_assignee uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.provider_review_cases%ROWTYPE;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'provider_review_actor_required';
  END IF;
  SELECT * INTO v FROM public.provider_review_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v.status <> 'open' THEN RETURN jsonb_build_object('status', 'resolved'); END IF;
  IF v.version IS DISTINCT FROM p_expected_version THEN RETURN jsonb_build_object('status', 'stale'); END IF;

  UPDATE public.provider_review_cases
  SET assigned_to = p_assignee,
      assigned_at = CASE WHEN p_assignee IS NULL THEN NULL ELSE now() END,
      version = version + 1
  WHERE id = v.id
  RETURNING * INTO v;

  INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
  VALUES ('review_case', v.id, v.cz_solicitud_id,
          CASE WHEN p_assignee IS NULL THEN 'unassigned' ELSE 'assigned' END,
          p_actor_user_id, jsonb_build_object('assignee', p_assignee));
  RETURN jsonb_build_object('status', CASE WHEN p_assignee IS NULL THEN 'unassigned' ELSE 'assigned' END,
                            'version', v.version);
END;
$$;

CREATE OR REPLACE FUNCTION public.provider_review_triage(
  p_case_id uuid,
  p_expected_version integer,
  p_priority text,
  p_due_at timestamptz,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.provider_review_cases%ROWTYPE;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'provider_review_actor_required';
  END IF;
  IF p_priority IS NULL OR p_priority NOT IN ('urgent', 'high', 'normal', 'low') OR p_due_at IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_triage');
  END IF;
  SELECT * INTO v FROM public.provider_review_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v.status <> 'open' THEN RETURN jsonb_build_object('status', 'resolved'); END IF;
  IF v.version IS DISTINCT FROM p_expected_version THEN RETURN jsonb_build_object('status', 'stale'); END IF;

  UPDATE public.provider_review_cases
  SET priority = p_priority, due_at = p_due_at, version = version + 1
  WHERE id = v.id
  RETURNING * INTO v;

  INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
  VALUES ('review_case', v.id, v.cz_solicitud_id, 'triaged', p_actor_user_id,
          jsonb_build_object('priority', p_priority, 'due_at', p_due_at));
  RETURN jsonb_build_object('status', 'triaged', 'version', v.version);
END;
$$;

CREATE OR REPLACE FUNCTION public.provider_review_resolve(
  p_case_id uuid,
  p_expected_version integer,
  p_resolution_code text,
  p_note text,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.provider_review_cases%ROWTYPE;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'provider_review_actor_required';
  END IF;
  IF p_resolution_code IS NULL OR p_resolution_code NOT IN
     ('resolved_with_provider', 'customer_contacted', 'no_action_required', 'other') THEN
    RETURN jsonb_build_object('status', 'invalid_resolution');
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 10 OR length(p_note) > 2000 THEN
    RETURN jsonb_build_object('status', 'note_required');
  END IF;
  SELECT * INTO v FROM public.provider_review_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v.status <> 'open' THEN RETURN jsonb_build_object('status', 'already_resolved'); END IF;
  IF v.version IS DISTINCT FROM p_expected_version THEN RETURN jsonb_build_object('status', 'stale'); END IF;

  UPDATE public.provider_review_cases
  SET status = 'resolved',
      resolution_code = p_resolution_code,
      resolution_note = btrim(p_note),
      resolved_by = p_actor_user_id,
      resolved_at = now(),
      version = version + 1
  WHERE id = v.id
  RETURNING * INTO v;

  INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
  VALUES ('review_case', v.id, v.cz_solicitud_id, 'resolved', p_actor_user_id,
          jsonb_build_object('resolution_code', p_resolution_code, 'note', btrim(p_note)));
  RETURN jsonb_build_object('status', 'resolved', 'version', v.version);
END;
$$;

-- ---------------------------------------------------------------------------
-- E. Access: backend only.
-- ---------------------------------------------------------------------------

ALTER TABLE public.elm_step_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.elm_ops_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_review_cases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.elm_step_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.elm_ops_audit_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.provider_review_cases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.elm_step_attempts TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.elm_step_attempts FROM service_role;
GRANT SELECT, INSERT ON TABLE public.elm_ops_audit_events TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.elm_ops_audit_events FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.provider_review_cases TO service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.provider_review_cases FROM service_role;

REVOKE ALL ON FUNCTION public.elm_append_only_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_review_cases_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.elm_begin_s2(bigint, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_begin_s2(bigint, jsonb, integer) TO service_role;
REVOKE ALL ON FUNCTION public.elm_retry_step(bigint, text, integer, integer, text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_retry_step(bigint, text, integer, integer, text[], integer) TO service_role;
REVOKE ALL ON FUNCTION public.elm_resolve_process(uuid, timestamptz, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_resolve_process(uuid, timestamptz, text, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.provider_fallback_finalize(uuid, text, text, text, jsonb, uuid, bigint, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_finalize(uuid, text, text, text, jsonb, uuid, bigint, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.provider_review_assign(uuid, integer, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_review_assign(uuid, integer, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.provider_review_triage(uuid, integer, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_review_triage(uuid, integer, text, timestamptz, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.provider_review_resolve(uuid, integer, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_review_resolve(uuid, integer, text, text, uuid) TO service_role;

COMMIT;
