-- CZ funnel solicitudes: why fecha_nacimiento is stored as it is.
-- NOT APPLIED. Apply manually in Supabase BEFORE deploying the code that writes it
-- (src/jobs/czFunnelSync.js upserts the column) and reads it (src/services/elm/repository.js).
-- Idempotent. No backfill: the solicitudes sync is a fullRefresh, so its next run fills every row.
--
-- fecha_nacimiento keeps only valid dates (calendar date, age 18-100); every other value is
-- stored as NULL. This column keeps the reason (src/lib/birthDate.js BIRTH_DATE_STATUS) so a
-- manual ELM send can leave out an absent / impossible date without hiding a minor's:
--   valid         stored in fecha_nacimiento
--   absent        CZ sent no value
--   impossible    not a calendar date
--   over_max_age  older than 100 years (e.g. year 0088)
--   underage      under 18           → blocks the manual ELM send
--   future        after the sync day → blocks the manual ELM send
-- NULL = not classified yet (row not synced since this migration, or the API item has no
-- fecha_nacimiento key) → blocks the manual ELM send.

BEGIN;

ALTER TABLE public.cz_funnel_solicitudes
  ADD COLUMN IF NOT EXISTS fecha_nacimiento_status text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cz_funnel_solicitudes_fecha_nacimiento_status_check'
      AND conrelid = 'public.cz_funnel_solicitudes'::regclass
  ) THEN
    ALTER TABLE public.cz_funnel_solicitudes
      ADD CONSTRAINT cz_funnel_solicitudes_fecha_nacimiento_status_check
      CHECK (
        fecha_nacimiento_status IS NULL
        OR fecha_nacimiento_status IN ('valid', 'absent', 'impossible', 'over_max_age', 'underage', 'future')
      );
  END IF;
END;
$$;

COMMENT ON COLUMN public.cz_funnel_solicitudes.fecha_nacimiento_status IS
  'Classification of Credizona /solicitudes.fecha_nacimiento at sync time (valid | absent | impossible | over_max_age | underage | future). NULL = not classified. Manual ELM sends omit dateOfBirth only for absent / impossible / over_max_age.';

COMMIT;
