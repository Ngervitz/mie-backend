-- C1 (Rechazados CDV → ELM): CZ event stream (PULL), monthly send lock per CI, ops tracking.
-- NOT APPLIED. Apply manually in Supabase AFTER, in this order:
--   20261007_elm_lead_processes.sql, 20261007_elm_postback_events.sql,
--   20261008_provider_fallback_requests.sql, 20261009_elm_phase3b_operations.sql, then this file.
-- Do NOT re-apply 3B after this file: 3B would put back provider_fallback_finalize without event
-- generation, the 5-argument provider_review_resolve / elm_resolve_process and the claim / retry
-- RPCs without the CI lock.
-- Idempotent. Reuses public.set_updated_at(). Does not modify 1A/1B functions (applied in prod).
-- PRECONDITION: no elm_lead_processes row without a CI lock (the file aborts otherwise; see C0).
--
-- A. provider_cz_state: projected CZ estado per C1 solicitud (what CZ has been told to apply).
--    Estados: 12 evaluando · 13 derivado a ventas · 14 revisión manual · 3 rechazo definitivo ·
--    15 derivación vigente en otra solicitud · 16 convertido. Allowed transitions (only):
--      12→13, 12→14, 12→3, 12→15, 13→3, 13→16, 14→13, 14→3, 14→16.
--    16, 15 and 3 are terminal. No automatic 3→13 / 3→16, never backwards.
-- B. provider_cz_events: append-only stream read by the CZ cron (pending → ack). seq per solicitud,
--    event n is delivered only after n-1 is acked; never deleted. dedupe_key makes every producer
--    idempotent. A contradictory event is not emitted: it becomes a provider_cz_conflicts row that
--    operations must review.
-- C. elm_ci_send_locks: at most one effective ELM send per CI per calendar month
--    (America/Montevideo), plus blocking rows (active referral, uncertain referral). A GRANTED
--    loan only closes its own solicitud: later solicitudes of the CI stay subject to the monthly
--    quota and to active referrals (credit evaluation belongs to ELM).
--    Every ELM send takes the lock in the DB: elm_claim_process (any trigger origin: automatic,
--    manual, batch, future historical) reserves it atomically with the process insert, and
--    triggers refuse any process insert / S2 start / retry without a live lock of that solicitud.
--    reserved  = send may happen / happened with an uncertain result → blocks the CI;
--    consumed  = ELM technically received the lead (any S1 answer, or an error after reception) →
--                uses the month quota even if ELM rejected;
--    released  = proven that ELM never received it (no process, gates closed, error before
--                reception, or operations confirmed not received) → quota not used.
--    Unique partial indexes are the backstop against concurrent sends for the same CI; the
--    acquire/settle functions also serialize per CI with a transaction advisory lock.
-- D. provider_fallback_finalize (same 9-arg signature) now also creates the CZ state, emits the
--    `outcome` event and settles the lock in the same transaction. Estado 3 only for the explicit
--    definitive rejection reasons (provider_fallback_definitive_rejection_reasons); any other
--    rejected / not_eligible is refused (never "anything else → 3").
-- E. Late events (reconcile, idempotent): ELM "Convertido" → late.granted (13/14 → 16);
--    post-referral rejection (configurable list, empty by default) → late.rejected (13/14 → 3).
-- F. provider_review_resolve gains p_cz_outcome (referred | rejected | granted | none).
--    elm_resolve_process gains p_cz_outcome: an active referral projected 13 is closed with
--    13 → 3 (provider_closed_no_loan) or 13 → 16 (provider_loan_disbursed + Convertido).
-- G. Ops tracking: provider_c1_active_referrals.
-- I. ELM "BCU error" (S1 technical_error elm_provider_bcu_error): exactly one automatic retry of
--    the same frozen request, 24 h after the error, same solicitud / lock (no new quota).
--
-- Access: backend only (service_role). RLS on, no policies, PUBLIC/anon/authenticated revoked.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------

-- Calendar month of an instant in Uruguay (first day of month).
CREATE OR REPLACE FUNCTION public.elm_month_key(p_at timestamptz)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT date_trunc('month', p_at AT TIME ZONE 'America/Montevideo')::date;
$$;

-- ELM technical errors proven to happen BEFORE ELM received the lead (NetSuite rejected the
-- authentication before running the RESTlet). Any other technical_error means ELM received it.
CREATE OR REPLACE FUNCTION public.elm_pre_reception_error_codes()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['elm_http_auth_rejected']::text[];
$$;

-- Did ELM receive this process' S1? none | in_progress | uncertain | received.
CREATE OR REPLACE FUNCTION public.elm_process_reception(p public.elm_lead_processes)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p.id IS NULL OR p.s1_status = 'not_started' THEN
    RETURN 'none';
  END IF;
  IF p.s1_status = 'in_flight' THEN
    RETURN CASE WHEN p.s1_lease_expires_at < now() THEN 'uncertain' ELSE 'in_progress' END;
  END IF;
  IF p.s1_status = 'unknown' THEN
    IF p.ops_resolution_code = 'provider_confirmed_not_received' THEN
      RETURN 'none';
    END IF;
    RETURN CASE WHEN p.ops_resolved_at IS NULL THEN 'uncertain' ELSE 'received' END;
  END IF;
  IF p.s1_status = 'technical_error' THEN
    IF p.s1_error_code = ANY (public.elm_pre_reception_error_codes())
       AND NOT EXISTS (
         SELECT 1 FROM public.elm_step_attempts a
         WHERE a.elm_process_id = p.id AND a.step = 's1'
           AND (a.error_code IS NULL OR NOT (a.error_code = ANY (public.elm_pre_reception_error_codes())))
       ) THEN
      RETURN 'none';
    END IF;
    RETURN 'received';
  END IF;
  RETURN 'received';
END;
$$;

-- ELM S1 "BCU error": not a credit decision. One automatic retry 24 h after the error.
CREATE OR REPLACE FUNCTION public.elm_bcu_error_code()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'elm_provider_bcu_error'::text;
$$;

-- Fallback reasons that are a definitive rejection (CZ estado 3). Explicit list, nothing else:
-- ELM credit answers (S1 negative texts / S2 invalid data) and data that ELM can never receive
-- (CDV rejection stands), plus the monthly quota already used by the CI.
CREATE OR REPLACE FUNCTION public.provider_fallback_definitive_rejection_reasons()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'elm_s1_rejected', 'elm_s2_rejected', 'ci_monthly_quota_used',
    'elm_missing_required_fields', 'elm_date_of_birth_invalid', 'elm_mobilephone_invalid',
    'elm_salary_invalid'
  ]::text[];
$$;

