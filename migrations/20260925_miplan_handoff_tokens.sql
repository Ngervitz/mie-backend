-- Mi Plan handoff tokens (A3): opaque one-time capabilities for Credizona → Mi Plan.
-- Apply manually in Supabase. Idempotent. No prod apply from this task.

BEGIN;

CREATE TABLE IF NOT EXISTS public.miplan_handoff_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  purpose text NOT NULL,
  external_ref_type text NOT NULL DEFAULT 'lrw',
  external_ref text NOT NULL,
  cz_solicitud_id bigint NULL,
  ci bigint NULL,
  status text NOT NULL DEFAULT 'issued',
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT miplan_handoff_tokens_purpose_check
    CHECK (purpose = 'miplan_handoff'),
  CONSTRAINT miplan_handoff_tokens_status_check
    CHECK (status IN ('issued', 'consumed', 'expired', 'revoked')),
  CONSTRAINT miplan_handoff_tokens_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_miplan_handoff_tokens_active_ref
  ON public.miplan_handoff_tokens (purpose, external_ref_type, external_ref)
  WHERE status = 'issued' AND redeemed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_miplan_handoff_tokens_expires_at
  ON public.miplan_handoff_tokens (expires_at)
  WHERE status = 'issued';

COMMENT ON TABLE public.miplan_handoff_tokens IS
  'Opaque one-time handoff codes for Credizona rejected → Mi Plan (A3). Store hash only.';

COMMENT ON COLUMN public.miplan_handoff_tokens.token_hash IS
  'SHA-256 hex of raw handoff_code. Never store raw code.';

COMMENT ON COLUMN public.miplan_handoff_tokens.external_ref IS
  'Credizona LRW / episode reference. Reference only — not authorization by itself.';

COMMENT ON COLUMN public.miplan_handoff_tokens.ci IS
  'Person CI from episode at issue time (server-side). Not returned to browser.';

-- Atomic redeem: only one concurrent caller wins.
CREATE OR REPLACE FUNCTION public.redeem_miplan_handoff_token(p_token_hash text)
RETURNS SETOF public.miplan_handoff_tokens
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.miplan_handoff_tokens t
  SET
    status = 'consumed',
    redeemed_at = now(),
    updated_at = now()
  WHERE t.token_hash = p_token_hash
    AND t.status = 'issued'
    AND t.redeemed_at IS NULL
    AND t.expires_at > now()
  RETURNING t.*;
END;
$$;

COMMENT ON FUNCTION public.redeem_miplan_handoff_token(text) IS
  'Atomically consume an issued, unexpired miplan_handoff token by hash. Empty set if already used/expired.';

COMMIT;
