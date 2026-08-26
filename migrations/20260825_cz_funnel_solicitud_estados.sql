-- CZ funnel solicitud state history (child of cz_funnel_solicitudes).
-- Apply manually in Supabase AFTER 20260813_cz_funnel_sync.sql.
-- Idempotent. No backfill. No DELETE. Does not touch granted / encuestas / cursors.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cz_funnel_solicitud_estados (
  cz_historico_id                  bigint PRIMARY KEY,
  cz_solicitud_id                  bigint NOT NULL,
  solicitudes_estados_id           integer NULL,
  solicitudes_estados_id_anterior  integer NULL,
  estado                           text NULL,
  estado_anterior                  text NULL,
  fechahora_src                    timestamptz NULL,
  fechahora_raw                    text NULL,
  extra_data                       jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at                        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cz_funnel_solicitud_estados_cz_solicitud_id_fkey
    FOREIGN KEY (cz_solicitud_id)
    REFERENCES public.cz_funnel_solicitudes (cz_id)
    ON DELETE CASCADE
);

COMMENT ON TABLE public.cz_funnel_solicitud_estados IS
  'Credizona solicitudes historico[] transitions. PK is CZ historico.id. Incomplete toward the past — empty arrays are not a wipe.';

COMMENT ON COLUMN public.cz_funnel_solicitud_estados.cz_historico_id IS
  'Credizona historico.id (solicitudes_historico_estados PK). Natural idempotency key.';

COMMENT ON COLUMN public.cz_funnel_solicitud_estados.cz_solicitud_id IS
  'historico.solicitudes_id = solicitudes.id = cz_funnel_solicitudes.cz_id.';

COMMENT ON COLUMN public.cz_funnel_solicitud_estados.fechahora_src IS
  'Parsed historico.fechahora. Timestamp of the CZ state transition when parseable.';

COMMENT ON COLUMN public.cz_funnel_solicitud_estados.fechahora_raw IS
  'Raw historico.fechahora string as received.';

COMMENT ON COLUMN public.cz_funnel_solicitud_estados.extra_data IS
  'historico.extra_data object as received (newEstado/oldEstado). {} when missing or not a plain object.';

CREATE INDEX IF NOT EXISTS idx_cz_funnel_solicitud_estados_solicitud_fechahora
  ON public.cz_funnel_solicitud_estados (cz_solicitud_id, fechahora_src);

CREATE INDEX IF NOT EXISTS idx_cz_funnel_solicitud_estados_estado_fechahora
  ON public.cz_funnel_solicitud_estados (solicitudes_estados_id, fechahora_src);

COMMIT;
