-- Marketing impacts tracking view + CZ solicitudes jt functional index.
-- Apply manually in Supabase AFTER 20260828_marketing_campaign_series.sql
-- and 20260825_cz_funnel_solicitud_estados.sql.
-- Idempotent. Creates a read-only query view and a partial functional index. Does not modify existing table columns or row data.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Partial functional index for fast join on tracking_data_summary->>'jt'
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_cz_funnel_solicitudes_tracking_jt
  ON public.cz_funnel_solicitudes ((tracking_data_summary->>'jt'))
  WHERE tracking_data_summary->>'jt' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Unified tracking view (impacts, sms, events, cz_solicitudes, series protection)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.marketing_impacts_tracking_view AS
SELECT
  -- Identidad del impacto y contacto
  i.id AS marketing_impact_id,
  i.tracking_token,
  i.channel,
  COALESCE(i.contact_id, m.contact_id) AS contact_id,
  m.phone,
  i.created_at AS impact_created_at,

  -- Campaña y Serie
  c.campaign_series_id,
  ser.name AS campaign_series_name,
  m.campaign_id,
  c.name AS campaign_name,

  -- Eventos del embudo asociados a este impacto
  COALESCE(ev.has_click, false) AS clicked,
  ev.clicked_at,
  ev.form_step_1_at,
  ev.form_step_2_at,
  ev.form_step_3_at,
  ev.last_event_at,
  COALESCE(ev.total_events, 0) AS total_events,

  -- Solicitud Credizona asociada (vía jt en tracking_data_summary)
  sol.cz_id AS cz_solicitud_id,
  sol.ci AS cz_ci,
  sol.fecha_reg AS solicitud_fecha_reg,
  sol.solicitudes_estados_id AS solicitud_estado_actual_id,
  est.estados_ids_historico AS solicitud_estados_historico,
  est.estados_historico_detalle AS solicitud_estados_detalle,

  -- Regla canónica de protección en la serie (evalúa toda la serie para esa identidad)
  CASE
    WHEN c.campaign_series_id IS NOT NULL THEN
      public.sms_contact_clicked_in_series(
        COALESCE(i.contact_id, m.contact_id),
        m.phone,
        c.campaign_series_id
      )
    ELSE false
  END AS protected_clicked

FROM public.marketing_impacts i
LEFT JOIN public.sms_messages m 
  ON m.marketing_impact_id = i.id
LEFT JOIN public.sms_campaigns c 
  ON c.id = m.campaign_id
LEFT JOIN public.marketing_campaign_series ser 
  ON ser.id = c.campaign_series_id

-- Agregación puntual de eventos por impacto
LEFT JOIN LATERAL (
  SELECT
    bool_or(e.event_name = 'click') AS has_click,
    min(CASE WHEN e.event_name = 'click' THEN e.occurred_at END) AS clicked_at,
    min(CASE WHEN e.event_name = 'form_step_1' THEN e.occurred_at END) AS form_step_1_at,
    min(CASE WHEN e.event_name = 'form_step_2' THEN e.occurred_at END) AS form_step_2_at,
    min(CASE WHEN e.event_name = 'form_step_3' THEN e.occurred_at END) AS form_step_3_at,
    max(e.occurred_at) AS last_event_at,
    count(*)::integer AS total_events
  FROM public.marketing_impact_events e
  WHERE e.impact_id = i.id
) ev ON true

-- Solicitud Credizona asociada por jt
LEFT JOIN public.cz_funnel_solicitudes sol
  ON (sol.tracking_data_summary->>'jt') = i.tracking_token

-- Agregación puntual de histórico de estados para la solicitud
LEFT JOIN LATERAL (
  SELECT
    array_agg(
      h.solicitudes_estados_id 
      ORDER BY h.fechahora_src ASC NULLS LAST, h.cz_historico_id ASC
    ) AS estados_ids_historico,
    jsonb_agg(
      jsonb_build_object(
        'estado_id', h.solicitudes_estados_id,
        'estado', h.estado,
        'fechahora', h.fechahora_src
      ) ORDER BY h.fechahora_src ASC NULLS LAST, h.cz_historico_id ASC
    ) AS estados_historico_detalle
  FROM public.cz_funnel_solicitud_estados h
  WHERE h.cz_solicitud_id = sol.cz_id
) est ON sol.cz_id IS NOT NULL;

COMMENT ON VIEW public.marketing_impacts_tracking_view IS
  'Unified view across marketing touches (impacts), SMS messages, series, click/funnel events, Credizona solicitudes by jt, and series protection.';

COMMIT;
