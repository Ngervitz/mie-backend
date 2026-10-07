-- ELM Fase 1B: postback/status events + GRANTED ELM (Convertido) on elm_lead_processes.
-- Apply manually AFTER 20261007_elm_lead_processes.sql.
-- Additive only: does not redefine Fase 1A functions/triggers. Adds one table, three columns,
-- three CHECKs and one guard trigger on elm_lead_processes, and two RPCs.
--
-- Events: every received postback is stored as its own row (no dedupe: ELM sends no event id,
-- so two identical POSTs may be two real events). Only the EFFECT on the process is idempotent.
-- Raw events are never deleted; the raw part is immutable and resolution happens exactly once.
--
-- GRANTED ELM = provider status "Convertido" (normalized 'convertido'). No other status counts.
-- Convertido sets disbursed_at; disbursed_amount stays NULL (ELM does not send the amount).
-- Once granted, disbursed_at / provider_status / provider_status_at / granted_event_id are frozen.
--
-- Ordering: effective event time = COALESCE(provider_event_at, received_at). received_at is the
-- RECEPTION order, not necessarily ELM's real order. A non-Convertido status is applied only if
-- its effective time >= current provider_status_at (else 'stale'). Convertido always applies
-- (sticky), regardless of order, unless the process is already granted ('ignored_granted').
--
-- Matching: ONLY by exact cz_solicitud_id returned by ELM. CI never selects a process; when
-- received it is only an audit control (normalized digits) and a mismatch → unmatched.
-- An event without cz_solicitud_id is stored and left unmatched (no mutation).
--
-- Compatible process (may receive a postback): S2 was initiated (s2_started_at NOT NULL) and
-- s2_status IN ('referred','unknown'). 'unknown' covers a lost/late S2 answer after S2 started.
-- Never S2 not_started / in_flight / rejected / technical_error.
--
-- Concurrency: elm_postback_resolve_event locks the event row, then the process row (always in
-- that order) with FOR UPDATE; under READ COMMITTED a waiting resolve re-reads the committed
-- process row, so a concurrent non-Convertido event resolved after a Convertido sees
-- disbursed_at and becomes ignored_granted. trg_elm_lead_processes_granted_guard is the
-- backstop. (Verified by SQL review; not executable on the single-connection local harness.)
--
-- Access: backend only (service_role). RLS enabled, no policies, PUBLIC/anon/authenticated revoked.
-- payload is sanitized by JANUS before insert; never store credentials, tokens or auth headers.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. elm_postback_events
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.elm_postback_events (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at               timestamptz NOT NULL DEFAULT now(),
  provider                  text NOT NULL DEFAULT 'elm',

  raw_status                text NULL,
  normalized_status         text NULL,
  ci                        bigint NULL,
  provider_external_id      text NULL,
  received_cz_solicitud_id  bigint NULL,
  provider_event_at         timestamptz NULL,
  payload                   jsonb NOT NULL,

  matched_elm_process_id    uuid NULL REFERENCES public.elm_lead_processes (id),
  matched_cz_solicitud_id   bigint NULL,
  match_method              text NULL,
  processing_status         text NOT NULL DEFAULT 'received',
  processed_at              timestamptz NULL,
  error_code                text NULL,

  CONSTRAINT elm_postback_events_provider_check CHECK (provider = 'elm'),
  CONSTRAINT elm_postback_events_processing_status_check
    CHECK (processing_status IN ('received', 'applied', 'stale', 'ignored_granted', 'unmatched', 'invalid')),
  CONSTRAINT elm_postback_events_match_method_check
    CHECK (match_method IS NULL OR match_method = 'cz_solicitud_id'),
  CONSTRAINT elm_postback_events_processed_check
    CHECK ((processing_status = 'received') = (processed_at IS NULL)),
  CONSTRAINT elm_postback_events_matched_check
    CHECK ((processing_status IN ('applied', 'stale', 'ignored_granted'))
           = (matched_elm_process_id IS NOT NULL AND matched_cz_solicitud_id IS NOT NULL)),
  CONSTRAINT elm_postback_events_matched_method_check
    CHECK (processing_status NOT IN ('applied', 'stale', 'ignored_granted') OR match_method IS NOT NULL),
  CONSTRAINT elm_postback_events_error_check
    CHECK (processing_status NOT IN ('unmatched', 'invalid') OR error_code IS NOT NULL),
  CONSTRAINT elm_postback_events_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT elm_postback_events_payload_size_check CHECK (pg_column_size(payload) <= 65536),
  CONSTRAINT elm_postback_events_ci_check CHECK (ci IS NULL OR ci > 0),
  CONSTRAINT elm_postback_events_received_cz_check
    CHECK (received_cz_solicitud_id IS NULL OR received_cz_solicitud_id > 0),
  CONSTRAINT elm_postback_events_raw_status_len_check
    CHECK (raw_status IS NULL OR length(raw_status) <= 200),
  CONSTRAINT elm_postback_events_external_id_len_check
    CHECK (provider_external_id IS NULL OR length(provider_external_id) <= 200)
);

