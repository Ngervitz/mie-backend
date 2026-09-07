-- Rechazados BCU extract Stage 2.1: draft lifecycle for extracting / extraction_failed,
-- nullable extraction_json, file_sha256, attempt ownership lease columns.
-- Apply manually in Supabase AFTER 20260906_rechazados_bcu_extract_stage2.sql.
-- Idempotent where practical.
-- Does NOT implement Stage 3 routes/LLM. Does NOT add RPC, retention cron, or UNIQUE hash.
-- Precondition: rejected_bcu_extraction_drafts should be empty before ADD file_sha256 NOT NULL
-- (verified 0 rows at authoring time; re-check before apply).

BEGIN;

-- =====================================================================
-- A. extraction_json → nullable
-- =====================================================================

ALTER TABLE public.rejected_bcu_extraction_drafts
  ALTER COLUMN extraction_json DROP NOT NULL;

-- =====================================================================
-- B. status vocabulary + ownership / extraction coherence CHECKs
-- =====================================================================

ALTER TABLE public.rejected_bcu_extraction_drafts
  DROP CONSTRAINT IF EXISTS rejected_bcu_extraction_drafts_status_check;

ALTER TABLE public.rejected_bcu_extraction_drafts
  ADD CONSTRAINT rejected_bcu_extraction_drafts_status_check CHECK (
    status IN (
      'pending_review',
      'confirmed',
      'abandoned',
      'expired',
      'extracting',
      'extraction_failed'
    )
  );

-- confirmed → confirmed_snapshot_id already enforced by
-- rejected_bcu_extraction_drafts_confirmed_snapshot_check (unchanged).

ALTER TABLE public.rejected_bcu_extraction_drafts
  DROP CONSTRAINT IF EXISTS rejected_bcu_extraction_drafts_extraction_json_check;

-- pending_review | confirmed require a real extraction payload.
-- extracting | extraction_failed must not fake one (NULL only).
-- abandoned | expired: no extraction_json rule — may come from success or failure paths.
ALTER TABLE public.rejected_bcu_extraction_drafts
  ADD CONSTRAINT rejected_bcu_extraction_drafts_extraction_json_check CHECK (
    (
      status IN ('extracting', 'extraction_failed')
      AND extraction_json IS NULL
    )
    OR (
      status IN ('pending_review', 'confirmed')
      AND extraction_json IS NOT NULL
    )
    OR status IN ('abandoned', 'expired')
  );

-- =====================================================================
-- C. file_sha256 (identity of upload bytes; soft dedup in app V1)
-- =====================================================================

ALTER TABLE public.rejected_bcu_extraction_drafts
  ADD COLUMN IF NOT EXISTS file_sha256 text;

-- Safe while table is empty. If rows exist without hash, this fails — do not backfill inventively.
ALTER TABLE public.rejected_bcu_extraction_drafts
  ALTER COLUMN file_sha256 SET NOT NULL;

COMMENT ON COLUMN public.rejected_bcu_extraction_drafts.file_sha256 IS
  'SHA-256 hex of uploaded file bytes. same_upload = (ci, file_sha256). V1 soft-dedup only among active draft statuses; not unique; not matched against confirmed snapshots.';

CREATE INDEX IF NOT EXISTS idx_rejected_bcu_extraction_drafts_ci_file_sha256
  ON public.rejected_bcu_extraction_drafts (ci, file_sha256);

-- =====================================================================
-- D. attempt ownership (CAS token + lease)
-- =====================================================================

ALTER TABLE public.rejected_bcu_extraction_drafts
  ADD COLUMN IF NOT EXISTS attempt_id uuid NULL;

ALTER TABLE public.rejected_bcu_extraction_drafts
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz NULL;

COMMENT ON COLUMN public.rejected_bcu_extraction_drafts.attempt_id IS
  'UUID of the in-flight extraction attempt. Required iff status=extracting. Final writes CAS on (status, attempt_id).';

COMMENT ON COLUMN public.rejected_bcu_extraction_drafts.lease_expires_at IS
  'When an extracting lease may be reclaimed. Required iff status=extracting. Stage 3: LEASE_TTL_MS = OPENAI_TIMEOUT_MS + LEASE_MARGIN_MS (180000).';

ALTER TABLE public.rejected_bcu_extraction_drafts
  DROP CONSTRAINT IF EXISTS rejected_bcu_extraction_drafts_attempt_lease_check;

ALTER TABLE public.rejected_bcu_extraction_drafts
  ADD CONSTRAINT rejected_bcu_extraction_drafts_attempt_lease_check CHECK (
    (
      status = 'extracting'
      AND attempt_id IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      status <> 'extracting'
      AND attempt_id IS NULL
      AND lease_expires_at IS NULL
    )
  );

COMMIT;
