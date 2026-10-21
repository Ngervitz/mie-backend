-- Affiliate attribution persist (stage 4b). Apply manually after
-- 20261021_affiliate_attributions.sql. Do not run from the app.
-- One transaction writes attributions, then originators, then last_evaluated_at.
-- Does not encode attribution rules. prize_eligible must be false.
--
-- ci is bigint on cz_funnel_solicitudes, affiliate_attributions and
-- affiliate_originators. p_ci_scope uses that type.
--
-- Idempotent CREATE OR REPLACE / CREATE TABLE IF NOT EXISTS. No seed rows.

BEGIN;

CREATE TABLE IF NOT EXISTS public.affiliate_ci_evaluations (
  ci bigint PRIMARY KEY,
  last_evaluated_at timestamptz NOT NULL
);

COMMENT ON TABLE public.affiliate_ci_evaluations IS
  'Latest successful evaluation instant per cédula. Kept when the cédula has no originator, so an older plan cannot overwrite a later one.';

COMMENT ON COLUMN public.affiliate_ci_evaluations.ci IS
  'Same bigint as affiliate_attributions.ci and affiliate_originators.ci.';

ALTER TABLE public.affiliate_ci_evaluations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.affiliate_ci_evaluations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.affiliate_ci_evaluations TO service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.affiliate_ci_evaluations FROM service_role;