CREATE OR REPLACE FUNCTION public.provider_cz_transition_allowed(p_from integer, p_to integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (p_from, p_to) IN ((12, 13), (12, 14), (12, 3), (12, 15), (13, 3), (13, 16), (14, 13), (14, 3), (14, 16));
$$;

-- Which transitions each event type may produce.
CREATE OR REPLACE FUNCTION public.provider_cz_event_shape_ok(p_type text, p_from integer, p_to integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT public.provider_cz_transition_allowed(p_from, p_to) AND (
    (p_type = 'outcome' AND p_from = 12)
    OR (p_type = 'late.rejected' AND p_from IN (13, 14) AND p_to = 3)
    OR (p_type = 'late.granted' AND p_from IN (13, 14) AND p_to = 16)
    OR (p_type = 'review.resolved' AND p_from = 14)
    OR (p_type = 'referral.resolved' AND p_from = 13 AND p_to IN (3, 16))
  );
$$;

-- ---------------------------------------------------------------------------
-- A. provider_cz_state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_cz_state (
  cz_solicitud_id      bigint PRIMARY KEY REFERENCES public.provider_fallback_requests (cz_solicitud_id),
  fallback_request_id  uuid NOT NULL REFERENCES public.provider_fallback_requests (id),
  ci                   bigint NOT NULL,
  projected_estado     integer NOT NULL DEFAULT 12,
  last_seq             integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_cz_state_request_key UNIQUE (fallback_request_id),
  CONSTRAINT provider_cz_state_ci_check CHECK (ci > 0),
  CONSTRAINT provider_cz_state_estado_check CHECK (projected_estado IN (3, 12, 13, 14, 15, 16)),
  CONSTRAINT provider_cz_state_seq_check CHECK (last_seq >= 0)
);

COMMENT ON TABLE public.provider_cz_state IS
  'C1: CZ estado projected by JANUS events per solicitud (12 → 13/14/3/15 → 3/16). Backend-only.';

CREATE INDEX IF NOT EXISTS idx_provider_cz_state_open
  ON public.provider_cz_state (projected_estado)
  WHERE projected_estado IN (13, 14);
CREATE INDEX IF NOT EXISTS idx_provider_cz_state_ci
  ON public.provider_cz_state (ci);

CREATE OR REPLACE FUNCTION public.provider_cz_state_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_cz_state rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.projected_estado <> 12 OR NEW.last_seq <> 0 THEN
      RAISE EXCEPTION 'provider_cz_state insert must start at 12 / seq 0';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.cz_solicitud_id, NEW.fallback_request_id, NEW.ci, NEW.created_at)
     IS DISTINCT FROM (OLD.cz_solicitud_id, OLD.fallback_request_id, OLD.ci, OLD.created_at) THEN
    RAISE EXCEPTION 'provider_cz_state identity columns are immutable';
  END IF;
  IF NEW.projected_estado IS DISTINCT FROM OLD.projected_estado THEN
    IF NOT public.provider_cz_transition_allowed(OLD.projected_estado, NEW.projected_estado) THEN
      RAISE EXCEPTION 'provider_cz_illegal_transition: % -> %', OLD.projected_estado, NEW.projected_estado;
    END IF;
    IF NEW.last_seq <> OLD.last_seq + 1 THEN
      RAISE EXCEPTION 'provider_cz_state transition must advance seq by one';
    END IF;
  ELSIF NEW.last_seq <> OLD.last_seq THEN
    RAISE EXCEPTION 'provider_cz_state seq only advances with a transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_cz_state_guard ON public.provider_cz_state;
CREATE TRIGGER trg_provider_cz_state_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.provider_cz_state
  FOR EACH ROW EXECUTE FUNCTION public.provider_cz_state_guard();
DROP TRIGGER IF EXISTS trg_provider_cz_state_updated_at ON public.provider_cz_state;
CREATE TRIGGER trg_provider_cz_state_updated_at
  BEFORE UPDATE ON public.provider_cz_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- B. provider_cz_events
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_cz_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cz_solicitud_id          bigint NOT NULL REFERENCES public.provider_cz_state (cz_solicitud_id),
  seq                      integer NOT NULL,
  event_type               text NOT NULL,
  from_estado              integer NOT NULL,
  target_estado            integer NOT NULL,
  outcome                  text NULL,
  reason_code              text NULL,
  related_cz_solicitud_id  bigint NULL,
  provider_status          text NULL,
  provider_status_at       timestamptz NULL,
  source_kind              text NOT NULL,
  source_id                uuid NULL,
  dedupe_key               text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  delivery_status          text NOT NULL DEFAULT 'pending',
  delivery_attempts        integer NOT NULL DEFAULT 0,
  last_delivered_at        timestamptz NULL,
  cz_ack_result            text NULL,
  acked_at                 timestamptz NULL,

  CONSTRAINT provider_cz_events_seq_key UNIQUE (cz_solicitud_id, seq),
  CONSTRAINT provider_cz_events_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT provider_cz_events_seq_check CHECK (seq >= 1),
  CONSTRAINT provider_cz_events_type_check
    CHECK (event_type IN ('outcome', 'late.rejected', 'late.granted', 'review.resolved', 'referral.resolved')),
  CONSTRAINT provider_cz_events_shape_check
    CHECK (public.provider_cz_event_shape_ok(event_type, from_estado, target_estado)),
  CONSTRAINT provider_cz_events_source_check
    CHECK (source_kind IN ('fallback_outcome', 'provider_status', 'review_case', 'elm_process')),
  CONSTRAINT provider_cz_events_dedupe_check CHECK (btrim(dedupe_key) <> ''),
  CONSTRAINT provider_cz_events_delivery_check CHECK (delivery_status IN ('pending', 'acked')),
  CONSTRAINT provider_cz_events_ack_check
    CHECK ((delivery_status = 'acked') = (acked_at IS NOT NULL AND cz_ack_result IS NOT NULL)),
  CONSTRAINT provider_cz_events_ack_result_check
    CHECK (cz_ack_result IS NULL OR cz_ack_result IN ('applied', 'not_applied', 'ignored')),
  CONSTRAINT provider_cz_events_attempts_check CHECK (delivery_attempts >= 0)
);

COMMENT ON TABLE public.provider_cz_events IS
  'C1: append-only CZ event stream (PULL by the CZ cron). seq per solicitud; event n delivered after n-1 acked; never deleted. Backend-only.';
COMMENT ON COLUMN public.provider_cz_events.cz_ack_result IS
  'applied (CZ changed the estado) | not_applied (compare-and-set matched no row) | ignored (CZ chose not to apply).';

CREATE INDEX IF NOT EXISTS idx_provider_cz_events_pending
  ON public.provider_cz_events (created_at, cz_solicitud_id, seq)
  WHERE delivery_status = 'pending';

CREATE OR REPLACE FUNCTION public.provider_cz_events_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_cz_events rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.delivery_status <> 'pending' OR NEW.delivery_attempts <> 0 OR NEW.acked_at IS NOT NULL
       OR NEW.cz_ack_result IS NOT NULL OR NEW.last_delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'provider_cz_events insert must start pending';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.cz_solicitud_id, NEW.seq, NEW.event_type, NEW.from_estado, NEW.target_estado,
      NEW.outcome, NEW.reason_code, NEW.related_cz_solicitud_id, NEW.provider_status,
      NEW.provider_status_at, NEW.source_kind, NEW.source_id, NEW.dedupe_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.cz_solicitud_id, OLD.seq, OLD.event_type, OLD.from_estado, OLD.target_estado,
      OLD.outcome, OLD.reason_code, OLD.related_cz_solicitud_id, OLD.provider_status,
      OLD.provider_status_at, OLD.source_kind, OLD.source_id, OLD.dedupe_key, OLD.created_at) THEN
    RAISE EXCEPTION 'provider_cz_events content is immutable';
  END IF;
  IF OLD.delivery_status = 'acked' THEN
    RAISE EXCEPTION 'provider_cz_events acked event is frozen';
  END IF;
  IF NEW.delivery_attempts < OLD.delivery_attempts THEN
    RAISE EXCEPTION 'provider_cz_events delivery_attempts cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_cz_events_guard ON public.provider_cz_events;
CREATE TRIGGER trg_provider_cz_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.provider_cz_events
  FOR EACH ROW EXECUTE FUNCTION public.provider_cz_events_guard();

-- ---------------------------------------------------------------------------
-- B2. provider_cz_conflicts: contradictory / not allowed events, for manual review.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_cz_conflicts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cz_solicitud_id   bigint NOT NULL,
  ci                bigint NULL,
  conflict_code     text NOT NULL,
  projected_estado  integer NULL,
  attempted_type    text NULL,
  attempted_target  integer NULL,
  dedupe_key        text NOT NULL,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'open',
  resolution_note   text NULL,
  resolved_by       uuid NULL REFERENCES public.dashboard_users (id) ON DELETE SET NULL,
  resolved_at       timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_cz_conflicts_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT provider_cz_conflicts_code_check
    CHECK (conflict_code IN ('transition_not_allowed', 'status_after_rejection', 'ci_lock_overlap')),
  CONSTRAINT provider_cz_conflicts_status_check CHECK (status IN ('open', 'resolved')),
  CONSTRAINT provider_cz_conflicts_detail_check CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT provider_cz_conflicts_resolved_check CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL AND resolution_note IS NOT NULL)
    AND (resolution_note IS NULL OR length(btrim(resolution_note)) >= 10)
  )
);

COMMENT ON TABLE public.provider_cz_conflicts IS
  'C1: events that were NOT emitted because they contradict the projected CZ estado (or lock overlaps). Operations review; resolving never changes CZ state. Backend-only.';

CREATE INDEX IF NOT EXISTS idx_provider_cz_conflicts_open
  ON public.provider_cz_conflicts (created_at)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_provider_cz_conflicts_cz
  ON public.provider_cz_conflicts (cz_solicitud_id);

CREATE OR REPLACE FUNCTION public.provider_cz_conflicts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_cz_conflicts rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'provider_cz_conflicts insert must be open';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.cz_solicitud_id, NEW.ci, NEW.conflict_code, NEW.projected_estado, NEW.attempted_type,
      NEW.attempted_target, NEW.dedupe_key, NEW.detail, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.cz_solicitud_id, OLD.ci, OLD.conflict_code, OLD.projected_estado, OLD.attempted_type,
      OLD.attempted_target, OLD.dedupe_key, OLD.detail, OLD.created_at) THEN
    RAISE EXCEPTION 'provider_cz_conflicts content is immutable';
  END IF;
  IF OLD.status = 'resolved' THEN
    -- Only ON DELETE SET NULL of a dashboard user.
    IF (NEW.status, NEW.resolution_note, NEW.resolved_at) IS DISTINCT FROM (OLD.status, OLD.resolution_note, OLD.resolved_at)
       OR (NEW.resolved_by IS DISTINCT FROM OLD.resolved_by AND NEW.resolved_by IS NOT NULL) THEN
      RAISE EXCEPTION 'provider_cz_conflicts resolved conflict is frozen';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_cz_conflicts_guard ON public.provider_cz_conflicts;
CREATE TRIGGER trg_provider_cz_conflicts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.provider_cz_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.provider_cz_conflicts_guard();
DROP TRIGGER IF EXISTS trg_provider_cz_conflicts_updated_at ON public.provider_cz_conflicts;
CREATE TRIGGER trg_provider_cz_conflicts_updated_at
  BEFORE UPDATE ON public.provider_cz_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Audit of conflict resolutions shares elm_ops_audit_events.
ALTER TABLE public.elm_ops_audit_events
  DROP CONSTRAINT IF EXISTS elm_ops_audit_events_entity_type_check;
ALTER TABLE public.elm_ops_audit_events
  ADD CONSTRAINT elm_ops_audit_events_entity_type_check
  CHECK (entity_type IN ('elm_process', 'review_case', 'cz_conflict'));

