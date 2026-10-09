-- Fase 3A: persistent automatic provider fallback (CZ → JANUS → ELM) + ELM late results.
-- NOT APPLIED. Apply manually in Supabase AFTER 20261007_elm_lead_processes.sql and
-- 20261007_elm_postback_events.sql. Reuses existing public.set_updated_at() (do not redefine).
-- Idempotent. Additive only: does not touch cz_funnel_*, CDV, Rechazados, Mi Plan or the
-- existing elm_lead_processes / elm_postback_events objects.
--
-- provider_fallback_requests = one durable job per CZ solicitud (cz_solicitud_id UNIQUE).
-- The ELM call state itself stays in elm_lead_processes (write-ahead in_flight + lease); this
-- table only schedules work, records the final outcome and tracks delivery to CZ.
--
-- Execution:   queued → running (atomic claim, job lease) → queued (defer) | done (finalize).
--              A running row whose job lease expired is reclaimable; the ELM process row decides
--              whether an external call may have started (in_flight → wait / unknown).
-- Outcome:     pending → referred | already_referred | rejected | not_eligible | manual_review.
--              Frozen once final. unknown / technical_error from ELM → manual_review (V1).
-- Delivery:    not_ready → pending (on finalize) → acked (CZ confirmed receipt). Idempotent ack.
-- CI:          only the oldest open request per CI is claimable and at most one per CI may be
--              running. CI is never used to match postbacks or to modify other solicitudes.
--
-- Access: backend only (service_role). RLS enabled with NO policies; PUBLIC/anon/authenticated
-- revoked. snapshot holds PII (CI, DOB, salary, phone, email). Never store credentials here.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. provider_fallback_requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_fallback_requests (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  cz_solicitud_id          bigint NOT NULL,
  ci                       bigint NOT NULL,
  provider                 text NOT NULL DEFAULT 'elm',
  snapshot                 jsonb NOT NULL,
  snapshot_hash            text NOT NULL,

  exec_status              text NOT NULL DEFAULT 'queued',
  run_after                timestamptz NOT NULL DEFAULT now(),
  job_lease_owner          text NULL,
  job_lease_expires_at     timestamptz NULL,
  claim_count              integer NOT NULL DEFAULT 0,
  not_started_attempts     integer NOT NULL DEFAULT 0,
  last_defer_reason        text NULL,
  last_claimed_at          timestamptz NULL,

  outcome                  text NOT NULL DEFAULT 'pending',
  reason_code              text NULL,
  reason_detail            jsonb NULL,
  elm_process_id           uuid NULL REFERENCES public.elm_lead_processes (id),
  related_cz_solicitud_id  bigint NULL,
  finalized_at             timestamptz NULL,

  cz_delivery_status       text NOT NULL DEFAULT 'not_ready',
  cz_acked_at              timestamptz NULL,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provider_fallback_requests_cz_solicitud_id_key UNIQUE (cz_solicitud_id),
  CONSTRAINT provider_fallback_requests_cz_solicitud_id_check CHECK (cz_solicitud_id > 0),
  CONSTRAINT provider_fallback_requests_ci_check CHECK (ci > 0),
  CONSTRAINT provider_fallback_requests_provider_check CHECK (provider IN ('elm')),
  CONSTRAINT provider_fallback_requests_snapshot_object_check
    CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT provider_fallback_requests_snapshot_hash_check
    CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT provider_fallback_requests_exec_status_check
    CHECK (exec_status IN ('queued', 'running', 'done')),
  CONSTRAINT provider_fallback_requests_lease_check
    CHECK ((exec_status = 'running')
           = (job_lease_owner IS NOT NULL AND job_lease_expires_at IS NOT NULL)),
  CONSTRAINT provider_fallback_requests_lease_owner_check
    CHECK (job_lease_owner IS NULL OR (btrim(job_lease_owner) <> '' AND length(job_lease_owner) <= 200)),
  CONSTRAINT provider_fallback_requests_counters_check
    CHECK (claim_count >= 0 AND not_started_attempts >= 0),

  CONSTRAINT provider_fallback_requests_outcome_check
    CHECK (outcome IN ('pending', 'referred', 'already_referred', 'rejected', 'not_eligible', 'manual_review')),
  CONSTRAINT provider_fallback_requests_done_check
    CHECK ((exec_status = 'done') = (outcome <> 'pending')),
  CONSTRAINT provider_fallback_requests_finalized_at_check
    CHECK ((outcome <> 'pending') = (finalized_at IS NOT NULL)),
  CONSTRAINT provider_fallback_requests_reason_code_check
    CHECK (outcome = 'pending' OR (reason_code IS NOT NULL AND btrim(reason_code) <> '')),
  CONSTRAINT provider_fallback_requests_reason_detail_object_check
    CHECK (reason_detail IS NULL OR jsonb_typeof(reason_detail) = 'object'),

  CONSTRAINT provider_fallback_requests_delivery_status_check
    CHECK (cz_delivery_status IN ('not_ready', 'pending', 'acked')),
  CONSTRAINT provider_fallback_requests_delivery_ready_check
    CHECK ((cz_delivery_status = 'not_ready') = (outcome = 'pending')),
  CONSTRAINT provider_fallback_requests_acked_at_check
    CHECK ((cz_delivery_status = 'acked') = (cz_acked_at IS NOT NULL))
);

