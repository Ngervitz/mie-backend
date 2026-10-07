-- ELM (Préstamos En La Mano / MANDAZY) Fase 1A: one ELM process per CZ solicitud.
-- Apply manually in Supabase AFTER 20260813_dashboard_users_permissions.sql (dashboard_users).
-- Reuses existing public.set_updated_at() (do not redefine).
-- Idempotent. Additive only: does not touch cz_funnel_*, CDV, Rechazados or Mi Plan data.
--
-- Identity: cz_solicitud_id (= cz_funnel_solicitudes.cz_id). NOT the CI: one CI may have several
-- legitimate solicitudes, each with its own process. ci is kept for person/reconciliation only.
--
-- S1 (Servicio 1) = ELM evaluation. S2 (Servicio 2) = lead handed to ELM sales.
-- s1 'eligible' is NOT referred. s2 'referred' is NOT granted and NOT disbursed.
-- Phase 1 has NO retries: no state ever goes back to in_flight; expired in_flight → unknown.
-- Unknown resolution is a future manual flow (not implemented).
--
-- Access: backend only (service_role bypasses RLS). RLS enabled with NO policies and
-- PUBLIC/anon/authenticated revoked, because the dashboard browser holds the anon key.
-- Rows hold PII (CI, DOB, salary, phone, email inside request snapshots) and provider responses.
-- Never store ELM credentials, OAuth secrets, tokens or authorization headers here.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. elm_lead_processes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.elm_lead_processes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  cz_solicitud_id          bigint NOT NULL,
  ci                       bigint NOT NULL,

  source_brand             text NOT NULL,
  trigger_origin           text NOT NULL,
  triggered_by_user_id     uuid NULL REFERENCES public.dashboard_users (id) ON DELETE SET NULL,

  cz_estado_id_at_start    integer NULL,
  lrw_id_at_start          text NULL,

  s1_status                text NOT NULL DEFAULT 'not_started',
  s1_request               jsonb NULL,
  s1_response              jsonb NULL,
  s1_http_status           integer NULL,
  s1_result_message        text NULL,
  s1_started_at            timestamptz NULL,
  s1_lease_expires_at      timestamptz NULL,
  s1_completed_at          timestamptz NULL,
  s1_latency_ms            integer NULL,
  s1_error_code            text NULL,
  s1_error_detail          text NULL,

  s2_status                text NOT NULL DEFAULT 'not_started',
  s2_request               jsonb NULL,
  s2_response              jsonb NULL,
  s2_http_status           integer NULL,
  s2_result_message        text NULL,
  s2_started_at            timestamptz NULL,
  s2_lease_expires_at      timestamptz NULL,
  s2_completed_at          timestamptz NULL,
  s2_latency_ms            integer NULL,
  s2_error_code            text NULL,
  s2_error_detail          text NULL,
  referred_at              timestamptz NULL,

  provider_external_id     text NULL,
  provider_status          text NULL,
  provider_status_at       timestamptz NULL,
  disbursed_at             timestamptz NULL,
  disbursed_amount         numeric NULL,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT elm_lead_processes_cz_solicitud_id_key UNIQUE (cz_solicitud_id),
  CONSTRAINT elm_lead_processes_cz_solicitud_id_check CHECK (cz_solicitud_id > 0),
  CONSTRAINT elm_lead_processes_ci_check CHECK (ci > 0),
  CONSTRAINT elm_lead_processes_source_brand_check CHECK (btrim(source_brand) <> ''),
  CONSTRAINT elm_lead_processes_trigger_origin_check
    CHECK (trigger_origin IN ('janus_manual', 'janus_batch', 'cz_automatic')),

  CONSTRAINT elm_lead_processes_s1_status_check
    CHECK (s1_status IN ('not_started', 'in_flight', 'eligible', 'rejected', 'unknown', 'technical_error')),
  CONSTRAINT elm_lead_processes_s2_status_check
    CHECK (s2_status IN ('not_started', 'in_flight', 'referred', 'rejected', 'unknown', 'technical_error')),

  CONSTRAINT elm_lead_processes_s2_requires_s1_eligible_check
    CHECK (s2_status = 'not_started' OR s1_status = 'eligible'),

  CONSTRAINT elm_lead_processes_s1_started_check
    CHECK (s1_status = 'not_started' OR (s1_request IS NOT NULL AND s1_started_at IS NOT NULL)),
  CONSTRAINT elm_lead_processes_s2_started_check
    CHECK (s2_status = 'not_started' OR (s2_request IS NOT NULL AND s2_started_at IS NOT NULL)),
  CONSTRAINT elm_lead_processes_s1_lease_check
    CHECK (s1_status <> 'in_flight' OR s1_lease_expires_at IS NOT NULL),
  CONSTRAINT elm_lead_processes_s2_lease_check
    CHECK (s2_status <> 'in_flight' OR s2_lease_expires_at IS NOT NULL),
  CONSTRAINT elm_lead_processes_s1_completed_check
    CHECK (s1_status IN ('not_started', 'in_flight') OR s1_completed_at IS NOT NULL),
  CONSTRAINT elm_lead_processes_s2_completed_check
    CHECK (s2_status IN ('not_started', 'in_flight') OR s2_completed_at IS NOT NULL),
  CONSTRAINT elm_lead_processes_referred_at_check
    CHECK ((s2_status = 'referred') = (referred_at IS NOT NULL)),

  CONSTRAINT elm_lead_processes_s1_request_object_check
    CHECK (s1_request IS NULL OR jsonb_typeof(s1_request) = 'object'),
  CONSTRAINT elm_lead_processes_s2_request_object_check
    CHECK (s2_request IS NULL OR jsonb_typeof(s2_request) = 'object'),
  CONSTRAINT elm_lead_processes_s1_http_status_check
    CHECK (s1_http_status IS NULL OR s1_http_status BETWEEN 100 AND 599),
  CONSTRAINT elm_lead_processes_s2_http_status_check
    CHECK (s2_http_status IS NULL OR s2_http_status BETWEEN 100 AND 599),
  CONSTRAINT elm_lead_processes_s1_latency_check
    CHECK (s1_latency_ms IS NULL OR s1_latency_ms >= 0),
  CONSTRAINT elm_lead_processes_s2_latency_check
    CHECK (s2_latency_ms IS NULL OR s2_latency_ms >= 0),
  CONSTRAINT elm_lead_processes_disbursed_amount_check
    CHECK (disbursed_amount IS NULL OR disbursed_amount >= 0)
);