COMMENT ON TABLE public.elm_postback_events IS
  'ELM postback/status events (Fase 1B). One row per received POST; never deleted. Backend-only.';
COMMENT ON COLUMN public.elm_postback_events.raw_status IS
  'Status exactly as received from ELM (always kept).';
COMMENT ON COLUMN public.elm_postback_events.normalized_status IS
  'raw_status normalized for comparison only (spaces, casing, accents). Not a business category.';
COMMENT ON COLUMN public.elm_postback_events.received_at IS
  'JANUS reception time = reception order, not necessarily ELM real order.';
COMMENT ON COLUMN public.elm_postback_events.match_method IS
  'cz_solicitud_id (exact id returned by ELM). The only matching method; CI is audit-only.';
COMMENT ON COLUMN public.elm_postback_events.ci IS
  'CI received from ELM, normalized to digits. Audit control only: never used to select a process.';
COMMENT ON COLUMN public.elm_postback_events.processing_status IS
  'received | applied | stale (older than current provider status) | ignored_granted (process already GRANTED ELM) | unmatched (no compatible process; no mutation) | invalid (unparseable/unknown status; no mutation).';

CREATE INDEX IF NOT EXISTS idx_elm_postback_events_received_at
  ON public.elm_postback_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_elm_postback_events_ci
  ON public.elm_postback_events (ci)
  WHERE ci IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_elm_postback_events_received_cz
  ON public.elm_postback_events (received_cz_solicitud_id)
  WHERE received_cz_solicitud_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_elm_postback_events_matched_process
  ON public.elm_postback_events (matched_elm_process_id)
  WHERE matched_elm_process_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_elm_postback_events_pending
  ON public.elm_postback_events (received_at)
  WHERE processing_status = 'received';

CREATE OR REPLACE FUNCTION public.elm_postback_events_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'elm_postback_events rows cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.processing_status <> 'received' OR NEW.processed_at IS NOT NULL
       OR NEW.matched_elm_process_id IS NOT NULL OR NEW.matched_cz_solicitud_id IS NOT NULL
       OR NEW.match_method IS NOT NULL OR NEW.error_code IS NOT NULL THEN
      RAISE EXCEPTION 'elm_postback_events insert must start as received';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.received_at, NEW.provider, NEW.raw_status, NEW.normalized_status, NEW.ci,
      NEW.provider_external_id, NEW.received_cz_solicitud_id, NEW.provider_event_at, NEW.payload)
     IS DISTINCT FROM
     (OLD.id, OLD.received_at, OLD.provider, OLD.raw_status, OLD.normalized_status, OLD.ci,
      OLD.provider_external_id, OLD.received_cz_solicitud_id, OLD.provider_event_at, OLD.payload) THEN
    RAISE EXCEPTION 'elm_postback_events raw event is immutable';
  END IF;
  IF OLD.processing_status <> 'received' THEN
    RAISE EXCEPTION 'elm_postback_events resolved event is frozen';
  END IF;
  IF NEW.processing_status = 'received' THEN
    RAISE EXCEPTION 'elm_postback_events update must resolve the event';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_elm_postback_events_guard ON public.elm_postback_events;
CREATE TRIGGER trg_elm_postback_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.elm_postback_events
  FOR EACH ROW EXECUTE FUNCTION public.elm_postback_events_guard();

-- ---------------------------------------------------------------------------
-- B. elm_lead_processes: GRANTED ELM support (additive)
-- ---------------------------------------------------------------------------

ALTER TABLE public.elm_lead_processes
  ADD COLUMN IF NOT EXISTS granted_event_id uuid NULL REFERENCES public.elm_postback_events (id),
  ADD COLUMN IF NOT EXISTS last_postback_event_id uuid NULL REFERENCES public.elm_postback_events (id),
  ADD COLUMN IF NOT EXISTS last_postback_at timestamptz NULL;

COMMENT ON COLUMN public.elm_lead_processes.disbursed_at IS
  'GRANTED ELM: set once when ELM reports "Convertido" (loan granted/disbursed). Frozen once set.';
COMMENT ON COLUMN public.elm_lead_processes.disbursed_amount IS
  'Not sent by ELM postback; filled later by reconciliation (Drive/email). NULL does not block GRANTED.';
