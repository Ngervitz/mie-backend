-- Liquidity cycle daily log + BCU usura rate history.
-- Apply manually in Supabase.
-- Deduped spend helper uses DISTINCT ON (campaign_id, metric_date) — never sum raw own_ad_metrics.

BEGIN;

CREATE TABLE IF NOT EXISTS public.liquidity_cycle_daily_log (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  log_date          date NOT NULL UNIQUE,
  cycle_phase       text NOT NULL
    CHECK (cycle_phase IN ('alta_demanda', 'mitad_mes', 'cierre_mes')),
  day_of_month      integer NOT NULL,
  meta_spend_day    numeric(12, 2),
  spend_source_note text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.liquidity_cycle_daily_log.meta_spend_day IS
  'Sum of own_ad_metrics.spend for log_date after DISTINCT ON (campaign_id, metric_date) ORDER BY created_at DESC. Avoids double-count across runs.';
COMMENT ON COLUMN public.liquidity_cycle_daily_log.cycle_phase IS
  'alta_demanda=days 1-7; mitad_mes=8-22; cierre_mes=23-31 (America/Montevideo day-of-month).';

CREATE INDEX IF NOT EXISTS idx_liquidity_cycle_daily_log_date_desc
  ON public.liquidity_cycle_daily_log (log_date DESC);

CREATE TABLE IF NOT EXISTS public.bcu_usura_rate_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_percent    numeric(5, 2) NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  source_note     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.bcu_usura_rate_history.effective_to IS
  'NULL means currently effective. Closed when a newer rate is inserted.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_bcu_usura_one_current
  ON public.bcu_usura_rate_history ((effective_to IS NULL))
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_bcu_usura_effective_from
  ON public.bcu_usura_rate_history (effective_from DESC);

-- Safe daily spend: one row per campaign for the date (newest created_at wins), then SUM.
CREATE OR REPLACE FUNCTION public.sum_deduped_own_ad_spend(p_metric_date date)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(d.spend), 0)::numeric
  FROM (
    SELECT DISTINCT ON (m.campaign_id, m.metric_date) m.spend
    FROM public.own_ad_metrics m
    WHERE m.metric_date = p_metric_date
    ORDER BY m.campaign_id, m.metric_date, m.created_at DESC
  ) d;
$$;

COMMENT ON FUNCTION public.sum_deduped_own_ad_spend(date) IS
  'SUM(spend) after DISTINCT ON (campaign_id, metric_date) ORDER BY created_at DESC. Required — raw SUM double-counts multi-run rows.';

-- Spec: timezone('America/Montevideo', now() - interval '1 day')::date
CREATE OR REPLACE FUNCTION public.montevideo_yesterday()
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT (timezone('America/Montevideo', now() - interval '1 day'))::date;
$$;

-- Atomic BCU rate insert: validate, close previous current, insert new current.
CREATE OR REPLACE FUNCTION public.insert_bcu_usura_rate(
  p_rate_percent numeric,
  p_effective_from date,
  p_source_note text DEFAULT NULL
)
RETURNS public.bcu_usura_rate_history
LANGUAGE plpgsql
AS $$
DECLARE
  v_current public.bcu_usura_rate_history%ROWTYPE;
  v_inserted public.bcu_usura_rate_history%ROWTYPE;
BEGIN
  IF p_rate_percent IS NULL OR p_effective_from IS NULL THEN
    RAISE EXCEPTION 'rate_percent and effective_from are required';
  END IF;

  SELECT * INTO v_current
  FROM public.bcu_usura_rate_history
  WHERE effective_to IS NULL
  ORDER BY effective_from DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF p_effective_from <= v_current.effective_from THEN
      RAISE EXCEPTION
        'effective_from (%) must be strictly greater than current effective_from (%)',
        p_effective_from,
        v_current.effective_from;
    END IF;

    UPDATE public.bcu_usura_rate_history
    SET effective_to = p_effective_from - 1
    WHERE id = v_current.id;
  END IF;

  INSERT INTO public.bcu_usura_rate_history (
    rate_percent,
    effective_from,
    effective_to,
    source_note
  )
  VALUES (
    p_rate_percent,
    p_effective_from,
    NULL,
    p_source_note
  )
  RETURNING * INTO v_inserted;

  RETURN v_inserted;
END;
$$;

COMMIT;
