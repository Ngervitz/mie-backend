-- Instagram DMs module for Credizona (@credizonauy).
-- Autonomous from comments module tables; shares Meta rate budget via
-- meta_api_rate_budget / reserve_meta_api_budget (same bucket_key).
-- Apply manually in Supabase.
--
-- Pendientes documentados (v1):
--   - Human Agent window (7 días) — no implementar como fallback automático.
--   - Filtro Primary/General/Requests folders — v1 pollea /conversations tal cual.

BEGIN;

-- Reuse public.set_updated_at() from comments migration if already present.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.social_conversations (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform                    text NOT NULL DEFAULT 'instagram'
    CHECK (platform = 'instagram'),
  ig_conversation_id          text NOT NULL UNIQUE,
  recipient_ig_scoped_id      text NOT NULL,
  ig_username                 text,
  status                      text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'answered', 'expired', 'closed')),
  last_inbound_at             timestamptz,
  last_outbound_at            timestamptz,
  response_window_expires_at  timestamptz,
  response_window_status      text
    CHECK (
      response_window_status IN ('open', 'expiring', 'expired')
      OR response_window_status IS NULL
    ),
  send_locked_at              timestamptz,
  send_locked_by              text,
  send_lock_expires_at        timestamptz,
  last_synced_at              timestamptz,
  last_sync_status            text
    CHECK (
      last_sync_status IN ('success', 'error')
      OR last_sync_status IS NULL
    ),
  last_sync_error             text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.social_conversations.recipient_ig_scoped_id IS
  'Instagram-scoped ID of the customer; used as recipient.id when sending. Not the global profile id and not @credizonauy.';
COMMENT ON COLUMN public.social_conversations.response_window_expires_at IS
  'last_inbound_at + 24 hours. v1 send window only — Human Agent (7d) not implemented.';
COMMENT ON COLUMN public.social_conversations.response_window_status IS
  'open if >2h remain; expiring if <=2h remain; expired if past response_window_expires_at.';
COMMENT ON COLUMN public.social_conversations.send_locked_by IS
  'UUID of the send attempt that owns the short send lock. Never blocks sync or reads.';

CREATE INDEX IF NOT EXISTS idx_social_conversations_status
  ON public.social_conversations (status);

CREATE INDEX IF NOT EXISTS idx_social_conversations_window
  ON public.social_conversations (response_window_expires_at);

CREATE TABLE IF NOT EXISTS public.social_messages (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  social_conversation_id  bigint NOT NULL REFERENCES public.social_conversations(id),
  ig_message_id           text NOT NULL UNIQUE,
  direction               text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  source                  text
    CHECK (source IN ('metadash', 'instagram') OR source IS NULL),
  text                    text,
  sent_by                 text,
  message_timestamp       timestamptz NOT NULL,
  guardrail_severity      text
    CHECK (
      guardrail_severity IN ('warning', 'confirmation', 'blocked')
      OR guardrail_severity IS NULL
    ),
  guardrail_matches       jsonb,
  guardrail_confirmed_at  timestamptz,
  guardrail_confirmed_by  text,
  fetched_at              timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.social_messages.fetched_at IS
  'First time this system stored the message. Never modified after insert.';
COMMENT ON COLUMN public.social_messages.source IS
  'metadash when sent from this API; instagram when observed from Meta sync. Null for inbound.';

CREATE INDEX IF NOT EXISTS idx_social_messages_conversation_id
  ON public.social_messages (social_conversation_id);

CREATE INDEX IF NOT EXISTS idx_social_messages_conversation_ts
  ON public.social_messages (social_conversation_id, message_timestamp DESC);

CREATE TABLE IF NOT EXISTS public.social_message_guardrails (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phrase_or_pattern  text NOT NULL,
  match_type         text NOT NULL CHECK (match_type IN ('exact', 'contains')),
  severity           text NOT NULL CHECK (severity IN ('warning', 'confirmation', 'blocked')),
  replacement_text   text,
  explanation        text,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.social_message_guardrails IS
  'Outbound DM phrase checks. match_type exact|contains only — regex out of scope for v1.';

DROP TRIGGER IF EXISTS trg_social_conversations_updated_at ON public.social_conversations;
CREATE TRIGGER trg_social_conversations_updated_at
  BEFORE UPDATE ON public.social_conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_social_messages_updated_at ON public.social_messages;
CREATE TRIGGER trg_social_messages_updated_at
  BEFORE UPDATE ON public.social_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_social_message_guardrails_updated_at ON public.social_message_guardrails;
CREATE TRIGGER trg_social_message_guardrails_updated_at
  BEFORE UPDATE ON public.social_message_guardrails
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Atomic send-lock acquire (2-minute TTL applied by caller via expires_at).
CREATE OR REPLACE FUNCTION public.acquire_dm_send_lock(
  p_conversation_id bigint,
  p_locked_by text,
  p_ttl_seconds integer DEFAULT 120
)
RETURNS SETOF public.social_conversations
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.social_conversations
  SET
    send_locked_at = now(),
    send_locked_by = p_locked_by,
    send_lock_expires_at = now() + make_interval(secs => p_ttl_seconds)
  WHERE id = p_conversation_id
    AND (
      send_lock_expires_at IS NULL
      OR send_lock_expires_at < now()
    )
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_dm_send_lock(
  p_conversation_id bigint,
  p_locked_by text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.social_conversations
  SET
    send_locked_at = NULL,
    send_locked_by = NULL,
    send_lock_expires_at = NULL
  WHERE id = p_conversation_id
    AND send_locked_by = p_locked_by;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- Seed guardrails (idempotent by phrase + match_type + severity).
INSERT INTO public.social_message_guardrails (
  phrase_or_pattern, match_type, severity, explanation
)
SELECT v.phrase_or_pattern, v.match_type, v.severity, v.explanation
FROM (
  VALUES
    (
      'aprobación garantizada',
      'contains',
      'blocked',
      'Promesa de aprobación garantizada — bloqueada'
    ),
    (
      'crédito garantizado',
      'contains',
      'blocked',
      'Promesa de crédito garantizado — bloqueada'
    ),
    (
      'tasa 0',
      'contains',
      'blocked',
      'Promesa de tasa 0 — bloqueada'
    ),
    (
      'te depositamos seguro',
      'contains',
      'blocked',
      'Promesa de depósito seguro — bloqueada'
    ),
    (
      'estás aprobado',
      'contains',
      'confirmation',
      'Afirmación de aprobación — requiere confirmación explícita'
    ),
    (
      'te lo aprueban',
      'contains',
      'confirmation',
      'Afirmación de aprobación — requiere confirmación explícita'
    )
) AS v(phrase_or_pattern, match_type, severity, explanation)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.social_message_guardrails g
  WHERE g.phrase_or_pattern = v.phrase_or_pattern
    AND g.match_type = v.match_type
    AND g.severity = v.severity
);

COMMIT;
