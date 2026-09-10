-- Rechazados BCU Stage 6D.7: optional file_sha256 on snapshots for HTML source evidence.
-- Apply manually AFTER 20260909_rechazados_bcu_html_direct_persistence.sql.
-- DO NOT apply automatically from agents until reviewed.
--
-- Does NOT change ops/CDV rules.
-- Does NOT alter image/PDF upload validation paths in the app.
-- Adds nullable file_sha256 so sanitized HTML source bytes can be audited.
-- Extends persist_rejected_bcu_observation with optional p_file_sha256.
--
-- Bucket note (NOT applied by this SQL):
--   Private bucket rejected-bcu-files must accept application/octet-stream
--   for opaque .bcuhtml source evidence. Do NOT allow text/html uploads.

BEGIN;

ALTER TABLE public.rejected_bcu_snapshots
  ADD COLUMN IF NOT EXISTS file_sha256 text NULL;

COMMENT ON COLUMN public.rejected_bcu_snapshots.file_sha256 IS
  'SHA-256 hex of stored private source bytes (sanitized HTML for html_import). NULL for historical rows without source evidence hash.';

ALTER TABLE public.rejected_bcu_snapshots
  DROP CONSTRAINT IF EXISTS rejected_bcu_snapshots_file_sha256_check;

ALTER TABLE public.rejected_bcu_snapshots
  ADD CONSTRAINT rejected_bcu_snapshots_file_sha256_check CHECK (
    file_sha256 IS NULL
    OR file_sha256 ~ '^[0-9a-f]{64}$'
  );

-- Drop prior overload (18 args) then recreate with optional p_file_sha256.
DROP FUNCTION IF EXISTS public.persist_rejected_bcu_observation(
  bigint, text, date, text, uuid, text, text, text, jsonb, text, jsonb, text, jsonb,
  text, text, text, integer, uuid
);

CREATE OR REPLACE FUNCTION public.persist_rejected_bcu_observation(
  p_ci bigint,
  p_period_label text,
  p_consulted_on date,
  p_source text,
  p_created_by uuid,
  p_currency_view_selected text,
  p_extraction_contract_version text,
  p_document_ci_raw text,
  p_summary jsonb,
  p_summary_validation_status text,
  p_summary_validation jsonb,
  p_reviewed_payload_sha256 text,
  p_institutions jsonb,
  p_storage_path text DEFAULT NULL,
  p_original_filename text DEFAULT NULL,
  p_content_type text DEFAULT NULL,
  p_file_size_bytes integer DEFAULT NULL,
  p_draft_id uuid DEFAULT NULL,
  p_file_sha256 text DEFAULT NULL
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
  v_storage_path text;
  v_original_filename text;
  v_content_type text;
  v_file_size_bytes integer;
  v_file_sha256 text;
  v_ci bigint;
BEGIN
  IF p_ci IS NULL THEN
    RAISE EXCEPTION 'CI_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_source IS NULL
     OR p_source NOT IN ('manual', 'llm_assisted', 'html_import') THEN
    RAISE EXCEPTION 'SOURCE_INVALID'
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

  IF p_file_sha256 IS NOT NULL
     AND p_file_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'FILE_SHA256_INVALID'
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

  v_ci := p_ci;
  v_storage_path := p_storage_path;
  v_original_filename := p_original_filename;
  v_content_type := p_content_type;
  v_file_size_bytes := p_file_size_bytes;
  v_file_sha256 := p_file_sha256;

  -- Optional draft path (Stage 4)
  IF p_draft_id IS NOT NULL THEN
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

    -- Idempotent: already confirmed → zero writes
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

    -- Stage 4: file/storage always from locked draft (ignore caller file meta).
    v_ci := v_draft.ci;
    v_storage_path := v_draft.storage_path;
    v_original_filename := v_draft.original_filename;
    v_content_type := v_draft.content_type;
    v_file_size_bytes := v_draft.file_size_bytes;
    v_file_sha256 := v_draft.file_sha256;

    IF v_storage_path IS NULL OR btrim(v_storage_path) = '' THEN
      RAISE EXCEPTION 'DRAFT_STORAGE_MISSING'
        USING ERRCODE = 'P0001';
    END IF;

    -- Draft-backed confirms are always llm_assisted regardless of p_source.
    IF p_source IS DISTINCT FROM 'llm_assisted' THEN
      RAISE EXCEPTION 'SOURCE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
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
    file_sha256,
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
    v_ci,
    p_period_label,
    p_consulted_on,
    p_source,
    NULLIF(btrim(COALESCE(v_storage_path, '')), ''),
    v_original_filename,
    v_content_type,
    v_file_size_bytes,
    v_file_sha256,
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

  IF p_draft_id IS NOT NULL THEN
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
  END IF;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(i) ORDER BY i.sort_order, i.created_at, i.id),
    '[]'::jsonb
  )
  INTO v_institutions
  FROM public.rejected_bcu_institutions i
  WHERE i.snapshot_id = v_snapshot.id;

  RETURN jsonb_build_object(
    'already_confirmed', false,
    'draft_id', CASE WHEN p_draft_id IS NULL THEN NULL ELSE v_draft.id END,
    'confirmed_snapshot_id', v_snapshot.id,
    'confirmed_at', CASE WHEN p_draft_id IS NULL THEN NULL ELSE v_draft.confirmed_at END,
    'reviewed_payload_sha256', p_reviewed_payload_sha256,
    'draft', CASE WHEN p_draft_id IS NULL THEN NULL ELSE to_jsonb(v_draft) END,
    'snapshot', to_jsonb(v_snapshot),
    'institutions', v_institutions
  );
END;
$$;

COMMENT ON FUNCTION public.persist_rejected_bcu_observation(
  bigint, text, date, text, uuid, text, text, text, jsonb, text, jsonb, text, jsonb,
  text, text, text, integer, uuid, text
) IS
  'Stage 6D.7: atomically persist BCU observation (snapshot+institutions). Optional p_file_sha256 for sanitized source evidence. Optional draft_id updates Stage 4 draft. source must be manual|llm_assisted|html_import.';

-- Keep Stage 4 wrapper signature unchanged (still omits p_file_sha256 → DEFAULT NULL;
-- draft path copies draft.file_sha256 into the snapshot).
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
BEGIN
  IF p_draft_id IS NULL OR p_ci IS NULL THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN public.persist_rejected_bcu_observation(
    p_ci,
    p_period_label,
    p_consulted_on,
    'llm_assisted',
    p_created_by,
    p_currency_view_selected,
    p_extraction_contract_version,
    p_document_ci_raw,
    p_summary,
    p_summary_validation_status,
    p_summary_validation,
    p_reviewed_payload_sha256,
    p_institutions,
    NULL,  -- storage from draft inside common RPC
    NULL,
    NULL,
    NULL,
    p_draft_id,
    NULL  -- file_sha256 from draft when present
  );
END;
$$;

COMMENT ON FUNCTION public.confirm_rejected_bcu_extraction_draft(
  uuid, bigint, date, uuid, text, text, text, text, jsonb, text, jsonb, text, jsonb
) IS
  'Stage 4 thin wrapper: confirms pending_review draft via persist_rejected_bcu_observation (source=llm_assisted). Idempotent when already confirmed.';

COMMIT;
