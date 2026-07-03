-- MIE Run History Integrity
-- Makes ad_snapshots append-only: one row per pipeline run, no overwrite on (entity_id, snapshot_date).
--
-- Apply via Supabase SQL Editor or psql against production.
-- Run scripts/audit-run-history-paso0.sql BEFORE deploy and BEFORE optional apify_run_id unique migration.

-- ---------------------------------------------------------------------------
-- 1. Drop UNIQUE on (entity_id, snapshot_date) — name discovered dynamically
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.ad_snapshots'::regclass
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) ~ 'entity_id'
      AND pg_get_constraintdef(c.oid) ~ 'snapshot_date'
  LOOP
    EXECUTE format('ALTER TABLE public.ad_snapshots DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE 'Dropped constraint %', r.conname;
  END LOOP;
END $$;

-- Standalone unique indexes on the same columns (if not backed by a table constraint)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'ad_snapshots'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%entity_id%'
      AND indexdef ILIKE '%snapshot_date%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexname);
    RAISE NOTICE 'Dropped unique index %', r.indexname;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Non-unique indexes for run history lookups
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ad_snapshots_entity_date_created
  ON public.ad_snapshots (entity_id, snapshot_date, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ad_snapshots_entity_created
  ON public.ad_snapshots (entity_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Immutability trigger (blocks all UPDATE; no updated_at on ad_snapshots)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ad_snapshots_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'MIE Integrity Error: ad_snapshots rows are immutable; insert a new run row instead';
END;
$$;

DROP TRIGGER IF EXISTS ad_snapshots_immutable ON public.ad_snapshots;

CREATE TRIGGER ad_snapshots_immutable
  BEFORE UPDATE ON public.ad_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.ad_snapshots_immutable_guard();

-- ---------------------------------------------------------------------------
-- 4. Partial UNIQUE on apify_run_id — NOT applied here.
--    Apply migrations/20260703_run_history_integrity_apify_unique.sql only after
--    PASO 0 confirms zero duplicate apify_run_id rows.
-- ---------------------------------------------------------------------------