COMMENT ON TABLE public.elm_lead_processes IS
  'ELM lead process per CZ solicitud (Fase 1A). One row per cz_solicitud_id; no retries. Backend-only (PII).';
COMMENT ON COLUMN public.elm_lead_processes.cz_solicitud_id IS
  'Process identity = cz_funnel_solicitudes.cz_id. Unique: DB is the idempotency authority (claim = INSERT ON CONFLICT DO NOTHING).';
COMMENT ON COLUMN public.elm_lead_processes.ci IS
  'Person CI at claim time. Reconciliation only (ELM may reconcile by CI). Not unique: same CI may have several processes.';
COMMENT ON COLUMN public.elm_lead_processes.source_brand IS
  'Original brand sent as ELM source (e.g. Credizona, Prestafácil). Not the trigger origin.';
COMMENT ON COLUMN public.elm_lead_processes.trigger_origin IS
  'Who started the process: janus_manual | janus_batch | cz_automatic. Unrelated to source_brand.';
COMMENT ON COLUMN public.elm_lead_processes.s1_request IS
  'Exact Servicio 1 JSON body built by JANUS (frozen at claim). PII. Never contains credentials.';
COMMENT ON COLUMN public.elm_lead_processes.s1_status IS
  'not_started | in_flight | eligible (S1 positive, NOT referred) | rejected | unknown (may or may not have been processed; never auto-retried) | technical_error (not processed by ELM).';
COMMENT ON COLUMN public.elm_lead_processes.s2_status IS
  'not_started | in_flight | referred (lead handed to ELM sales; NOT granted, NOT disbursed) | rejected | unknown | technical_error.';
COMMENT ON COLUMN public.elm_lead_processes.referred_at IS
  'Set when S2 returns referred (sent to ELM sales). Start of the commission window. Not a grant/disbursement date.';
COMMENT ON COLUMN public.elm_lead_processes.provider_status IS
  'Reserved for future ELM postback (states not yet defined by ELM). Not written in Fase 1A.';
COMMENT ON COLUMN public.elm_lead_processes.provider_external_id IS
  'Reserved: ELM-side identifier if ELM ever returns one. Not unique (semantics unknown).';

CREATE INDEX IF NOT EXISTS idx_elm_lead_processes_ci
  ON public.elm_lead_processes (ci);
CREATE INDEX IF NOT EXISTS idx_elm_lead_processes_s1_in_flight
  ON public.elm_lead_processes (s1_lease_expires_at)
  WHERE s1_status = 'in_flight';
