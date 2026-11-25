-- Atomic parent-row upsert for cz_funnel_solicitudes (tip + full refresh concurrency).
-- Apply after profile/historico migrations. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.cz_funnel_parent_row_is_newer(
  p_existing_updated timestamptz,
  p_existing_parent_estado integer,
  p_existing_hist_max timestamptz,
  p_existing_hist_estado integer,
  p_incoming_updated timestamptz,
  p_incoming_parent_estado integer,
  p_incoming_hist_max timestamptz,
  p_incoming_hist_estado integer
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_incoming_updated IS NULL THEN
    RETURN true;
  END IF;
  IF p_existing_updated IS NULL THEN
    RETURN true;
  END IF;
  IF p_incoming_updated > p_existing_updated THEN
    RETURN true;
  END IF;
  IF p_incoming_updated < p_existing_updated THEN
    RETURN false;
  END IF;

  IF p_incoming_hist_max IS NOT NULL
     AND (p_existing_hist_max IS NULL OR p_incoming_hist_max > p_existing_hist_max) THEN
    RETURN true;
  END IF;

  IF p_incoming_hist_max IS NOT NULL
     AND p_existing_hist_max IS NOT NULL
     AND p_incoming_hist_max = p_existing_hist_max THEN
    IF p_incoming_hist_estado IS NOT NULL
       AND p_existing_hist_estado IS NOT NULL
       AND p_incoming_hist_estado < p_existing_hist_estado THEN
      RETURN false;
    END IF;
    IF p_incoming_hist_estado IS DISTINCT FROM p_existing_hist_estado THEN
      RETURN true;
    END IF;
  END IF;

  IF p_incoming_parent_estado IS NOT NULL
     AND p_existing_parent_estado IS NOT NULL
     AND p_incoming_parent_estado < p_existing_parent_estado THEN
    RETURN false;
  END IF;

  IF p_incoming_parent_estado IS DISTINCT FROM p_existing_parent_estado THEN
  RETURN true;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.cz_funnel_solicitud_hist_tip(p_cz_id bigint)
RETURNS TABLE(hist_max timestamptz, hist_estado integer)
LANGUAGE sql
STABLE
AS $$
  SELECT h.fechahora_src, h.solicitudes_estados_id
  FROM public.cz_funnel_solicitud_estados h
  WHERE h.cz_solicitud_id = p_cz_id
  ORDER BY h.fechahora_src DESC NULLS LAST, h.cz_historico_id DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.cz_funnel_upsert_solicitudes_guarded(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row jsonb;
  v_applied integer := 0;
  v_skipped integer := 0;
  v_cz_id bigint;
  v_existing public.cz_funnel_solicitudes%ROWTYPE;
  v_ex_hist_max timestamptz;
  v_ex_hist_estado integer;
  v_in_hist_max timestamptz;
  v_in_hist_estado integer;
  v_should boolean;
  v_row_count integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('applied', 0, 'skipped', 0);
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_cz_id := (v_row->>'cz_id')::bigint;
    IF v_cz_id IS NULL THEN
      CONTINUE;
    END IF;

    v_in_hist_max := NULLIF(v_row->>'incoming_hist_max', '')::timestamptz;
    v_in_hist_estado := NULLIF(v_row->>'incoming_hist_estado_id', '')::integer;

    SELECT * INTO v_existing
    FROM public.cz_funnel_solicitudes
    WHERE cz_id = v_cz_id
    FOR UPDATE;

    IF FOUND THEN
      SELECT t.hist_max, t.hist_estado
      INTO v_ex_hist_max, v_ex_hist_estado
      FROM public.cz_funnel_solicitud_hist_tip(v_cz_id) t;

      v_should := public.cz_funnel_parent_row_is_newer(
        v_existing.updated_at_src,
        v_existing.solicitudes_estados_id,
        v_ex_hist_max,
        v_ex_hist_estado,
        NULLIF(v_row->>'updated_at_src', '')::timestamptz,
        NULLIF(v_row->>'solicitudes_estados_id', '')::integer,
        v_in_hist_max,
        v_in_hist_estado
      );

      IF NOT v_should THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
    END IF;

    INSERT INTO public.cz_funnel_solicitudes (
      cz_id,
      solicitudes_estados_id,
      usuarios_id,
      ci,
      nombre,
      apellido,
      email,
      lrw_id,
      celular,
      salario,
      fecha_nacimiento,
      fecha_nacimiento_status,
      relacion_laboral,
      fecha_reg,
      updated_at_src,
      updated_raw,
      tracking_data_summary,
      synced_at
    )
    VALUES (
      v_cz_id,
      NULLIF(v_row->>'solicitudes_estados_id', '')::integer,
      NULLIF(v_row->>'usuarios_id', '')::integer,
      NULLIF(v_row->>'ci', '')::bigint,
      NULLIF(v_row->>'nombre', ''),
      NULLIF(v_row->>'apellido', ''),
      NULLIF(v_row->>'email', ''),
      NULLIF(v_row->>'lrw_id', ''),
      NULLIF(v_row->>'celular', ''),
      NULLIF(v_row->>'salario', '')::numeric,
      NULLIF(v_row->>'fecha_nacimiento', '')::date,
      NULLIF(v_row->>'fecha_nacimiento_status', ''),
      NULLIF(v_row->>'relacion_laboral', ''),
      NULLIF(v_row->>'fecha_reg', '')::timestamptz,
      NULLIF(v_row->>'updated_at_src', '')::timestamptz,
      NULLIF(v_row->>'updated_raw', ''),
      COALESCE(v_row->'tracking_data_summary', '{}'::jsonb),
      COALESCE(NULLIF(v_row->>'synced_at', '')::timestamptz, now())
    )
    ON CONFLICT (cz_id) DO UPDATE SET
      solicitudes_estados_id = EXCLUDED.solicitudes_estados_id,
      usuarios_id = EXCLUDED.usuarios_id,
      ci = EXCLUDED.ci,
      nombre = EXCLUDED.nombre,
      apellido = EXCLUDED.apellido,
      email = EXCLUDED.email,
      lrw_id = EXCLUDED.lrw_id,
      celular = EXCLUDED.celular,
      salario = EXCLUDED.salario,
      fecha_nacimiento = EXCLUDED.fecha_nacimiento,
      fecha_nacimiento_status = EXCLUDED.fecha_nacimiento_status,
      relacion_laboral = EXCLUDED.relacion_laboral,
      fecha_reg = EXCLUDED.fecha_reg,
      updated_at_src = EXCLUDED.updated_at_src,
      updated_raw = EXCLUDED.updated_raw,
      tracking_data_summary = EXCLUDED.tracking_data_summary,
      synced_at = EXCLUDED.synced_at
    WHERE public.cz_funnel_parent_row_is_newer(
      cz_funnel_solicitudes.updated_at_src,
      cz_funnel_solicitudes.solicitudes_estados_id,
      (SELECT hist_max FROM public.cz_funnel_solicitud_hist_tip(cz_funnel_solicitudes.cz_id)),
      (SELECT hist_estado FROM public.cz_funnel_solicitud_hist_tip(cz_funnel_solicitudes.cz_id)),
      EXCLUDED.updated_at_src,
      EXCLUDED.solicitudes_estados_id,
      v_in_hist_max,
      v_in_hist_estado
    );

    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    IF v_row_count > 0 THEN
      v_applied := v_applied + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.cz_funnel_upsert_solicitudes_guarded(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cz_funnel_upsert_solicitudes_guarded(jsonb) TO service_role;

COMMIT;