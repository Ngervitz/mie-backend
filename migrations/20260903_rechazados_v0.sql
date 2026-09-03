-- Rechazados V0 etapa 1: nombre/apellido on solicitudes + BCU fact tables + section_key.
-- Apply manually in Supabase AFTER 20260813_cz_funnel_sync.sql
-- (and 20260813_dashboard_users_permissions.sql for dashboard_users).
-- Idempotent. Does not backfill names. Does not persist ops_state.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Person display names on the solicitudes mirror (source: CZ /solicitudes)
-- ---------------------------------------------------------------------------

ALTER TABLE public.cz_funnel_solicitudes
  ADD COLUMN IF NOT EXISTS nombre text;

ALTER TABLE public.cz_funnel_solicitudes
  ADD COLUMN IF NOT EXISTS apellido text;

COMMENT ON COLUMN public.cz_funnel_solicitudes.nombre IS
  'Credizona solicitudes.nombre. Display only; not a person identity key.';
COMMENT ON COLUMN public.cz_funnel_solicitudes.apellido IS
  'Credizona solicitudes.apellido. Display only; not a person identity key.';

-- ---------------------------------------------------------------------------
-- B. BCU snapshots (append-only facts; ops_status is derived in app code)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rejected_bcu_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ci                 bigint NOT NULL,
  period_label       text NOT NULL,
  consulted_on       date NOT NULL,
  source             text NOT NULL DEFAULT 'manual',
  storage_path       text NULL,
  original_filename  text NULL,
  content_type       text NULL,
  file_size_bytes    integer NULL,
  created_by         uuid NULL REFERENCES public.dashboard_users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rejected_bcu_snapshots_source_check
    CHECK (source IN ('manual')),
  CONSTRAINT rejected_bcu_snapshots_file_size_bytes_check
    CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0)
);

COMMENT ON TABLE public.rejected_bcu_snapshots IS
  'Manual BCU consultation snapshots keyed by CI. Append-only. Operational status is not stored.';

CREATE INDEX IF NOT EXISTS idx_rejected_bcu_snapshots_ci_consulted
  ON public.rejected_bcu_snapshots (ci, consulted_on DESC, created_at DESC);

-- ---------------------------------------------------------------------------
-- C. BCU institutions (child of snapshot; MN/ME never summed)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rejected_bcu_institutions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id        uuid NOT NULL
                       REFERENCES public.rejected_bcu_snapshots (id) ON DELETE CASCADE,
  institution_name   text NOT NULL,
  category           text NOT NULL,
  vigente_mn         numeric NOT NULL DEFAULT 0,
  vigente_me         numeric NOT NULL DEFAULT 0,
  moroso_mn          numeric NOT NULL DEFAULT 0,
  moroso_me          numeric NOT NULL DEFAULT 0,
  castigado_mn       numeric NOT NULL DEFAULT 0,
  castigado_me       numeric NOT NULL DEFAULT 0,
  contingencias_mn   numeric NOT NULL DEFAULT 0,
  contingencias_me   numeric NOT NULL DEFAULT 0,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rejected_bcu_institutions_category_check
    CHECK (category IN ('1C', '2A', '2B', '3', '4', '5')),
  CONSTRAINT rejected_bcu_institutions_balances_nonneg_check CHECK (
    vigente_mn >= 0 AND vigente_me >= 0 AND
    moroso_mn >= 0 AND moroso_me >= 0 AND
    castigado_mn >= 0 AND castigado_me >= 0 AND
    contingencias_mn >= 0 AND contingencias_me >= 0
  )
);

COMMENT ON TABLE public.rejected_bcu_institutions IS
  'Per-institution BCU balances for a snapshot. MN and ME stay separate.';

CREATE INDEX IF NOT EXISTS idx_rejected_bcu_institutions_snapshot
  ON public.rejected_bcu_institutions (snapshot_id, sort_order);

-- ---------------------------------------------------------------------------
-- D. Allow section_key rechazados (copy latest CHECK from 20260813_cz_funnel_sync.sql)
-- ---------------------------------------------------------------------------

ALTER TABLE public.dashboard_user_permissions
  DROP CONSTRAINT IF EXISTS dashboard_user_permissions_section_key_check;

ALTER TABLE public.dashboard_user_permissions
  ADD CONSTRAINT dashboard_user_permissions_section_key_check CHECK (
    section_key IN (
      'market',
      'discoveries',
      'ai-visibility',
      'ga4',
      'searchconsole',
      'meta',
      'sms',
      'email',
      'inbox',
      'cz-funnel',
      'rechazados'
    )
  );

COMMIT;
