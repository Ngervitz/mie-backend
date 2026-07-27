-- SMS contacts synced periodically from Credizona (IT CSV import).
-- This module does NOT write back to Credizona CRM.
-- Isolated from Notifyme campaign tables aside from shared phone text.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sms_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  source_record_id text NULL,
  source_system text NOT NULL DEFAULT 'credizona2_datos',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  import_batch_id uuid NULL,
  CONSTRAINT sms_contacts_phone_unique UNIQUE (phone)
);

CREATE INDEX IF NOT EXISTS idx_sms_contacts_last_seen_at
  ON public.sms_contacts (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_contacts_source_ref
  ON public.sms_contacts (source_system, source_record_id)
  WHERE source_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_contacts_import_batch_id
  ON public.sms_contacts (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.sms_contact_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imported_at timestamptz NOT NULL DEFAULT now(),
  filename text NULL,
  rows_received integer NOT NULL DEFAULT 0,
  rows_inserted integer NOT NULL DEFAULT 0,
  rows_updated integer NOT NULL DEFAULT 0,
  rows_rejected integer NOT NULL DEFAULT 0,
  alert_sent boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_sms_contact_imports_imported_at
  ON public.sms_contact_imports (imported_at DESC);

COMMENT ON TABLE public.sms_contacts IS
  'Phone contacts imported from Credizona CSV sync. No CRM writes from this table.';
COMMENT ON TABLE public.sms_contact_imports IS
  'Per-file import summaries for sms_contacts, including alert_sent for Make webhook.';
COMMENT ON COLUMN public.sms_contacts.phone IS
  'Destination phone text as provided by IT. Unique; keep as text (no Number coercion).';
COMMENT ON COLUMN public.sms_contacts.source_system IS
  'Provenance label. Default credizona2_datos for IT Credizona exports.';

COMMIT;
