-- CZ Credizona lead sync tables (granted loans + solicitudes + cursors).
-- Apply manually in Supabase.
-- Source adapters live in src/services/cz-lead-source/ — job does not know transport.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cz_granted_loans (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cdv_operation_id  text NOT NULL UNIQUE,
  loan_amount       numeric NOT NULL,
  granted_at        timestamptz NOT NULL,
  cz_solicitud_id   integer NOT NULL,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cz_granted_loans IS
  'Loans granted in Credizona (estado 11). Synced via CZLeadSource adapters.';
COMMENT ON COLUMN public.cz_granted_loans.cdv_operation_id IS
  'Credizona LRW / CDV operation id (lrw_id). Rows without lrw_id are never inserted.';

CREATE INDEX IF NOT EXISTS idx_cz_granted_loans_granted_at
  ON public.cz_granted_loans (granted_at DESC);

CREATE TABLE IF NOT EXISTS public.cz_solicitudes_synced (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cz_id                   integer NOT NULL UNIQUE,
  solicitudes_estados_id  integer,
  usuarios_id             integer,
  fecha_reg               timestamptz,
  lrw_id                  text,
  tracking_data           jsonb,
  synced_at               timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cz_solicitudes_synced IS
  'Mirror of Credizona solicitudes for MetaDash analytics. Synced via CZLeadSource.';

CREATE INDEX IF NOT EXISTS idx_cz_solicitudes_synced_fecha_reg
  ON public.cz_solicitudes_synced (fecha_reg DESC);

CREATE TABLE IF NOT EXISTS public.cz_sync_cursor (
  source_name      text PRIMARY KEY,
  last_since       text,
  last_synced_at   timestamptz,
  last_sync_status text
    CHECK (
      last_sync_status IN ('success', 'error')
      OR last_sync_status IS NULL
    ),
  last_sync_error  text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.cz_sync_cursor.source_name IS
  'granted_loans | solicitudes';

DROP TRIGGER IF EXISTS trg_cz_sync_cursor_updated_at ON public.cz_sync_cursor;
CREATE TRIGGER trg_cz_sync_cursor_updated_at
  BEFORE UPDATE ON public.cz_sync_cursor
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.cz_sync_cursor (source_name)
VALUES ('granted_loans'), ('solicitudes')
ON CONFLICT (source_name) DO NOTHING;

COMMIT;
