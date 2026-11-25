-- PREPARE ONLY — reconcile cdv_estado8_elm_queue 4617 to manual ELM process.
-- Do not run until explicitly authorized in production.
-- Process: 02592d53-69d7-4550-b22d-9e1ecc12fe21 (janus_manual / rechazados_manual)

UPDATE public.cdv_estado8_elm_queue
SET
  status = 'completed',
  elm_process_id = '02592d53-69d7-4550-b22d-9e1ecc12fe21',
  last_error = NULL,
  updated_at = now()
WHERE cz_solicitud_id = 4617
  AND status = 'skipped_ineligible';