CREATE OR REPLACE FUNCTION public.persist_affiliate_plan(
  p_evaluated_at timestamptz,
  p_ci_scope bigint[],
  p_attributions jsonb,
  p_originators jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_attr jsonb;
  v_orig jsonb;
  v_ci bigint;
  v_cz bigint;
  v_last timestamptz;
  v_row_at timestamptz;
  v_same boolean;
  v_scope bigint[] := ARRAY[]::bigint[];
  v_write bigint[] := ARRAY[]::bigint[];
  v_skipped bigint[] := ARRAY[]::bigint[];
  v_idempotent bigint[] := ARRAY[]::bigint[];
  v_write_cz bigint[] := ARRAY[]::bigint[];
  v_skipped_cz bigint[] := ARRAY[]::bigint[];
  v_attr_count integer := 0;
  v_orig_count integer := 0;
BEGIN
  IF p_evaluated_at IS NULL THEN
    RAISE EXCEPTION 'EVALUATED_AT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_attributions IS NULL OR jsonb_typeof(p_attributions) <> 'array' THEN
    RAISE EXCEPTION 'ATTRIBUTIONS_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_originators IS NULL OR jsonb_typeof(p_originators) <> 'array' THEN
    RAISE EXCEPTION 'ORIGINATORS_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(array_agg(s.ci ORDER BY s.ci), ARRAY[]::bigint[])
  INTO v_scope
  FROM (
    SELECT DISTINCT x AS ci
    FROM unnest(coalesce(p_ci_scope, ARRAY[]::bigint[])) AS x
    WHERE x IS NOT NULL
  ) s;

  FOR v_attr IN SELECT value FROM jsonb_array_elements(p_attributions) LOOP
    IF jsonb_typeof(v_attr) <> 'object' THEN
      RAISE EXCEPTION 'ATTRIBUTION_SHAPE' USING ERRCODE = 'P0001';
    END IF;
    IF v_attr->>'cz_id' IS NULL OR btrim(v_attr->>'cz_id') = '' THEN
      RAISE EXCEPTION 'ATTRIBUTION_CZ_ID_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    IF v_attr->>'outcome' IS NULL OR btrim(v_attr->>'outcome') = '' THEN
      RAISE EXCEPTION 'ATTRIBUTION_OUTCOME_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(v_attr->'prize_eligible') IS DISTINCT FROM 'boolean'
       OR (v_attr->>'prize_eligible')::boolean IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'PRIZE_ELIGIBLE_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(v_attr->'is_test') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'IS_TEST_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    v_cz := (v_attr->>'cz_id')::bigint;
    IF jsonb_typeof(v_attr->'ci') = 'number' THEN
      v_ci := (v_attr->>'ci')::bigint;
      IF NOT v_ci = ANY(v_scope) THEN
        RAISE EXCEPTION 'ATTRIBUTION_CI_OUTSIDE_SCOPE' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_attr->'ci' IS NOT NULL AND jsonb_typeof(v_attr->'ci') <> 'null' THEN
      RAISE EXCEPTION 'ATTRIBUTION_CI_TYPE' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF (
    SELECT count(*) FROM jsonb_array_elements(p_attributions)
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT (value->>'cz_id')::bigint)
    FROM jsonb_array_elements(p_attributions)
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_CZ_ID' USING ERRCODE = 'P0001';
  END IF;

  FOR v_orig IN SELECT value FROM jsonb_array_elements(p_originators) LOOP
    IF jsonb_typeof(v_orig) <> 'object' THEN
      RAISE EXCEPTION 'ORIGINATOR_SHAPE' USING ERRCODE = 'P0001';
    END IF;
    IF v_orig->>'ci' IS NULL OR v_orig->>'affiliate_id' IS NULL
       OR v_orig->>'first_cz_id' IS NULL
       OR v_orig->>'first_presentation_at' IS NULL
       OR btrim(v_orig->>'first_presentation_at') = '' THEN
      RAISE EXCEPTION 'ORIGINATOR_FIELDS_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(v_orig->'prize_eligible') IS DISTINCT FROM 'boolean'
       OR (v_orig->>'prize_eligible')::boolean IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'PRIZE_ELIGIBLE_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(v_orig->'is_test') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'IS_TEST_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    v_ci := (v_orig->>'ci')::bigint;
    IF NOT v_ci = ANY(v_scope) THEN
      RAISE EXCEPTION 'ORIGINATOR_CI_OUTSIDE_SCOPE' USING ERRCODE = 'P0001';
    END IF;
    v_cz := (v_orig->>'first_cz_id')::bigint;
    v_last := (v_orig->>'first_presentation_at')::timestamptz;
    IF v_cz IS NULL OR v_last IS NULL OR (v_orig->>'affiliate_id')::uuid IS NULL THEN
      RAISE EXCEPTION 'ORIGINATOR_FIELDS_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF (
    SELECT count(*) FROM jsonb_array_elements(p_originators)
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT (value->>'ci')::bigint)
    FROM jsonb_array_elements(p_originators)
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_ORIGINATOR_CI' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_ci IN ARRAY v_scope LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('affiliate_ci_eval:' || v_ci::text, 0));
  END LOOP;

  FOR v_cz IN
    SELECT (value->>'cz_id')::bigint
    FROM jsonb_array_elements(p_attributions)
    WHERE value->'ci' IS NULL OR jsonb_typeof(value->'ci') = 'null'
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('affiliate_cz_eval:' || v_cz::text, 0));
  END LOOP;

  FOREACH v_ci IN ARRAY v_scope LOOP
    v_last := NULL;
    SELECT e.last_evaluated_at
    INTO v_last
    FROM public.affiliate_ci_evaluations e
    WHERE e.ci = v_ci
    FOR UPDATE;

    IF v_last IS NOT NULL AND p_evaluated_at < v_last THEN
      v_skipped := array_append(v_skipped, v_ci);
      CONTINUE;
    END IF;

    IF v_last IS NOT NULL AND p_evaluated_at = v_last THEN
      v_same := false;
      WITH payload AS (
        SELECT
          (a->>'cz_id')::bigint AS cz_id,
          a->>'outcome' AS outcome,
          NULLIF(btrim(a->>'click_id'), '')::uuid AS click_id,
          NULLIF(btrim(a->>'affiliate_id'), '')::uuid AS affiliate_id,
          NULLIF(btrim(a->>'occurred_at'), '')::timestamptz AS occurred_at,
          NULLIF(btrim(a->>'presentation_at'), '')::timestamptz AS presentation_at,
          a->>'presentation_text' AS presentation_text,
          (a->>'is_test')::boolean AS is_test,
          false AS prize_eligible
        FROM jsonb_array_elements(p_attributions) a
        WHERE jsonb_typeof(a->'ci') = 'number'
          AND (a->>'ci')::bigint = v_ci
      ),
      stored AS (
        SELECT
          cz_id, outcome, click_id, affiliate_id, occurred_at, presentation_at,
          presentation_text, is_test, prize_eligible
        FROM public.affiliate_attributions
        WHERE ci = v_ci
      ),
      payload_origin AS (
        SELECT
          (x->>'affiliate_id')::uuid AS affiliate_id,
          (x->>'first_cz_id')::bigint AS first_cz_id,
          (x->>'first_presentation_at')::timestamptz AS first_presentation_at,
          (x->>'is_test')::boolean AS is_test,
          false AS prize_eligible
        FROM jsonb_array_elements(p_originators) x
        WHERE (x->>'ci')::bigint = v_ci
      ),
      stored_origin AS (
        SELECT affiliate_id, first_cz_id, first_presentation_at, is_test, prize_eligible
        FROM public.affiliate_originators
        WHERE ci = v_ci
      )
      SELECT
        (SELECT count(*) FROM payload) = (SELECT count(*) FROM stored)
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT * FROM payload EXCEPT SELECT * FROM stored) d
        )
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT * FROM stored EXCEPT SELECT * FROM payload) d
        )
        AND (SELECT count(*) FROM payload_origin) = (SELECT count(*) FROM stored_origin)
        AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT * FROM payload_origin EXCEPT SELECT * FROM stored_origin
          ) d
        )
        AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT * FROM stored_origin EXCEPT SELECT * FROM payload_origin
          ) d
        )
      INTO v_same;

      IF v_same THEN
        v_idempotent := array_append(v_idempotent, v_ci);
      ELSE
        v_skipped := array_append(v_skipped, v_ci);
      END IF;
      CONTINUE;
    END IF;

    v_write := array_append(v_write, v_ci);
  END LOOP;

  FOR v_attr IN
    SELECT value
    FROM jsonb_array_elements(p_attributions)
    WHERE value->'ci' IS NULL OR jsonb_typeof(value->'ci') = 'null'
    ORDER BY (value->>'cz_id')::bigint
  LOOP
    v_cz := (v_attr->>'cz_id')::bigint;
    v_row_at := NULL;
    SELECT a.evaluated_at
    INTO v_row_at
    FROM public.affiliate_attributions a
    WHERE a.cz_id = v_cz
    FOR UPDATE;

    IF v_row_at IS NOT NULL AND p_evaluated_at < v_row_at THEN
      v_skipped_cz := array_append(v_skipped_cz, v_cz);
      CONTINUE;
    END IF;

    IF v_row_at IS NOT NULL AND p_evaluated_at = v_row_at THEN
      v_same := false;
      SELECT
        outcome IS NOT DISTINCT FROM (v_attr->>'outcome')
        AND click_id IS NOT DISTINCT FROM NULLIF(btrim(v_attr->>'click_id'), '')::uuid
        AND affiliate_id IS NOT DISTINCT FROM NULLIF(btrim(v_attr->>'affiliate_id'), '')::uuid
        AND occurred_at IS NOT DISTINCT FROM NULLIF(btrim(v_attr->>'occurred_at'), '')::timestamptz
        AND presentation_at IS NOT DISTINCT FROM NULLIF(btrim(v_attr->>'presentation_at'), '')::timestamptz
        AND presentation_text IS NOT DISTINCT FROM (v_attr->>'presentation_text')
        AND is_test IS NOT DISTINCT FROM (v_attr->>'is_test')::boolean
        AND prize_eligible IS NOT DISTINCT FROM false
        AND ci IS NULL
      INTO v_same
      FROM public.affiliate_attributions
      WHERE cz_id = v_cz;

      IF NOT coalesce(v_same, false) THEN
        v_skipped_cz := array_append(v_skipped_cz, v_cz);
      END IF;
      CONTINUE;
    END IF;

    v_write_cz := array_append(v_write_cz, v_cz);
  END LOOP;

  INSERT INTO public.affiliate_attributions (
    cz_id, ci, outcome, click_id, affiliate_id, occurred_at, presentation_at,
    presentation_text, is_test, prize_eligible, evaluated_at
  )
  SELECT
    (a->>'cz_id')::bigint,
    CASE
      WHEN jsonb_typeof(a->'ci') = 'number' THEN (a->>'ci')::bigint
      ELSE NULL
    END,
    a->>'outcome',
    NULLIF(btrim(a->>'click_id'), '')::uuid,
    NULLIF(btrim(a->>'affiliate_id'), '')::uuid,
    NULLIF(btrim(a->>'occurred_at'), '')::timestamptz,
    NULLIF(btrim(a->>'presentation_at'), '')::timestamptz,
    a->>'presentation_text',
    (a->>'is_test')::boolean,
    false,
    p_evaluated_at
  FROM jsonb_array_elements(p_attributions) a
  WHERE (
    jsonb_typeof(a->'ci') = 'number'
    AND (a->>'ci')::bigint = ANY(v_write)
  ) OR (
    (a->'ci' IS NULL OR jsonb_typeof(a->'ci') = 'null')
    AND (a->>'cz_id')::bigint = ANY(v_write_cz)
  )
  ON CONFLICT (cz_id) DO UPDATE SET
    ci = EXCLUDED.ci,
    outcome = EXCLUDED.outcome,
    click_id = EXCLUDED.click_id,
    affiliate_id = EXCLUDED.affiliate_id,
    occurred_at = EXCLUDED.occurred_at,
    presentation_at = EXCLUDED.presentation_at,
    presentation_text = EXCLUDED.presentation_text,
    is_test = EXCLUDED.is_test,
    prize_eligible = false,
    evaluated_at = EXCLUDED.evaluated_at;
  GET DIAGNOSTICS v_attr_count = ROW_COUNT;

  DELETE FROM public.affiliate_originators o
  WHERE o.ci = ANY(v_write);

  INSERT INTO public.affiliate_originators (
    ci, affiliate_id, first_cz_id, first_presentation_at, is_test, prize_eligible, updated_at
  )
  SELECT
    (x->>'ci')::bigint,
    (x->>'affiliate_id')::uuid,
    (x->>'first_cz_id')::bigint,
    (x->>'first_presentation_at')::timestamptz,
    (x->>'is_test')::boolean,
    false,
    p_evaluated_at
  FROM jsonb_array_elements(p_originators) x
  WHERE (x->>'ci')::bigint = ANY(v_write);
  GET DIAGNOSTICS v_orig_count = ROW_COUNT;

  INSERT INTO public.affiliate_ci_evaluations (ci, last_evaluated_at)
  SELECT x, p_evaluated_at
  FROM unnest(v_write) AS x
  ON CONFLICT (ci) DO UPDATE
  SET last_evaluated_at = EXCLUDED.last_evaluated_at
  WHERE public.affiliate_ci_evaluations.last_evaluated_at < EXCLUDED.last_evaluated_at;

  RETURN jsonb_build_object(
    'applied_ci', coalesce((
      SELECT to_jsonb(array_agg(s.ci ORDER BY s.ci))
      FROM (
        SELECT unnest(v_write) AS ci
        UNION
        SELECT unnest(v_idempotent) AS ci
      ) s
    ), '[]'::jsonb),
    'skipped_ci', coalesce((
      SELECT to_jsonb(array_agg(s.ci ORDER BY s.ci))
      FROM (SELECT unnest(v_skipped) AS ci) s
    ), '[]'::jsonb),
    'idempotent_ci', coalesce((
      SELECT to_jsonb(array_agg(s.ci ORDER BY s.ci))
      FROM (SELECT unnest(v_idempotent) AS ci) s
    ), '[]'::jsonb),
    'skipped_cz_id', coalesce((
      SELECT to_jsonb(array_agg(s.cz_id ORDER BY s.cz_id))
      FROM (SELECT unnest(v_skipped_cz) AS cz_id) s
    ), '[]'::jsonb),
    'attribution_count', v_attr_count,
    'originator_count', v_orig_count
  );
END;
$$;

COMMENT ON FUNCTION public.persist_affiliate_plan(timestamptz, bigint[], jsonb, jsonb) IS
  'Atomic affiliate plan persist. Attributions are written before originators. Advisory locks are taken per cédula in ascending ci order. An older p_evaluated_at skips that cédula. An equal timestamp replays only an identical plan and does not overwrite a different one. Any error rolls the call back.';

REVOKE ALL ON FUNCTION public.persist_affiliate_plan(timestamptz, bigint[], jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.persist_affiliate_plan(timestamptz, bigint[], jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_affiliate_plan(timestamptz, bigint[], jsonb, jsonb)
  TO service_role;

COMMIT;
