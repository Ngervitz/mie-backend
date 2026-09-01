-- SMS performance analytics RPC.
-- Computes aggregated funnel metrics by campaign, cohort month, and overall (America/Montevideo).
-- Guaranteed COUNT(DISTINCT cz_id) and distinct impacts across each granularity level.
-- Idempotent, read-only analytics function.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_sms_performance_analytics(
  p_series_id uuid DEFAULT NULL,
  p_campaign_id uuid DEFAULT NULL
)
RETURNS TABLE (
  aggregation_level text,
  campaign_id uuid,
  campaign_name text,
  campaign_series_id uuid,
  campaign_series_name text,
  cohort_month text,
  messages_sent bigint,
  messages_delivered bigint,
  total_impacts bigint,
  total_clicks bigint,
  total_form_step_1 bigint,
  total_form_step_2 bigint,
  total_form_step_3 bigint,
  impacts_with_solicitud bigint,
  total_solicitudes bigint,
  first_sms_at timestamptz,
  last_sms_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
WITH base_sms AS (
  SELECT
    m.unique_id,
    m.campaign_id,
    c.name AS campaign_name,
    c.campaign_series_id,
    ser.name AS campaign_series_name,
    m.status AS message_status,
    m.created_at AS sms_created_at,
    to_char(m.created_at AT TIME ZONE 'America/Montevideo', 'YYYY-MM') AS cohort_month,
    m.marketing_impact_id,
    i.tracking_token
  FROM public.sms_messages m
  JOIN public.sms_campaigns c ON c.id = m.campaign_id
  LEFT JOIN public.marketing_campaign_series ser ON ser.id = c.campaign_series_id
  LEFT JOIN public.marketing_impacts i ON i.id = m.marketing_impact_id
  WHERE (p_series_id IS NULL OR c.campaign_series_id = p_series_id)
    AND (p_campaign_id IS NULL OR c.id = p_campaign_id)
),
sms_events AS (
  -- Pre-agregación 1:1 por impacto para evitar duplicaciones de eventos
  SELECT
    ev.impact_id,
    bool_or(ev.event_name = 'click') AS has_click,
    bool_or(ev.event_name = 'form_step_1') AS has_step_1,
    bool_or(ev.event_name = 'form_step_2') AS has_step_2,
    bool_or(ev.event_name = 'form_step_3') AS has_step_3
  FROM public.marketing_impact_events ev
  WHERE ev.impact_id IN (
    SELECT DISTINCT marketing_impact_id FROM base_sms WHERE marketing_impact_id IS NOT NULL
  )
  GROUP BY ev.impact_id
),
solicitudes_per_impact AS (
  -- Conteo de solicitudes por token (para saber si el impacto individual generó >= 1 solicitud)
  SELECT
    s.tracking_data_summary->>'jt' AS tracking_token,
    COUNT(DISTINCT s.cz_id) AS cnt_solicitudes
  FROM public.cz_funnel_solicitudes s
  WHERE s.tracking_data_summary->>'jt' IN (
    SELECT DISTINCT tracking_token FROM base_sms WHERE tracking_token IS NOT NULL
  )
  GROUP BY s.tracking_data_summary->>'jt'
),
solicitudes_campaign AS (
  -- Conteo DISTINCT cz_id por campaña y mes
  SELECT
    b.campaign_id,
    b.cohort_month,
    COUNT(DISTINCT s.cz_id) AS total_solicitudes
  FROM base_sms b
  JOIN public.cz_funnel_solicitudes s
    ON (s.tracking_data_summary->>'jt') = b.tracking_token
  WHERE b.tracking_token IS NOT NULL
  GROUP BY b.campaign_id, b.cohort_month
),
solicitudes_month AS (
  -- Conteo DISTINCT cz_id a nivel mensual
  SELECT
    b.cohort_month,
    COUNT(DISTINCT s.cz_id) AS total_solicitudes
  FROM base_sms b
  JOIN public.cz_funnel_solicitudes s
    ON (s.tracking_data_summary->>'jt') = b.tracking_token
  WHERE b.tracking_token IS NOT NULL
  GROUP BY b.cohort_month
),
solicitudes_overall AS (
  -- Conteo DISTINCT cz_id a nivel global
  SELECT
    COUNT(DISTINCT s.cz_id) AS total_solicitudes
  FROM base_sms b
  JOIN public.cz_funnel_solicitudes s
    ON (s.tracking_data_summary->>'jt') = b.tracking_token
  WHERE b.tracking_token IS NOT NULL
),
campaign_level AS (
  SELECT
    'campaign'::text AS aggregation_level,
    b.campaign_id,
    b.campaign_name,
    b.campaign_series_id,
    b.campaign_series_name,
    b.cohort_month,
    COUNT(b.unique_id)::bigint AS messages_sent,
    COALESCE(SUM(CASE WHEN lower(b.message_status) = 'delivered' THEN 1 ELSE 0 END), 0)::bigint AS messages_delivered,
    COUNT(DISTINCT b.marketing_impact_id)::bigint AS total_impacts,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_click)::bigint AS total_clicks,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_step_1)::bigint AS total_form_step_1,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_step_2)::bigint AS total_form_step_2,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_step_3)::bigint AS total_form_step_3,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE COALESCE(spi.cnt_solicitudes, 0) > 0)::bigint AS impacts_with_solicitud,
    COALESCE(sc.total_solicitudes, 0)::bigint AS total_solicitudes,
    MIN(b.sms_created_at) AS first_sms_at,
    MAX(b.sms_created_at) AS last_sms_at
  FROM base_sms b
  LEFT JOIN sms_events e ON e.impact_id = b.marketing_impact_id
  LEFT JOIN solicitudes_per_impact spi ON spi.tracking_token = b.tracking_token
  LEFT JOIN solicitudes_campaign sc
    ON sc.campaign_id = b.campaign_id AND sc.cohort_month = b.cohort_month
  GROUP BY
    b.campaign_id,
    b.campaign_name,
    b.campaign_series_id,
    b.campaign_series_name,
    b.cohort_month,
    sc.total_solicitudes
),
month_level AS (
  SELECT
    'month'::text AS aggregation_level,
    NULL::uuid AS campaign_id,
    NULL::text AS campaign_name,
    NULL::uuid AS campaign_series_id,
    NULL::text AS campaign_series_name,
    b.cohort_month,
    COUNT(b.unique_id)::bigint AS messages_sent,
    COALESCE(SUM(CASE WHEN lower(b.message_status) = 'delivered' THEN 1 ELSE 0 END), 0)::bigint AS messages_delivered,
    COUNT(DISTINCT b.marketing_impact_id)::bigint AS total_impacts,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_click)::bigint AS total_clicks,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_step_1)::bigint AS total_form_step_1,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_step_2)::bigint AS total_form_step_2,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_step_3)::bigint AS total_form_step_3,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE COALESCE(spi.cnt_solicitudes, 0) > 0)::bigint AS impacts_with_solicitud,
    COALESCE(sm.total_solicitudes, 0)::bigint AS total_solicitudes,
    MIN(b.sms_created_at) AS first_sms_at,
    MAX(b.sms_created_at) AS last_sms_at
  FROM base_sms b
  LEFT JOIN sms_events e ON e.impact_id = b.marketing_impact_id
  LEFT JOIN solicitudes_per_impact spi ON spi.tracking_token = b.tracking_token
  LEFT JOIN solicitudes_month sm ON sm.cohort_month = b.cohort_month
  GROUP BY
    b.cohort_month,
    sm.total_solicitudes
),
overall_level AS (
  SELECT
    'overall'::text AS aggregation_level,
    NULL::uuid AS campaign_id,
    NULL::text AS campaign_name,
    NULL::uuid AS campaign_series_id,
    NULL::text AS campaign_series_name,
    NULL::text AS cohort_month,
    COUNT(b.unique_id)::bigint AS messages_sent,
    COALESCE(SUM(CASE WHEN lower(b.message_status) = 'delivered' THEN 1 ELSE 0 END), 0)::bigint AS messages_delivered,
    COUNT(DISTINCT b.marketing_impact_id)::bigint AS total_impacts,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_click)::bigint AS total_clicks,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_step_1)::bigint AS total_form_step_1,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_step_2)::bigint AS total_form_step_2,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE e.has_step_3)::bigint AS total_form_step_3,
    COUNT(DISTINCT b.marketing_impact_id) FILTER (WHERE COALESCE(spi.cnt_solicitudes, 0) > 0)::bigint AS impacts_with_solicitud,
    COALESCE(so.total_solicitudes, 0)::bigint AS total_solicitudes,
    MIN(b.sms_created_at) AS first_sms_at,
    MAX(b.sms_created_at) AS last_sms_at
  FROM base_sms b
  LEFT JOIN sms_events e ON e.impact_id = b.marketing_impact_id
  LEFT JOIN solicitudes_per_impact spi ON spi.tracking_token = b.tracking_token
  LEFT JOIN solicitudes_overall so ON true
  GROUP BY so.total_solicitudes
)
SELECT *
FROM (
  SELECT * FROM campaign_level
  UNION ALL
  SELECT * FROM month_level
  UNION ALL
  SELECT * FROM overall_level
) AS analytics_rows
ORDER BY
  CASE aggregation_level
    WHEN 'overall' THEN 1
    WHEN 'month' THEN 2
    WHEN 'campaign' THEN 3
    ELSE 4
  END,
  cohort_month DESC NULLS LAST,
  campaign_name ASC NULLS LAST;
$$;

COMMENT ON FUNCTION public.get_sms_performance_analytics(uuid, uuid) IS
  'Aggregated SMS performance and conversion metrics by campaign, cohort month, and overall (America/Montevideo).';

COMMIT;
