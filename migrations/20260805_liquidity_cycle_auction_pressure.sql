-- Persist daily auction-pressure ratios on liquidity_cycle_daily_log.
-- Apply manually in Supabase.

BEGIN;

ALTER TABLE public.liquidity_cycle_daily_log
  ADD COLUMN IF NOT EXISTS competitor_pressure_ratio DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS own_cpm_ratio DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS auction_pressure_index DOUBLE PRECISION;

COMMIT;
