-- Marketing impacts (V1 SMS individual tracking).
-- Apply manually in Supabase AFTER 20260819_sms_short_links.sql
-- and 20260819_sms_messages_contact_id.sql.
-- Idempotent. No backfill. Does not change runtime, exclusion, or email tables.
--
-- Out of V1 on purpose:
--   marketing_impacts.campaign_id
--   marketing_impacts.cz_solicitud_id
--   JSONB metadata / event payload
--   CZ → Janus endpoint

BEGIN;

-- ---------------------------------------------------------------------------
-- marketing_impacts
-- Identity of one outbound marketing touch. SMS campaign is reached via
-- sms_messages.campaign_id, not a column here.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.marketing_impacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_token text NOT NULL,
  channel text NOT NULL,
  contact_id uuid NULL REFERENCES public.sms_contacts (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_impacts_tracking_token_unique UNIQUE (tracking_token),
  CONSTRAINT marketing_impacts_tracking_token_format_check
    CHECK (tracking_token ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT marketing_impacts_channel_check
    CHECK (channel IN ('sms', 'email', 'whatsapp'))
);

COMMENT ON TABLE public.marketing_impacts IS
  'One outbound marketing touch. tracking_token is public impact identity (not auth). SMS campaign is via sms_messages; no campaign_id / cz_solicitud_id in V1.';

COMMENT ON COLUMN public.marketing_impacts.tracking_token IS
  'CSPRNG 16 bytes, base64url without padding, 22 chars. Stored plaintext. UNIQUE. Query param to CZ: jt.';

COMMENT ON COLUMN public.marketing_impacts.channel IS
  'Allowed: sms, email, whatsapp. V1 writes sms only.';

COMMENT ON COLUMN public.marketing_impacts.contact_id IS
  'sms_contacts.id when the send resolved a contact (list). NULL for paste / unknown phone.';

CREATE INDEX IF NOT EXISTS marketing_impacts_contact_id_idx
  ON public.marketing_impacts (contact_id)
  WHERE contact_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- marketing_impact_events
-- Append-only occurrences (Janus click now; Credizona later).
-- Idempotency: UNIQUE (source, external_event_id).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.marketing_impact_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  impact_id uuid NOT NULL REFERENCES public.marketing_impacts (id) ON DELETE CASCADE,
  source text NOT NULL,
  event_name text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  external_event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_impact_events_source_nonempty_check
    CHECK (btrim(source) <> ''),
  CONSTRAINT marketing_impact_events_event_name_nonempty_check
    CHECK (btrim(event_name) <> ''),
  CONSTRAINT marketing_impact_events_external_event_id_nonempty_check
    CHECK (btrim(external_event_id) <> ''),
  CONSTRAINT marketing_impact_events_source_external_event_id_unique
    UNIQUE (source, external_event_id)
);

COMMENT ON TABLE public.marketing_impact_events IS
  'Occurrences on a marketing impact. event_name (not event_type) matches the future Credizona → Janus contract. No JSONB payload in V1.';

COMMENT ON COLUMN public.marketing_impact_events.source IS
  'Origin of the event. Expected V1: janus. Future CZ ingest: credizona. Not an enum so the CZ contract can land without a schema change.';

COMMENT ON COLUMN public.marketing_impact_events.event_name IS
  'Logical event name (e.g. click). Same field name the future Credizona → Janus contract will send.';

COMMENT ON COLUMN public.marketing_impact_events.external_event_id IS
  'Idempotency key within source. UNIQUE with source. Janus generates one per click occurrence; CZ will send its own.';

COMMENT ON COLUMN public.marketing_impact_events.occurred_at IS
  'When the event happened.';

COMMENT ON COLUMN public.marketing_impact_events.received_at IS
  'When Janus received the event. Used for retries, delay, and audit.';

CREATE INDEX IF NOT EXISTS marketing_impact_events_impact_id_occurred_at_idx
  ON public.marketing_impact_events (impact_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- sms_messages: optional 1:1 link to the impact created for that send
-- ---------------------------------------------------------------------------

ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS marketing_impact_id uuid NULL
    REFERENCES public.marketing_impacts (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sms_messages.marketing_impact_id IS
  'Impact created for this SMS. NULL for historical rows and pre-flag sends. ON DELETE SET NULL keeps the Notifyme row.';

CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_marketing_impact_id_uidx
  ON public.sms_messages (marketing_impact_id)
  WHERE marketing_impact_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sms_short_links: optional 1:1 link to the impact that owns this short
-- Preview and historical shared shorts stay impact_id NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE public.sms_short_links
  ADD COLUMN IF NOT EXISTS impact_id uuid NULL
    REFERENCES public.marketing_impacts (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sms_short_links.impact_id IS
  'Impact that owns this short. NULL for preview and historical shared campaign shorts. New individual-tracking shorts set this (1:1).';

CREATE UNIQUE INDEX IF NOT EXISTS sms_short_links_impact_id_uidx
  ON public.sms_short_links (impact_id)
  WHERE impact_id IS NOT NULL;

-- destination_url UNIQUE only for preview / historical rows (impact_id IS NULL).
-- Per-impact shorts may share the same composed UTM destination.
ALTER TABLE public.sms_short_links
  DROP CONSTRAINT IF EXISTS sms_short_links_destination_url_key;

DROP INDEX IF EXISTS public.sms_short_links_destination_url_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS sms_short_links_destination_url_uidx
  ON public.sms_short_links (destination_url)
  WHERE impact_id IS NULL;

COMMENT ON TABLE public.sms_short_links IS
  'Owned SMS short links. Preview and historical shared rows have impact_id NULL and remain unique on destination_url. Per-impact shorts set impact_id and may share destination_url.';

COMMIT;
