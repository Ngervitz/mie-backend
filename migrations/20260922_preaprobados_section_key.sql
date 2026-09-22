-- Preaprobados V1: allow section_key preaprobados (dashboard permission only).
-- Apply manually in Supabase AFTER 20260903_rechazados_v0.sql.
-- Idempotent. No business tables. No backfill.

BEGIN;

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
      'rechazados',
      'preaprobados'
    )
  );

COMMIT;
