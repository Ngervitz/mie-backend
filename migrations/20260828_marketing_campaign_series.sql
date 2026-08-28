-- Marketing campaign series + SMS contextual eligibility (click of series).
-- Apply manually in Supabase AFTER 20260823_marketing_impacts.sql
-- and 20260820_sms_contacts_excluded_from_campaigns.sql.
-- Idempotent. No backfill. Does NOT replace legacy eligibility RPCs:
--   sms_contact_has_prior_message
--   sms_eligible_contacts_base
--   sms_eligible_contacts_count
--   sms_eligible_contacts
-- Does not change excluded_from_campaigns semantics or writers.

BEGIN;

-- ---------------------------------------------------------------------------
-- marketing_campaign_series
-- Generic product series. V1 consumer: sms_campaigns only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.marketing_campaign_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_campaign_series_name_nonempty_check
    CHECK (btrim(name) <> '')
);

COMMENT ON TABLE public.marketing_campaign_series IS
  'Product campaign series (reactivation). V1 referenced by sms_campaigns. Future email/WhatsApp may FK the same id. No channel/status/rules in V1.';

COMMENT ON COLUMN public.marketing_campaign_series.name IS
  'Operator label. Not unique. Identity is id.';

-- ---------------------------------------------------------------------------
-- sms_campaigns.campaign_series_id (nullable; historical rows stay NULL)
-- ---------------------------------------------------------------------------

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS campaign_series_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sms_campaigns_campaign_series_id_fkey'
  ) THEN
    ALTER TABLE public.sms_campaigns
      ADD CONSTRAINT sms_campaigns_campaign_series_id_fkey
      FOREIGN KEY (campaign_series_id)
      REFERENCES public.marketing_campaign_series (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

COMMENT ON COLUMN public.sms_campaigns.campaign_series_id IS
  'FK to marketing_campaign_series. NULL for historical campaigns and tracking-OFF sends. Application requires it when SMS_INDIVIDUAL_TRACKING=true on new-shape POSTs.';

CREATE INDEX IF NOT EXISTS sms_campaigns_campaign_series_id_idx
  ON public.sms_campaigns (campaign_series_id)
  WHERE campaign_series_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS marketing_impact_events_click_impact_id_idx
  ON public.marketing_impact_events (impact_id)
  WHERE event_name = 'click';

-- ---------------------------------------------------------------------------
-- Clicked identities for one series, computed ONCE (MATERIALIZED).
-- Mass eligibility/count/classify MUST use this CTE pattern, not a
-- per-contact correlated helper. p_campaign_series_id NULL raises.
-- Historical sms_campaigns.campaign_series_id NULL never match here
-- (equality to a non-null series id).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sms_contact_clicked_in_series(
  p_contact_id uuid,
  p_phone text,
  p_campaign_series_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_campaign_series_id IS NULL THEN
    RAISE EXCEPTION 'campaign_series_id is required'
      USING ERRCODE = '22023';
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.sms_campaigns camp
    INNER JOIN public.sms_messages m
      ON m.campaign_id = camp.id
    INNER JOIN public.marketing_impact_events e
      ON e.impact_id = m.marketing_impact_id
    WHERE camp.campaign_series_id = p_campaign_series_id
      AND m.marketing_impact_id IS NOT NULL
      AND e.event_name = 'click'
      AND (
        (m.contact_id IS NOT NULL AND p_contact_id IS NOT NULL
          AND m.contact_id = p_contact_id)
        OR (p_phone IS NOT NULL AND m.phone = p_phone)
      )
  );
END;
$$;

COMMENT ON FUNCTION public.sms_contact_clicked_in_series(uuid, text, uuid) IS
  'Single-row helper. NULL series raises. Mass list/count/classify must not call this per sms_contacts row.';

-- ---------------------------------------------------------------------------
-- New eligibility RPCs. Legacy functions above are intentionally untouched.
-- ---------------------------------------------------------------------------

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
  WITH clicked AS MATERIALIZED (
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
  SELECT c.*
  FROM public.sms_contacts c
  WHERE c.source_system = p_source_system
    AND btrim(COALESCE(c.phone, '')) <> ''
    AND NOT c.excluded_from_campaigns
    AND NOT EXISTS (
      SELECT 1
      FROM clicked cl
      WHERE (cl.contact_id IS NOT NULL AND cl.contact_id = c.id)
         OR (cl.phone IS NOT NULL AND cl.phone = c.phone)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.sms_eligible_contacts_for_series_count(
  p_source_system text,
  p_campaign_series_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  n bigint;
BEGIN
  IF p_campaign_series_id IS NULL THEN
    RAISE EXCEPTION 'campaign_series_id is required'
      USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::bigint
    INTO n
  FROM public.sms_eligible_contacts_for_series_base(
    p_source_system,
    p_campaign_series_id
  );
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.sms_series_protected_clicked_count(
  p_source_system text,
  p_campaign_series_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  n bigint;
BEGIN
  IF p_campaign_series_id IS NULL THEN
    RAISE EXCEPTION 'campaign_series_id is required'
      USING ERRCODE = '22023';
  END IF;
  WITH clicked AS MATERIALIZED (
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
  SELECT count(*)::bigint
    INTO n
  FROM public.sms_contacts c
  WHERE c.source_system = p_source_system
    AND btrim(COALESCE(c.phone, '')) <> ''
    AND NOT c.excluded_from_campaigns
    AND EXISTS (
      SELECT 1
      FROM clicked cl
      WHERE (cl.contact_id IS NOT NULL AND cl.contact_id = c.id)
         OR (cl.phone IS NOT NULL AND cl.phone = c.phone)
    );
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.sms_eligible_contacts_for_series(
  p_source_system text,
  p_campaign_series_id uuid,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  phone text,
  nombre text,
  source_system text,
  source_record_id text
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
  SELECT
    c.id,
    c.phone,
    c.nombre,
    c.source_system,
    c.source_record_id
  FROM public.sms_eligible_contacts_for_series_base(
    p_source_system,
    p_campaign_series_id
  ) c
  ORDER BY c.first_seen_at ASC, c.id ASC
  LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Classify pasted/directed phones for fail-closed protection.
-- protection: excluded (definitive, wins if both) | clicked | NULL (ok).
-- Clicked identities computed once (MATERIALIZED), not per phone via helper.
-- ---------------------------------------------------------------------------

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
  'Per-phone protection for directed/paste. NULL series raises. excluded wins over clicked. NULL protection means sendable.';

COMMIT;
