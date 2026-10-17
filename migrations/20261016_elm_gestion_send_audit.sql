-- Extends elm_ops_audit_events.action for Gestión ELM manual sends.
-- NOT applied in this delivery; required before appendGestionSendAudit succeeds in prod.

ALTER TABLE public.elm_ops_audit_events
  DROP CONSTRAINT IF EXISTS elm_ops_audit_events_action_check;
ALTER TABLE public.elm_ops_audit_events
  ADD CONSTRAINT elm_ops_audit_events_action_check
  CHECK (action IN ('created', 'assigned', 'unassigned', 'triaged', 'resolved', 'retried', 'gestion_send'));
