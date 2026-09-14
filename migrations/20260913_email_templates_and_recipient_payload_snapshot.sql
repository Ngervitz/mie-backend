-- Template catalog + frozen recipient payload (Migration B).
-- Apply manually in Supabase. Idempotent. No backfill. No DML.
-- Does not apply Migration A (provider_send_started_at).
-- Does not change status enums, claim columns, or other tables.

BEGIN;

CREATE TABLE IF NOT EXISTS public.email_templates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_templates IS
  'Reusable email template catalog. Edits affect only future campaign selections. Never rewrites existing campaigns or recipients.';

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES public.email_templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.email_campaigns.template_id IS
  'Optional catalog template chosen at create time. subject/body_html are an owned copy and do not follow later template edits.';

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS payload_to TEXT;

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS payload_from TEXT;

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS payload_subject TEXT;

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS payload_html TEXT;

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS template_subject_snapshot TEXT;

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS template_body_html_snapshot TEXT;

COMMENT ON COLUMN public.email_campaign_recipients.payload_to IS
  'Frozen delivery address. Snapshot-based sends must use this, not a later edit of email.';
COMMENT ON COLUMN public.email_campaign_recipients.payload_from IS
  'Frozen From captured at materialize. Snapshot-based sends must not re-read EMAIL_CAMPAIGNS_FROM.';
COMMENT ON COLUMN public.email_campaign_recipients.payload_subject IS
  'Frozen rendered subject. Snapshot-based sends must not re-render.';
COMMENT ON COLUMN public.email_campaign_recipients.payload_html IS
  'Frozen rendered HTML. Snapshot-based sends must not re-render.';
COMMENT ON COLUMN public.email_campaign_recipients.template_subject_snapshot IS
  'Source subject frozen at materialize. Pre-start repair may re-render from this, never from the live template or campaign.';
COMMENT ON COLUMN public.email_campaign_recipients.template_body_html_snapshot IS
  'Source HTML frozen at materialize. Pre-start repair may re-render from this, never from the live template or campaign.';

COMMIT;
