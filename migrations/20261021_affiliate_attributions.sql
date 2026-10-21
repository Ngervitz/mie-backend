-- Affiliate attribution (stage 3). Apply manually. Do not run from the app.
-- Does not alter cz_funnel_solicitudes or the funnel sync.
-- Idempotent. No seed rows. No prize rows.

BEGIN;

CREATE TABLE IF NOT EXISTS public.affiliate_attributions (
  cz_id              bigint PRIMARY KEY,
  ci                 bigint NULL,
  outcome            text NOT NULL,
  click_id           uuid NULL REFERENCES public.affiliate_clicks (click_id) ON DELETE RESTRICT,
  affiliate_id       uuid NULL REFERENCES public.affiliates (id) ON DELETE RESTRICT,
  occurred_at        timestamptz NULL,
  presentation_at    timestamptz NULL,
  presentation_text  text NULL,
  is_test            boolean NOT NULL DEFAULT false,
  prize_eligible     boolean NOT NULL DEFAULT false,
  evaluated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_attributions_outcome_check CHECK (
    outcome IN (
      'no_click',
      'unknown_click',
      'unknown_affiliate',
      'no_presentation_at',
      'no_occurred_at',
      'click_after_presentation',
      'expired',
      'no_ci',
      'click_ci_conflict',
      'ambiguous_fecha_reg',
      'blocked_ambiguous_history',
      'excluded_prior_solicitud',
      'other_affiliate',
      'attributed'
    )
  ),
  CONSTRAINT affiliate_attributions_no_test_prize_check CHECK (
    NOT (is_test AND prize_eligible)
  )
);

COMMENT ON TABLE public.affiliate_attributions IS
  'One evaluation per Credizona solicitud (cz_id), including non-attributions. The same cz_click may attribute several solicitudes of one cédula within 30 days. A click seen on more than one cédula is click_ci_conflict and is not an automatic remunerable attribution. Future prize, not implemented: one per granted loan that generates a Copanel commission, deduplicated by loan.';

COMMENT ON COLUMN public.affiliate_attributions.presentation_at IS
  'Instant from presentation_at with an explicit zone. Never a naive browser timestamp.';

COMMENT ON COLUMN public.affiliate_attributions.presentation_text IS
  'Original presentation_at text, including its offset.';

COMMENT ON COLUMN public.affiliate_attributions.is_test IS
  'Independent of prize_eligible. Copied from the affiliate. A test affiliate may be attributed and still never generates a prize.';

COMMENT ON COLUMN public.affiliate_attributions.prize_eligible IS
  'Independent of is_test and of outcome. An attributed real affiliate is not remunerable by itself. Stage 3 stores false. is_test can never be combined with prize_eligible.';

CREATE INDEX IF NOT EXISTS affiliate_attributions_ci_presentation_idx
  ON public.affiliate_attributions (ci, presentation_at);

CREATE INDEX IF NOT EXISTS affiliate_attributions_affiliate_idx
  ON public.affiliate_attributions (affiliate_id);

CREATE TABLE IF NOT EXISTS public.affiliate_originators (
  ci                      bigint PRIMARY KEY,
  affiliate_id            uuid NOT NULL REFERENCES public.affiliates (id) ON DELETE RESTRICT,
  first_cz_id             bigint NOT NULL UNIQUE REFERENCES public.affiliate_attributions (cz_id) ON DELETE RESTRICT,
  first_presentation_at   timestamptz NOT NULL,
  is_test                 boolean NOT NULL DEFAULT false,
  prize_eligible          boolean NOT NULL DEFAULT false,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_originators_no_test_prize_check CHECK (
    NOT (is_test AND prize_eligible)
  )
);

COMMENT ON TABLE public.affiliate_originators IS
  'Provisional originator per cédula: affiliate of the earliest attributable solicitud by (presentation_at, cz_id). Recomputed when an earlier solicitud arrives. Not a certificate that the cédula is new outside cz_funnel_solicitudes. Stage 3 does not pay prizes. is_test never pays a prize.';

CREATE INDEX IF NOT EXISTS affiliate_originators_affiliate_idx
  ON public.affiliate_originators (affiliate_id);

ALTER TABLE public.affiliate_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_originators ENABLE ROW LEVEL SECURITY;

-- No policies. RLS default-deny blocks anon and authenticated.
REVOKE ALL ON TABLE public.affiliate_attributions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.affiliate_originators FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.affiliate_attributions TO service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.affiliate_attributions FROM service_role;

-- DELETE only so a recomputed cédula can drop a provisional originator.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_originators TO service_role;
REVOKE TRUNCATE ON TABLE public.affiliate_originators FROM service_role;

COMMIT;
