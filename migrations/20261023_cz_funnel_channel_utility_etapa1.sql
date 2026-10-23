-- Etapa 1: channel classification for cz_funnel_channel_utility_live.
-- Body taken from the live Supabase definition (pg_get_viewdef, 2026-10-23).
-- Only the grant channel CASE and the channels list change.
-- Revenue, utility, Meta spend, SMS spend, missing BCU rates, and the
-- solicitud-to-grant lateral join are unchanged.
-- NOT APPLIED. Do not run until explicitly authorized.

BEGIN;

CREATE OR REPLACE VIEW public.cz_funnel_channel_utility_live AS
WITH params AS (
  SELECT 'v1'::text AS attribution_version
),
granted_attributed AS (
  SELECT
    g.cz_id,
    g.monto_otorgado,
    date_trunc(
      'month'::text,
      timezone('America/Montevideo'::text, g.updated_at_src)
    )::date AS period_month,
    CASE
      WHEN lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'attribution_source'::text, ''::text))) = 'paid_unqualified'::text
        THEN 'origen_no_confirmado'::text
      WHEN lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_source'::text, ''::text))) = 'meta'::text
       AND lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_medium'::text, ''::text))) = 'paid_social'::text
        THEN 'meta'::text
      WHEN lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_source'::text, ''::text))) = 'fb'::text
       AND lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_medium'::text, ''::text))) = 'paid'::text
        THEN 'meta'::text
      WHEN lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_source'::text, ''::text))) = 'ig'::text
       AND lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_medium'::text, ''::text))) = 'paid'::text
        THEN 'meta'::text
      WHEN lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_source'::text, ''::text))) = ANY (ARRAY['facebook'::text, 'instagram'::text, 'ig'::text])
       AND lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_medium'::text, ''::text))) = 'organic_social'::text
        THEN 'social_organico'::text
      WHEN lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_source'::text, ''::text))) = 'ig'::text
       AND lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_medium'::text, ''::text))) = 'social'::text
        THEN 'social_no_confirmado'::text
      WHEN lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_source'::text, ''::text))) = ANY (ARRAY['google'::text, 'bing'::text])
       AND lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_medium'::text, ''::text))) = 'organic_search'::text
        THEN 'busqueda_organica'::text
      WHEN lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_source'::text, ''::text))) = 'sms'::text
       AND lower(TRIM(BOTH FROM coalesce(s.tracking_data_summary ->> 'utm_medium'::text, ''::text))) = 'sms'::text
        THEN 'sms'::text
      ELSE 'sin_atribuir'::text
    END AS channel
  FROM public.cz_funnel_granted_loans g
  LEFT JOIN LATERAL (
    SELECT s0.tracking_data_summary
    FROM public.cz_funnel_solicitudes s0
    WHERE s0.ci IS NOT NULL
      AND g.ci IS NOT NULL
      AND s0.ci = g.ci
      AND s0.fecha_reg IS NOT NULL
      AND g.updated_at_src IS NOT NULL
      AND s0.fecha_reg <= g.updated_at_src
    ORDER BY s0.fecha_reg DESC, s0.cz_id DESC
    LIMIT 1
  ) s ON true
  WHERE g.updated_at_src IS NOT NULL
),
revenue_by_month_channel AS (
  SELECT
    granted_attributed.period_month,
    granted_attributed.channel,
    count(*)::integer AS granted_count,
    COALESCE(sum(granted_attributed.monto_otorgado), 0::numeric) AS monto_total_otorgado
  FROM granted_attributed
  GROUP BY granted_attributed.period_month, granted_attributed.channel
),
meta_spend_days AS (
  SELECT
    d.metric_date,
    COALESCE(sum(d.spend), 0::numeric) AS spend_usd
  FROM (
    SELECT DISTINCT ON (m.campaign_id, m.metric_date)
      m.metric_date,
      m.spend
    FROM public.own_ad_metrics m
    ORDER BY m.campaign_id, m.metric_date, m.created_at DESC
  ) d
  GROUP BY d.metric_date
),
meta_spend_converted AS (
  SELECT
    s.metric_date,
    s.spend_usd,
    (
      SELECT r_1.sell
      FROM public.bcu_usd_uyu_daily r_1
      WHERE r_1.rate_date <= s.metric_date
      ORDER BY r_1.rate_date DESC
      LIMIT 1
    ) AS sell
  FROM meta_spend_days s
),
meta_spend_by_month AS (
  SELECT
    date_trunc('month'::text, c.metric_date::timestamp with time zone)::date AS period_month,
    CASE
      WHEN bool_or(c.sell IS NULL) THEN NULL::numeric
      ELSE COALESCE(sum(c.spend_usd * c.sell), 0::numeric)
    END AS spend
  FROM meta_spend_converted c
  GROUP BY (date_trunc('month'::text, c.metric_date::timestamp with time zone)::date)
),
sms_delivered_by_month AS (
  SELECT
    date_trunc(
      'month'::text,
      timezone('America/Montevideo'::text, m.delivered_at)
    )::date AS period_month,
    count(*)::integer AS messages_delivered
  FROM public.sms_messages m
  WHERE m.delivered_at IS NOT NULL
    AND m.status = 'DELIVERED'::text
  GROUP BY (date_trunc('month'::text, timezone('America/Montevideo'::text, m.delivered_at))::date)
),
sms_spend_by_month AS (
  SELECT
    d.period_month,
    d.messages_delivered::numeric * cfg.cost_per_sms_ex_vat AS spend
  FROM sms_delivered_by_month d
  JOIN LATERAL (
    SELECT c.cost_per_sms_ex_vat
    FROM public.sms_cost_config c
    WHERE c.effective_from <= (d.period_month + '1 mon'::interval - '1 day'::interval)::date
    ORDER BY c.effective_from DESC
    LIMIT 1
  ) cfg ON true
),
months AS (
  SELECT revenue_by_month_channel.period_month
  FROM revenue_by_month_channel
  UNION
  SELECT meta_spend_by_month.period_month
  FROM meta_spend_by_month
  UNION
  SELECT sms_spend_by_month.period_month
  FROM sms_spend_by_month
),
channels AS (
  SELECT unnest(ARRAY[
    'meta'::text,
    'sms'::text,
    'social_organico'::text,
    'social_no_confirmado'::text,
    'busqueda_organica'::text,
    'origen_no_confirmado'::text,
    'sin_atribuir'::text
  ]) AS channel
)
SELECT
  mo.period_month,
  ch.channel,
  p.attribution_version,
  COALESCE(r.granted_count, 0) AS granted_count,
  COALESCE(r.monto_total_otorgado, 0::numeric) AS monto_total_otorgado,
  COALESCE(r.monto_total_otorgado, 0::numeric) * 0.06 AS revenue,
  CASE ch.channel
    WHEN 'meta'::text THEN
      CASE
        WHEN ms.period_month IS NULL THEN 0::numeric
        ELSE ms.spend
      END
    WHEN 'sms'::text THEN COALESCE(ss.spend, 0::numeric)
    ELSE 0::numeric
  END AS spend,
  COALESCE(r.monto_total_otorgado, 0::numeric) * 0.06
    - CASE ch.channel
        WHEN 'meta'::text THEN
          CASE
            WHEN ms.period_month IS NULL THEN 0::numeric
            ELSE ms.spend
          END
        WHEN 'sms'::text THEN COALESCE(ss.spend, 0::numeric)
        ELSE 0::numeric
      END AS utility
FROM months mo
CROSS JOIN channels ch
CROSS JOIN params p
LEFT JOIN revenue_by_month_channel r
  ON r.period_month = mo.period_month AND r.channel = ch.channel
LEFT JOIN meta_spend_by_month ms
  ON ms.period_month = mo.period_month
LEFT JOIN sms_spend_by_month ss
  ON ss.period_month = mo.period_month;

COMMIT;