CREATE INDEX IF NOT EXISTS idx_elm_lead_processes_s2_in_flight
  ON public.elm_lead_processes (s2_lease_expires_at)
  WHERE s2_status = 'in_flight';
CREATE INDEX IF NOT EXISTS idx_elm_lead_processes_provider_external_id
  ON public.elm_lead_processes (provider_external_id)
  WHERE provider_external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- B. Guards: identity immutable, frozen requests, legal transitions only, lease fixed per
--    step, no DELETE.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.elm_lead_processes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
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
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.cz_solicitud_id IS DISTINCT FROM OLD.cz_solicitud_id
     OR NEW.ci IS DISTINCT FROM OLD.ci
     OR NEW.source_brand IS DISTINCT FROM OLD.source_brand
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

  IF NEW.s1_status IS DISTINCT FROM OLD.s1_status THEN
    IF NOT (
      (OLD.s1_status = 'not_started' AND NEW.s1_status = 'in_flight')
      OR (OLD.s1_status = 'in_flight'
          AND NEW.s1_status IN ('eligible', 'rejected', 'unknown', 'technical_error'))
    ) THEN
      RAISE EXCEPTION 'elm_illegal_s1_transition: % -> %', OLD.s1_status, NEW.s1_status;
    END IF;
  END IF;
  IF OLD.s1_status NOT IN ('not_started', 'in_flight')
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
    ) THEN
      RAISE EXCEPTION 'elm_illegal_s2_transition: % -> %', OLD.s2_status, NEW.s2_status;
    END IF;
  END IF;
  IF OLD.s2_status NOT IN ('not_started', 'in_flight')
     AND (NEW.s2_response, NEW.s2_http_status, NEW.s2_result_message, NEW.s2_started_at,
          NEW.s2_completed_at, NEW.s2_latency_ms, NEW.s2_error_code, NEW.s2_error_detail)
         IS DISTINCT FROM
         (OLD.s2_response, OLD.s2_http_status, OLD.s2_result_message, OLD.s2_started_at,
          OLD.s2_completed_at, OLD.s2_latency_ms, OLD.s2_error_code, OLD.s2_error_detail) THEN
    RAISE EXCEPTION 'elm_lead_processes s2 result is frozen once terminal';
  END IF;

  -- Lease: set only on not_started → in_flight, cleared to NULL on in_flight → terminal.
  -- Never extended/changed while the step stays in_flight; never present outside in_flight.
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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_elm_lead_processes_guard ON public.elm_lead_processes;
CREATE TRIGGER trg_elm_lead_processes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.elm_lead_processes
  FOR EACH ROW EXECUTE FUNCTION public.elm_lead_processes_guard();

DROP TRIGGER IF EXISTS trg_elm_lead_processes_updated_at ON public.elm_lead_processes;
CREATE TRIGGER trg_elm_lead_processes_updated_at
  BEFORE UPDATE ON public.elm_lead_processes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- C. RPCs (service_role only). Lease clock = DB now().
-- ---------------------------------------------------------------------------

