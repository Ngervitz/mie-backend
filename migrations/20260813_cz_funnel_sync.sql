-- CZ Funnel Credizona sync (isolated from legacy cz_* lead/email tables).
-- Apply manually in Supabase.
--
-- Does NOT touch: cz_granted_loans, cz_solicitudes_synced, cz_encuestas_synced, cz_sync_cursor.

BEGIN;

-- ---------------------------------------------------------------------------
-- Funnel data tables (contracts validated against www.credizona.com.uy/api)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cz_funnel_granted_loans (
  cz_id           bigint PRIMARY KEY,
  ci              bigint,
  monto_otorgado  numeric,
  -- updated is an approximation of grant time — not the exact GRANTED transition.
  updated_at_src  timestamptz,
  updated_raw     text,
  synced_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cz_funnel_granted_loans IS
  'Credizona cdv_granted_loans mirror for MetaDash funnel. Isolated from legacy cz_granted_loans.';
COMMENT ON COLUMN public.cz_funnel_granted_loans.updated_at_src IS
  'Parsed from API field updated. Approximation only — not exact GRANTED transition time.';
COMMENT ON COLUMN public.cz_funnel_granted_loans.updated_raw IS
  'Raw API updated string as received.';

CREATE INDEX IF NOT EXISTS idx_cz_funnel_granted_loans_ci
  ON public.cz_funnel_granted_loans (ci);
CREATE INDEX IF NOT EXISTS idx_cz_funnel_granted_loans_updated
  ON public.cz_funnel_granted_loans (updated_at_src DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS public.cz_funnel_solicitudes (
  cz_id                    bigint PRIMARY KEY,
  solicitudes_estados_id   integer,
  usuarios_id              integer,
  ci                       bigint,
  fecha_reg                timestamptz,
  updated_at_src           timestamptz,
  updated_raw              text,
  -- Allowlisted UTM / submitted_at only — never raw tracking_data / PII.
  tracking_data_summary    jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cz_funnel_solicitudes IS
  'Credizona solicitudes mirror for funnel. tracking_data_summary is allowlisted keys only.';
COMMENT ON COLUMN public.cz_funnel_solicitudes.tracking_data_summary IS
  'Only utm_source,utm_medium,utm_campaign,utm_content,utm_term,submitted_at. Never IP/cookies/UA.';

CREATE INDEX IF NOT EXISTS idx_cz_funnel_solicitudes_fecha_reg
  ON public.cz_funnel_solicitudes (fecha_reg DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_cz_funnel_solicitudes_ci
  ON public.cz_funnel_solicitudes (ci);

CREATE TABLE IF NOT EXISTS public.cz_funnel_encuestas (
  cz_id          bigint PRIMARY KEY,
  ci             bigint,
  email          text,
  score_v2       numeric,
  completed_at   timestamptz,
  synced_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cz_funnel_encuestas IS
  'Credizona encuestas mirror. Uses score_v2 from API; no marketing_consent in source contract.';

CREATE INDEX IF NOT EXISTS idx_cz_funnel_encuestas_completed
  ON public.cz_funnel_encuestas (completed_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_cz_funnel_encuestas_ci
  ON public.cz_funnel_encuestas (ci);

-- ---------------------------------------------------------------------------
-- Isolated cursors (do not reuse cz_sync_cursor)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cz_funnel_sync_cursors (
  source_name      text PRIMARY KEY,
  last_since       text,
  last_synced_at   timestamptz,
  last_sync_status text
    CHECK (
      last_sync_status IN ('success', 'error')
      OR last_sync_status IS NULL
    ),
  last_sync_error  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cz_funnel_sync_cursors_source_name_check CHECK (
    source_name IN (
      'cz_funnel_granted_loans',
      'cz_funnel_solicitudes',
      'cz_funnel_encuestas'
    )
  )
);

COMMENT ON COLUMN public.cz_funnel_sync_cursors.last_since IS
  'Opaque nextSince cursor from CZ API (TEXT). Do not recompute from MAX(date).';

INSERT INTO public.cz_funnel_sync_cursors (source_name)
VALUES
  ('cz_funnel_granted_loans'),
  ('cz_funnel_solicitudes'),
  ('cz_funnel_encuestas')
ON CONFLICT (source_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Allow section_key cz-funnel for dashboard permissions
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
      'cz-funnel'
    )
  );

COMMIT;
