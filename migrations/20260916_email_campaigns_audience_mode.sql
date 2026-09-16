-- Explicit audience_mode for email_campaigns: SEGMENT_DRIVEN | DIRECTED.
-- Apply manually in Supabase (or via pg client with DATABASE_URL).
-- Idempotent where practical. Backfills ONLY campaigns with segment_id + snapshot.
-- Final state: audience_mode NOT NULL with NO permanent DEFAULT (fail-closed inserts).
-- DIRECTED requires segment_rules_snapshot NULL (never []).

BEGIN;

-- 1) Add column nullable (temporary) for backfill.
ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS audience_mode text;

COMMENT ON COLUMN public.email_campaigns.audience_mode IS
  'Audience materialization mode: SEGMENT_DRIVEN (generic segment materialize) or DIRECTED (specific materializer, no segment). NOT NULL; no DB default — callers must set explicitly.';

-- 2) Backfill only unequivocal SEGMENT_DRIVEN rows.
UPDATE public.email_campaigns
SET audience_mode = 'SEGMENT_DRIVEN'
WHERE audience_mode IS NULL
  AND segment_id IS NOT NULL
  AND segment_rules_snapshot IS NOT NULL;

-- 3) Refuse to proceed if any row remains unclassified.
DO $$
DECLARE
  leftover integer;
BEGIN
  SELECT count(*)::integer INTO leftover
  FROM public.email_campaigns
  WHERE audience_mode IS NULL;
  IF leftover > 0 THEN
    RAISE EXCEPTION
      'email_campaigns.audience_mode backfill incomplete: % row(s) still NULL — refuse migration',
      leftover;
  END IF;
END $$;

-- 4) Lock column: NOT NULL, no permanent default.
ALTER TABLE public.email_campaigns
  ALTER COLUMN audience_mode SET NOT NULL;

ALTER TABLE public.email_campaigns
  ALTER COLUMN audience_mode DROP DEFAULT;

-- 5) Allowed values.
ALTER TABLE public.email_campaigns
  DROP CONSTRAINT IF EXISTS email_campaigns_audience_mode_check;

ALTER TABLE public.email_campaigns
  ADD CONSTRAINT email_campaigns_audience_mode_check
  CHECK (audience_mode IN ('SEGMENT_DRIVEN', 'DIRECTED'));

-- 6) Allow NULL snapshot for DIRECTED (must precede consistency CHECK that permits NULL).
ALTER TABLE public.email_campaigns
  ALTER COLUMN segment_rules_snapshot DROP NOT NULL;

-- 7) Mode ↔ segment/snapshot consistency (invalid cross-states forbidden).
ALTER TABLE public.email_campaigns
  DROP CONSTRAINT IF EXISTS email_campaigns_audience_mode_segment_consistency_check;

ALTER TABLE public.email_campaigns
  ADD CONSTRAINT email_campaigns_audience_mode_segment_consistency_check
  CHECK (
    (
      audience_mode = 'SEGMENT_DRIVEN'
      AND segment_id IS NOT NULL
      AND segment_rules_snapshot IS NOT NULL
    )
    OR
    (
      audience_mode = 'DIRECTED'
      AND segment_id IS NULL
      AND segment_rules_snapshot IS NULL
    )
  );

COMMIT;