COMMENT ON TABLE public.provider_fallback_requests IS
  'Fase 3A durable fallback job per CZ solicitud (CZ → JANUS → ELM). Backend-only (PII in snapshot).';
COMMENT ON COLUMN public.provider_fallback_requests.cz_solicitud_id IS
  'Identity = CZ solicitud id. Unique: start is idempotent (INSERT ON CONFLICT DO NOTHING).';
COMMENT ON COLUMN public.provider_fallback_requests.ci IS
  'Applicant CI from the snapshot. Used only to serialize automatic evaluations per person; never to match postbacks or modify other solicitudes.';
COMMENT ON COLUMN public.provider_fallback_requests.snapshot IS
  'Applicant data sent by CZ at start (frozen). PII. Source for the ELM payload instead of the mirror.';
COMMENT ON COLUMN public.provider_fallback_requests.not_started_attempts IS
  'Defers where it is proven no external ELM call started (gates closed). Bounded by config; exhausted → manual_review.';
COMMENT ON COLUMN public.provider_fallback_requests.outcome IS
  'pending | referred (ELM S2 referred) | already_referred (active referral for the CI, nothing sent) | rejected (ELM S1/S2 negative) | not_eligible (data blocks ELM) | manual_review (unknown/technical/config/undefined rule).';
COMMENT ON COLUMN public.provider_fallback_requests.cz_delivery_status IS
  'not_ready (no outcome) | pending (outcome ready for CZ) | acked (CZ confirmed receipt).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_fallback_requests_one_running_per_ci
  ON public.provider_fallback_requests (ci)
  WHERE exec_status = 'running';
CREATE INDEX IF NOT EXISTS idx_provider_fallback_requests_queued
  ON public.provider_fallback_requests (run_after)
  WHERE exec_status = 'queued';
CREATE INDEX IF NOT EXISTS idx_provider_fallback_requests_running_lease
  ON public.provider_fallback_requests (job_lease_expires_at)
  WHERE exec_status = 'running';
CREATE INDEX IF NOT EXISTS idx_provider_fallback_requests_open_ci
  ON public.provider_fallback_requests (ci, created_at, cz_solicitud_id)
  WHERE exec_status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_provider_fallback_requests_delivery_pending
  ON public.provider_fallback_requests (finalized_at, cz_solicitud_id)
  WHERE cz_delivery_status = 'pending';

