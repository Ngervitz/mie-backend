-- Email campaign recipients: purpose + per-recipient template_vars (Stage 2A).
-- Apply manually in Supabase. Idempotent. No backfill. No CHECK on purpose.
-- Does not change email_campaigns, email_suppressions, SMS, or marketing_impacts.

BEGIN;

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS purpose text;

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS template_vars jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.email_campaign_recipients.purpose IS
  'Logical send purpose (e.g. rechazados_survey_invite). NULL = legacy/generic segment campaigns. Validated in app (EMAIL_PURPOSES), not DB CHECK.';

COMMENT ON COLUMN public.email_campaign_recipients.template_vars IS
  'Per-recipient merge vars for subject/body_html at send time. Never mutates email_campaigns.body_html.';

COMMIT;
