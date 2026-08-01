CREATE TABLE email_segments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  rules JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_campaigns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  segment_id BIGINT REFERENCES email_segments(id),
  segment_rules_snapshot JSONB NOT NULL,
  recipient_count INTEGER,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','sending','completed','partial_error','error')),
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_campaign_recipients (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES email_campaigns(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  ci TEXT,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','failed','bounced')),
  provider_message_id TEXT,
  error_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_email_campaign_recipient
  ON email_campaign_recipients (campaign_id, lower(email));

CREATE UNIQUE INDEX uq_email_provider_message_id
  ON email_campaign_recipients (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE email_suppressions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_email_suppressions_email
  ON email_suppressions (lower(email));

CREATE TABLE cz_encuestas_synced (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ci TEXT NOT NULL UNIQUE,
  email TEXT,
  encuesta_score NUMERIC,
  marketing_consent BOOLEAN,
  marketing_consent_at TIMESTAMPTZ,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
