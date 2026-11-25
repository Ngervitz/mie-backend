-- Tip-pass cursor for POST /jobs/run-cz-solicitudes-tip-sync (dual-pass CZ funnel).
-- Apply before enabling cron; does not alter full-refresh cursor cz_funnel_solicitudes.

BEGIN;

ALTER TABLE public.cz_funnel_sync_cursors
  DROP CONSTRAINT IF EXISTS cz_funnel_sync_cursors_source_name_check;

ALTER TABLE public.cz_funnel_sync_cursors
  ADD CONSTRAINT cz_funnel_sync_cursors_source_name_check CHECK (
    source_name IN (
      'cz_funnel_granted_loans',
      'cz_funnel_solicitudes',
      'cz_funnel_encuestas',
      'cz_funnel_solicitudes_tip'
    )
  );

INSERT INTO public.cz_funnel_sync_cursors (source_name)
VALUES ('cz_funnel_solicitudes_tip')
ON CONFLICT (source_name) DO NOTHING;

COMMIT;