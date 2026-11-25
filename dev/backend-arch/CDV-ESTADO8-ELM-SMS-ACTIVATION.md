# CDV estado 8 → ELM + S2 referred SMS — activación (pre-prod)

**No activar en producción** hasta migraciones aplicadas, pruebas y autorización explícita (línea `release/c1-elm-ops`).

## Migraciones (Supabase, en orden)

1. `migrations/20261120_cdv_estado8_elm_automation.sql` — cola `cdv_estado8_elm_queue`, trigger `cdv_estado_8`, seed `skipped_historical` del cohorte estado 8 actual.
2. `migrations/20261120_elm_s2_referred_sms_idempotency.sql` — índice único `sms_messages` para `elm_s2_referred`.
3. `migrations/20261124_cdv_estado8_elm_send_origin.sql` — `elm_claim_process` + `send_origin` para `cdv_estado_8` (requerido antes de activar envíos automáticos).

## Variables Railway (`mie-backend` / production)

| Variable | Valor inicial | Efecto |
|----------|---------------|--------|
| `CDV_ESTADO8_ELM_AUTOMATION_ENABLED` | **unset** o `false` | Sin enqueue en sync ni cola ELM en worker |
| `ELM_S2_REFERRED_SMS_ENABLED` | **unset** o `false` | Sin hook SMS tras S2 referred |
| `ELM_S2_REFERRED_SMS_SEND_ENABLED` | `false` | Con SMS enabled: solo dry-run en logs |
| `ELM_S2_REFERRED_SMS_CAMPAIGN_ID` | uuid campaña Notifyme transaccional | Requerido para envío real |

Opcionales: `CDV_ESTADO8_ELM_MAX_ATTEMPTS` (default 8), `CDV_ESTADO8_ELM_BATCH_LIMIT` (default 5).

## Orden de activación sugerido

1. Deploy código en `release/c1-elm-ops` (sin flags).
2. Aplicar ambas migraciones en Supabase prod.
3. Crear campaña SMS transaccional en dashboard JANUS; copiar id a `ELM_S2_REFERRED_SMS_CAMPAIGN_ID`.
4. `ELM_S2_REFERRED_SMS_ENABLED=true`, `ELM_S2_REFERRED_SMS_SEND_ENABLED=false` → validar dry-run en logs tras un S2 referred manual en staging.
5. `CDV_ESTADO8_ELM_AUTOMATION_ENABLED=true` en staging; simular estado 8 nuevo; validar cola + S1/S2 (client ELM mock o sandbox).
6. Producción: habilitar A, luego B send cuando copy y campaña estén confirmados.

## Flujo operativo

- **`POST /jobs/run-cz-data-sync` (~5 min):** detecta nuevas solicitudes en estado 8 y encola (`enqueueCdvEstado8FromSync`). **No** ejecuta S1/S2.
- **`POST /jobs/run-provider-fallback-worker` (~1 min):** al inicio de cada tick, `processCdvEstado8ElmQueue` drena la cola estado 8 (flag on). Circuito **C1** (`provider_fallback_requests`) y sus ocho CZ excluidos del claim C1 **no** se modifican.

## Verificación

- Sync: `POST /jobs/run-cz-data-sync` → `cdvEstado8Elm` (enqueue counts) en respuesta; logs `cdv_estado8_elm_enqueue` — sin `processed` ELM en sync.
- Worker: logs `provider_fallback_worker finished` con `cdv_estado8` en summary cuando flag on.
- Cola: `SELECT status, count(*) FROM cdv_estado8_elm_queue GROUP BY 1`.
- Los ocho CZ `1490,1491,1948,1962,1966,2424,3115,3532` → `skipped_excluded` si aparecen.
- C1: `provider_fallback_requests` y worker sin cambios de comportamiento con flags apagados.
- SMS: una fila `sms_messages` por `source_record_id` = `elm_lead_processes.id`.

## Rollback

- Apagar flags (inmediato).
- Migraciones son aditivas; no borrar cola en prod salvo decisión ops.