-- One Notifyme row per ELM process referred (source_system = elm_s2_referred).

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_elm_s2_referred_source_record_uidx
  ON public.sms_messages (source_system, source_record_id)
  WHERE source_system = 'elm_s2_referred'
    AND source_record_id IS NOT NULL;

COMMIT;