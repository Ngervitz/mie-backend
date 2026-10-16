-- C1: a locally invalid cellphone is never a commercial rejection (CZ 3).
-- JANUS maps it to manual_review / elm_mobilephone_needs_correction / estado 14.
-- This replaces provider_fallback_definitive_rejection_reasons() so SQL refuses
-- not_eligible|rejected with the legacy code elm_mobilephone_invalid.
-- Production currently also lists elm_s1_duplicate_other_channel (20261015); that
-- code stays. Only elm_mobilephone_invalid is removed.
-- Same signature as the live function: owner and EXECUTE grants are preserved.
-- Not applied to production until authorized.

CREATE OR REPLACE FUNCTION public.provider_fallback_definitive_rejection_reasons()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'elm_s1_rejected', 'elm_s2_rejected', 'ci_monthly_quota_used',
    'elm_missing_required_fields', 'elm_date_of_birth_invalid',
    'elm_salary_invalid', 'elm_s1_duplicate_other_channel'
  ]::text[];
$$;

COMMENT ON FUNCTION public.provider_fallback_definitive_rejection_reasons() IS
  'Reasons allowed for rejected / not_eligible (CZ 3). Local cellphone format errors are not listed: they go to manual_review. elm_s1_duplicate_other_channel stays definitive.';
