-- Align elm_ci_lock_try / elm_ci_lock_settle with evaluateCiGuard (closedInCz).
-- A prior process with persisted s1_status=unknown (or expired in_flight) must not block a new
-- send when provider_cz_state already projects CZ 3/16 for that solicitud.
-- Prod regression: CZ 3975 blocked by prior 1517 (unknown + Repetido, CZ closed 3).

CREATE OR REPLACE FUNCTION public.elm_ci_lock_try(
  p_ci bigint,
  p_cz_solicitud_id bigint,
  p_fallback_request_id uuid,
  p_trigger_origin text,
  p_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_month date := public.elm_month_key(COALESCE(p_at, now()));
  v_lock public.elm_ci_send_locks%ROWTYPE;
  v_related bigint;
BEGIN
  IF p_ci IS NULL OR p_ci <= 0 OR p_cz_solicitud_id IS NULL OR p_cz_solicitud_id <= 0
     OR p_trigger_origin IS NULL THEN
    RAISE EXCEPTION 'elm_ci_lock_invalid_args';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('elm_ci_send_lock:' || p_ci::text, 0));

  SELECT * INTO v_lock FROM public.elm_ci_send_locks
  WHERE cz_solicitud_id = p_cz_solicitud_id AND state IN ('reserved', 'consumed');
  IF FOUND THEN
    IF v_lock.ci <> p_ci THEN
      RAISE EXCEPTION 'elm_ci_lock_ci_mismatch';
    END IF;
    RETURN jsonb_build_object('status', 'held', 'lock_id', v_lock.id, 'state', v_lock.state,
                              'month_key', v_lock.month_key);
  END IF;

  -- active_referral
  SELECT l.cz_solicitud_id INTO v_related FROM public.elm_ci_send_locks l
  WHERE l.ci = p_ci AND l.block_reason = 'active_referral'
  ORDER BY l.reserved_at LIMIT 1;
  IF v_related IS NULL THEN
    SELECT p.cz_solicitud_id INTO v_related FROM public.elm_lead_processes p
    WHERE p.ci = p_ci AND p.cz_solicitud_id <> p_cz_solicitud_id
      AND p.s2_status = 'referred' AND p.ops_resolved_at IS NULL AND p.disbursed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.provider_cz_state s
                      WHERE s.cz_solicitud_id = p.cz_solicitud_id AND s.projected_estado IN (3, 16))
    ORDER BY p.cz_solicitud_id LIMIT 1;
  END IF;
  IF v_related IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'active_referral', 'related_cz_solicitud_id', v_related);
  END IF;

  -- uncertain
  SELECT l.cz_solicitud_id INTO v_related FROM public.elm_ci_send_locks l
  LEFT JOIN public.provider_fallback_requests f ON f.id = l.fallback_request_id
  WHERE l.ci = p_ci
    AND (l.block_reason = 'uncertain_referral' OR (l.state = 'reserved' AND f.outcome <> 'pending'))
    AND NOT EXISTS (
      SELECT 1 FROM public.provider_cz_state s
      WHERE s.cz_solicitud_id = l.cz_solicitud_id AND s.projected_estado IN (3, 16)
    )
  ORDER BY l.reserved_at LIMIT 1;
  IF v_related IS NULL THEN
    SELECT p.cz_solicitud_id INTO v_related FROM public.elm_lead_processes p
    WHERE p.ci = p_ci AND p.cz_solicitud_id <> p_cz_solicitud_id AND p.ops_resolved_at IS NULL
      AND (
        (p.s1_status = 'unknown'
         AND NOT EXISTS (SELECT 1 FROM public.provider_cz_state s
                         WHERE s.cz_solicitud_id = p.cz_solicitud_id AND s.projected_estado IN (3, 16)))
        OR (p.s1_status = 'in_flight' AND p.s1_lease_expires_at < now()
            AND NOT EXISTS (SELECT 1 FROM public.provider_cz_state s
                            WHERE s.cz_solicitud_id = p.cz_solicitud_id AND s.projected_estado IN (3, 16)))
        OR ((p.s2_status = 'unknown' OR (p.s2_status = 'in_flight' AND p.s2_lease_expires_at < now()))
            AND p.disbursed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM public.provider_cz_state s
                            WHERE s.cz_solicitud_id = p.cz_solicitud_id AND s.projected_estado IN (3, 16)))
      )
    ORDER BY p.cz_solicitud_id LIMIT 1;
  END IF;
  IF v_related IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'uncertain', 'related_cz_solicitud_id', v_related);
  END IF;

  -- send_in_progress
  SELECT l.cz_solicitud_id INTO v_related FROM public.elm_ci_send_locks l
  LEFT JOIN public.provider_fallback_requests f ON f.id = l.fallback_request_id
  WHERE l.ci = p_ci AND l.state = 'reserved' AND (f.id IS NULL OR f.outcome = 'pending')
  ORDER BY l.reserved_at LIMIT 1;
  IF v_related IS NULL THEN
    SELECT p.cz_solicitud_id INTO v_related FROM public.elm_lead_processes p
    WHERE p.ci = p_ci AND p.cz_solicitud_id <> p_cz_solicitud_id
      AND ((p.s1_status = 'in_flight' AND p.s1_lease_expires_at >= now())
           OR (p.s2_status = 'in_flight' AND p.s2_lease_expires_at >= now()))
    ORDER BY p.cz_solicitud_id LIMIT 1;
  END IF;
  IF v_related IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'send_in_progress', 'related_cz_solicitud_id', v_related);
  END IF;

  -- monthly_quota_used
  SELECT l.cz_solicitud_id INTO v_related FROM public.elm_ci_send_locks l
  WHERE l.ci = p_ci AND l.state = 'consumed' AND l.month_key = v_month
  ORDER BY l.reserved_at LIMIT 1;
  IF v_related IS NULL THEN
    SELECT p.cz_solicitud_id INTO v_related FROM public.elm_lead_processes p
    WHERE p.ci = p_ci AND p.cz_solicitud_id <> p_cz_solicitud_id
      AND p.s1_started_at IS NOT NULL AND public.elm_month_key(p.s1_started_at) = v_month
      AND public.elm_process_reception(p) = 'received'
      AND NOT EXISTS (SELECT 1 FROM public.elm_ci_send_locks x
                      WHERE x.cz_solicitud_id = p.cz_solicitud_id AND x.state IN ('reserved', 'consumed'))
    ORDER BY p.cz_solicitud_id LIMIT 1;
  END IF;
  IF v_related IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'monthly_quota_used', 'related_cz_solicitud_id', v_related,
                              'month_key', v_month);
  END IF;

  INSERT INTO public.elm_ci_send_locks (ci, month_key, cz_solicitud_id, fallback_request_id, trigger_origin)
  VALUES (p_ci, v_month, p_cz_solicitud_id, p_fallback_request_id, p_trigger_origin)
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_lock;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'blocked', 'block', 'send_in_progress', 'related_cz_solicitud_id', NULL,
                              'detail', 'lock_conflict');
  END IF;
  RETURN jsonb_build_object('status', 'acquired', 'lock_id', v_lock.id, 'state', v_lock.state,
                            'month_key', v_lock.month_key);