-- Atomic claim: INSERT ... ON CONFLICT (cz_solicitud_id) DO NOTHING RETURNING.
-- Winner gets claimed=true with s1 already in_flight; every other caller gets the existing row.
CREATE OR REPLACE FUNCTION public.elm_claim_process(
  p_cz_solicitud_id bigint,
  p_ci bigint,
  p_source_brand text,
  p_trigger_origin text,
  p_triggered_by_user_id uuid,
  p_cz_estado_id_at_start integer,
  p_lrw_id_at_start text,
  p_s1_request jsonb,
  p_lease_seconds integer
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
    cz_solicitud_id, ci, source_brand, trigger_origin, triggered_by_user_id,
    cz_estado_id_at_start, lrw_id_at_start,
    s1_status, s1_request, s1_started_at, s1_lease_expires_at
  )
  VALUES (
    p_cz_solicitud_id, p_ci, p_source_brand, p_trigger_origin, p_triggered_by_user_id,
    p_cz_estado_id_at_start, p_lrw_id_at_start,
    'in_flight', p_s1_request, now(), now() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT (cz_solicitud_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true, 'process', to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row
  FROM public.elm_lead_processes
  WHERE cz_solicitud_id = p_cz_solicitud_id;

  RETURN jsonb_build_object('claimed', false, 'process', to_jsonb(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION public.elm_finish_s1(
  p_process_id uuid,
  p_status text,
  p_response jsonb,
  p_http_status integer,
  p_result_message text,
  p_latency_ms integer,
  p_error_code text,
  p_error_detail text
)
RETURNS SETOF public.elm_lead_processes
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('eligible', 'rejected', 'unknown', 'technical_error') THEN
    RAISE EXCEPTION 'elm_invalid_s1_final_status';
  END IF;

  RETURN QUERY
  UPDATE public.elm_lead_processes p
  SET
    s1_status = p_status,
    s1_response = p_response,
    s1_http_status = p_http_status,
    s1_result_message = p_result_message,
    s1_completed_at = now(),
    s1_latency_ms = p_latency_ms,
    s1_error_code = p_error_code,
    s1_error_detail = p_error_detail,
    s1_lease_expires_at = NULL
  WHERE p.id = p_process_id
    AND p.s1_status = 'in_flight'
  RETURNING p.*;
END;
$$;

-- S2 claim: conditional UPDATE, only from s1 eligible + s2 not_started (atomic, no retry).
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
    s2_request = p_s2_request,
    s2_started_at = now(),
    s2_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  WHERE p.cz_solicitud_id = p_cz_solicitud_id
    AND p.s1_status = 'eligible'
    AND p.s2_status = 'not_started'
  RETURNING p.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.elm_finish_s2(
  p_process_id uuid,
  p_status text,
  p_response jsonb,
  p_http_status integer,
  p_result_message text,
  p_latency_ms integer,
  p_error_code text,
  p_error_detail text
)
RETURNS SETOF public.elm_lead_processes
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('referred', 'rejected', 'unknown', 'technical_error') THEN
    RAISE EXCEPTION 'elm_invalid_s2_final_status';
  END IF;

  RETURN QUERY
  UPDATE public.elm_lead_processes p
  SET
    s2_status = p_status,
    s2_response = p_response,
    s2_http_status = p_http_status,
    s2_result_message = p_result_message,
    s2_completed_at = now(),
    s2_latency_ms = p_latency_ms,
    s2_error_code = p_error_code,
    s2_error_detail = p_error_detail,
    s2_lease_expires_at = NULL,
    referred_at = CASE WHEN p_status = 'referred' THEN now() ELSE NULL END
  WHERE p.id = p_process_id
    AND p.s2_status = 'in_flight'
  RETURNING p.*;
END;
$$;

-- Expired in_flight → unknown. Never re-sends; unknown is terminal until a future manual flow.
CREATE OR REPLACE FUNCTION public.elm_expire_stale_in_flight(p_cz_solicitud_id bigint)
RETURNS SETOF public.elm_lead_processes
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.elm_lead_processes p
  SET
    s1_status = 'unknown',
    s1_completed_at = now(),
    s1_error_code = 'elm_in_flight_lease_expired',
    s1_lease_expires_at = NULL
  WHERE p.cz_solicitud_id = p_cz_solicitud_id
    AND p.s1_status = 'in_flight'
    AND p.s1_lease_expires_at < now();

  UPDATE public.elm_lead_processes p
  SET
    s2_status = 'unknown',
    s2_completed_at = now(),
    s2_error_code = 'elm_in_flight_lease_expired',
    s2_lease_expires_at = NULL
  WHERE p.cz_solicitud_id = p_cz_solicitud_id
    AND p.s2_status = 'in_flight'
    AND p.s2_lease_expires_at < now();

  RETURN QUERY
  SELECT * FROM public.elm_lead_processes p
  WHERE p.cz_solicitud_id = p_cz_solicitud_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- D. Access: backend only.
-- ---------------------------------------------------------------------------

ALTER TABLE public.elm_lead_processes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.elm_lead_processes FROM PUBLIC, anon, authenticated;
-- RPCs are SECURITY INVOKER: service_role needs row access. No DELETE (guard also forbids it)
-- and no TRUNCATE (row triggers do not fire on TRUNCATE; Supabase default privileges grant it).
GRANT SELECT, INSERT, UPDATE ON TABLE public.elm_lead_processes TO service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.elm_lead_processes FROM service_role;

REVOKE ALL ON FUNCTION public.elm_lead_processes_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer) TO service_role;
REVOKE ALL ON FUNCTION public.elm_finish_s1(uuid, text, jsonb, integer, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_finish_s1(uuid, text, jsonb, integer, text, integer, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.elm_begin_s2(bigint, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_begin_s2(bigint, jsonb, integer) TO service_role;
REVOKE ALL ON FUNCTION public.elm_finish_s2(uuid, text, jsonb, integer, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_finish_s2(uuid, text, jsonb, integer, text, integer, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.elm_expire_stale_in_flight(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_expire_stale_in_flight(bigint) TO service_role;

COMMIT;
