-- Rechazados Stage 1: Mi Plan / Mi Deuda outreach state per CI.
-- Apply manually in Supabase AFTER 20260903_rechazados_v0.sql
-- Idempotent. No backfill. No soft delete.
-- Reuses existing public.set_updated_at() (do not redefine).

BEGIN;

CREATE TABLE IF NOT EXISTS public.rejected_ci_outreach (
  ci                      bigint PRIMARY KEY,
  mi_plan_status          text NOT NULL DEFAULT 'not_invited',
  mi_plan_updated_at      timestamptz NULL,
  mi_deuda_status         text NOT NULL DEFAULT 'not_invited',
  mi_deuda_updated_at     timestamptz NULL,
  mi_deuda_invited_at     timestamptz NULL,
  mi_deuda_responded_at   timestamptz NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rejected_ci_outreach_mi_plan_status_check
    CHECK (mi_plan_status IN ('not_invited', 'invited', 'active')),
  CONSTRAINT rejected_ci_outreach_mi_deuda_status_check
    CHECK (mi_deuda_status IN (
      'not_invited',
      'invite_sent',
      'opt_in_accepted',
      'opt_in_rejected'
    ))
);

COMMENT ON TABLE public.rejected_ci_outreach IS
  'Per-CI Mi Plan / Mi Deuda outreach memory for Rechazados. Missing row = not_invited defaults in app.';

COMMENT ON COLUMN public.rejected_ci_outreach.ci IS
  'Operational identity for Rechazados. Same CI key as rejected_bcu_snapshots.';

COMMENT ON COLUMN public.rejected_ci_outreach.mi_plan_status IS
  'not_invited | invited | active. App defaults to not_invited when no row.';

COMMENT ON COLUMN public.rejected_ci_outreach.mi_deuda_status IS
  'not_invited | invite_sent | opt_in_accepted | opt_in_rejected. Invite expiry is derived in app.';

COMMENT ON COLUMN public.rejected_ci_outreach.mi_deuda_invited_at IS
  'When invite_sent was set. Used to derive mi_deuda_invite_expired (>= 7*24h).';

COMMENT ON COLUMN public.rejected_ci_outreach.mi_deuda_responded_at IS
  'When opt-in accepted/rejected was recorded.';

DROP TRIGGER IF EXISTS trg_rejected_ci_outreach_updated_at ON public.rejected_ci_outreach;
CREATE TRIGGER trg_rejected_ci_outreach_updated_at
  BEFORE UPDATE ON public.rejected_ci_outreach
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMIT;
