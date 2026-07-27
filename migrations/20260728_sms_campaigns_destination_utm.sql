-- Additive columns for SMS campaign destination URL + UTM campaign value.
-- utm_campaign_value stores the campaign UUID used in utm_campaign=.
-- Do not apply automatically.

BEGIN;

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS destination_url text NULL;

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS utm_campaign_value text NULL;

COMMENT ON COLUMN public.sms_campaigns.destination_url IS
  'Original destination URL provided at campaign creation (before UTM append).';
COMMENT ON COLUMN public.sms_campaigns.utm_campaign_value IS
  'Value written to utm_campaign query param; equals the campaign UUID.';

COMMIT;
