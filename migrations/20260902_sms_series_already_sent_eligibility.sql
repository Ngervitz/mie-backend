-- Series eligibility: exclude contacts already sent SMS in the same campaign_series.
-- Apply manually in Supabase AFTER 20260828_marketing_campaign_series.sql.
-- Idempotent. Does NOT change legacy eligibility RPCs or sms_contact_clicked_in_series.
--
-- Consumes series slot when sms_campaigns.status IN ('sending', 'sent', 'partial_error').
-- status = 'error' does NOT consume (prep / NotifyMe reject before any chunk succeeded).

BEGIN;

CREATE INDEX IF NOT EXISTS idx_sms_campaigns_series_status
  ON public.sms_campaigns (campaign_series_id, status)
  WHERE campaign_series_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sms_eligible_contacts_for_series_base(
  p_source_system text,
  p_campaign_series_id uuid
)
RETURNS SETOF public.sms_contacts
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_campaign_series_id IS NULL THEN
    RAISE EXCEPTION 'campaign_series_id is required'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH already_sent AS MATERIALIZED (
    SELECT DISTINCT m.contact_id, m.phone
    FROM public.sms_campaigns camp
    INNER JOIN public.sms_messages m
      ON m.campaign_id = camp.id
    WHERE camp.campaign_series_id = p_campaign_series_id
      AND camp.status IN ('sending', 'sent', 'partial_error')
  )
  SELECT c.*
  FROM public.sms_contacts c
  WHERE c.source_system = p_source_system
    AND btrim(COALESCE(c.phone, '')) <> ''
    AND NOT c.excluded_from_campaigns
    AND NOT EXISTS (
      SELECT 1
      FROM already_sent s
      WHERE (s.contact_id IS NOT NULL AND s.contact_id = c.id)
         OR (s.phone IS NOT NULL AND s.phone = c.phone)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.sms_classify_phones_for_series(
  p_campaign_series_id uuid,
  p_phones text[]
)
RETURNS TABLE (
  phone text,
  protection text
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_campaign_series_id IS NULL THEN
    RAISE EXCEPTION 'campaign_series_id is required'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH input AS (
    SELECT DISTINCT btrim(p) AS phone
    FROM unnest(COALESCE(p_phones, ARRAY[]::text[])) AS p
    WHERE btrim(COALESCE(p, '')) <> ''
  ),
  already_sent AS MATERIALIZED (
    SELECT DISTINCT m.contact_id, m.phone
    FROM public.sms_campaigns camp
    INNER JOIN public.sms_messages m
      ON m.campaign_id = camp.id
    WHERE camp.campaign_series_id = p_campaign_series_id
      AND camp.status IN ('sending', 'sent', 'partial_error')
  ),
  clicked AS MATERIALIZED (
    SELECT DISTINCT m.contact_id, m.phone
    FROM public.sms_campaigns camp
    INNER JOIN public.sms_messages m
      ON m.campaign_id = camp.id
    INNER JOIN public.marketing_impact_events e
      ON e.impact_id = m.marketing_impact_id
    WHERE camp.campaign_series_id = p_campaign_series_id
      AND m.marketing_impact_id IS NOT NULL
      AND e.event_name = 'click'
  )
  SELECT
    i.phone,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM public.sms_contacts c
        WHERE c.phone = i.phone
          AND c.excluded_from_campaigns
      ) THEN 'excluded'
      WHEN EXISTS (
        SELECT 1
        FROM already_sent s
        LEFT JOIN public.sms_contacts c
          ON c.phone = i.phone
        WHERE (s.contact_id IS NOT NULL AND c.id IS NOT NULL
            AND s.contact_id = c.id)
           OR (s.phone IS NOT NULL AND s.phone = i.phone)
      ) THEN 'already_sent'
      WHEN EXISTS (
        SELECT 1
        FROM clicked cl
        LEFT JOIN public.sms_contacts c
          ON c.phone = i.phone
        WHERE (cl.contact_id IS NOT NULL AND c.id IS NOT NULL
            AND cl.contact_id = c.id)
           OR (cl.phone IS NOT NULL AND cl.phone = i.phone)
      ) THEN 'clicked'
      ELSE NULL
    END AS protection
  FROM input i;
END;
$$;

COMMENT ON FUNCTION public.sms_classify_phones_for_series(uuid, text[]) IS
  'Per-phone protection for directed/paste. NULL series raises. excluded > already_sent > clicked. NULL protection means sendable.';

COMMIT;
