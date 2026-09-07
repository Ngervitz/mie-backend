-- Rechazados BCU extract Stage 4: human confirm of extraction drafts.
-- Apply manually in Supabase AFTER 20260906_rechazados_bcu_extract_stage2_1.sql.
-- Idempotent where practical.
-- Does NOT confirm existing drafts. Does NOT purge Storage. Does NOT change category nullability.
--
-- Retention note (future): if a snapshot references a draft-owned storage_path,
-- draft purge MUST NOT delete that Storage object while any snapshot still references it.

BEGIN;

-- =====================================================================
-- A. reviewed_payload_sha256 (idempotency + durability)
-- =====================================================================

ALTER TABLE public.rejected_bcu_extraction_drafts
  ADD COLUMN IF NOT EXISTS reviewed_payload_sha256 text NULL;

ALTER TABLE public.rejected_bcu_snapshots
  ADD COLUMN IF NOT EXISTS reviewed_payload_sha256 text NULL;

COMMENT ON COLUMN public.rejected_bcu_extraction_drafts.reviewed_payload_sha256 IS
  'SHA-256 hex (lowercase) of canonical {consulted_on, reviewed} at first confirm. Used for HTTP idempotency mismatch detection.';

COMMENT ON COLUMN public.rejected_bcu_snapshots.reviewed_payload_sha256 IS
  'Copy of confirm payload hash for durability if drafts are later purged. NULL for historical manual snapshots.';

ALTER TABLE public.rejected_bcu_extraction_drafts
  DROP CONSTRAINT IF EXISTS rejected_bcu_extraction_drafts_reviewed_payload_sha256_check;

