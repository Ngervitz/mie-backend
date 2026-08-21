-- REPLACE cz_funnel_channel_utility_live: Meta spend USD × BCU TCV (2225).
-- Apply manually in Supabase ONLY after bcu_usd_uyu_daily is backfilled.
-- Do not apply together with 20260820_bcu_usd_uyu_daily.sql.

CREATE OR REPLACE VIEW public.cz_funnel_channel_utility_live AS
WITH params AS (
  SELECT 'v1'::text AS attribution_version
),
granted_attributed AS (
  SELECT
    g.cz_id,
    g.monto_otorgado,
    date_trunc(
      'month',
      timezone('America/Montevideo', g.updated_at_src)
    )::date AS period_month,
    CASE
      WHEN lower(trim(s.tracking_data_summary->>'utm_source')) = 'sms'
        THEN 'sms'
      WHEN lower(trim(s.tracking_data_summary->>'utm_source'))
        IN ('facebook', 'instagram', 'fb', 'ig')
        THEN 'meta'
      ELSE 'sin_atribuir'
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
    period_month,
    channel,
    count(*)::integer                AS granted_count,
    coalesce(sum(monto_otorgado), 0) AS monto_total_otorgado
  FROM granted_attributed
  GROUP BY period_month, channel
),
meta_spend_days AS (
  SELECT
    d.metric_date,
    coalesce(sum(d.spend), 0) AS spend_usd
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
      SELECT r.sell
      FROM public.bcu_usd_uyu_daily r
      WHERE r.rate_date <= s.metric_date
      ORDER BY r.rate_date DESC
      LIMIT 1
    ) AS sell
  FROM meta_spend_days s
),
meta_spend_by_month AS (
  SELECT
    date_trunc('month', c.metric_date)::date AS period_month,
    CASE
      WHEN bool_or(c.sell IS NULL) THEN NULL::numeric
      ELSE coalesce(sum(c.spend_usd * c.sell), 0)
    END AS spend
  FROM meta_spend_converted c
  GROUP BY 1
),
sms_delivered_by_month AS (
  SELECT
    date_trunc(
      'month',
      timezone('America/Montevideo', m.delivered_at)
    )::date AS period_month,
    count(*)::integer AS messages_delivered
  FROM public.sms_messages m
  WHERE m.delivered_at IS NOT NULL
    AND m.status = 'DELIVERED'
  GROUP BY 1
),
sms_spend_by_month AS (
  SELECT
    d.period_month,
    d.messages_delivered
      * cfg.cost_per_sms_ex_vat
      * (1 + cfg.vat_rate) AS spend
  FROM sms_delivered_by_month d
  JOIN LATERAL (
    SELECT c.cost_per_sms_ex_vat, c.vat_rate
    FROM public.sms_cost_config c
    WHERE c.effective_from
      <= (d.period_month + interval '1 month' - interval '1 day')::date
    ORDER BY c.effective_from DESC
    LIMIT 1
  ) cfg ON true
),
months AS (
  SELECT period_month FROM revenue_by_month_channel
  UNION
  SELECT period_month FROM meta_spend_by_month
  UNION
  SELECT period_month FROM sms_spend_by_month
),
channels AS (
  SELECT unnest(ARRAY['meta', 'sms', 'sin_atribuir']) AS channel
)
SELECT
  mo.period_month,
  ch.channel,
  p.attribution_version,
  coalesce(r.granted_count, 0)            AS granted_count,
  coalesce(r.monto_total_otorgado, 0)     AS monto_total_otorgado,
  coalesce(r.monto_total_otorgado, 0) * 0.06 AS revenue,
  CASE ch.channel
    WHEN 'meta' THEN
      CASE WHEN ms.period_month IS NULL THEN 0::numeric ELSE ms.spend END
    WHEN 'sms' THEN coalesce(ss.spend, 0)
    ELSE 0::numeric
  END                                     AS spend,
  (coalesce(r.monto_total_otorgado, 0) * 0.06)
    - CASE ch.channel
        WHEN 'meta' THEN
          CASE WHEN ms.period_month IS NULL THEN 0::numeric ELSE ms.spend END
        WHEN 'sms' THEN coalesce(ss.spend, 0)
        ELSE 0::numeric
      END                                 AS utility
FROM months mo
CROSS JOIN channels ch
CROSS JOIN params p
LEFT JOIN revenue_by_month_channel r
  ON r.period_month = mo.period_month AND r.channel = ch.channel
LEFT JOIN meta_spend_by_month ms
  ON ms.period_month = mo.period_month
LEFT JOIN sms_spend_by_month ss
  ON ss.period_month = mo.period_month;

COMMENT ON VIEW public.cz_funnel_channel_utility_live IS
  'Live CZ funnel utility by channel. Meta spend = own_ad_metrics USD × BCU TCV (2225) on metric_date with carry-forward. If any spend day in the month has no rate even with carry-forward, Meta spend and utility are NULL for that month. SMS/revenue stay UYU. updated_at_src is not a real GRANTED date.';
