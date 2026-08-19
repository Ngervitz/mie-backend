-- Optional first/last name on sms_contacts for SMS personalization.
-- Apply manually in Supabase. Does not touch campaign send tables.

BEGIN;

ALTER TABLE public.sms_contacts
  ADD COLUMN IF NOT EXISTS nombre text,
  ADD COLUMN IF NOT EXISTS apellido text;

COMMENT ON COLUMN public.sms_contacts.nombre IS
  'Optional first name from CSV import. Used to personalize SMS text.';
COMMENT ON COLUMN public.sms_contacts.apellido IS
  'Optional last name from CSV import. Used to personalize SMS text.';

COMMIT;
