-- C1: S1 "Repetido. Aprobado" (elm_s1_duplicate_other_channel) ends in CZ 3 without review.
-- NOT APPLIED. Apply manually in Supabase BEFORE deploying the code that finalizes it as
-- rejected (src/services/providerFallback/outcome.js): until then provider_fallback_finalize
-- refuses that outcome (provider_fallback_rejection_not_definitive) and the job keeps retrying.
-- Idempotent.
--
-- Same provider_fallback_definitive_rejection_reasons() (20261010_provider_fallback_c1_events.sql)
-- plus 'elm_s1_duplicate_other_channel': the client is already approved by another ELM channel and
-- Copanel has nothing to manage. Not an ELM credit rejection: the commercial reading stays closed
-- "Duplicado · Otro canal" (src/services/elm/classification.js). Mirrored by
-- DEFINITIVE_REJECTION_REASONS (src/services/providerFallback/constants.js).
-- No table, row, other function or grant changes; requests and review cases already finalized
-- (e.g. CZ 1460 in 14) stay as they are.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.provider_fallback_definitive_rejection_reasons()') IS NULL THEN
    RAISE EXCEPTION 'precondition_failed: apply 20261010_provider_fallback_c1_events.sql first';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.provider_fallback_definitive_rejection_reasons()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'elm_s1_rejected', 'elm_s2_rejected', 'ci_monthly_quota_used',
    'elm_missing_required_fields', 'elm_date_of_birth_invalid', 'elm_mobilephone_invalid',
    'elm_salary_invalid', 'elm_s1_duplicate_other_channel'
  ]::text[];
$$;

REVOKE ALL ON FUNCTION public.provider_fallback_definitive_rejection_reasons() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_fallback_definitive_rejection_reasons() TO service_role;

COMMIT;
