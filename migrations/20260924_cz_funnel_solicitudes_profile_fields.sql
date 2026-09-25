-- CZ funnel solicitudes: persist profile/contact fields already returned by
-- Credizona GET /solicitudes (decode Bearer API).
-- Apply manually in Supabase AFTER 20260911_cz_funnel_solicitudes_email_lrw.sql.
-- Idempotent. No backfill. No NOT NULL / UNIQUE.
--
-- Episode-scoped on cz_funnel_solicitudes (PK cz_id / LRW episode).
-- Same CI with multiple LRW keeps distinct salario / celular / DOB snapshots.
-- Next fullRefresh sync fills existing rows (solicitudes sync uses fullRefresh).

BEGIN;

ALTER TABLE public.cz_funnel_solicitudes
  ADD COLUMN IF NOT EXISTS celular text;

ALTER TABLE public.cz_funnel_solicitudes
  ADD COLUMN IF NOT EXISTS salario numeric;

ALTER TABLE public.cz_funnel_solicitudes
  ADD COLUMN IF NOT EXISTS fecha_nacimiento date;

ALTER TABLE public.cz_funnel_solicitudes
  ADD COLUMN IF NOT EXISTS relacion_laboral text;

COMMENT ON COLUMN public.cz_funnel_solicitudes.celular IS
  'Credizona /solicitudes.celular (usuarios.celular). Declared contact; source=credizona. Digits as text. Episode-scoped; CI→celular = latest non-null by updated_at_src.';

COMMENT ON COLUMN public.cz_funnel_solicitudes.salario IS
  'Credizona /solicitudes.salario. Declared income for this solicitud (not verified). Currency implicit UYU. Episode-scoped — do not treat as eternal person attribute.';

COMMENT ON COLUMN public.cz_funnel_solicitudes.fecha_nacimiento IS
  'Credizona /solicitudes.fecha_nacimiento (usuarios). Date-only Y-m-d. Prefer DOB over derived age.';

COMMENT ON COLUMN public.cz_funnel_solicitudes.relacion_laboral IS
  'Credizona /solicitudes.relacion_laboral. Declared employment status for this solicitud. Episode-scoped.';

-- CI → celular / profile lookups (existing idx_cz_funnel_solicitudes_ci remains).
CREATE INDEX IF NOT EXISTS idx_cz_funnel_solicitudes_ci_updated
  ON public.cz_funnel_solicitudes (ci, updated_at_src DESC NULLS LAST);

-- LRW → episode lookup for future JANUS→Mi Plan context.
CREATE INDEX IF NOT EXISTS idx_cz_funnel_solicitudes_lrw_id
  ON public.cz_funnel_solicitudes (lrw_id)
  WHERE lrw_id IS NOT NULL;

COMMIT;
