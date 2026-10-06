-- Mi Deuda Stage 1: canonical creditor catalog (creditors + creditor_aliases) + BCU seed.
-- Apply manually in Supabase AFTER 20260813_dashboard_users_permissions.sql (dashboard_users)
-- and BEFORE deploying the runtime that reads it (miDeudaBagsRead fails closed without it).
-- Idempotent. Additive only: does not touch BCU facts, opt-in, outreach or Mi Plan data.
-- Reuses existing public.set_updated_at() (do not redefine).
--
-- Access: backend only (service_role bypasses RLS). RLS enabled with NO policies and
-- anon/authenticated grants revoked, because the dashboard browser holds the anon key.
--
-- Seed mirrors src/lib/creditorCatalogBcuSeed.js (enforced by scripts/unit-creditor-catalog.js).
-- normalized_key = creditor_key_v1(raw) (src/lib/creditorCatalog.js). Frozen; v2 = re-key.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. creditors: stable identity. creditor_id / slug never change; display_name may.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.creditors (
  creditor_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                      text NOT NULL,
  display_name              text NOT NULL,
  status                    text NOT NULL DEFAULT 'active',
  merged_into_creditor_id   uuid NULL REFERENCES public.creditors (creditor_id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid NULL REFERENCES public.dashboard_users (id) ON DELETE SET NULL,
  CONSTRAINT creditors_slug_key UNIQUE (slug),
  CONSTRAINT creditors_slug_format_check
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT creditors_display_name_check
    CHECK (btrim(display_name) <> ''),
  CONSTRAINT creditors_status_check
    CHECK (status IN ('active', 'merged', 'retired')),
  CONSTRAINT creditors_merged_target_check
    CHECK ((status = 'merged') = (merged_into_creditor_id IS NOT NULL)),
  CONSTRAINT creditors_not_self_merged_check
    CHECK (merged_into_creditor_id IS DISTINCT FROM creditor_id)
);

COMMENT ON TABLE public.creditors IS
  'Canonical creditor catalog (JANUS). creditor_id is the identity; display_name is presentation only.';
COMMENT ON COLUMN public.creditors.merged_into_creditor_id IS
  'Single hop only: target must not itself be merged (runtime fails closed otherwise).';

CREATE INDEX IF NOT EXISTS idx_creditors_merged_into
  ON public.creditors (merged_into_creditor_id)
  WHERE merged_into_creditor_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.creditors_guard_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.creditor_id IS DISTINCT FROM OLD.creditor_id OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'creditors.creditor_id and creditors.slug are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_creditors_guard_identity ON public.creditors;
CREATE TRIGGER trg_creditors_guard_identity
  BEFORE UPDATE ON public.creditors
  FOR EACH ROW EXECUTE FUNCTION public.creditors_guard_identity();

DROP TRIGGER IF EXISTS trg_creditors_updated_at ON public.creditors;
CREATE TRIGGER trg_creditors_updated_at
  BEFORE UPDATE ON public.creditors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- B. creditor_aliases: (source, normalized_key) → creditor. Exact lookup only.
--    Rows are never re-pointed: disable and insert a new row (audit trail).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.creditor_aliases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text NOT NULL,
  normalized_key   text NOT NULL,
  creditor_id      uuid NULL REFERENCES public.creditors (creditor_id),
  status           text NOT NULL,
  example_raw      text NULL,
  note             text NULL,
  approved_by      uuid NULL REFERENCES public.dashboard_users (id) ON DELETE SET NULL,
  approved_at      timestamptz NULL,
  disabled_by      uuid NULL REFERENCES public.dashboard_users (id) ON DELETE SET NULL,
  disabled_at      timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creditor_aliases_source_check
    CHECK (source IN ('bcu', 'miplan_declared')),
  CONSTRAINT creditor_aliases_status_check
    CHECK (status IN ('approved', 'ambiguous', 'disabled')),
  CONSTRAINT creditor_aliases_normalized_key_format_check
    CHECK (normalized_key ~ '^[a-z0-9]+( [a-z0-9]+)*$'),
  CONSTRAINT creditor_aliases_approved_target_check
    CHECK (status <> 'approved' OR creditor_id IS NOT NULL),
  CONSTRAINT creditor_aliases_ambiguous_target_check
    CHECK (status <> 'ambiguous' OR creditor_id IS NULL),
  CONSTRAINT creditor_aliases_disabled_at_check
    CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

COMMENT ON TABLE public.creditor_aliases IS
  'Exact (source, creditor_key_v1) → creditor. approved resolves; ambiguous = reviewed unknown; disabled = history.';
COMMENT ON COLUMN public.creditor_aliases.normalized_key IS
  'creditor_key_v1(raw). Frozen normalizer; a new version requires a re-key, not an in-place change.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_creditor_aliases_active_source_key
  ON public.creditor_aliases (source, normalized_key)
  WHERE status IN ('approved', 'ambiguous');

CREATE INDEX IF NOT EXISTS idx_creditor_aliases_creditor
  ON public.creditor_aliases (creditor_id)
  WHERE creditor_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.creditor_aliases_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.normalized_key IS DISTINCT FROM OLD.normalized_key
     OR NEW.creditor_id IS DISTINCT FROM OLD.creditor_id THEN
    RAISE EXCEPTION 'creditor_aliases rows are not re-pointed: disable and insert a new row';
  END IF;
  IF OLD.status = 'disabled' AND NEW.status <> 'disabled' THEN
    RAISE EXCEPTION 'disabled creditor_aliases rows cannot be re-enabled: insert a new row';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_creditor_aliases_guard_update ON public.creditor_aliases;
CREATE TRIGGER trg_creditor_aliases_guard_update
  BEFORE UPDATE ON public.creditor_aliases
  FOR EACH ROW EXECUTE FUNCTION public.creditor_aliases_guard_update();

-- ---------------------------------------------------------------------------
-- C. Access: backend (service_role) only.
-- ---------------------------------------------------------------------------

ALTER TABLE public.creditors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creditor_aliases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.creditors FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.creditor_aliases FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- D. BCU seed: one creditor per legacy canonical; one bcu alias per distinct key.
-- ---------------------------------------------------------------------------

INSERT INTO public.creditors (creditor_id, slug, display_name, status)
VALUES
  ('163e0226-599e-5bc2-8553-151379f66537', 'cash', 'CASH S.A.', 'active'),
  ('c541d904-9aae-5da3-b199-c2107d1dddb8', 'socur', 'SOCUR S.A.', 'active'),
  ('0039dcbe-0af2-5a2d-a025-3a94e072ed95', 'banco-santander', 'Banco Santander S.A.', 'active'),
  ('6a126a47-8b2a-5872-9a2c-527d0891b855', 'oca', 'OCA S.A.', 'active'),
  ('8d631ae7-c2f7-5844-b500-c87f01b38aae', 'retop', 'RETOP S.A.', 'active'),
  ('703c88c1-c296-5a10-86b1-9033b1b16044', 'bautzen', 'BAUTZEN S.A.', 'active'),
  ('f7301263-de28-5ba4-8cfe-c3af02ea9982', 'scotiabank-uruguay', 'Scotiabank Uruguay S.A.', 'active'),
  ('c6b6f643-a76e-59d3-8a8d-df833365c63f', 'floder', 'Floder S.A.', 'active'),
  ('aba4810d-3f3c-5e3a-8507-192b7d9a8cd5', 'pass-card', 'PASS CARD S.A.', 'active'),
  ('9d17be3d-44b8-5689-b2db-7476254cb8fa', 'anda', 'ANDA', 'active'),
  ('c4f5b28b-a68b-535e-9b1a-4844b0120569', 'bbva-uruguay', 'Banco Bilbao Vizcaya Argentaria Uruguay S.A.', 'active'),
  ('37ed5be1-7640-5b3d-863b-22931f35b81b', 'fucac-verde', 'FUCAC VERDE COOPERATIVA DE AHORRO Y CRÉDITO', 'active'),
  ('485edd12-a6ca-591b-a869-7c3f0faaedca', 'fucerep', 'Cooperativa de Ahorro y Crédito FUCEREP', 'active'),
  ('2153c7f3-0193-5a03-9055-c37ed08c4ca6', 'brou', 'Banco de la República Oriental del Uruguay', 'active'),
  ('d9269f73-7e34-5ed5-b600-452763fec8c0', 'administradora-soluciones-integrales', 'Administradora de Soluciones Integrales S.A.', 'active'),
  ('23e32bcd-6d59-560f-8bca-e8d17bfe6f8c', 'banco-itau-uruguay', 'Banco Itaú Uruguay S.A.', 'active')
ON CONFLICT (creditor_id) DO NOTHING;

INSERT INTO public.creditor_aliases
  (id, source, normalized_key, creditor_id, status, example_raw, note, approved_at)
VALUES
  ('fbab7b75-407a-5bc3-a1f2-0e51dcb8d7e9', 'bcu', 'cash sa', '163e0226-599e-5bc2-8553-151379f66537', 'approved', 'CASH S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('ee701800-92e3-5f96-b93c-3c96244ef24f', 'bcu', 'socur sa', 'c541d904-9aae-5da3-b199-c2107d1dddb8', 'approved', 'SOCUR S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('25c150e1-eb95-5805-9dfe-3f7284607361', 'bcu', 'banco santander sa', '0039dcbe-0af2-5a2d-a025-3a94e072ed95', 'approved', 'Banco Santander S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('619179c2-2894-532b-8cfa-12312c132443', 'bcu', 'oca sa', '6a126a47-8b2a-5872-9a2c-527d0891b855', 'approved', 'OCA S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('92c67cc1-a026-59e9-b95c-7335fbc4dba3', 'bcu', 'retop sa', '8d631ae7-c2f7-5844-b500-c87f01b38aae', 'approved', 'RETOP S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('0b6a87bc-bf7e-5ce9-b4d2-005917f572c8', 'bcu', 'bautzen sa', '703c88c1-c296-5a10-86b1-9033b1b16044', 'approved', 'BAUTZEN S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('09fd3b8b-b54d-52ff-b1db-207cdac29390', 'bcu', 'scotiabank uruguay sa', 'f7301263-de28-5ba4-8cfe-c3af02ea9982', 'approved', 'Scotiabank Uruguay S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('eb598c8d-7abb-5a49-b3e8-c83616cce9f8', 'bcu', 'floder sa', 'c6b6f643-a76e-59d3-8a8d-df833365c63f', 'approved', 'Floder S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('feeb1735-ad4d-5a61-bb5c-00616fffec5d', 'bcu', 'pass card sa', 'aba4810d-3f3c-5e3a-8507-192b7d9a8cd5', 'approved', 'PASS CARD S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('b5afbc4a-e3a0-5981-948b-219a53d0b28b', 'bcu', 'anda', '9d17be3d-44b8-5689-b2db-7476254cb8fa', 'approved', 'ANDA', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('8e48a9af-d785-5d13-bf5b-d12c71cf1d93', 'bcu', 'banco bilbao vizcaya argentaria uruguay sa', 'c4f5b28b-a68b-535e-9b1a-4844b0120569', 'approved', 'Banco Bilbao Vizcaya Argentaria Uruguay S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('9840787c-c903-561c-8497-8bbe51ff5cbc', 'bcu', 'fucac verde cooperativa de ahorro y credito', '37ed5be1-7640-5b3d-863b-22931f35b81b', 'approved', 'FUCAC VERDE COOPERATIVA DE AHORRO Y CRÉDITO', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('8ae764de-d491-5cb4-a535-d9d359670445', 'bcu', 'cooperativa de ahorro y credito fucerep', '485edd12-a6ca-591b-a869-7c3f0faaedca', 'approved', 'Cooperativa de Ahorro y Crédito FUCEREP', 'seed: legacy APPROVED_RAW_TO_CANONICAL', now()),
  ('9c62ecd6-b9d0-5482-a600-f750b2759114', 'bcu', 'banco de la republica oriental del uruguay', '2153c7f3-0193-5a03-9055-c37ed08c4ca6', 'approved', 'Banco de la República Oriental del Uruguay', 'seed: legacy APPROVED_RAW_TO_CANONICAL (2 case variants)', now()),
  ('bfbabae8-7390-5998-a09e-a2980bcedee2', 'bcu', 'administradora de soluciones integrales sa', 'd9269f73-7e34-5ed5-b600-452763fec8c0', 'approved', 'Administradora de Soluciones Integrales S.A.', 'seed: legacy APPROVED_RAW_TO_CANONICAL (2 case variants)', now()),
  ('90c30089-14cc-5aa6-b6f8-a15b906756b2', 'bcu', 'banco itau uruguay sa', '23e32bcd-6d59-560f-8bca-e8d17bfe6f8c', 'approved', 'Banco Itaú Uruguay SA', 'seed: legacy APPROVED_RAW_TO_CANONICAL (closed decision SA → S.A.)', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
