-- Email campaign recipients: provider send idempotency window start (delivery atomicity).
-- Apply manually in Supabase. Idempotent. No backfill.
-- Does not change status enum, claim columns, or other tables.

BEGIN;

ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS provider_send_started_at timestamptz NULL;

COMMENT ON COLUMN public.email_campaign_recipients.provider_send_started_at IS
  'Start of provider idempotency window (Resend key janus-email-recipient:{id}). Set once before first provider call; not updated on retries. After 24h without sent → terminal unknown.';

COMMIT;