COMMENT ON COLUMN public.elm_lead_processes.granted_event_id IS
  'elm_postback_events row that produced GRANTED ELM (Convertido).';
COMMENT ON COLUMN public.elm_lead_processes.provider_status IS
  'Latest ELM status text applied from postbacks (raw ELM wording). Frozen once GRANTED ELM.';

ALTER TABLE public.elm_lead_processes
  DROP CONSTRAINT IF EXISTS elm_lead_processes_disbursed_requires_s2_check;
ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_disbursed_requires_s2_check
  CHECK (disbursed_at IS NULL OR (s2_started_at IS NOT NULL AND s2_status IN ('referred', 'unknown')));

ALTER TABLE public.elm_lead_processes
  DROP CONSTRAINT IF EXISTS elm_lead_processes_disbursed_amount_requires_at_check;
ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_disbursed_amount_requires_at_check
  CHECK (disbursed_amount IS NULL OR disbursed_at IS NOT NULL);

ALTER TABLE public.elm_lead_processes
  DROP CONSTRAINT IF EXISTS elm_lead_processes_granted_event_check;
ALTER TABLE public.elm_lead_processes
  ADD CONSTRAINT elm_lead_processes_granted_event_check
  CHECK (granted_event_id IS NULL OR disbursed_at IS NOT NULL);

CREATE OR REPLACE FUNCTION public.elm_lead_processes_granted_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.disbursed_at IS NOT NULL THEN
    IF NEW.disbursed_at IS DISTINCT FROM OLD.disbursed_at THEN
      RAISE EXCEPTION 'elm_granted_disbursed_at_frozen';
    END IF;
    IF (NEW.provider_status, NEW.provider_status_at, NEW.granted_event_id)
       IS DISTINCT FROM (OLD.provider_status, OLD.provider_status_at, OLD.granted_event_id) THEN
      RAISE EXCEPTION 'elm_granted_provider_status_frozen';
    END IF;
  END IF;
  IF OLD.disbursed_amount IS NOT NULL AND NEW.disbursed_amount IS DISTINCT FROM OLD.disbursed_amount THEN
    RAISE EXCEPTION 'elm_disbursed_amount_frozen';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_elm_lead_processes_granted_guard ON public.elm_lead_processes;
CREATE TRIGGER trg_elm_lead_processes_granted_guard
  BEFORE UPDATE ON public.elm_lead_processes
  FOR EACH ROW EXECUTE FUNCTION public.elm_lead_processes_granted_guard();

-- ---------------------------------------------------------------------------
-- C. RPCs (service_role only)
-- ---------------------------------------------------------------------------

-- Store one received event (always; no dedupe). received_at = DB now().
CREATE OR REPLACE FUNCTION public.elm_postback_record_event(
  p_raw_status text,
  p_normalized_status text,
  p_ci bigint,
  p_provider_external_id text,
  p_received_cz_solicitud_id bigint,
  p_provider_event_at timestamptz,
  p_payload jsonb
)
RETURNS public.elm_postback_events
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev public.elm_postback_events%ROWTYPE;
BEGIN
  INSERT INTO public.elm_postback_events (
    raw_status, normalized_status, ci, provider_external_id, received_cz_solicitud_id,
    provider_event_at, payload
  )
  VALUES (
    p_raw_status, p_normalized_status, p_ci, p_provider_external_id, p_received_cz_solicitud_id,
    p_provider_event_at, COALESCE(p_payload, '{}'::jsonb)
  )
  RETURNING * INTO v_ev;
  RETURN v_ev;
END;
$$;

-- Resolve one event exactly once. With p_process_id: DB re-checks identity (exact
-- cz_solicitud_id required; CI must match when received) + compatibility and applies the
-- idempotent effect under row locks. Without: records unmatched/invalid, no mutation.
CREATE OR REPLACE FUNCTION public.elm_postback_resolve_event(
  p_event_id uuid,
  p_process_id uuid,
  p_match_method text,
  p_unresolved_status text,
  p_error_code text
)
RETURNS public.elm_postback_events
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev public.elm_postback_events%ROWTYPE;
  v_proc public.elm_lead_processes%ROWTYPE;
  v_error text;
  v_outcome text;
  v_at timestamptz;
