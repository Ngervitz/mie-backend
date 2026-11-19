# ELM worker + CZ c1elm — activación (2026-11-19)

Preparado; **no activar** hasta deploy de migración `20261120` y autorización explícita.

## Cambios de código (rama de trabajo actual)

| Artefacto | Qué hace |
|-----------|----------|
| `migrations/20261120_provider_fallback_claim_excluded_cz.sql` | `provider_fallback_claim(..., p_excluded_cz_solicitud_ids)`. Excluidas no se reclaman y **no bloquean** jobs más nuevos de la misma CI. |
| `constants.js` | Lista fija: 1490, 1491, 1948, 1962, 1966, 2424, 3115, 3532. |
| `worker.js` | Pasa exclusión al claim; kick reintenta claim vacío (default 2 × 20 s). |
| `jobs.js` | Body opcional `{ cz_solicitud_id, limit }` para cron acotado. |

Sin cambios a clasificador S1 ni a `5511df8`.

## Orden de activación producción

1. **Supabase:** aplicar migración `20261120_provider_fallback_claim_excluded_cz.sql`.
2. **Railway:** deploy `mie-backend` con el commit que incluye el código anterior (línea `release/c1-elm-ops`).
3. **cron-job.org:** crear job (puede quedar **deshabilitado** hasta paso 2 SUCCESS):

   - `POST https://s.credizona.net/jobs/run-provider-fallback-worker`
   - Header: `X-Cron-Key: <CRON_SECRET>`
   - Body: `{}`
   - Schedule: `* * * * *`

4. **cPanel CZ:** cron `c1elm` cada 1–2 min, header `X-CZ-Cron-Token`, `CZ_ELM_FALLBACK_CRON_ENABLED=true`.

## Verificación

| Señal | Dónde |
|-------|--------|
| Worker cada min | Railway HTTP `/jobs/run-provider-fallback-worker` + log `provider_fallback_worker finished` |
| 4007 cierra | JANUS finalize; CZ funnel ≠ 12; c1elm `events/ack` |
| Backlog intacto | Las 8 CZ siguen `queued`, `claim_count` sin cambios |
| Nuevo par misma CI | Kick + retry o worker ≤1 min; sin cola indefinida |

## Test local

```bash
node scripts/unit-worker-automatic-exclusion.js
```