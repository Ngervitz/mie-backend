-- Affiliate links (stage 1): stable code + raw click log.
-- Apply manually in Supabase. Do not run from the app.
-- Independent of marketing_impacts and marketing_impact_events.
-- Idempotent. No seed rows.

BEGIN;

CREATE TABLE IF NOT EXISTS public.affiliates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliates_code_unique UNIQUE (code),
  CONSTRAINT affiliates_code_format_check
    CHECK (code ~ '^[A-Za-z0-9]{4,32}$'),
  CONSTRAINT affiliates_status_check
    CHECK (status IN ('active', 'inactive'))
);

-- Safe if an earlier draft of this table was created without the column.
ALTER TABLE public.affiliates
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

COMMENT ON TABLE public.affiliates IS
  'Stable affiliate codes for GET /a/:code. No public signup.';

COMMENT ON COLUMN public.affiliates.code IS
  'Public path segment. 4–32 alphanumeric characters. Unique.';

COMMENT ON COLUMN public.affiliates.status IS
  'active records a click. inactive redirects to the clean destination and records nothing.';

COMMENT ON COLUMN public.affiliates.is_test IS
  'Test affiliate. Rows with is_test = true never generate prizes. Prize settlement must exclude them. Default false is not a prize grant.';

CREATE TABLE IF NOT EXISTS public.affiliate_clicks (
  click_id uuid PRIMARY KEY,
  affiliate_id uuid NOT NULL REFERENCES public.affiliates (id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_agent text NULL,
  ip_hash text NULL,
  referer text NULL,
  CONSTRAINT affiliate_clicks_ip_hash_hex_check
    CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE public.affiliate_clicks IS
  'One row per valid GET /a/:code. HEAD does not insert. No raw IP column.';

COMMENT ON COLUMN public.affiliate_clicks.click_id IS
  'Server-generated UUID. Public query param cz_click. Not derived from the visitor.';

COMMENT ON COLUMN public.affiliate_clicks.occurred_at IS
  'Server time when the click was accepted. Not a client timestamp.';

COMMENT ON COLUMN public.affiliate_clicks.ip_hash IS
  'HMAC-SHA256 (hex) of the client address with AFFILIATE_IP_HASH_SECRET. Clicks are not inserted when that secret is unset.';

CREATE INDEX IF NOT EXISTS affiliate_clicks_affiliate_occurred_idx
  ON public.affiliate_clicks (affiliate_id, occurred_at DESC);

ALTER TABLE public.affiliates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_clicks ENABLE ROW LEVEL SECURITY;

-- No policies. RLS default-deny blocks anon and authenticated even if a grant leaks.
-- The route and the seed script use the backend service role client only.
REVOKE ALL ON TABLE public.affiliates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.affiliate_clicks FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON TABLE public.affiliates TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.affiliates FROM service_role;

GRANT SELECT, INSERT ON TABLE public.affiliate_clicks TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.affiliate_clicks FROM service_role;

COMMIT;
