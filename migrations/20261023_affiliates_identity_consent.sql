-- Affiliate identity and consent (V1). Apply manually after
-- 20261022_affiliate_persist_plan.sql. Do not run from the app.
--
-- ci is unique when present and stays nullable: test affiliates and a future
-- external affiliate have no Credizona cédula. A real cédula still requires
-- documented acceptance. An active non-test row also requires acceptance, so
-- a NULL ci cannot be enabled without consent.
-- Existence of the cédula in cz_funnel_solicitudes is checked by the admin
-- route, not by a foreign key: solicitudes.ci is not unique.
--
-- Idempotent. No seed rows. Does not change attribution or prizes.

BEGIN;

ALTER TABLE public.affiliates
  ADD COLUMN IF NOT EXISTS ci bigint;

ALTER TABLE public.affiliates
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

ALTER TABLE public.affiliates
  ADD COLUMN IF NOT EXISTS acceptance_channel text;

ALTER TABLE public.affiliates
  ADD COLUMN IF NOT EXISTS terms_version text;

ALTER TABLE public.affiliates
  ADD COLUMN IF NOT EXISTS acceptance_evidence text;

COMMENT ON COLUMN public.affiliates.ci IS
  'Credizona cédula. Unique when present. NULL keeps test affiliates and a future external affiliate.';

COMMENT ON COLUMN public.affiliates.accepted_at IS
  'Server time when JANUS recorded the acceptance. Not a browser timestamp.';

COMMENT ON COLUMN public.affiliates.acceptance_channel IS
  'Where the acceptance was recorded. V1: dashboard or presencial.';

COMMENT ON COLUMN public.affiliates.terms_version IS
  'Version of the bases the person accepted.';

COMMENT ON COLUMN public.affiliates.acceptance_evidence IS
  'Locator for the acceptance evidence (note, file name, or URL). Not the document itself.';

CREATE UNIQUE INDEX IF NOT EXISTS affiliates_ci_unique
  ON public.affiliates (ci)
  WHERE ci IS NOT NULL;

CREATE INDEX IF NOT EXISTS cz_funnel_solicitudes_cz_click_idx
  ON public.cz_funnel_solicitudes ((tracking_data_summary->>'cz_click'))
  WHERE tracking_data_summary->>'cz_click' IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'affiliates_ci_positive_check'
      AND conrelid = 'public.affiliates'::regclass
  ) THEN
    ALTER TABLE public.affiliates
      ADD CONSTRAINT affiliates_ci_positive_check
      CHECK (ci IS NULL OR ci > 0)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'affiliates_acceptance_channel_check'
      AND conrelid = 'public.affiliates'::regclass
  ) THEN
    ALTER TABLE public.affiliates
      ADD CONSTRAINT affiliates_acceptance_channel_check
      CHECK (
        acceptance_channel IS NULL
        OR acceptance_channel IN ('dashboard', 'presencial')
      )
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'affiliates_terms_version_check'
      AND conrelid = 'public.affiliates'::regclass
  ) THEN
    ALTER TABLE public.affiliates
      ADD CONSTRAINT affiliates_terms_version_check
      CHECK (
        terms_version IS NULL
        OR (
          char_length(btrim(terms_version)) BETWEEN 1 AND 64
          AND terms_version ~ '^[A-Za-z0-9._-]+$'
        )
      )
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'affiliates_acceptance_evidence_check'
      AND conrelid = 'public.affiliates'::regclass
  ) THEN
    ALTER TABLE public.affiliates
      ADD CONSTRAINT affiliates_acceptance_evidence_check
      CHECK (
        acceptance_evidence IS NULL
        OR char_length(btrim(acceptance_evidence)) BETWEEN 1 AND 500
      )
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'affiliates_consent_required'
      AND conrelid = 'public.affiliates'::regclass
  ) THEN
    ALTER TABLE public.affiliates
      ADD CONSTRAINT affiliates_consent_required
      CHECK (
        is_test
        OR (
          ci IS NULL
          AND status <> 'active'
        )
        OR (
          accepted_at IS NOT NULL
          AND acceptance_channel IS NOT NULL
          AND char_length(btrim(acceptance_channel)) > 0
          AND terms_version IS NOT NULL
          AND char_length(btrim(terms_version)) > 0
          AND acceptance_evidence IS NOT NULL
          AND char_length(btrim(acceptance_evidence)) > 0
        )
      )
      NOT VALID;
  END IF;
END $$;

COMMIT;
