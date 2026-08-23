-- Version production exclusion of old-base SMS contacts.
-- Applied manually in Supabase on 2026-08-20; this file only captures that schema.
-- Apply AFTER 20260819_sms_messages_contact_id.sql.
-- Idempotent. No backfill. Does not change campaign/short-link/tracking tables.

BEGIN;

ALTER TABLE public.sms_contacts
  ADD COLUMN IF NOT EXISTS excluded_from_campaigns boolean NOT NULL DEFAULT false;

ALTER TABLE public.sms_contacts
  ADD COLUMN IF NOT EXISTS excluded_at timestamptz NULL;

COMMENT ON COLUMN public.sms_contacts.excluded_from_campaigns IS
  'True when an old-base contact (credizona2_datos / prestafacil) reappears in cz_funnel_solicitudes by CI. Kept for historical attribution; omitted from automatic list campaigns.';

COMMENT ON COLUMN public.sms_contacts.excluded_at IS
  'First time excluded_from_campaigns became true. Later syncs must not overwrite.';

-- Match CI as text. Never cast source_record_id to bigint (non-numeric values would abort).
CREATE OR REPLACE FUNCTION public.sms_contacts_exclude_old_base_by_ci(p_cis bigint[])
RETURNS integer
LANGUAGE sql
AS $$
  WITH updated AS (
    UPDATE public.sms_contacts c
    SET
      excluded_from_campaigns = true,
      excluded_at = COALESCE(c.excluded_at, now())
    WHERE c.source_system IN ('credizona2_datos', 'prestafacil')
      AND c.source_record_id IS NOT NULL
      AND btrim(c.source_record_id) <> ''
      AND p_cis IS NOT NULL
      AND cardinality(p_cis) > 0
      AND btrim(c.source_record_id) = ANY (
        SELECT x::text FROM unnest(p_cis) AS x
      )
    RETURNING c.id
  )
  SELECT count(*)::integer FROM updated;
$$;

COMMENT ON FUNCTION public.sms_contacts_exclude_old_base_by_ci(bigint[]) IS
  'Marks credizona2_datos/prestafacil contacts whose source_record_id text equals a CI. Compares btrim(source_record_id) to CI::text; never casts source_record_id.';

CREATE OR REPLACE FUNCTION public.sms_eligible_contacts_base(p_source_system text)
RETURNS SETOF public.sms_contacts
LANGUAGE sql
STABLE
AS $$
  SELECT c.*
  FROM public.sms_contacts c
  WHERE c.source_system = p_source_system
    AND btrim(COALESCE(c.phone, '')) <> ''
    AND NOT c.excluded_from_campaigns
    AND NOT public.sms_contact_has_prior_message(c.id, c.phone);
$$;

COMMIT;