ALTER TABLE public.rejected_bcu_extraction_drafts
  ADD CONSTRAINT rejected_bcu_extraction_drafts_reviewed_payload_sha256_check CHECK (
    reviewed_payload_sha256 IS NULL
    OR reviewed_payload_sha256 ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE public.rejected_bcu_snapshots
  DROP CONSTRAINT IF EXISTS rejected_bcu_snapshots_reviewed_payload_sha256_check;

ALTER TABLE public.rejected_bcu_snapshots
  ADD CONSTRAINT rejected_bcu_snapshots_reviewed_payload_sha256_check CHECK (
    reviewed_payload_sha256 IS NULL
    OR reviewed_payload_sha256 ~ '^[0-9a-f]{64}$'
  );

-- =====================================================================
-- B. confirm_rejected_bcu_extraction_draft (transactional)
--
-- Trust boundary:
--   Node validates bcu_v1 + gates + hash.
--   RPC owns draft lock, ownership, idempotency, inserts, draft update.
--   RPC derives ci/storage/file meta from locked draft; fixes source=llm_assisted.
--   RPC does NOT accept p_storage_path / p_source / alternate CI via snapshot blob.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.confirm_rejected_bcu_extraction_draft(
  p_draft_id uuid,
  p_ci bigint,
  p_consulted_on date,
  p_created_by uuid,
  p_period_label text,
  p_currency_view_selected text,
  p_extraction_contract_version text,
  p_document_ci_raw text,
  p_summary jsonb,
  p_summary_validation_status text,
  p_summary_validation jsonb,
  p_reviewed_payload_sha256 text,
  p_institutions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_draft public.rejected_bcu_extraction_drafts%ROWTYPE;
  v_snapshot public.rejected_bcu_snapshots%ROWTYPE;
  v_institutions jsonb;
  v_inst jsonb;
  v_i integer;
  v_n integer;
BEGIN
  IF p_draft_id IS NULL OR p_ci IS NULL THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
  INTO v_draft
  FROM public.rejected_bcu_extraction_drafts
  WHERE id = p_draft_id
    AND ci = p_ci
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent path: already confirmed → zero writes
  IF v_draft.status = 'confirmed' THEN
    IF v_draft.confirmed_snapshot_id IS NULL THEN
      RAISE EXCEPTION 'CONFIRMED_WITHOUT_SNAPSHOT'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT *
    INTO v_snapshot
    FROM public.rejected_bcu_snapshots
    WHERE id = v_draft.confirmed_snapshot_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CONFIRMED_SNAPSHOT_MISSING'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(
      jsonb_agg(to_jsonb(i) ORDER BY i.sort_order, i.created_at, i.id),
      '[]'::jsonb
    )
    INTO v_institutions
    FROM public.rejected_bcu_institutions i
    WHERE i.snapshot_id = v_snapshot.id;

    RETURN jsonb_build_object(
      'already_confirmed', true,
      'draft_id', v_draft.id,
      'confirmed_snapshot_id', v_draft.confirmed_snapshot_id,
      'confirmed_at', v_draft.confirmed_at,
      'reviewed_payload_sha256', v_draft.reviewed_payload_sha256,
      'draft', to_jsonb(v_draft),
      'snapshot', to_jsonb(v_snapshot),
      'institutions', v_institutions
    );
  END IF;

  IF v_draft.status IS DISTINCT FROM 'pending_review' THEN
    RAISE EXCEPTION 'DRAFT_NOT_PENDING'
      USING ERRCODE = 'P0001';
  END IF;

  -- Defensive checks (Node is primary validator)
  IF v_draft.storage_path IS NULL OR btrim(v_draft.storage_path) = '' THEN
    RAISE EXCEPTION 'DRAFT_STORAGE_MISSING'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_consulted_on IS NULL THEN
    RAISE EXCEPTION 'CONSULTED_ON_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_period_label IS NULL OR btrim(p_period_label) = '' THEN
    RAISE EXCEPTION 'PERIOD_LABEL_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_reviewed_payload_sha256 IS NULL
     OR p_reviewed_payload_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'REVIEWED_HASH_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_summary_validation_status IS NULL
     OR p_summary_validation_status NOT IN ('MATCH', 'MISMATCH', 'NOT_COMPARABLE') THEN
    RAISE EXCEPTION 'SUMMARY_VALIDATION_STATUS_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_institutions IS NULL OR jsonb_typeof(p_institutions) <> 'array' THEN
    RAISE EXCEPTION 'INSTITUTIONS_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  v_n := jsonb_array_length(p_institutions);
  IF v_n < 1 THEN
    RAISE EXCEPTION 'INSTITUTIONS_EMPTY'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.rejected_bcu_snapshots (
    ci,
    period_label,
    consulted_on,
    source,
    storage_path,
    original_filename,
    content_type,
    file_size_bytes,
    created_by,
    currency_view_selected,
    extraction_contract_version,
    document_ci_raw,
    summary,
    summary_validation_status,
    summary_validation,
    reviewed_payload_sha256
  )
  VALUES (
    v_draft.ci,
    p_period_label,
    p_consulted_on,
    'llm_assisted',
    v_draft.storage_path,
    v_draft.original_filename,
    v_draft.content_type,
    v_draft.file_size_bytes,
    p_created_by,
    p_currency_view_selected,
    p_extraction_contract_version,
    p_document_ci_raw,
    p_summary,
    p_summary_validation_status,
    p_summary_validation,
    p_reviewed_payload_sha256
  )
  RETURNING * INTO v_snapshot;

  FOR v_i IN 0 .. (v_n - 1) LOOP
    v_inst := p_institutions -> v_i;

    IF v_inst IS NULL OR jsonb_typeof(v_inst) <> 'object' THEN
      RAISE EXCEPTION 'INSTITUTION_ROW_INVALID'
        USING ERRCODE = 'P0001';
    END IF;

    IF COALESCE(btrim(v_inst->>'institution_name'), '') = '' THEN
      RAISE EXCEPTION 'INSTITUTION_NAME_REQUIRED'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_inst->>'category' IS NULL THEN
      RAISE EXCEPTION 'INSTITUTION_CATEGORY_REQUIRED'
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.rejected_bcu_institutions (
      snapshot_id,
      institution_name,
      category,
      vigente_mn,
      vigente_me,
      vigente_no_autoliquidable_mn,
      vigente_no_autoliquidable_me,
      moroso_mn,
      moroso_me,
      castigado_mn,
      castigado_me,
      contingencias_mn,
      contingencias_me,
      creditos_reestructurados_mn,
      creditos_reestructurados_me,
      sort_order
    )
    VALUES (
      v_snapshot.id,
      btrim(v_inst->>'institution_name'),
      v_inst->>'category',
      NULLIF(v_inst->>'vigente_mn', '')::numeric,
      NULLIF(v_inst->>'vigente_me', '')::numeric,
      NULLIF(v_inst->>'vigente_no_autoliquidable_mn', '')::numeric,
      NULLIF(v_inst->>'vigente_no_autoliquidable_me', '')::numeric,
      NULLIF(v_inst->>'moroso_mn', '')::numeric,
      NULLIF(v_inst->>'moroso_me', '')::numeric,
      NULLIF(v_inst->>'castigado_mn', '')::numeric,
      NULLIF(v_inst->>'castigado_me', '')::numeric,
      NULLIF(v_inst->>'contingencias_mn', '')::numeric,
      NULLIF(v_inst->>'contingencias_me', '')::numeric,
      NULLIF(v_inst->>'creditos_reestructurados_mn', '')::numeric,
      NULLIF(v_inst->>'creditos_reestructurados_me', '')::numeric,
      COALESCE((v_inst->>'sort_order')::integer, v_i)
    );
  END LOOP;

  UPDATE public.rejected_bcu_extraction_drafts
  SET
    status = 'confirmed',
    confirmed_snapshot_id = v_snapshot.id,
    confirmed_at = now(),
    reviewed_payload_sha256 = p_reviewed_payload_sha256,
    attempt_id = NULL,
    lease_expires_at = NULL,
    updated_at = now()
  WHERE id = v_draft.id
  RETURNING * INTO v_draft;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(i) ORDER BY i.sort_order, i.created_at, i.id),
    '[]'::jsonb
  )
  INTO v_institutions
  FROM public.rejected_bcu_institutions i
  WHERE i.snapshot_id = v_snapshot.id;

  RETURN jsonb_build_object(
    'already_confirmed', false,
    'draft_id', v_draft.id,
    'confirmed_snapshot_id', v_snapshot.id,
    'confirmed_at', v_draft.confirmed_at,
    'reviewed_payload_sha256', v_draft.reviewed_payload_sha256,
    'draft', to_jsonb(v_draft),
    'snapshot', to_jsonb(v_snapshot),
    'institutions', v_institutions
  );
END;
$$;

COMMENT ON FUNCTION public.confirm_rejected_bcu_extraction_draft(
  uuid, bigint, date, uuid, text, text, text, text, jsonb, text, jsonb, text, jsonb
) IS
  'Stage 4: atomically confirm a pending_review BCU extraction draft into snapshot+institutions. Idempotent when already confirmed.';

COMMIT;