END;
$$;

COMMENT ON FUNCTION public.elm_ci_lock_try(bigint, bigint, uuid, text, timestamptz) IS
  'Monthly CI send lock. uncertain: ignore S1 unknown / expired in_flight when CZ projected 3/16 (matches evaluateCiGuard closedInCz).';

-- Settle: S1 unknown leaves reception "uncertain" but CZ 3/16 must consume the month lock (free ci_active index).
CREATE OR REPLACE FUNCTION public.elm_ci_lock_settle(p_cz_solicitud_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lock public.elm_ci_send_locks%ROWTYPE;
  v_req public.provider_fallback_requests%ROWTYPE;
  v_state public.provider_cz_state%ROWTYPE;
  v_proc public.elm_lead_processes%ROWTYPE;
  v_rec text;
  v_target text;
  v_block text;
  v_reason text;
BEGIN
  SELECT * INTO v_lock FROM public.elm_ci_send_locks
  WHERE cz_solicitud_id = p_cz_solicitud_id AND state IN ('reserved', 'consumed');
  IF NOT FOUND THEN
    RETURN 'no_lock';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('elm_ci_send_lock:' || v_lock.ci::text, 0));
  SELECT * INTO v_lock FROM public.elm_ci_send_locks WHERE id = v_lock.id FOR UPDATE;
  IF v_lock.state = 'released' THEN
    RETURN 'unchanged';
  END IF;
  IF v_lock.fallback_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM public.provider_fallback_requests WHERE id = v_lock.fallback_request_id;
    IF v_req.outcome = 'pending' THEN
      RETURN 'request_open';
    END IF;
  END IF;
  SELECT * INTO v_state FROM public.provider_cz_state WHERE cz_solicitud_id = p_cz_solicitud_id;
  SELECT * INTO v_proc FROM public.elm_lead_processes WHERE cz_solicitud_id = p_cz_solicitud_id;
  v_rec := public.elm_process_reception(v_proc);

  IF v_lock.fallback_request_id IS NULL AND v_lock.state = 'reserved' AND v_proc.ops_resolved_at IS NULL
     AND (v_rec = 'in_progress' OR (v_proc.s1_status = 'eligible' AND v_proc.s2_status IN ('not_started', 'in_flight'))) THEN
    UPDATE public.elm_ci_send_locks SET last_checked_at = now() WHERE id = v_lock.id;
    RETURN 'kept_reserved';
  END IF;

  IF v_proc.disbursed_at IS NOT NULL OR v_state.projected_estado = 16 THEN
    v_target := 'consumed';
    v_block := NULL;
    v_reason := 'granted_elm';
  ELSIF v_rec IN ('in_progress', 'uncertain') THEN
    IF v_state.projected_estado IN (3, 16) THEN
      v_target := 'consumed';
      v_reason := 'received';
      v_block := NULL;
    ELSE
      UPDATE public.elm_ci_send_locks SET last_checked_at = now() WHERE id = v_lock.id;
      RETURN 'kept_reserved';
    END IF;
  ELSIF v_rec = 'none' THEN
    v_target := 'released';
    v_block := NULL;
    v_reason := 'not_received';
  ELSE
    v_target := 'consumed';
    v_reason := 'received';
    IF v_proc.ops_resolved_at IS NOT NULL OR v_state.projected_estado = 3 THEN
      v_block := NULL;
    ELSIF v_state.projected_estado = 13 OR v_proc.s2_status = 'referred' THEN
      v_block := 'active_referral';
    ELSIF v_proc.s2_status IN ('unknown', 'in_flight') THEN
      v_block := 'uncertain_referral';
    ELSE
      v_block := NULL;
    END IF;
  END IF;

  IF v_lock.state = 'consumed' AND v_target = 'released' THEN
    v_target := 'consumed';
    v_block := NULL;
    v_reason := 'confirmed_not_received_after_consume';
  END IF;

  IF v_lock.state = v_target AND v_lock.block_reason IS NOT DISTINCT FROM v_block THEN
    UPDATE public.elm_ci_send_locks SET last_checked_at = now() WHERE id = v_lock.id;
    RETURN 'unchanged';
  END IF;

  BEGIN
    UPDATE public.elm_ci_send_locks
    SET state = v_target,
        consumed_at = CASE WHEN v_target = 'consumed' THEN COALESCE(consumed_at, now()) ELSE consumed_at END,
        released_at = CASE WHEN v_target = 'released' THEN now() ELSE NULL END,
        blocks_future = v_block IS NOT NULL,
        block_reason = v_block,
        settle_reason = v_reason,
        last_checked_at = now()
    WHERE id = v_lock.id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.elm_ci_send_locks
    SET state = 'consumed',
        consumed_at = COALESCE(consumed_at, now()),
        released_at = NULL,
        blocks_future = false,
        block_reason = NULL,
        settle_reason = 'block_overlap',
        last_checked_at = now()
    WHERE id = v_lock.id;
    PERFORM public.provider_cz_record_conflict(
      p_cz_solicitud_id, v_lock.ci, 'ci_lock_overlap', v_state.projected_estado, NULL, NULL,
      'ci_lock_overlap:' || v_lock.id::text || ':' || COALESCE(v_block, '-'),
      jsonb_build_object('wanted_block', v_block, 'lock_id', v_lock.id)
    );
    RETURN 'conflict';
  END;
  RETURN v_target;
END;
$$;