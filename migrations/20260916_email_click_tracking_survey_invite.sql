-- Email click tracking for Rechazados → Encuesta (minimal).
-- Apply manually in Supabase. Idempotent. No backfill. No DML on historical rows.
--
-- Adds:
--   marketing_impacts.destination_url (nullable; SMS rows stay NULL)
--   email_campaign_recipients.marketing_impact_id (UNIQUE FK → marketing_impacts)
--   upsert_email_survey_invite_recipient_impact(...) atomic RPC
--
-- Does NOT touch SMS writers, sms_short_links, or survey completion logic.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. destination_url on marketing_impacts
-- ---------------------------------------------------------------------------

ALTER TABLE public.marketing_impacts
  ADD COLUMN IF NOT EXISTS destination_url text;

COMMENT ON COLUMN public.marketing_impacts.destination_url IS
  'Freeze-time redirect target for email channel (REAL survey URL without requiring jt). NULL for historical SMS impacts. Click-time appends jt=tracking_token.';

-- ---------------------------------------------------------------------------
-- B. recipient → impact link (1:1)
-- ---------------------------------------------------------------------------

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS marketing_impact_id uuid
    REFERENCES public.marketing_impacts (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.email_campaign_recipients.marketing_impact_id IS
  'Email marketing impact for this recipient (1:1). NULL for legacy/generic recipients without click tracking.';

CREATE UNIQUE INDEX IF NOT EXISTS email_campaign_recipients_marketing_impact_id_uidx
  ON public.email_campaign_recipients (marketing_impact_id)
  WHERE marketing_impact_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- C. Atomic upsert: recipient + impact + link
-- Unit identity = email_campaign_recipients.idempotency_key (existing UNIQUE).
-- tracking_token = CSPRNG (gen_random_bytes), never derived from business data.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_email_survey_invite_recipient_impact(
  p_idempotency_key text,
  p_campaign_id bigint,
  p_ci text,
  p_email text,
  p_purpose text,
  p_destination_url text
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

  -- Serialize on the logical unit key.
  INSERT INTO public.email_campaign_recipients (
    campaign_id,
    idempotency_key,
    ci,
    email,
    status,
    purpose,
    template_vars
  )
  VALUES (
    p_campaign_id,
    p_idempotency_key,
    p_ci,
    lower(btrim(p_email)),
    'queued',
    p_purpose,
    '{}'::jsonb
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

  -- Already linked: reuse impact (refresh destination if still pre-send and empty payload path).
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

    -- Pre-send only: keep destination aligned with latest freeze input.
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
      'provider_send_started_at', v_recipient.provider_send_started_at
    );
  END IF;

  -- Create impact with CSPRNG token (retry on unique collision).
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
        -- Token collision only; retry new CSPRNG token.
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
    'provider_send_started_at', v_recipient.provider_send_started_at
  );
END;
$$;

COMMENT ON FUNCTION public.upsert_email_survey_invite_recipient_impact(
  text, bigint, text, text, text, text
) IS
  'Atomic create/reuse of email survey-invite recipient + marketing_impact + link. Unit key = idempotency_key. tracking_token is CSPRNG.';

COMMIT;
