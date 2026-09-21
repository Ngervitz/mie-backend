-- Episode-scoped survey invites (rechazados_survey_invite).
-- Apply manually in Supabase. Idempotent. No backfill of legacy recipients.
--
-- Adds:
--   email_campaign_recipients.cz_solicitud_id (nullable bigint, no FK)
--   partial UNIQUE indexes (generic vs survey episode)
--   upsert_email_survey_invite_recipient_impact with p_cz_solicitud_id
--
-- Does NOT rewrite legacy recipients (cz_solicitud_id stays NULL).

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Episode column
-- ---------------------------------------------------------------------------

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS cz_solicitud_id bigint;

COMMENT ON COLUMN public.email_campaign_recipients.cz_solicitud_id IS
  'Logical episode key = cz_funnel_solicitudes.cz_id for purpose=rechazados_survey_invite. NULL = legacy pre-episode recipients. No FK by design (email lifecycle ≠ funnel lifecycle).';

CREATE INDEX IF NOT EXISTS email_campaign_recipients_survey_episode_idx
  ON public.email_campaign_recipients (cz_solicitud_id)
  WHERE purpose = 'rechazados_survey_invite'
    AND cz_solicitud_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- B. Replace lifetime (campaign_id, email) UNIQUE with partial indexes
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS public.uq_email_campaign_recipient;

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_campaign_recipient_generic
  ON public.email_campaign_recipients (campaign_id, lower(email))
  WHERE purpose IS DISTINCT FROM 'rechazados_survey_invite';

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_campaign_recipient_survey_episode
  ON public.email_campaign_recipients (campaign_id, lower(email), cz_solicitud_id)
  WHERE purpose = 'rechazados_survey_invite'
    AND cz_solicitud_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- C. RPC: require + persist cz_solicitud_id for survey invites
-- Drop old 6-arg signature to avoid overload ambiguity, then create 7-arg.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.upsert_email_survey_invite_recipient_impact(
  text, bigint, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.upsert_email_survey_invite_recipient_impact(
  p_idempotency_key text,
  p_campaign_id bigint,
  p_ci text,
  p_email text,
  p_purpose text,
  p_destination_url text,
  p_cz_solicitud_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_recipient public.email_campaign_recipients%ROWTYPE;
  v_impact public.marketing_impacts%ROWTYPE;
  v_token text;
  v_attempts integer := 0;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_campaign_id IS NULL THEN
    RAISE EXCEPTION 'CAMPAIGN_ID_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'EMAIL_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_purpose IS NULL OR btrim(p_purpose) = '' THEN
    RAISE EXCEPTION 'PURPOSE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_destination_url IS NULL OR btrim(p_destination_url) = '' THEN
    RAISE EXCEPTION 'DESTINATION_URL_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF btrim(p_destination_url) !~* '^https?://' THEN
    RAISE EXCEPTION 'DESTINATION_URL_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF btrim(p_purpose) = 'rechazados_survey_invite' AND p_cz_solicitud_id IS NULL THEN
    RAISE EXCEPTION 'CZ_SOLICITUD_ID_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.email_campaign_recipients (
    campaign_id,
    idempotency_key,
    ci,
    email,
    status,
    purpose,
    template_vars,
    cz_solicitud_id
  )
  VALUES (
    p_campaign_id,
    p_idempotency_key,
    p_ci,
    lower(btrim(p_email)),
    'queued',
    p_purpose,
    '{}'::jsonb,
    p_cz_solicitud_id
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  SELECT *
  INTO v_recipient
  FROM public.email_campaign_recipients
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECIPIENT_LOOKUP_FAILED' USING ERRCODE = 'P0001';
  END IF;

  IF v_recipient.marketing_impact_id IS NOT NULL THEN
    SELECT *
    INTO v_impact
    FROM public.marketing_impacts
    WHERE id = v_recipient.marketing_impact_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'LINKED_IMPACT_MISSING' USING ERRCODE = 'P0001';
    END IF;

    IF v_impact.channel IS DISTINCT FROM 'email' THEN
      RAISE EXCEPTION 'LINKED_IMPACT_WRONG_CHANNEL' USING ERRCODE = 'P0001';
    END IF;

    IF v_recipient.provider_send_started_at IS NULL
       AND v_impact.destination_url IS DISTINCT FROM btrim(p_destination_url) THEN
      UPDATE public.marketing_impacts
      SET destination_url = btrim(p_destination_url)
      WHERE id = v_impact.id
      RETURNING * INTO v_impact;
    END IF;

    RETURN jsonb_build_object(
      'created', false,
      'recipient_id', v_recipient.id,
      'impact_id', v_impact.id,
      'tracking_token', v_impact.tracking_token,
      'destination_url', v_impact.destination_url,
      'campaign_id', v_recipient.campaign_id,
      'idempotency_key', v_recipient.idempotency_key,
      'status', v_recipient.status,
      'provider_send_started_at', v_recipient.provider_send_started_at,
      'cz_solicitud_id', v_recipient.cz_solicitud_id
    );
  END IF;

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > 8 THEN
      RAISE EXCEPTION 'TRACKING_TOKEN_COLLISION' USING ERRCODE = 'P0001';
    END IF;

    v_token := rtrim(
      translate(encode(gen_random_bytes(16), 'base64'), '+/', '-_'),
      '='
    );

    BEGIN
      INSERT INTO public.marketing_impacts (
        tracking_token,
        channel,
        contact_id,
        destination_url
      )
      VALUES (
        v_token,
        'email',
        NULL,
        btrim(p_destination_url)
      )
      RETURNING * INTO v_impact;
      EXIT;
    EXCEPTION
      WHEN unique_violation THEN
        NULL;
    END;
  END LOOP;

  UPDATE public.email_campaign_recipients
  SET marketing_impact_id = v_impact.id
  WHERE id = v_recipient.id
    AND marketing_impact_id IS NULL
  RETURNING * INTO v_recipient;

  IF v_recipient.marketing_impact_id IS DISTINCT FROM v_impact.id THEN
    RAISE EXCEPTION 'LINK_FAILED' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'created', true,
    'recipient_id', v_recipient.id,
    'impact_id', v_impact.id,
    'tracking_token', v_impact.tracking_token,
    'destination_url', v_impact.destination_url,
    'campaign_id', v_recipient.campaign_id,
    'idempotency_key', v_recipient.idempotency_key,
    'status', v_recipient.status,
    'provider_send_started_at', v_recipient.provider_send_started_at,
    'cz_solicitud_id', v_recipient.cz_solicitud_id
  );
END;
$$;

COMMENT ON FUNCTION public.upsert_email_survey_invite_recipient_impact(
  text, bigint, text, text, text, text, bigint
) IS
  'Atomic create/reuse of email survey-invite recipient + marketing_impact + link. Unit key = idempotency_key. Requires p_cz_solicitud_id when purpose=rechazados_survey_invite. tracking_token is CSPRNG.';

COMMIT;
