-- Ad-level Meta insights (form_step_3), one row per entity × ad × metric_date.
-- Apply manually in Supabase after review. Do not run from deploy.
--
-- Verified against production (read-only, 2026-10-15):
--   public.own_ad_metrics columns + types
--   public.own_ad_metric_runs.run_id uuid PK
--   public.monitored_entities.id uuid PK
--   Dashboard Meta agent reads via PostgREST + anon key (SELECT only).
--   Backend collector writes via service_role (bypasses RLS).
--
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS public.own_ad_ad_metrics;

BEGIN;

CREATE TABLE IF NOT EXISTS public.own_ad_ad_metrics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL REFERENCES public.monitored_entities(id),
  run_id          uuid NOT NULL REFERENCES public.own_ad_metric_runs(run_id),
  campaign_id     text NOT NULL,
  campaign_name   text NULL,
  ad_id           text NOT NULL,
  ad_name         text NULL,
  metric_date     date NOT NULL,
  spend           numeric NULL,
  impressions     bigint NULL,
  clicks          bigint NULL,
  actions         numeric NULL,
  actions_value   numeric NULL,
  raw_json        jsonb NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT own_ad_ad_metrics_entity_ad_date_key
    UNIQUE (entity_id, ad_id, metric_date)
);

COMMENT ON TABLE public.own_ad_ad_metrics IS
  'Meta Marketing API insights at ad level (time_increment=1). Not used for funnel or liquidity spend.';

CREATE INDEX IF NOT EXISTS idx_own_ad_ad_metrics_campaign_date
  ON public.own_ad_ad_metrics (entity_id, campaign_id, metric_date);

CREATE INDEX IF NOT EXISTS idx_own_ad_ad_metrics_entity_date
  ON public.own_ad_ad_metrics (entity_id, metric_date DESC);

ALTER TABLE public.own_ad_ad_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_anon_select_own_ad_ad_metrics ON public.own_ad_ad_metrics;

CREATE POLICY allow_anon_select_own_ad_ad_metrics
  ON public.own_ad_ad_metrics
  FOR SELECT
  TO anon
  USING (true);

REVOKE ALL ON TABLE public.own_ad_ad_metrics FROM PUBLIC;
REVOKE ALL ON TABLE public.own_ad_ad_metrics FROM anon;
REVOKE ALL ON TABLE public.own_ad_ad_metrics FROM authenticated;

GRANT SELECT ON TABLE public.own_ad_ad_metrics TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.own_ad_ad_metrics TO service_role;

COMMIT;

-- Post-apply verification (run manually in SQL editor; expect all checks true):
--
-- SELECT
--   has_table_privilege('anon', 'public.own_ad_ad_metrics', 'SELECT') AS anon_select,
--   has_table_privilege('anon', 'public.own_ad_ad_metrics', 'INSERT') AS anon_insert,
--   has_table_privilege('anon', 'public.own_ad_ad_metrics', 'UPDATE') AS anon_update,
--   has_table_privilege('anon', 'public.own_ad_ad_metrics', 'DELETE') AS anon_delete,
--   has_table_privilege('authenticated', 'public.own_ad_ad_metrics', 'SELECT') AS auth_select,
--   has_table_privilege('service_role', 'public.own_ad_ad_metrics', 'SELECT') AS svc_select,
--   has_table_privilege('service_role', 'public.own_ad_ad_metrics', 'INSERT') AS svc_insert,
--   has_table_privilege('service_role', 'public.own_ad_ad_metrics', 'UPDATE') AS svc_update;
--
-- Expected:
--   anon_select = true
--   anon_insert, anon_update, anon_delete = false
--   auth_select = false
--   svc_select, svc_insert, svc_update = true
