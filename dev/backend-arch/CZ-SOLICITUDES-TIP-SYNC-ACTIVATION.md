# CZ solicitudes tip sync — activación (dual-pass)

## Estado

- Código local: `POST /jobs/run-cz-solicitudes-tip-sync`
- Migración pendiente: `migrations/20261125_cz_funnel_solicitudes_tip_cursor.sql`
- Cron: **no activar** hasta deploy + migración en producción

## Secuencia de activación

1. Aplicar migraciones Supabase (en orden):
   - `20261125_cz_funnel_solicitudes_tip_cursor.sql`
   - `20261125_cz_funnel_solicitudes_guarded_upsert.sql`
2. Deploy backend en rama oficial JANUS (`release/c1-elm-ops` o descendiente autorizado).
3. Verificar manual: `POST /jobs/run-cz-solicitudes-tip-sync` con `X-Cron-Key` → `ok: true`, `passComplete: true`.
4. En cron-job.org (o actual): añadir job **cada 1 min** → `https://s.credizona.net/jobs/run-cz-solicitudes-tip-sync` con mismo `X-Cron-Key` que otros jobs.
5. **No** cambiar frecuencia ni lógica de `POST /jobs/run-cz-data-sync`.

## Reconciliación CZ 4617 (manual, sin re-ELM)

Cuando autorice operaciones:

```sql
-- Vincular cola al proceso manual existente (02592d53-69d7-4550-b22d-9e1ecc12fe21).
-- No dispara envío ELM.
UPDATE public.cdv_estado8_elm_queue
SET
  status = 'completed',
  elm_process_id = '02592d53-69d7-4550-b22d-9e1ecc12fe21',
  last_error = NULL,
  updated_at = now()
WHERE cz_solicitud_id = 4617
  AND status = 'skipped_ineligible';
```

Verificar antes: un solo `elm_ci_send_locks` mensual `janus_manual` y sin fila `pending`/`failed` para el mismo CI.

## Monitoreo

- Logs: `cz_funnel_solicitudes_tip_sync completed`
- Métricas: `parentSkippedStale` estable; picos → revisar concurrencia full/tip
- Cola: nuevos `pending` en `cdv_estado8_elm_queue` minutos después de estado 8 en CZ