-- ---------------------------------------------------------------------------
-- B. Guards: identity/snapshot immutable, legal transitions, frozen outcome, no DELETE.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.provider_fallback_requests_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_fallback_requests rows cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.exec_status <> 'queued' OR NEW.outcome <> 'pending'
       OR NEW.cz_delivery_status <> 'not_ready' OR NEW.claim_count <> 0
       OR NEW.not_started_attempts <> 0 OR NEW.elm_process_id IS NOT NULL THEN
      RAISE EXCEPTION 'provider_fallback_requests insert must start queued/pending';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.cz_solicitud_id IS DISTINCT FROM OLD.cz_solicitud_id
     OR NEW.ci IS DISTINCT FROM OLD.ci
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'provider_fallback_requests identity/snapshot columns are immutable';
  END IF;

  IF NEW.claim_count < OLD.claim_count OR NEW.not_started_attempts < OLD.not_started_attempts THEN
    RAISE EXCEPTION 'provider_fallback_requests counters cannot decrease';
  END IF;

  IF NEW.exec_status IS DISTINCT FROM OLD.exec_status THEN
    IF NOT (
      (OLD.exec_status = 'queued' AND NEW.exec_status = 'running')
      OR (OLD.exec_status = 'running' AND NEW.exec_status IN ('queued', 'done'))
    ) THEN
      RAISE EXCEPTION 'provider_fallback_illegal_exec_transition: % -> %', OLD.exec_status, NEW.exec_status;
    END IF;
  END IF;

  IF OLD.outcome <> 'pending' THEN
    IF (NEW.exec_status, NEW.outcome, NEW.reason_code, NEW.reason_detail, NEW.elm_process_id,
        NEW.related_cz_solicitud_id, NEW.finalized_at, NEW.run_after, NEW.job_lease_owner,
        NEW.job_lease_expires_at, NEW.claim_count, NEW.not_started_attempts)
       IS DISTINCT FROM
       (OLD.exec_status, OLD.outcome, OLD.reason_code, OLD.reason_detail, OLD.elm_process_id,
        OLD.related_cz_solicitud_id, OLD.finalized_at, OLD.run_after, OLD.job_lease_owner,
        OLD.job_lease_expires_at, OLD.claim_count, OLD.not_started_attempts) THEN
      RAISE EXCEPTION 'provider_fallback_requests outcome is frozen once final';
    END IF;
  END IF;

  IF NEW.cz_delivery_status IS DISTINCT FROM OLD.cz_delivery_status THEN
    IF NOT (
      (OLD.cz_delivery_status = 'not_ready' AND NEW.cz_delivery_status = 'pending'
       AND NEW.outcome <> 'pending')
      OR (OLD.cz_delivery_status = 'pending' AND NEW.cz_delivery_status = 'acked')
    ) THEN
      RAISE EXCEPTION 'provider_fallback_illegal_delivery_transition: % -> %', OLD.cz_delivery_status, NEW.cz_delivery_status;
    END IF;
  END IF;
  IF OLD.cz_acked_at IS NOT NULL AND NEW.cz_acked_at IS DISTINCT FROM OLD.cz_acked_at THEN
    RAISE EXCEPTION 'provider_fallback_requests.cz_acked_at is immutable once set';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_fallback_requests_guard ON public.provider_fallback_requests;
CREATE TRIGGER trg_provider_fallback_requests_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.provider_fallback_requests
  FOR EACH ROW EXECUTE FUNCTION public.provider_fallback_requests_guard();

DROP TRIGGER IF EXISTS trg_provider_fallback_requests_updated_at ON public.provider_fallback_requests;
CREATE TRIGGER trg_provider_fallback_requests_updated_at
  BEFORE UPDATE ON public.provider_fallback_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- C. elm_late_results: ELM answers that arrived after the step left in_flight (lease expired →
--    unknown). Append-only, for manual reconciliation. Never applied automatically.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.elm_late_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  elm_process_id    uuid NOT NULL REFERENCES public.elm_lead_processes (id),
  cz_solicitud_id   bigint NOT NULL,
  step              text NOT NULL,
  late_status       text NOT NULL,
  http_status       integer NULL,
  result_message    text NULL,
  error_code        text NULL,
  response          jsonb NULL,
  latency_ms        integer NULL,
  trigger_origin    text NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT elm_late_results_cz_solicitud_id_check CHECK (cz_solicitud_id > 0),
  CONSTRAINT elm_late_results_step_status_check CHECK (
    (step = 's1' AND late_status IN ('eligible', 'rejected', 'unknown', 'technical_error'))
    OR (step = 's2' AND late_status IN ('referred', 'rejected', 'unknown', 'technical_error'))
  ),
  CONSTRAINT elm_late_results_http_status_check
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT elm_late_results_latency_check
    CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT elm_late_results_response_object_check
    CHECK (response IS NULL OR jsonb_typeof(response) = 'object')
);

COMMENT ON TABLE public.elm_late_results IS
  'ELM results received after the step lease expired (process already unknown). Append-only; reconciliation is manual. Backend-only.';

CREATE INDEX IF NOT EXISTS idx_elm_late_results_process
  ON public.elm_late_results (elm_process_id, received_at);
CREATE INDEX IF NOT EXISTS idx_elm_late_results_cz_solicitud_id
  ON public.elm_late_results (cz_solicitud_id);

