-- BCU USD/UYU daily close (currency 2225, TCV = sell).
-- Apply manually in Supabase.
-- Do NOT replace cz_funnel_channel_utility_live in this file.

BEGIN;

CREATE TABLE IF NOT EXISTS public.bcu_usd_uyu_daily (
  rate_date  date PRIMARY KEY,
  buy        numeric(12, 6) NOT NULL CHECK (buy > 0),
  sell       numeric(12, 6) NOT NULL CHECK (sell > 0),
  fetched_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bcu_usd_uyu_daily IS
  'Official BCU USD/UYU close. One row per published business day. Always currency 2225 (DLS. USA BILLETE). sell = TCV (venta), used by cz_funnel_channel_utility_live only. Weekends/holidays are omitted; consumers carry forward last rate_date <= target date. Not usura.';

COMMENT ON COLUMN public.bcu_usd_uyu_daily.rate_date IS
  'BCU SOAP Fecha (Uruguay calendar day).';

COMMENT ON COLUMN public.bcu_usd_uyu_daily.buy IS
  'TCC (compra). Stored; Funnel CZ conversion uses sell.';

COMMENT ON COLUMN public.bcu_usd_uyu_daily.sell IS
  'TCV (venta). Multiplier USD → UYU in cz_funnel_channel_utility_live.';

COMMIT;