-- ---------------------------------------------------------------------------
-- C. elm_ci_send_locks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.elm_ci_send_locks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ci                   bigint NOT NULL,
  month_key            date NOT NULL,
  cz_solicitud_id      bigint NOT NULL,
  -- NULL for sends outside the CZ fallback (manual, batch, historical).
  fallback_request_id  uuid NULL REFERENCES public.provider_fallback_requests (id),
  trigger_origin       text NOT NULL,
  state                text NOT NULL DEFAULT 'reserved',
  blocks_future        boolean NOT NULL DEFAULT false,
  block_reason         text NULL,
  settle_reason        text NULL,
  reserved_at          timestamptz NOT NULL DEFAULT now(),
  consumed_at          timestamptz NULL,
  released_at          timestamptz NULL,
  last_checked_at      timestamptz NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT elm_ci_send_locks_ci_check CHECK (ci > 0),
  CONSTRAINT elm_ci_send_locks_cz_check CHECK (cz_solicitud_id > 0),
  CONSTRAINT elm_ci_send_locks_month_check CHECK (month_key = date_trunc('month', month_key::timestamp)::date),
  CONSTRAINT elm_ci_send_locks_state_check CHECK (state IN ('reserved', 'consumed', 'released')),
  CONSTRAINT elm_ci_send_locks_origin_check
    CHECK (trigger_origin IN ('janus_manual', 'janus_batch', 'cz_automatic')),
  CONSTRAINT elm_ci_send_locks_block_reason_check
    CHECK (block_reason IS NULL OR block_reason IN ('active_referral', 'uncertain_referral')),
  CONSTRAINT elm_ci_send_locks_block_check CHECK (blocks_future = (block_reason IS NOT NULL)),
  CONSTRAINT elm_ci_send_locks_block_consumed_check CHECK (NOT blocks_future OR state = 'consumed'),
  CONSTRAINT elm_ci_send_locks_consumed_at_check CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CONSTRAINT elm_ci_send_locks_released_at_check CHECK ((state = 'released') = (released_at IS NOT NULL))
);

COMMENT ON TABLE public.elm_ci_send_locks IS
  'C1: monthly ELM send quota per CI (America/Montevideo) + blocking rows, for every trigger origin. reserved/consumed use the month; released does not. Backend-only.';
COMMENT ON COLUMN public.elm_ci_send_locks.blocks_future IS
  'Consumed lock that keeps blocking later months: active_referral | uncertain_referral. A granted loan does not block future solicitudes.';

-- One effective (or possibly effective) send per CI per calendar month.
CREATE UNIQUE INDEX IF NOT EXISTS uq_elm_ci_send_locks_ci_month
  ON public.elm_ci_send_locks (ci, month_key)
  WHERE state IN ('reserved', 'consumed');
-- At most one open evaluation or blocking referral per CI at any time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_elm_ci_send_locks_ci_active
  ON public.elm_ci_send_locks (ci)
  WHERE state = 'reserved' OR blocks_future;
-- One live lock per solicitud.
CREATE UNIQUE INDEX IF NOT EXISTS uq_elm_ci_send_locks_solicitud
  ON public.elm_ci_send_locks (cz_solicitud_id)
  WHERE state IN ('reserved', 'consumed');
CREATE INDEX IF NOT EXISTS idx_elm_ci_send_locks_ci
  ON public.elm_ci_send_locks (ci, month_key);

CREATE OR REPLACE FUNCTION public.elm_ci_send_locks_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'elm_ci_send_locks rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' OR NEW.blocks_future THEN
      RAISE EXCEPTION 'elm_ci_send_locks insert must be reserved';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.ci, NEW.month_key, NEW.cz_solicitud_id, NEW.fallback_request_id, NEW.trigger_origin, NEW.reserved_at)
     IS DISTINCT FROM (OLD.id, OLD.ci, OLD.month_key, OLD.cz_solicitud_id, OLD.fallback_request_id, OLD.trigger_origin, OLD.reserved_at) THEN
    RAISE EXCEPTION 'elm_ci_send_locks identity columns are immutable';
  END IF;
  IF OLD.state = 'released' THEN
    RAISE EXCEPTION 'elm_ci_send_locks released lock is frozen';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (OLD.state = 'reserved' AND NEW.state IN ('consumed', 'released')) THEN
      RAISE EXCEPTION 'elm_ci_lock_illegal_transition: % -> %', OLD.state, NEW.state;
    END IF;
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'elm_ci_send_locks.consumed_at is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_elm_ci_send_locks_guard ON public.elm_ci_send_locks;
CREATE TRIGGER trg_elm_ci_send_locks_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.elm_ci_send_locks
  FOR EACH ROW EXECUTE FUNCTION public.elm_ci_send_locks_guard();
DROP TRIGGER IF EXISTS trg_elm_ci_send_locks_updated_at ON public.elm_ci_send_locks;
CREATE TRIGGER trg_elm_ci_send_locks_updated_at
  BEFORE UPDATE ON public.elm_ci_send_locks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- C0. Precondition: every existing ELM process must already have its CI lock. Processes created
-- before C1 (none expected: the ELM client is disabled) need an explicit backfill decision.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.elm_lead_processes p
    WHERE NOT EXISTS (SELECT 1 FROM public.elm_ci_send_locks l WHERE l.cz_solicitud_id = p.cz_solicitud_id)
  ) THEN
    RAISE EXCEPTION 'c1_precondition_failed: elm_lead_processes without CI lock; backfill elm_ci_send_locks first';
  END IF;
END;
$$;

-- No ELM call without the CI lock of that solicitud, whatever the caller: process insert (S1)
-- needs a reserved lock (taken by elm_claim_process in the same transaction); S2 start and any
-- retry need a live (reserved / consumed) lock.
CREATE OR REPLACE FUNCTION public.elm_lead_processes_ci_lock_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.elm_ci_send_locks l
                   WHERE l.cz_solicitud_id = NEW.cz_solicitud_id AND l.ci = NEW.ci AND l.state = 'reserved') THEN
      RAISE EXCEPTION 'elm_ci_lock_required: no reserved CI lock for solicitud %', NEW.cz_solicitud_id;
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.s1_status = 'technical_error' AND NEW.s1_status = 'in_flight')
     OR (OLD.s2_status IN ('not_started', 'technical_error') AND NEW.s2_status = 'in_flight') THEN
    IF NOT EXISTS (SELECT 1 FROM public.elm_ci_send_locks l
                   WHERE l.cz_solicitud_id = NEW.cz_solicitud_id AND l.ci = NEW.ci
                     AND l.state IN ('reserved', 'consumed')) THEN
      RAISE EXCEPTION 'elm_ci_lock_required: no live CI lock for solicitud %', NEW.cz_solicitud_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_elm_lead_processes_ci_lock_guard ON public.elm_lead_processes;
CREATE TRIGGER trg_elm_lead_processes_ci_lock_guard
  BEFORE INSERT OR UPDATE OF s1_status, s2_status ON public.elm_lead_processes
  FOR EACH ROW EXECUTE FUNCTION public.elm_lead_processes_ci_lock_guard();