CREATE OR REPLACE FUNCTION public.elm_late_results_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'elm_late_results is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_elm_late_results_guard ON public.elm_late_results;
CREATE TRIGGER trg_elm_late_results_guard
  BEFORE UPDATE OR DELETE ON public.elm_late_results
  FOR EACH ROW EXECUTE FUNCTION public.elm_late_results_guard();

-- ---------------------------------------------------------------------------
-- D. RPCs (service_role only). Lease clock = DB now().
-- ---------------------------------------------------------------------------

-- Idempotent start. Same cz_solicitud_id → existing row; conflict=true when the snapshot differs.
CREATE OR REPLACE FUNCTION public.provider_fallback_enqueue(
  p_cz_solicitud_id bigint,
  p_ci bigint,
  p_snapshot jsonb,
  p_snapshot_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.provider_fallback_requests%ROWTYPE;
BEGIN
  INSERT INTO public.provider_fallback_requests (cz_solicitud_id, ci, snapshot, snapshot_hash)
  VALUES (p_cz_solicitud_id, p_ci, p_snapshot, p_snapshot_hash)
  ON CONFLICT (cz_solicitud_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('created', true, 'conflict', false, 'request', to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row
  FROM public.provider_fallback_requests
  WHERE cz_solicitud_id = p_cz_solicitud_id;

  RETURN jsonb_build_object(
    'created', false,
    'conflict', v_row.snapshot_hash IS DISTINCT FROM p_snapshot_hash,
    'request', to_jsonb(v_row)
  );
END;
$$;

-- Atomic claim. Claimable: queued and due, or running with an expired job lease. Only the
-- oldest open request of each CI is claimable. Concurrent workers never get the same row
-- (FOR UPDATE SKIP LOCKED). p_cz_solicitud_id narrows the claim for the immediate trigger.
CREATE OR REPLACE FUNCTION public.provider_fallback_claim(
  p_worker_id text,
  p_lease_seconds integer,
  p_limit integer,
  p_cz_solicitud_id bigint DEFAULT NULL
)
RETURNS SETOF public.provider_fallback_requests
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 200 THEN
    RAISE EXCEPTION 'provider_fallback_invalid_worker_id';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'provider_fallback_invalid_lease_seconds';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'provider_fallback_invalid_limit';
  END IF;

  RETURN QUERY
  WITH cand AS (
    SELECT r.id
    FROM public.provider_fallback_requests r
    WHERE (p_cz_solicitud_id IS NULL OR r.cz_solicitud_id = p_cz_solicitud_id)
      AND (
        (r.exec_status = 'queued' AND r.run_after <= now())
        OR (r.exec_status = 'running' AND r.job_lease_expires_at < now())
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.provider_fallback_requests o
        WHERE o.ci = r.ci
          AND o.id <> r.id
          AND o.exec_status IN ('queued', 'running')
          AND (o.created_at, o.cz_solicitud_id) < (r.created_at, r.cz_solicitud_id)
      )
    ORDER BY r.created_at, r.cz_solicitud_id
    LIMIT p_limit
    FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE public.provider_fallback_requests p
  SET
    exec_status = 'running',
    job_lease_owner = p_worker_id,
    job_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    claim_count = p.claim_count + 1,
    last_claimed_at = now()
  FROM cand
  WHERE p.id = cand.id
  RETURNING p.*;
END;
$$;

-- Back to queued. p_not_started=true only when it is proven that no external call started.
CREATE OR REPLACE FUNCTION public.provider_fallback_defer(
  p_id uuid,
  p_worker_id text,
  p_delay_seconds integer,
  p_not_started boolean,
  p_reason text
)
RETURNS SETOF public.provider_fallback_requests
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_delay_seconds IS NULL OR p_delay_seconds < 0 OR p_delay_seconds > 86400 THEN
    RAISE EXCEPTION 'provider_fallback_invalid_delay_seconds';
  END IF;

  RETURN QUERY
  UPDATE public.provider_fallback_requests p
  SET
    exec_status = 'queued',
    job_lease_owner = NULL,
    job_lease_expires_at = NULL,
    run_after = now() + make_interval(secs => p_delay_seconds),
    not_started_attempts = p.not_started_attempts + CASE WHEN p_not_started THEN 1 ELSE 0 END,
    last_defer_reason = left(p_reason, 200)
  WHERE p.id = p_id
    AND p.exec_status = 'running'
    AND p.job_lease_owner = p_worker_id
  RETURNING p.*;
END;
$$;

-- Final outcome. Only the current lease owner can finalize, once.
CREATE OR REPLACE FUNCTION public.provider_fallback_finalize(
  p_id uuid,
  p_worker_id text,
  p_outcome text,
  p_reason_code text,
  p_reason_detail jsonb,
  p_elm_process_id uuid,
  p_related_cz_solicitud_id bigint
)
RETURNS SETOF public.provider_fallback_requests
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_outcome IS NULL
     OR p_outcome NOT IN ('referred', 'already_referred', 'rejected', 'not_eligible', 'manual_review') THEN
    RAISE EXCEPTION 'provider_fallback_invalid_outcome';
  END IF;
  IF p_reason_code IS NULL OR btrim(p_reason_code) = '' THEN
    RAISE EXCEPTION 'provider_fallback_reason_code_required';
  END IF;

  RETURN QUERY
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
  RETURNING p.*;
END;
$$;

-- CZ receipt confirmation. Idempotent: a repeated ack returns already_acked.
CREATE OR REPLACE FUNCTION public.provider_fallback_ack(
  p_cz_solicitud_id bigint,
  p_outcome text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.provider_fallback_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.provider_fallback_requests
  WHERE cz_solicitud_id = p_cz_solicitud_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_row.outcome = 'pending' THEN
    RETURN jsonb_build_object('status', 'not_final');
  END IF;
  IF p_outcome IS DISTINCT FROM v_row.outcome THEN
    RETURN jsonb_build_object('status', 'outcome_mismatch');
  END IF;
  IF v_row.cz_delivery_status = 'acked' THEN
    RETURN jsonb_build_object('status', 'already_acked', 'acked_at', v_row.cz_acked_at);
  END IF;

  UPDATE public.provider_fallback_requests
  SET cz_delivery_status = 'acked', cz_acked_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('status', 'acked', 'acked_at', v_row.cz_acked_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.elm_record_late_result(
  p_process_id uuid,
  p_cz_solicitud_id bigint,
  p_step text,
  p_late_status text,
  p_http_status integer,
  p_result_message text,
  p_error_code text,
  p_response jsonb,
  p_latency_ms integer,
  p_trigger_origin text
)
RETURNS SETOF public.elm_late_results
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  INSERT INTO public.elm_late_results (
    elm_process_id, cz_solicitud_id, step, late_status, http_status, result_message,
    error_code, response, latency_ms, trigger_origin
  )
  VALUES (
    p_process_id, p_cz_solicitud_id, p_step, p_late_status, p_http_status, p_result_message,
    p_error_code, p_response, p_latency_ms, p_trigger_origin
  )
  RETURNING *;
END;
$$;

-- ---------------------------------------------------------------------------
-- E. Access: backend only.
-- ---------------------------------------------------------------------------

ALTER TABLE public.provider_fallback_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.elm_late_results ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.provider_fallback_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.elm_late_results FROM PUBLIC, anon, authenticated;
-- RPCs are SECURITY INVOKER: service_role needs row access. No DELETE / TRUNCATE
-- (row triggers do not fire on TRUNCATE; Supabase default privileges grant it).
GRANT SELECT, INSERT, UPDATE ON TABLE public.provider_fallback_requests TO service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.provider_fallback_requests FROM service_role;
GRANT SELECT, INSERT ON TABLE public.elm_late_results TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.elm_late_results FROM service_role;

REVOKE ALL ON FUNCTION public.provider_fallback_requests_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elm_late_results_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_fallback_enqueue(bigint, bigint, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_enqueue(bigint, bigint, jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.provider_fallback_claim(text, integer, integer, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_claim(text, integer, integer, bigint) TO service_role;
REVOKE ALL ON FUNCTION public.provider_fallback_defer(uuid, text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_defer(uuid, text, integer, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.provider_fallback_finalize(uuid, text, text, text, jsonb, uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_finalize(uuid, text, text, text, jsonb, uuid, bigint) TO service_role;
REVOKE ALL ON FUNCTION public.provider_fallback_ack(bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_ack(bigint, text) TO service_role;
REVOKE ALL ON FUNCTION public.elm_record_late_result(uuid, bigint, text, text, integer, text, text, jsonb, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_record_late_result(uuid, bigint, text, text, integer, text, text, jsonb, integer, text) TO service_role;

COMMIT;
