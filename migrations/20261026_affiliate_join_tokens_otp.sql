-- Affiliate join (MVP block 1): invite tokens + OTP challenges.
-- Apply manually after 20261023_affiliates_identity_consent.sql.
-- Idempotent. No seed rows. Does not change attribution or prizes.

BEGIN;

CREATE TABLE IF NOT EXISTS public.affiliate_invite_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  ci bigint NOT NULL,
  status text NOT NULL DEFAULT 'issued',
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_invite_tokens_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT affiliate_invite_tokens_ci_positive_check CHECK (ci > 0),
  CONSTRAINT affiliate_invite_tokens_status_check CHECK (
    status IN ('issued', 'consumed', 'revoked', 'expired')
  )
);

COMMENT ON TABLE public.affiliate_invite_tokens IS
  'Opaque invite capabilities for the affiliate landing. Store hash only; raw token is never persisted.';

COMMENT ON COLUMN public.affiliate_invite_tokens.token_hash IS
  'SHA-256 hex of the raw invite token from the email link.';

COMMENT ON COLUMN public.affiliate_invite_tokens.status IS
  'issued until opt-in completes; consumed on successful OTP verification. Opening the landing does not consume.';

CREATE INDEX IF NOT EXISTS affiliate_invite_tokens_ci_status_idx
  ON public.affiliate_invite_tokens (ci, status)
  WHERE status = 'issued';

CREATE INDEX IF NOT EXISTS affiliate_invite_tokens_expires_at_idx
  ON public.affiliate_invite_tokens (expires_at)
  WHERE status = 'issued';

CREATE TABLE IF NOT EXISTS public.affiliate_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_token_id uuid NOT NULL REFERENCES public.affiliate_invite_tokens (id) ON DELETE RESTRICT,
  ci bigint NOT NULL,
  otp_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  send_count integer NOT NULL DEFAULT 1,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_otp_challenges_ci_positive_check CHECK (ci > 0),
  CONSTRAINT affiliate_otp_challenges_status_check CHECK (
    status IN ('pending', 'verified', 'expired', 'locked')
  ),
  CONSTRAINT affiliate_otp_challenges_otp_hash_hex_check CHECK (
    otp_hash ~ '^[0-9a-f]{64}$'
  )
);

COMMENT ON TABLE public.affiliate_otp_challenges IS
  'SMS OTP for affiliate opt-in. Stores HMAC-SHA256 hex of the six-digit code, never the raw OTP.';

CREATE INDEX IF NOT EXISTS affiliate_otp_challenges_invite_pending_idx
  ON public.affiliate_otp_challenges (invite_token_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS affiliate_otp_challenges_ci_created_idx
  ON public.affiliate_otp_challenges (ci, created_at DESC);

ALTER TABLE public.affiliate_invite_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_otp_challenges ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.affiliate_invite_tokens FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.affiliate_otp_challenges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.affiliate_invite_tokens TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.affiliate_otp_challenges TO service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.affiliate_invite_tokens FROM service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.affiliate_otp_challenges FROM service_role;

-- Extend acceptance_channel for landing + OTP opt-in.
ALTER TABLE public.affiliates
  DROP CONSTRAINT IF EXISTS affiliates_acceptance_channel_check;

ALTER TABLE public.affiliates
  ADD CONSTRAINT affiliates_acceptance_channel_check
  CHECK (
    acceptance_channel IS NULL
    OR acceptance_channel IN (
      'dashboard',
      'presencial',
      'affiliate_landing_otp'
    )
  )
  NOT VALID;

COMMIT;