-- Keep the lock in step with its process (finish, expiry, postback GRANTED, manual resolution).
-- Never fails the process write: elm_ci_lock_reconcile (cron) settles anything missed here.
CREATE OR REPLACE FUNCTION public.elm_lead_processes_ci_lock_settle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    PERFORM public.elm_ci_lock_settle(NEW.cz_solicitud_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'elm_ci_lock_settle failed for solicitud %: %', NEW.cz_solicitud_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_elm_lead_processes_ci_lock_settle ON public.elm_lead_processes;
CREATE TRIGGER trg_elm_lead_processes_ci_lock_settle
  AFTER UPDATE OF s1_status, s2_status, disbursed_at, ops_resolved_at ON public.elm_lead_processes
  FOR EACH ROW
  WHEN ((OLD.s1_status, OLD.s2_status, OLD.disbursed_at, OLD.ops_resolved_at)
        IS DISTINCT FROM (NEW.s1_status, NEW.s2_status, NEW.disbursed_at, NEW.ops_resolved_at))
  EXECUTE FUNCTION public.elm_lead_processes_ci_lock_settle();

-- ---------------------------------------------------------------------------
-- C2. Conflicts + lock functions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.provider_cz_record_conflict(
  p_cz_solicitud_id bigint,
  p_ci bigint,
  p_conflict_code text,
  p_projected_estado integer,
  p_attempted_type text,
  p_attempted_target integer,
  p_dedupe_key text,
  p_detail jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.provider_cz_conflicts (
    cz_solicitud_id, ci, conflict_code, projected_estado, attempted_type, attempted_target, dedupe_key, detail
  ) VALUES (
    p_cz_solicitud_id, p_ci, p_conflict_code, p_projected_estado, p_attempted_type, p_attempted_target,
    p_dedupe_key, COALESCE(p_detail, '{}'::jsonb)
  )
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.provider_cz_conflicts WHERE dedupe_key = p_dedupe_key;
  END IF;
  RETURN v_id;
END;
$$;

-- Core of the CI lock, shared by every ELM send path (elm_ci_lock_acquire for the CZ fallback
-- worker, elm_claim_process for every trigger origin). Takes the per-CI advisory lock for the
-- rest of the caller's transaction. Idempotent for the same solicitud ('held'): retries and S2
-- of that solicitud never use another quota. The unique partial indexes are the backstop.
-- Blockers (other solicitudes of the CI), most severe first:
--   active_referral     unresolved S2 referral not closed by a rejection / GRANTED (lock or process)
--   uncertain           uncertain result (reserved lock of a finished request, uncertain referral,
--                       unknown / expired in_flight process)
--   send_in_progress    another reserved lock (open request, or a send outside the fallback), or a
--                       live in_flight process
--   monthly_quota_used  consumed lock or received process (without lock) in the same calendar month
-- A GRANTED loan of another solicitud is not a blocker by itself.
-- p_at only selects the month (tests); lease checks always use now().
CREATE OR REPLACE FUNCTION public.elm_ci_lock_try(
  p_ci bigint,
  p_cz_solicitud_id bigint,
  p_fallback_request_id uuid,
  p_trigger_origin text,
  p_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_month date := public.elm_month_key(COALESCE(p_at, now()));
  v_lock public.elm_ci_send_locks%ROWTYPE;
  v_related bigint;
BEGIN
  IF p_ci IS NULL OR p_ci <= 0 OR p_cz_solicitud_id IS NULL OR p_cz_solicitud_id <= 0
     OR p_trigger_origin IS NULL THEN
    RAISE EXCEPTION 'elm_ci_lock_invalid_args';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('elm_ci_send_lock:' || p_ci::text, 0));

  SELECT * INTO v_lock FROM public.elm_ci_send_locks
  WHERE cz_solicitud_id = p_cz_solicitud_id AND state IN ('reserved', 'consumed');
  IF FOUND THEN
    IF v_lock.ci <> p_ci THEN
      RAISE EXCEPTION 'elm_ci_lock_ci_mismatch';
    END IF;
    RETURN jsonb_build_object('status', 'held', 'lock_id', v_lock.id, 'state', v_lock.state,
                              'month_key', v_lock.month_key);
  END IF;

  -- active_referral
  SELECT l.cz_solicitud_id INTO v_related FROM public.elm_ci_send_locks l
  WHERE l.ci = p_ci AND l.block_reason = 'active_referral'
  ORDER BY l.reserved_at LIMIT 1;
  IF v_related IS NULL THEN
    SELECT p.cz_solicitud_id INTO v_related FROM public.elm_lead_processes p
    WHERE p.ci = p_ci AND p.cz_solicitud_id <> p_cz_solicitud_id
      AND p.s2_status = 'referred' AND p.ops_resolved_at IS NULL AND p.disbursed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.provider_cz_state s
                      WHERE s.cz_solicitud_id = p.cz_solicitud_id AND s.projected_estado IN (3, 16))
    ORDER BY p.cz_solicitud_id LIMIT 1;
  END IF;
  IF v_related IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'active_referral', 'related_cz_solicitud_id', v_related);
  END IF;

  -- uncertain
  SELECT l.cz_solicitud_id INTO v_related FROM public.elm_ci_send_locks l
  LEFT JOIN public.provider_fallback_requests f ON f.id = l.fallback_request_id
  WHERE l.ci = p_ci
    AND (l.block_reason = 'uncertain_referral' OR (l.state = 'reserved' AND f.outcome <> 'pending'))
  ORDER BY l.reserved_at LIMIT 1;
  IF v_related IS NULL THEN
    SELECT p.cz_solicitud_id INTO v_related FROM public.elm_lead_processes p
    WHERE p.ci = p_ci AND p.cz_solicitud_id <> p_cz_solicitud_id AND p.ops_resolved_at IS NULL
      AND (
        p.s1_status = 'unknown'
        OR (p.s1_status = 'in_flight' AND p.s1_lease_expires_at < now())
        OR ((p.s2_status = 'unknown' OR (p.s2_status = 'in_flight' AND p.s2_lease_expires_at < now()))
            AND p.disbursed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM public.provider_cz_state s
                            WHERE s.cz_solicitud_id = p.cz_solicitud_id AND s.projected_estado IN (3, 16)))
      )
    ORDER BY p.cz_solicitud_id LIMIT 1;
  END IF;
  IF v_related IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'uncertain', 'related_cz_solicitud_id', v_related);
  END IF;

  -- send_in_progress
  SELECT l.cz_solicitud_id INTO v_related FROM public.elm_ci_send_locks l
  LEFT JOIN public.provider_fallback_requests f ON f.id = l.fallback_request_id
  WHERE l.ci = p_ci AND l.state = 'reserved' AND (f.id IS NULL OR f.outcome = 'pending')
  ORDER BY l.reserved_at LIMIT 1;
  IF v_related IS NULL THEN
    SELECT p.cz_solicitud_id INTO v_related FROM public.elm_lead_processes p
    WHERE p.ci = p_ci AND p.cz_solicitud_id <> p_cz_solicitud_id
      AND ((p.s1_status = 'in_flight' AND p.s1_lease_expires_at >= now())
           OR (p.s2_status = 'in_flight' AND p.s2_lease_expires_at >= now()))
    ORDER BY p.cz_solicitud_id LIMIT 1;
  END IF;
  IF v_related IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'send_in_progress', 'related_cz_solicitud_id', v_related);
  END IF;

  -- monthly_quota_used
  SELECT l.cz_solicitud_id INTO v_related FROM public.elm_ci_send_locks l
  WHERE l.ci = p_ci AND l.state = 'consumed' AND l.month_key = v_month
  ORDER BY l.reserved_at LIMIT 1;
  IF v_related IS NULL THEN
    -- The lock month is authoritative (a retry in a later month uses the original quota); the
    -- process start month only counts for processes without a live lock.
    SELECT p.cz_solicitud_id INTO v_related FROM public.elm_lead_processes p
    WHERE p.ci = p_ci AND p.cz_solicitud_id <> p_cz_solicitud_id
      AND p.s1_started_at IS NOT NULL AND public.elm_month_key(p.s1_started_at) = v_month
      AND public.elm_process_reception(p) = 'received'
      AND NOT EXISTS (SELECT 1 FROM public.elm_ci_send_locks x
                      WHERE x.cz_solicitud_id = p.cz_solicitud_id AND x.state IN ('reserved', 'consumed'))
    ORDER BY p.cz_solicitud_id LIMIT 1;
  END IF;
  IF v_related IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'monthly_quota_used', 'related_cz_solicitud_id', v_related,
                              'month_key', v_month);
  END IF;

  INSERT INTO public.elm_ci_send_locks (ci, month_key, cz_solicitud_id, fallback_request_id, trigger_origin)
  VALUES (p_ci, v_month, p_cz_solicitud_id, p_fallback_request_id, p_trigger_origin)
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_lock;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'send_in_progress', 'related_cz_solicitud_id', NULL,
                              'detail', 'lock_conflict');
  END IF;
  RETURN jsonb_build_object('status', 'acquired', 'lock_id', v_lock.id, 'state', v_lock.state,
                            'month_key', v_lock.month_key);
END;
$$;

