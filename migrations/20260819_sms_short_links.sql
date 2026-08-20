-- Own SMS short links (replaces third-party shorteners).
-- Apply manually in Supabase. Public redirects are served by GET /s/:short_code.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sms_short_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code text NOT NULL,
  destination_url text NOT NULL,
  campaign_id uuid NULL REFERENCES public.sms_campaigns (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  click_count integer NOT NULL DEFAULT 0,
  last_clicked_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_short_links_short_code_uidx
  ON public.sms_short_links (short_code);

CREATE UNIQUE INDEX IF NOT EXISTS sms_short_links_destination_url_uidx
  ON public.sms_short_links (destination_url);

CREATE INDEX IF NOT EXISTS sms_short_links_campaign_id_idx
  ON public.sms_short_links (campaign_id)
  WHERE campaign_id IS NOT NULL;

COMMENT ON TABLE public.sms_short_links IS
  'Owned SMS short links. Preview rows have campaign_id NULL. destination_url is the composed UTM URL.';

CREATE OR REPLACE FUNCTION public.sms_short_link_record_click(p_short_code text)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.sms_short_links
  SET
    click_count = click_count + 1,
    last_clicked_at = now()
  WHERE short_code = p_short_code;
$$;

COMMENT ON FUNCTION public.sms_short_link_record_click(text) IS
  'Atomically increment click_count and set last_clicked_at for a short_code.';

COMMIT;
