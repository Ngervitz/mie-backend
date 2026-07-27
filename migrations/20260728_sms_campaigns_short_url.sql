-- Additive short_url for TinyURL-shortened campaign links.
-- Do not apply automatically.

BEGIN;

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS short_url text NULL;

COMMENT ON COLUMN public.sms_campaigns.short_url IS
  'TinyURL short link for the UTM final_url. Null when shortening failed and the full final_url was sent.';

COMMIT;