-- CZ fallback worker: reserve before any new external call of a C1 solicitud (same core).
CREATE OR REPLACE FUNCTION public.elm_ci_lock_acquire(
  p_ci bigint,
  p_cz_solicitud_id bigint,
  p_fallback_request_id uuid,
  p_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.provider_fallback_requests%ROWTYPE;
BEGIN
  IF p_ci IS NULL OR p_ci <= 0 OR p_cz_solicitud_id IS NULL OR p_cz_solicitud_id <= 0
     OR p_fallback_request_id IS NULL THEN
    RAISE EXCEPTION 'elm_ci_lock_invalid_args';
  END IF;
  SELECT * INTO v_req FROM public.provider_fallback_requests WHERE id = p_fallback_request_id;
  IF NOT FOUND OR v_req.cz_solicitud_id <> p_cz_solicitud_id OR v_req.ci <> p_ci THEN
    RAISE EXCEPTION 'elm_ci_lock_request_mismatch';
  END IF;
  RETURN public.elm_ci_lock_try(p_ci, p_cz_solicitud_id, p_fallback_request_id, 'cz_automatic', p_at);
END;
$$;

-- ---------------------------------------------------------------------------
-- C1b. ELM RPCs that start external calls (replace 3B, same signatures): all take the CI lock.
-- ---------------------------------------------------------------------------

-- Single entry point for every NEW ELM evaluation (S1), any trigger origin. The CI lock and the
-- process insert happen in the same transaction under the per-CI advisory lock, so two callers
-- (automatic, manual, batch, historical) can never both send for the same CI / month.
-- Blocked → {claimed:false, process:null, blocked:{block, related_cz_solicitud_id, month_key}}.
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
  v_req_id uuid;
  v_lock jsonb;
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

-- Retry of a technical_error step with the SAME frozen request (same TrackingId / solicitud).
-- Atomic and idempotent: the caller passes the attempt count it observed; a concurrent retry
-- makes it a no-op. Requires the live CI lock of the solicitud (no new quota).
-- S1 "BCU error" has a fixed policy that ignores p_max_attempts / p_retry_safe_error_codes:
-- only after the first attempt, and only 24 h after that error. A second BCU error is final.
-- Other errors: unchanged 3B rule (configured safe codes, below p_max_attempts).
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
  v_allowed boolean;
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
  IF NOT EXISTS (SELECT 1 FROM public.elm_ci_send_locks l
                 WHERE l.cz_solicitud_id = v.cz_solicitud_id AND l.ci = v.ci
                   AND l.state IN ('reserved', 'consumed')) THEN
    RETURN;
  END IF;

  IF p_step = 's1' THEN
    IF v.s1_status <> 'technical_error' OR v.s1_attempts <> p_expected_attempts THEN
      RETURN;
    END IF;
    IF v.s1_error_code = public.elm_bcu_error_code() THEN
      v_allowed := v.s1_attempts = 1 AND v.s1_completed_at IS NOT NULL
                   AND now() >= v.s1_completed_at + interval '24 hours';
    ELSE
      v_allowed := v.s1_attempts < p_max_attempts AND v.s1_error_code IS NOT NULL
                   AND v.s1_error_code = ANY (COALESCE(p_retry_safe_error_codes, '{}'::text[]));
    END IF;
    IF NOT v_allowed THEN
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

-- Release a reservation when it is proven that no external call started (gates closed before
-- the claim of the ELM process).
CREATE OR REPLACE FUNCTION public.elm_ci_lock_release_unstarted(p_cz_solicitud_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lock public.elm_ci_send_locks%ROWTYPE;
BEGIN
  SELECT * INTO v_lock FROM public.elm_ci_send_locks
  WHERE cz_solicitud_id = p_cz_solicitud_id AND state = 'reserved';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_lock');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('elm_ci_send_lock:' || v_lock.ci::text, 0));
  SELECT * INTO v_lock FROM public.elm_ci_send_locks WHERE id = v_lock.id FOR UPDATE;
  IF v_lock.state <> 'reserved' THEN
    RETURN jsonb_build_object('status', 'no_lock');
  END IF;
  IF EXISTS (SELECT 1 FROM public.elm_lead_processes p
             WHERE p.cz_solicitud_id = p_cz_solicitud_id AND p.s1_status <> 'not_started') THEN
    RETURN jsonb_build_object('status', 'process_exists');
  END IF;
  UPDATE public.elm_ci_send_locks
  SET state = 'released', released_at = now(), settle_reason = 'not_started', last_checked_at = now()
  WHERE id = v_lock.id;
  RETURN jsonb_build_object('status', 'released');
END;
$$;

-- Recompute the lock of one solicitud from its ELM process and projected CZ estado. Fallback
-- locks: only after the request is final. Locks of other origins (no request): kept reserved
-- while the evaluation is open (call in progress, or S1 eligible waiting for S2).
-- GRANTED (disbursed / projected 16): consumed, no future block (only that solicitud is closed).
-- Returns: no_lock | request_open | kept_reserved | unchanged | consumed | released | conflict.
CREATE OR REPLACE FUNCTION public.elm_ci_lock_settle(p_cz_solicitud_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lock public.elm_ci_send_locks%ROWTYPE;
  v_req public.provider_fallback_requests%ROWTYPE;
  v_state public.provider_cz_state%ROWTYPE;
  v_proc public.elm_lead_processes%ROWTYPE;
  v_rec text;
  v_target text;
  v_block text;
  v_reason text;
BEGIN
  SELECT * INTO v_lock FROM public.elm_ci_send_locks
  WHERE cz_solicitud_id = p_cz_solicitud_id AND state IN ('reserved', 'consumed');
  IF NOT FOUND THEN
    RETURN 'no_lock';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('elm_ci_send_lock:' || v_lock.ci::text, 0));
  SELECT * INTO v_lock FROM public.elm_ci_send_locks WHERE id = v_lock.id FOR UPDATE;
  IF v_lock.state = 'released' THEN
    RETURN 'unchanged';
  END IF;
  IF v_lock.fallback_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM public.provider_fallback_requests WHERE id = v_lock.fallback_request_id;
    IF v_req.outcome = 'pending' THEN
      RETURN 'request_open';
    END IF;
  END IF;
  SELECT * INTO v_state FROM public.provider_cz_state WHERE cz_solicitud_id = p_cz_solicitud_id;
  SELECT * INTO v_proc FROM public.elm_lead_processes WHERE cz_solicitud_id = p_cz_solicitud_id;
  v_rec := public.elm_process_reception(v_proc);

  IF v_lock.fallback_request_id IS NULL AND v_lock.state = 'reserved' AND v_proc.ops_resolved_at IS NULL
     AND (v_rec = 'in_progress' OR (v_proc.s1_status = 'eligible' AND v_proc.s2_status IN ('not_started', 'in_flight'))) THEN
    UPDATE public.elm_ci_send_locks SET last_checked_at = now() WHERE id = v_lock.id;
    RETURN 'kept_reserved';
  END IF;

  IF v_proc.disbursed_at IS NOT NULL OR v_state.projected_estado = 16 THEN
    v_target := 'consumed';
    v_block := NULL;
    v_reason := 'granted_elm';
  ELSIF v_rec IN ('in_progress', 'uncertain') THEN
    UPDATE public.elm_ci_send_locks SET last_checked_at = now() WHERE id = v_lock.id;
    RETURN 'kept_reserved';
  ELSIF v_rec = 'none' THEN
    v_target := 'released';
    v_block := NULL;
    v_reason := 'not_received';
  ELSE
    v_target := 'consumed';
    v_reason := 'received';
    IF v_proc.ops_resolved_at IS NOT NULL OR v_state.projected_estado = 3 THEN
      v_block := NULL;
    ELSIF v_state.projected_estado = 13 OR v_proc.s2_status = 'referred' THEN
      v_block := 'active_referral';
    ELSIF v_proc.s2_status IN ('unknown', 'in_flight') THEN
      v_block := 'uncertain_referral';
    ELSE
      v_block := NULL;
    END IF;
  END IF;

  -- Received is never undone: a consumed lock is not released, it only stops blocking.
  IF v_lock.state = 'consumed' AND v_target = 'released' THEN
    v_target := 'consumed';
    v_block := NULL;
    v_reason := 'confirmed_not_received_after_consume';
  END IF;

  IF v_lock.state = v_target AND v_lock.block_reason IS NOT DISTINCT FROM v_block THEN
    UPDATE public.elm_ci_send_locks SET last_checked_at = now() WHERE id = v_lock.id;
    RETURN 'unchanged';
  END IF;

  BEGIN
    UPDATE public.elm_ci_send_locks
    SET state = v_target,
        consumed_at = CASE WHEN v_target = 'consumed' THEN COALESCE(consumed_at, now()) ELSE consumed_at END,
        released_at = CASE WHEN v_target = 'released' THEN now() ELSE NULL END,
        blocks_future = v_block IS NOT NULL,
        block_reason = v_block,
        settle_reason = v_reason,
        last_checked_at = now()
    WHERE id = v_lock.id;
  EXCEPTION WHEN unique_violation THEN
    -- Another row of the CI already blocks: keep this one consumed without blocking and alert.
    UPDATE public.elm_ci_send_locks
    SET state = 'consumed',
        consumed_at = COALESCE(consumed_at, now()),
        released_at = NULL,
        blocks_future = false,
        block_reason = NULL,
        settle_reason = 'block_overlap',
        last_checked_at = now()
    WHERE id = v_lock.id;
    PERFORM public.provider_cz_record_conflict(
      p_cz_solicitud_id, v_lock.ci, 'ci_lock_overlap', v_state.projected_estado, NULL, NULL,
      'ci_lock_overlap:' || v_lock.id::text || ':' || COALESCE(v_block, '-'),
      jsonb_build_object('wanted_block', v_block, 'lock_id', v_lock.id)
    );
    RETURN 'conflict';
  END;
  RETURN v_target;
END;
$$;

-- Periodic settle of locks that still reserve or block, once their fallback request (if any) is
-- final: the process or the CZ projection may have changed (postback, manual resolution, late
-- events). Backstop of the settle trigger on elm_lead_processes.
CREATE OR REPLACE FUNCTION public.elm_ci_lock_reconcile(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_out text;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'elm_ci_lock_invalid_limit';
  END IF;
  FOR r IN
    SELECT l.cz_solicitud_id
    FROM public.elm_ci_send_locks l
    LEFT JOIN public.provider_fallback_requests f ON f.id = l.fallback_request_id
    WHERE (f.id IS NULL OR f.outcome <> 'pending')
      AND (l.state = 'reserved' OR l.blocks_future)
    ORDER BY l.last_checked_at NULLS FIRST, l.reserved_at
    LIMIT p_limit
  LOOP
    v_out := public.elm_ci_lock_settle(r.cz_solicitud_id);
    v_counts := jsonb_set(v_counts, ARRAY[v_out], to_jsonb(COALESCE((v_counts ->> v_out)::int, 0) + 1));
  END LOOP;
  RETURN v_counts;
END;
$$;

-- ---------------------------------------------------------------------------
-- C3. Event emission (internal: called by finalize / review resolve / late reconcile)
-- ---------------------------------------------------------------------------

-- Returns status: emitted | duplicate | noop | conflict | no_state.
CREATE OR REPLACE FUNCTION public.provider_cz_emit(
  p_cz_solicitud_id bigint,
  p_event_type text,
  p_target_estado integer,
  p_source_kind text,
  p_source_id uuid,
  p_dedupe_key text,
  p_outcome text,
  p_reason_code text,
  p_related_cz_solicitud_id bigint,
  p_provider_status text,
  p_provider_status_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state public.provider_cz_state%ROWTYPE;
  v_ev public.provider_cz_events%ROWTYPE;
  v_conflict uuid;
BEGIN
  IF p_dedupe_key IS NULL OR btrim(p_dedupe_key) = '' THEN
    RAISE EXCEPTION 'provider_cz_dedupe_key_required';
  END IF;
  SELECT * INTO v_state FROM public.provider_cz_state WHERE cz_solicitud_id = p_cz_solicitud_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_state');
  END IF;

  SELECT * INTO v_ev FROM public.provider_cz_events WHERE dedupe_key = p_dedupe_key;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'event_id', v_ev.id, 'seq', v_ev.seq);
  END IF;
  SELECT id INTO v_conflict FROM public.provider_cz_conflicts WHERE dedupe_key = p_dedupe_key;
  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'duplicate', 'conflict_id', v_conflict);
  END IF;
  IF v_state.projected_estado = p_target_estado THEN
    RETURN jsonb_build_object('status', 'noop', 'projected_estado', v_state.projected_estado);
  END IF;
  IF NOT public.provider_cz_event_shape_ok(p_event_type, v_state.projected_estado, p_target_estado) THEN
    v_conflict := public.provider_cz_record_conflict(
      p_cz_solicitud_id, v_state.ci, 'transition_not_allowed', v_state.projected_estado,
      p_event_type, p_target_estado, p_dedupe_key,
      jsonb_build_object('outcome', p_outcome, 'reason_code', p_reason_code,
                         'provider_status', p_provider_status, 'provider_status_at', p_provider_status_at,
                         'source_kind', p_source_kind, 'source_id', p_source_id)
    );
    RETURN jsonb_build_object('status', 'conflict', 'conflict_id', v_conflict,
                              'projected_estado', v_state.projected_estado);
  END IF;

  INSERT INTO public.provider_cz_events (
    cz_solicitud_id, seq, event_type, from_estado, target_estado, outcome, reason_code,
    related_cz_solicitud_id, provider_status, provider_status_at, source_kind, source_id, dedupe_key
  ) VALUES (
    p_cz_solicitud_id, v_state.last_seq + 1, p_event_type, v_state.projected_estado, p_target_estado,
    p_outcome, left(p_reason_code, 100), p_related_cz_solicitud_id, left(p_provider_status, 200),
    p_provider_status_at, p_source_kind, p_source_id, p_dedupe_key
  )
  RETURNING * INTO v_ev;

  UPDATE public.provider_cz_state
  SET projected_estado = p_target_estado, last_seq = v_ev.seq
  WHERE cz_solicitud_id = p_cz_solicitud_id;

  PERFORM public.elm_ci_lock_settle(p_cz_solicitud_id);

  RETURN jsonb_build_object('status', 'emitted', 'event_id', v_ev.id, 'seq', v_ev.seq,
                            'from_estado', v_ev.from_estado, 'target_estado', v_ev.target_estado);
END;
$$;

-- ---------------------------------------------------------------------------
-- D. Finalize (same signature as 3B): + CZ state + outcome event + lock settle, one transaction.
-- ---------------------------------------------------------------------------

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
  -- Technical / unknown / unmapped results are never a rejection: they go to manual_review.
  IF p_outcome IN ('rejected', 'not_eligible')
     AND NOT (p_reason_code = ANY (public.provider_fallback_definitive_rejection_reasons())) THEN
    RAISE EXCEPTION 'provider_fallback_rejection_not_definitive: %', p_reason_code;
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

  INSERT INTO public.provider_cz_state (cz_solicitud_id, fallback_request_id, ci)
  VALUES (v.cz_solicitud_id, v.id, v.ci)
  ON CONFLICT (cz_solicitud_id) DO NOTHING;

  PERFORM public.provider_cz_emit(
    v.cz_solicitud_id,
    'outcome',
    CASE p_outcome
      WHEN 'referred' THEN 13
      WHEN 'manual_review' THEN 14
      WHEN 'already_referred' THEN 15
      WHEN 'rejected' THEN 3
      WHEN 'not_eligible' THEN 3
    END,
    'fallback_outcome',
    v.id,
    'outcome:' || v.id::text,
    p_outcome,
    v.reason_code,
    v.related_cz_solicitud_id,
    NULL,
    NULL
  );
  -- No event (should not happen) still settles the lock from the final request.
  PERFORM public.elm_ci_lock_settle(v.cz_solicitud_id);

  RETURN NEXT v;
END;
$$;

-- ---------------------------------------------------------------------------
-- D2. CZ PULL: pending events + ack
-- ---------------------------------------------------------------------------

-- Head of each solicitud only (seq n waits until n-1 is acked). Counts the delivery attempt.
CREATE OR REPLACE FUNCTION public.provider_cz_events_pending(p_limit integer)
RETURNS SETOF public.provider_cz_events
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'provider_cz_invalid_limit';
  END IF;
  RETURN QUERY
  WITH heads AS (
    SELECT e.id
    FROM public.provider_cz_events e
    WHERE e.delivery_status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM public.provider_cz_events prev
        WHERE prev.cz_solicitud_id = e.cz_solicitud_id
          AND prev.seq < e.seq
          AND prev.delivery_status = 'pending'
      )
    ORDER BY e.created_at, e.cz_solicitud_id, e.seq
    LIMIT p_limit
    FOR UPDATE OF e SKIP LOCKED
  )
  UPDATE public.provider_cz_events u
  SET delivery_attempts = u.delivery_attempts + 1,
      last_delivered_at = now()
  FROM heads
  WHERE u.id = heads.id
  RETURNING u.*;
END;
$$;

-- Idempotent ack: acked | already_acked | out_of_order | not_found | invalid_result.
CREATE OR REPLACE FUNCTION public.provider_cz_event_ack(p_event_id uuid, p_result text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.provider_cz_events%ROWTYPE;
BEGIN
  IF p_result IS NULL OR p_result NOT IN ('applied', 'not_applied', 'ignored') THEN
    RETURN jsonb_build_object('status', 'invalid_result');
  END IF;
  SELECT * INTO v FROM public.provider_cz_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v.delivery_status = 'acked' THEN
    RETURN jsonb_build_object('status', 'already_acked', 'acked_at', v.acked_at, 'result', v.cz_ack_result,
                              'cz_solicitud_id', v.cz_solicitud_id, 'seq', v.seq);
  END IF;
  IF EXISTS (SELECT 1 FROM public.provider_cz_events prev
             WHERE prev.cz_solicitud_id = v.cz_solicitud_id AND prev.seq < v.seq
               AND prev.delivery_status = 'pending') THEN
    RETURN jsonb_build_object('status', 'out_of_order', 'cz_solicitud_id', v.cz_solicitud_id, 'seq', v.seq);
  END IF;
  UPDATE public.provider_cz_events
  SET delivery_status = 'acked', cz_ack_result = p_result, acked_at = now()
  WHERE id = v.id
  RETURNING * INTO v;
  RETURN jsonb_build_object('status', 'acked', 'acked_at', v.acked_at, 'result', v.cz_ack_result,
                            'cz_solicitud_id', v.cz_solicitud_id, 'seq', v.seq);
END;
$$;

-- ---------------------------------------------------------------------------
-- E. Late events (idempotent reconcile over the ELM process / applied postbacks)
-- ---------------------------------------------------------------------------

-- p_rejection_statuses: normalized ELM statuses that close a referral as rejected (config, empty
-- by default → no late.rejected). 'convertido' is never a rejection.
-- Current ELM status = the APPLIED postback with the greatest effective time (same rule as 1B).
CREATE OR REPLACE FUNCTION public.provider_cz_reconcile_late(p_rejection_statuses text[], p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rej text[];
  r record;
  v_res jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'provider_cz_invalid_limit';
  END IF;
  v_rej := ARRAY(
    SELECT DISTINCT x FROM unnest(COALESCE(p_rejection_statuses, '{}'::text[])) AS x
    WHERE x IS NOT NULL AND btrim(x) <> '' AND x <> 'convertido'
  );

  -- Convertido → late.granted (13/14 → 16). From 3/15 it is recorded as a conflict (no 3→16).
  FOR r IN
    SELECT s.cz_solicitud_id, p.id AS process_id, p.granted_event_id, p.provider_status, p.provider_status_at
    FROM public.provider_cz_state s
    JOIN public.elm_lead_processes p ON p.cz_solicitud_id = s.cz_solicitud_id
    WHERE p.disbursed_at IS NOT NULL
      AND s.projected_estado <> 16
      AND NOT EXISTS (SELECT 1 FROM public.provider_cz_events e WHERE e.dedupe_key = 'late.granted:' || p.id::text)
      AND NOT EXISTS (SELECT 1 FROM public.provider_cz_conflicts c WHERE c.dedupe_key = 'late.granted:' || p.id::text)
    ORDER BY p.disbursed_at
    LIMIT p_limit
  LOOP
    v_res := public.provider_cz_emit(
      r.cz_solicitud_id, 'late.granted', 16, 'provider_status', r.granted_event_id,
      'late.granted:' || r.process_id::text, NULL, 'elm_convertido', NULL, r.provider_status, r.provider_status_at
    );
    v_key := 'granted_' || (v_res ->> 'status');
    v_counts := jsonb_set(v_counts, ARRAY[v_key], to_jsonb(COALESCE((v_counts ->> v_key)::int, 0) + 1));
  END LOOP;

  IF cardinality(v_rej) > 0 THEN
    -- Rejection after referral (13/14 → 3).
    FOR r IN
      SELECT s.cz_solicitud_id, ev.id AS event_id, ev.raw_status, ev.eff
      FROM public.provider_cz_state s
      JOIN public.elm_lead_processes p ON p.cz_solicitud_id = s.cz_solicitud_id
      CROSS JOIN LATERAL (
        SELECT e.id, e.normalized_status, e.raw_status, COALESCE(e.provider_event_at, e.received_at) AS eff
        FROM public.elm_postback_events e
        WHERE e.matched_elm_process_id = p.id AND e.processing_status = 'applied'
        ORDER BY COALESCE(e.provider_event_at, e.received_at) DESC, e.processed_at DESC, e.received_at DESC
        LIMIT 1
      ) ev
      WHERE s.projected_estado IN (13, 14)
        AND p.disbursed_at IS NULL
        AND ev.normalized_status = ANY (v_rej)
        AND NOT EXISTS (SELECT 1 FROM public.provider_cz_events x WHERE x.dedupe_key = 'late.rejected:' || ev.id::text)
        AND NOT EXISTS (SELECT 1 FROM public.provider_cz_conflicts c WHERE c.dedupe_key = 'late.rejected:' || ev.id::text)
      ORDER BY ev.eff
      LIMIT p_limit
    LOOP
      v_res := public.provider_cz_emit(
        r.cz_solicitud_id, 'late.rejected', 3, 'provider_status', r.event_id,
        'late.rejected:' || r.event_id::text, NULL, 'elm_post_referral_rejection', NULL, r.raw_status, r.eff
      );
      v_key := 'rejected_' || (v_res ->> 'status');
      v_counts := jsonb_set(v_counts, ARRAY[v_key], to_jsonb(COALESCE((v_counts ->> v_key)::int, 0) + 1));
    END LOOP;

    -- A newer non-rejection status after a late.rejected already sent to CZ: never 3→13, conflict.
    FOR r IN
      SELECT s.cz_solicitud_id, s.ci, ev.id AS event_id, ev.raw_status, ev.eff, le.id AS rejection_event_id
      FROM public.provider_cz_state s
      JOIN public.provider_cz_events le
        ON le.cz_solicitud_id = s.cz_solicitud_id AND le.seq = s.last_seq AND le.event_type = 'late.rejected'
      JOIN public.elm_lead_processes p ON p.cz_solicitud_id = s.cz_solicitud_id
      CROSS JOIN LATERAL (
        SELECT e.id, e.normalized_status, e.raw_status, COALESCE(e.provider_event_at, e.received_at) AS eff
        FROM public.elm_postback_events e
        WHERE e.matched_elm_process_id = p.id AND e.processing_status = 'applied'
        ORDER BY COALESCE(e.provider_event_at, e.received_at) DESC, e.processed_at DESC, e.received_at DESC
        LIMIT 1
      ) ev
      WHERE s.projected_estado = 3
        AND p.disbursed_at IS NULL
        AND ev.id IS DISTINCT FROM le.source_id
        AND NOT (ev.normalized_status = ANY (v_rej))
        AND NOT EXISTS (SELECT 1 FROM public.provider_cz_conflicts c
                        WHERE c.dedupe_key = 'status_after_rejection:' || ev.id::text)
      ORDER BY ev.eff
      LIMIT p_limit
    LOOP
      PERFORM public.provider_cz_record_conflict(
        r.cz_solicitud_id, r.ci, 'status_after_rejection', 3, NULL, NULL,
        'status_after_rejection:' || r.event_id::text,
        jsonb_build_object('provider_status', r.raw_status, 'provider_status_at', r.eff,
                           'rejection_event_id', r.rejection_event_id)
      );
      v_counts := jsonb_set(v_counts, ARRAY['status_after_rejection'],
                            to_jsonb(COALESCE((v_counts ->> 'status_after_rejection')::int, 0) + 1));
    END LOOP;
  END IF;

  RETURN v_counts;
END;
$$;

-- ---------------------------------------------------------------------------
-- F. Review resolution with CZ outcome (replaces the 3B 5-argument function)
-- ---------------------------------------------------------------------------

-- p_cz_outcome: referred (14→13) | rejected (14→3) | granted (14→16, requires ELM Convertido) |
-- none (no CZ change). A CZ outcome is required while the projected estado is 14 and refused
-- otherwise (the solicitud already left 14 through another event, or it has no C1 state).
DROP FUNCTION IF EXISTS public.provider_review_resolve(uuid, integer, text, text, uuid);
CREATE OR REPLACE FUNCTION public.provider_review_resolve(
  p_case_id uuid,
  p_expected_version integer,
  p_resolution_code text,
  p_note text,
  p_actor_user_id uuid,
  p_cz_outcome text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.provider_review_cases%ROWTYPE;
  v_state public.provider_cz_state%ROWTYPE;
  v_has_state boolean;
  v_disbursed timestamptz;
  v_emit jsonb := NULL;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'provider_review_actor_required';
  END IF;
  IF p_resolution_code IS NULL OR p_resolution_code NOT IN
     ('resolved_with_provider', 'customer_contacted', 'no_action_required', 'other') THEN
    RETURN jsonb_build_object('status', 'invalid_resolution');
  END IF;
  IF p_cz_outcome IS NULL OR p_cz_outcome NOT IN ('referred', 'rejected', 'granted', 'none') THEN
    RETURN jsonb_build_object('status', 'invalid_cz_outcome');
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 10 OR length(p_note) > 2000 THEN
    RETURN jsonb_build_object('status', 'note_required');
  END IF;
  SELECT * INTO v FROM public.provider_review_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v.status <> 'open' THEN RETURN jsonb_build_object('status', 'already_resolved'); END IF;
  IF v.version IS DISTINCT FROM p_expected_version THEN RETURN jsonb_build_object('status', 'stale'); END IF;

  SELECT * INTO v_state FROM public.provider_cz_state WHERE cz_solicitud_id = v.cz_solicitud_id FOR UPDATE;
  v_has_state := FOUND;
  IF v_has_state AND v_state.projected_estado = 14 THEN
    IF p_cz_outcome = 'none' THEN
      RETURN jsonb_build_object('status', 'cz_outcome_required');
    END IF;
    IF p_cz_outcome = 'granted' THEN
      SELECT disbursed_at INTO v_disbursed FROM public.elm_lead_processes WHERE cz_solicitud_id = v.cz_solicitud_id;
      IF v_disbursed IS NULL THEN
        RETURN jsonb_build_object('status', 'evidence_required');
      END IF;
    END IF;
  ELSIF p_cz_outcome <> 'none' THEN
    RETURN jsonb_build_object('status', 'cz_outcome_not_applicable',
                              'projected_estado', CASE WHEN v_has_state THEN v_state.projected_estado END);
  END IF;

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
          jsonb_build_object('resolution_code', p_resolution_code, 'note', btrim(p_note),
                             'cz_outcome', p_cz_outcome));

  IF p_cz_outcome <> 'none' THEN
    v_emit := public.provider_cz_emit(
      v.cz_solicitud_id,
      'review.resolved',
      CASE p_cz_outcome WHEN 'referred' THEN 13 WHEN 'granted' THEN 16 ELSE 3 END,
      'review_case',
      v.id,
      'review.resolved:' || v.id::text,
      p_cz_outcome,
      v.reason_code,
      v.related_cz_solicitud_id,
      NULL,
      NULL
    );
  END IF;

  RETURN jsonb_build_object('status', 'resolved', 'version', v.version, 'cz_event', v_emit);
END;
$$;

-- Manual resolution of an ELM process (replaces the 3B 5-argument function; same rules) plus
-- p_cz_outcome for a C1 referral that CZ still has as active (projected 13):
--   rejected  → 13 → 3   only with provider_closed_no_loan (ELM confirmed: closed, no loan);
--   granted   → 13 → 16  only with provider_loan_disbursed and ELM "Convertido" (disbursed_at);
--   none / NULL → cz_outcome_required: without definitive evidence the referral stays pending.
-- Any other resolution code on a projected 13 → cz_outcome_mismatch. Outside 13 only none / NULL.
-- The referral.resolved event reaches CZ through the existing PULL + ACK; CZ applying 3 is what
-- starts the JANUS rejected circuit. Audit: actor, time, note, evidence, CZ estado before/after.
DROP FUNCTION IF EXISTS public.elm_resolve_process(uuid, timestamptz, text, text, uuid);
CREATE OR REPLACE FUNCTION public.elm_resolve_process(
  p_process_id uuid,
  p_expected_updated_at timestamptz,
  p_resolution_code text,
  p_note text,
  p_actor_user_id uuid,
  p_cz_outcome text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.elm_lead_processes%ROWTYPE;
  v_kind text;
  v_outcome text := COALESCE(p_cz_outcome, 'none');
  v_state public.provider_cz_state%ROWTYPE;
  v_has_state boolean;
  v_from integer;
  v_target integer := NULL;
  v_emit jsonb := NULL;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'elm_ops_actor_required';
  END IF;
  IF v_outcome NOT IN ('rejected', 'granted', 'none') THEN
    RETURN jsonb_build_object('status', 'invalid_cz_outcome');
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

  SELECT * INTO v_state FROM public.provider_cz_state WHERE cz_solicitud_id = v.cz_solicitud_id FOR UPDATE;
  v_has_state := FOUND;
  v_from := CASE WHEN v_has_state THEN v_state.projected_estado END;
  IF v_from = 13 THEN
    IF v_outcome = 'none' THEN
      RETURN jsonb_build_object('status', 'cz_outcome_required', 'projected_estado', v_from);
    END IF;
    IF NOT ((v_outcome = 'rejected' AND p_resolution_code = 'provider_closed_no_loan')
            OR (v_outcome = 'granted' AND p_resolution_code = 'provider_loan_disbursed')) THEN
      RETURN jsonb_build_object('status', 'cz_outcome_mismatch', 'projected_estado', v_from);
    END IF;
    v_target := CASE v_outcome WHEN 'rejected' THEN 3 ELSE 16 END;
  ELSIF v_outcome <> 'none' THEN
    RETURN jsonb_build_object('status', 'cz_outcome_not_applicable', 'projected_estado', v_from);
  END IF;

  UPDATE public.elm_lead_processes
  SET ops_resolution_code = p_resolution_code,
      ops_resolution_note = btrim(p_note),
      ops_resolved_by = p_actor_user_id,
      ops_resolved_at = now()
  WHERE id = v.id
  RETURNING * INTO v;

  IF v_target IS NOT NULL THEN
    v_emit := public.provider_cz_emit(
      v.cz_solicitud_id, 'referral.resolved', v_target, 'elm_process', v.id,
      'referral.resolved:' || v.id::text, v_outcome, p_resolution_code, NULL,
      v.provider_status, v.provider_status_at
    );
  END IF;

  INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
  VALUES ('elm_process', v.id, v.cz_solicitud_id, 'resolved', p_actor_user_id, jsonb_build_object(
    'kind', v_kind,
    'resolution_code', p_resolution_code,
    'note', btrim(p_note),
    's1_status', v.s1_status,
    's2_status', v.s2_status,
    'provider_status', v.provider_status,
    'disbursed', v.disbursed_at IS NOT NULL,
    'last_postback_event_id', v.last_postback_event_id,
    'cz_outcome', v_outcome,
    'cz_from_estado', v_from,
    'cz_to_estado', v_target,
    'cz_event_status', v_emit ->> 'status',
    'evidence', jsonb_build_object(
      'provider_status', v.provider_status,
      'provider_status_at', v.provider_status_at,
      'disbursed_at', v.disbursed_at,
      'granted_event_id', v.granted_event_id,
      'last_postback_event_id', v.last_postback_event_id
    )
  ));

  RETURN jsonb_build_object('status', 'resolved', 'kind', v_kind, 'resolved_at', v.ops_resolved_at,
                            'cz_event', v_emit);
END;
$$;

-- Conflict acknowledgement by operations (never changes CZ state or the event stream).
CREATE OR REPLACE FUNCTION public.provider_cz_conflict_resolve(
  p_conflict_id uuid,
  p_note text,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.provider_cz_conflicts%ROWTYPE;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'provider_cz_actor_required';
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 10 OR length(p_note) > 2000 THEN
    RETURN jsonb_build_object('status', 'note_required');
  END IF;
  SELECT * INTO v FROM public.provider_cz_conflicts WHERE id = p_conflict_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v.status <> 'open' THEN RETURN jsonb_build_object('status', 'already_resolved'); END IF;

  UPDATE public.provider_cz_conflicts
  SET status = 'resolved', resolution_note = btrim(p_note), resolved_by = p_actor_user_id, resolved_at = now()
  WHERE id = v.id
  RETURNING * INTO v;

  INSERT INTO public.elm_ops_audit_events (entity_type, entity_id, cz_solicitud_id, action, actor_user_id, detail)
  VALUES ('cz_conflict', v.id, v.cz_solicitud_id, 'resolved', p_actor_user_id,
          jsonb_build_object('conflict_code', v.conflict_code, 'note', btrim(p_note)));
  RETURN jsonb_build_object('status', 'resolved', 'resolved_at', v.resolved_at);
END;
$$;

-- ---------------------------------------------------------------------------
-- G. Ops tracking: active C1 referrals (13) and solicitudes in review (14).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.provider_c1_active_referrals(p_stale_after_hours integer, p_limit integer)
RETURNS TABLE (
  cz_solicitud_id bigint,
  ci bigint,
  projected_estado integer,
  fallback_outcome text,
  reason_code text,
  elm_process_id uuid,
  started_at timestamptz,
  referred_at timestamptz,
  age_hours numeric,
  provider_status text,
  provider_status_at timestamptz,
  last_postback_at timestamptz,
  hours_since_last_signal numeric,
  last_event_seq integer,
  last_event_type text,
  last_event_delivery text,
  unacked_events integer,
  open_conflicts integer,
  lock_state text,
  lock_month date,
  lock_block_reason text,
  granted_elm boolean,
  stale boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_stale_after_hours IS NULL OR p_stale_after_hours < 1 OR p_stale_after_hours > 8760 THEN
    RAISE EXCEPTION 'provider_c1_invalid_stale_hours';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'provider_c1_invalid_limit';
  END IF;
  RETURN QUERY
  SELECT
    s.cz_solicitud_id,
    s.ci,
    s.projected_estado,
    f.outcome,
    f.reason_code,
    p.id,
    COALESCE(p.referred_at, f.finalized_at),
    p.referred_at,
    round((extract(epoch FROM (now() - COALESCE(p.referred_at, f.finalized_at))) / 3600.0)::numeric, 1),
    p.provider_status,
    p.provider_status_at,
    p.last_postback_at,
    round((extract(epoch FROM (now() - COALESCE(p.last_postback_at, p.referred_at, f.finalized_at))) / 3600.0)::numeric, 1),
    s.last_seq,
    le.event_type,
    le.delivery_status,
    (SELECT count(*)::int FROM public.provider_cz_events e
      WHERE e.cz_solicitud_id = s.cz_solicitud_id AND e.delivery_status = 'pending'),
    (SELECT count(*)::int FROM public.provider_cz_conflicts c
      WHERE c.cz_solicitud_id = s.cz_solicitud_id AND c.status = 'open'),
    l.state,
    l.month_key,
    l.block_reason,
    p.disbursed_at IS NOT NULL,
    now() - COALESCE(p.last_postback_at, p.referred_at, f.finalized_at) > make_interval(hours => p_stale_after_hours)
  FROM public.provider_cz_state s
  JOIN public.provider_fallback_requests f ON f.id = s.fallback_request_id
  LEFT JOIN public.elm_lead_processes p ON p.cz_solicitud_id = s.cz_solicitud_id
  LEFT JOIN public.provider_cz_events le ON le.cz_solicitud_id = s.cz_solicitud_id AND le.seq = s.last_seq
  LEFT JOIN LATERAL (
    SELECT x.state, x.month_key, x.block_reason
    FROM public.elm_ci_send_locks x
    WHERE x.cz_solicitud_id = s.cz_solicitud_id
    ORDER BY x.reserved_at DESC
    LIMIT 1
  ) l ON true
  WHERE s.projected_estado IN (13, 14)
  ORDER BY COALESCE(p.referred_at, f.finalized_at) ASC, s.cz_solicitud_id
  LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- H. Access: backend only.
-- ---------------------------------------------------------------------------

ALTER TABLE public.provider_cz_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_cz_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_cz_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.elm_ci_send_locks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.provider_cz_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.provider_cz_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.provider_cz_conflicts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.elm_ci_send_locks FROM PUBLIC, anon, authenticated;
-- RPCs are SECURITY INVOKER: service_role needs row access. No DELETE / TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON TABLE public.provider_cz_state TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.provider_cz_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.provider_cz_conflicts TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.elm_ci_send_locks TO service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.provider_cz_state FROM service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.provider_cz_events FROM service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.provider_cz_conflicts FROM service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.elm_ci_send_locks FROM service_role;

REVOKE ALL ON FUNCTION public.elm_month_key(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_month_key(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.elm_pre_reception_error_codes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_pre_reception_error_codes() TO service_role;
REVOKE ALL ON FUNCTION public.elm_process_reception(public.elm_lead_processes) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_process_reception(public.elm_lead_processes) TO service_role;
REVOKE ALL ON FUNCTION public.provider_cz_transition_allowed(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_cz_transition_allowed(integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.provider_cz_event_shape_ok(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_cz_event_shape_ok(text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.provider_cz_state_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_cz_events_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_cz_conflicts_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elm_ci_send_locks_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_cz_record_conflict(bigint, bigint, text, integer, text, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_cz_record_conflict(bigint, bigint, text, integer, text, integer, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.elm_bcu_error_code() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_bcu_error_code() TO service_role;
REVOKE ALL ON FUNCTION public.provider_fallback_definitive_rejection_reasons() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_definitive_rejection_reasons() TO service_role;
REVOKE ALL ON FUNCTION public.elm_lead_processes_ci_lock_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elm_lead_processes_ci_lock_settle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elm_ci_lock_try(bigint, bigint, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_ci_lock_try(bigint, bigint, uuid, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.elm_ci_lock_acquire(bigint, bigint, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_ci_lock_acquire(bigint, bigint, uuid, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_claim_process(bigint, bigint, text, text, uuid, integer, text, jsonb, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.elm_retry_step(bigint, text, integer, integer, text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_retry_step(bigint, text, integer, integer, text[], integer) TO service_role;
REVOKE ALL ON FUNCTION public.elm_resolve_process(uuid, timestamptz, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_resolve_process(uuid, timestamptz, text, text, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.elm_ci_lock_release_unstarted(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_ci_lock_release_unstarted(bigint) TO service_role;
REVOKE ALL ON FUNCTION public.elm_ci_lock_settle(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_ci_lock_settle(bigint) TO service_role;
REVOKE ALL ON FUNCTION public.elm_ci_lock_reconcile(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elm_ci_lock_reconcile(integer) TO service_role;
REVOKE ALL ON FUNCTION public.provider_cz_emit(bigint, text, integer, text, uuid, text, text, text, bigint, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_cz_emit(bigint, text, integer, text, uuid, text, text, text, bigint, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.provider_fallback_finalize(uuid, text, text, text, jsonb, uuid, bigint, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_finalize(uuid, text, text, text, jsonb, uuid, bigint, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.provider_cz_events_pending(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_cz_events_pending(integer) TO service_role;
REVOKE ALL ON FUNCTION public.provider_cz_event_ack(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_cz_event_ack(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.provider_cz_reconcile_late(text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_cz_reconcile_late(text[], integer) TO service_role;
REVOKE ALL ON FUNCTION public.provider_review_resolve(uuid, integer, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_review_resolve(uuid, integer, text, text, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.provider_cz_conflict_resolve(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_cz_conflict_resolve(uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.provider_c1_active_referrals(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_c1_active_referrals(integer, integer) TO service_role;

COMMIT;
