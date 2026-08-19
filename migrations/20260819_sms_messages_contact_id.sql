-- sms_messages.contact_id + shared eligibility for list-based campaigns.
-- Apply after 20260819_sms_contacts_nombre_apellido.sql (nombre column).
-- Apply manually in Supabase. Does not change Notifyme send tables besides the FK.

BEGIN;

ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS contact_id uuid NULL
    REFERENCES public.sms_contacts (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sms_messages.contact_id IS
  'sms_contacts.id copied at send time. ON DELETE SET NULL keeps the message row.';

CREATE INDEX IF NOT EXISTS idx_sms_messages_contact_id
  ON public.sms_messages (contact_id)
  WHERE contact_id IS NOT NULL;

-- Single predicate: any prior sms_messages row for this contact (by id or phone).
-- delivered_at is ignored. Used by both count and list RPCs.
CREATE OR REPLACE FUNCTION public.sms_contact_has_prior_message(
  p_contact_id uuid,
  p_phone text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.sms_messages m
    WHERE m.phone = p_phone
       OR (m.contact_id IS NOT NULL AND m.contact_id = p_contact_id)
  );
$$;

COMMENT ON FUNCTION public.sms_contact_has_prior_message(uuid, text) IS
  'True if sms_messages already has this contact_id or phone. Eligibility exclusion.';

CREATE OR REPLACE FUNCTION public.sms_eligible_contacts_base(p_source_system text)
RETURNS SETOF public.sms_contacts
LANGUAGE sql
STABLE
AS $$
  SELECT c.*
  FROM public.sms_contacts c
  WHERE c.source_system = p_source_system
    AND btrim(COALESCE(c.phone, '')) <> ''
    AND NOT public.sms_contact_has_prior_message(c.id, c.phone);
$$;

CREATE OR REPLACE FUNCTION public.sms_eligible_contacts_count(p_source_system text)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT count(*)::bigint
  FROM public.sms_eligible_contacts_base(p_source_system);
$$;

CREATE OR REPLACE FUNCTION public.sms_eligible_contacts(
  p_source_system text,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  phone text,
  nombre text,
  source_system text,
  source_record_id text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id,
    c.phone,
    c.nombre,
    c.source_system,
    c.source_record_id
  FROM public.sms_eligible_contacts_base(p_source_system) c
  ORDER BY c.first_seen_at ASC, c.id ASC
  LIMIT p_limit;
$$;

COMMIT;
