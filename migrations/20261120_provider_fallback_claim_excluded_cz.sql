-- Explicit backlog exclusion for provider_fallback_claim (ops triage 2026-11-19).
-- Excluded solicitudes are never claimed and do not block younger open jobs on the same CI.
-- Does not update excluded rows.

CREATE OR REPLACE FUNCTION public.provider_fallback_claim(
  p_worker_id text,
  p_lease_seconds integer,
  p_limit integer,
  p_cz_solicitud_id bigint DEFAULT NULL,
  p_excluded_cz_solicitud_ids bigint[] DEFAULT '{}'::bigint[]
)
RETURNS SETOF public.provider_fallback_requests
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 200 THEN
    RAISE EXCEPTION 'provider_fallback_invalid_worker_id';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'provider_fallback_invalid_lease_seconds';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'provider_fallback_invalid_limit';
  END IF;
  IF p_excluded_cz_solicitud_ids IS NULL THEN
    p_excluded_cz_solicitud_ids := '{}'::bigint[];
  END IF;

  RETURN QUERY
  WITH cand AS (
    SELECT r.id
    FROM public.provider_fallback_requests r
    WHERE (p_cz_solicitud_id IS NULL OR r.cz_solicitud_id = p_cz_solicitud_id)
      AND NOT (r.cz_solicitud_id = ANY(p_excluded_cz_solicitud_ids))
      AND (
        (r.exec_status = 'queued' AND r.run_after <= now())
        OR (r.exec_status = 'running' AND r.job_lease_expires_at < now())
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.provider_fallback_requests o
        WHERE o.ci = r.ci
          AND o.id <> r.id
          AND o.exec_status IN ('queued', 'running')
          AND NOT (o.cz_solicitud_id = ANY(p_excluded_cz_solicitud_ids))
          AND (o.created_at, o.cz_solicitud_id) < (r.created_at, r.cz_solicitud_id)
      )
    ORDER BY r.created_at, r.cz_solicitud_id
    LIMIT p_limit
    FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE public.provider_fallback_requests p
  SET
    exec_status = 'running',
    job_lease_owner = p_worker_id,
    job_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    claim_count = p.claim_count + 1,
    last_claimed_at = now()
  FROM cand
  WHERE p.id = cand.id
  RETURNING p.*;
END;
$$;

COMMENT ON FUNCTION public.provider_fallback_claim(text, integer, integer, bigint, bigint[]) IS
  'Atomic worker claim. p_excluded_cz_solicitud_ids: never claim; excluded rows do not block younger open jobs on the same CI.';

REVOKE ALL ON FUNCTION public.provider_fallback_claim(text, integer, integer, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_fallback_claim(text, integer, integer, bigint, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_claim(text, integer, integer, bigint, bigint[]) TO service_role;