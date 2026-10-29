-- SMS campaign commercial vertical + communication purpose.
-- Apply manually in Supabase (NOT production until authorized).
-- Historical backfill uses explicit campaign id registry only (no name/url heuristics).

BEGIN;

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS vertical text;

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS purpose text;

-- ---------------------------------------------------------------------------
-- 1. Explicit affiliate OTP / transactional buckets
--    Keep in sync with src/lib/smsCampaignHistoricalRegistry.js
-- ---------------------------------------------------------------------------

UPDATE public.sms_campaigns
SET vertical = 'affiliates',
    purpose = 'transactional'
WHERE id IN (
  '62894481-1b47-4f73-b8c0-f9515d3bb943'::uuid,
  'd0446992-7dd9-428a-a052-f7091a184b02'::uuid
);

-- ---------------------------------------------------------------------------
-- 2. Explicit SMS engine / internal test campaigns (loans + purpose=test)
-- ---------------------------------------------------------------------------

UPDATE public.sms_campaigns
SET vertical = 'loans',
    purpose = 'test'
WHERE id IN (
  'ee3285f6-40f6-4866-b208-63a37cf33696'::uuid,
  'ecc608f1-8297-436f-9278-4ecd9029d2e2'::uuid,
  '3501584d-5e66-4e23-90dc-52e138284476'::uuid,
  '9efe67e6-e557-4529-8cbf-e4fae030c534'::uuid,
  'ad31c33a-f4d9-42de-ada3-0e5144bf5b11'::uuid,
  'a803c8d7-a1ee-4df3-8d8f-7f5f22ad48f2'::uuid,
  '9912a496-189a-4481-88e5-453cc826205a'::uuid,
  '22aaedf3-d9a4-427b-8519-ac78e5145e0b'::uuid,
  'd2b7f687-ee5e-4f26-b91a-78f26497d71c'::uuid,
  'd6cec290-a343-4fed-9ee1-d9825b34fc53'::uuid,
  'a5651b31-11a7-4814-85d9-db37c3418da2'::uuid,
  'b024cd01-3cb2-4e54-8e75-3c7f168c2e5b'::uuid
);

-- ---------------------------------------------------------------------------
-- 3. Default: loan reactivation for all remaining null rows
--    (includes 87609495-e408-4273-b012-e40f25cbd1e7 Campania 1 CZ 50)
-- ---------------------------------------------------------------------------

UPDATE public.sms_campaigns
SET vertical = 'loans'
WHERE vertical IS NULL;

UPDATE public.sms_campaigns
SET purpose = 'loan_reactivation'
WHERE purpose IS NULL;

ALTER TABLE public.sms_campaigns
  ALTER COLUMN vertical SET DEFAULT 'loans';

ALTER TABLE public.sms_campaigns
  ALTER COLUMN vertical SET NOT NULL;

ALTER TABLE public.sms_campaigns
  ALTER COLUMN purpose SET DEFAULT 'loan_reactivation';

ALTER TABLE public.sms_campaigns
  ALTER COLUMN purpose SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_campaigns_vertical_check'
  ) THEN
    ALTER TABLE public.sms_campaigns
      ADD CONSTRAINT sms_campaigns_vertical_check
      CHECK (vertical IN ('loans', 'affiliates', 'insurance', 'ecommerce'));
  END IF;
END
$$;

DO $$
BEGIN
  ALTER TABLE public.sms_campaigns DROP CONSTRAINT IF EXISTS sms_campaigns_purpose_check;
  ALTER TABLE public.sms_campaigns
    ADD CONSTRAINT sms_campaigns_purpose_check
    CHECK (
      purpose IN (
        'loan_reactivation',
        'affiliate_program_invite',
        'transactional',
        'test',
        'affiliate_otp',
        'insurance_outreach',
        'ecommerce_outreach'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

UPDATE public.sms_campaigns
SET purpose = 'transactional'
WHERE purpose = 'affiliate_otp';

COMMENT ON COLUMN public.sms_campaigns.vertical IS
  'Commercial vertical: loans, affiliates, insurance, ecommerce. Independent of campaign_series_id.';

COMMENT ON COLUMN public.sms_campaigns.purpose IS
  'Communication purpose. transactional/test excluded from JT commercial funnel metrics; still in spend.';

CREATE INDEX IF NOT EXISTS sms_campaigns_vertical_created_at_idx
  ON public.sms_campaigns (vertical, created_at DESC);

CREATE INDEX IF NOT EXISTS sms_campaigns_vertical_purpose_idx
  ON public.sms_campaigns (vertical, purpose);

COMMIT;