BEGIN
  SELECT * INTO v_ev FROM public.elm_postback_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'elm_postback_event_not_found';
  END IF;
  IF v_ev.processing_status <> 'received' THEN
    RETURN v_ev;
  END IF;
  IF p_match_method IS NOT NULL AND p_match_method <> 'cz_solicitud_id' THEN
    RAISE EXCEPTION 'elm_postback_invalid_match_method';
  END IF;

  IF p_process_id IS NULL THEN
    IF p_unresolved_status IS NULL OR p_unresolved_status NOT IN ('unmatched', 'invalid') THEN
      RAISE EXCEPTION 'elm_postback_invalid_unresolved_status';
    END IF;
    IF p_error_code IS NULL OR btrim(p_error_code) = '' THEN
      RAISE EXCEPTION 'elm_postback_error_code_required';
    END IF;
    UPDATE public.elm_postback_events
    SET processing_status = p_unresolved_status,
        processed_at = now(),
        match_method = p_match_method,
        error_code = p_error_code
    WHERE id = p_event_id
    RETURNING * INTO v_ev;
    RETURN v_ev;
  END IF;

  IF p_match_method IS NULL THEN
    RAISE EXCEPTION 'elm_postback_match_method_required';
  END IF;
  IF v_ev.normalized_status IS NULL OR v_ev.raw_status IS NULL THEN
    RAISE EXCEPTION 'elm_postback_status_required';
  END IF;

  SELECT * INTO v_proc FROM public.elm_lead_processes WHERE id = p_process_id FOR UPDATE;
  IF NOT FOUND THEN
    v_error := 'elm_postback_process_not_found';
  ELSIF v_ev.received_cz_solicitud_id IS NULL THEN
    v_error := 'elm_postback_cz_id_missing';
  ELSIF v_proc.cz_solicitud_id <> v_ev.received_cz_solicitud_id THEN
    v_error := 'elm_postback_cz_id_mismatch';
  ELSIF v_ev.ci IS NOT NULL AND v_proc.ci <> v_ev.ci THEN
    v_error := 'elm_postback_ci_mismatch';
  ELSIF v_proc.s2_started_at IS NULL OR v_proc.s2_status NOT IN ('referred', 'unknown') THEN
    v_error := 'elm_postback_process_not_compatible';
  END IF;

  IF v_error IS NOT NULL THEN
    UPDATE public.elm_postback_events
    SET processing_status = 'unmatched',
        processed_at = now(),
        match_method = p_match_method,
        error_code = v_error
    WHERE id = p_event_id
    RETURNING * INTO v_ev;
    RETURN v_ev;
  END IF;

  v_at := COALESCE(v_ev.provider_event_at, v_ev.received_at);

  IF v_proc.disbursed_at IS NOT NULL THEN
    v_outcome := 'ignored_granted';
  ELSIF v_ev.normalized_status = 'convertido' THEN
    UPDATE public.elm_lead_processes
    SET disbursed_at = v_at,
        provider_status = btrim(v_ev.raw_status),
        provider_status_at = v_at,
        granted_event_id = v_ev.id
    WHERE id = v_proc.id;
    v_outcome := 'applied';
  ELSIF v_proc.provider_status_at IS NULL OR v_at >= v_proc.provider_status_at THEN
    UPDATE public.elm_lead_processes
    SET provider_status = btrim(v_ev.raw_status),
        provider_status_at = v_at
    WHERE id = v_proc.id;
    v_outcome := 'applied';
  ELSE
    v_outcome := 'stale';
  END IF;

  UPDATE public.elm_lead_processes
  SET last_postback_event_id = v_ev.id,
      last_postback_at = v_ev.received_at
  WHERE id = v_proc.id
    AND (last_postback_at IS NULL OR last_postback_at <= v_ev.received_at);

  UPDATE public.elm_postback_events
  SET processing_status = v_outcome,
      processed_at = now(),
      matched_elm_process_id = v_proc.id,
      matched_cz_solicitud_id = v_proc.cz_solicitud_id,
      match_method = p_match_method,
      error_code = NULL
  WHERE id = p_event_id
  RETURNING * INTO v_ev;
  RETURN v_ev;
END;
$$;

-- ---------------------------------------------------------------------------
-- D. Access: backend only.
-- ---------------------------------------------------------------------------

ALTER TABLE public.elm_postback_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.elm_postback_events FROM PUBLIC, anon, authenticated;
-- RPCs are SECURITY INVOKER: service_role needs row access. No DELETE/TRUNCATE (raw events kept).
GRANT SELECT, INSERT, UPDATE ON TABLE public.elm_postback_events TO service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.elm_postback_events FROM service_role;

REVOKE ALL ON FUNCTION public.elm_postback_events_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elm_lead_processes_granted_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elm_postback_record_event(text, text, bigint, text, bigint, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_postback_record_event(text, text, bigint, text, bigint, timestamptz, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.elm_postback_resolve_event(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_postback_resolve_event(uuid, uuid, text, text, text) TO service_role;

COMMIT;
