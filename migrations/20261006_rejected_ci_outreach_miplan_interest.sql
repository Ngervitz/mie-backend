-- Mi Plan waitlist interest (Credizona rejected thank-you CTA "Me interesa, avísenme").
-- Apply manually in Supabase AFTER 20260904_rejected_ci_outreach.sql and
-- 20260925_miplan_handoff_tokens.sql, and BEFORE deploying the code that reads
-- these columns (Rechazados list/detail select them).
-- Additive and idempotent. No backfill. Does not touch mi_plan_status or Mi Deuda columns.

BEGIN;

ALTER TABLE public.rejected_ci_outreach
  ADD COLUMN IF NOT EXISTS mi_plan_interest_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS mi_plan_interest_source text NULL,
  ADD COLUMN IF NOT EXISTS mi_plan_interest_lrw text NULL,
  ADD COLUMN IF NOT EXISTS mi_plan_interest_cz_solicitud_id bigint NULL;

ALTER TABLE public.rejected_ci_outreach
  DROP CONSTRAINT IF EXISTS rejected_ci_outreach_mi_plan_interest_source_check;
ALTER TABLE public.rejected_ci_outreach
  ADD CONSTRAINT rejected_ci_outreach_mi_plan_interest_source_check
    CHECK (
      mi_plan_interest_source IS NULL
      OR mi_plan_interest_source IN ('credizona_rejected_thank_you')
    );

ALTER TABLE public.rejected_ci_outreach
  DROP CONSTRAINT IF EXISTS rejected_ci_outreach_mi_plan_interest_complete_check;
ALTER TABLE public.rejected_ci_outreach
  ADD CONSTRAINT rejected_ci_outreach_mi_plan_interest_complete_check
    CHECK ((mi_plan_interest_at IS NULL) = (mi_plan_interest_source IS NULL));

COMMENT ON COLUMN public.rejected_ci_outreach.mi_plan_interest_at IS
  'First time this CI asked to be notified when Mi Plan opens (server time). Set once; replays keep it. Independent of mi_plan_status and Mi Deuda.';

COMMENT ON COLUMN public.rejected_ci_outreach.mi_plan_interest_source IS
  'Where the first interest was registered. Only credizona_rejected_thank_you today.';

COMMENT ON COLUMN public.rejected_ci_outreach.mi_plan_interest_lrw IS
  'Credizona LRW of the episode whose handoff code registered the first interest (from miplan_handoff_tokens, never from the browser).';

COMMENT ON COLUMN public.rejected_ci_outreach.mi_plan_interest_cz_solicitud_id IS
  'Credizona solicitud id of that episode (from miplan_handoff_tokens).';

COMMIT;
