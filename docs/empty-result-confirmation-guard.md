# Empty Result Confirmation Guard

## Objetivo

Evitar falsos positivos de "salida del mercado" cuando Apify devuelve cero anuncios por fallo de captura, timeout o error parcial.

**Principio:** una ausencia de evidencia no es evidencia de ausencia.

## Status de snapshot

| Status | Condición |
|--------|-----------|
| `success` | `adsFound > 0` |
| `empty_confirmed` | `adsFound == 0`, log legible, sin patrón de fallo |
| `empty_unconfirmed` | `adsFound == 0` con patrón de fallo en log, log ilegible, o retry fallido |

Legacy: `empty` se interpreta como `empty_confirmed` en guards de mercado.

`ad_snapshots.status` es **texto libre** — no requiere migración DB. Valores nuevos son compatibles con Run History Integrity (append-only).

## Flujo Apify (`src/clients/apify.js`)

1. `runActorWithRetry()` ejecuta `runActorOnce()` (`.call()` + dataset).
2. Si `adsFound > 0` → `success`, sin retry.
3. Si `adsFound == 0` → `getRunLog(runId)` vía `client.run(id).log().get()`.
4. Log ilegible → `empty_unconfirmed`, **sin retry** (fail-closed).
5. Log sin patrón de fallo → `empty_confirmed`, sin retry.
6. Log con patrón de fallo → **un retry**; si retry trae ads → dos snapshots (`empty_unconfirmed` + `success`).

### Patrones de fallo (case-insensitive)

`timeout`, `sources failed`, `failed to get source`, `connection error`, `browser closed`, `context closed`, `page closed`, `net::err`, `blocked`, `rate limit`

## Reconcile (`src/steps/reconcile.js`)

- `empty_unconfirmed` → skip total, log: `Empty result unconfirmed. Reconciliation skipped.`
- `empty_confirmed` sin confirmación de salida → skip total
- `empty_confirmed` con confirmación → reconcile normal (incluye `disappeared` / deactivate)
- `success` → reconcile normal

## Confirmación de salida del mercado (`src/steps/market-exit.js`)

Requiere **dos** snapshots con `status = 'empty_confirmed'` **post-deploy** (corte: `EMPTY_CONFIRMATION_GUARD_DEPLOY_AT`, default `2026-07-05T00:00:00.000Z`).

**Legacy `empty` queda excluido** del conteo de confirmación aunque exista antes del deploy.

- Mínimo **24h**, máximo **72h** entre anclas (`MARKET_EXIT_MIN_HOURS` / `MARKET_EXIT_MAX_HOURS`)
- Continuidad día a día entre anclas
- Sin `success` ni `empty_unconfirmed` entre anclas

## Hugo — cap de atención

Taxonomía en `src/routes/reports.js`: `normal < interesting < high_activity < strategic_movement`.

Con captura vacía no confirmada en entidad estratégica: **máximo `interesting`**, **`normal`** si `totalEvents === 0`.

## Métricas de retry

En respuesta de `collect()`: `apifyRetryMetrics` con `retriesExecuted`, `retriesSucceeded`, `retriesFailed`, `retryRatePercent`, `estimatedExtraRuns`.

## Fuera de alcance

maxResults, paginación, Activity, transacciones globales, reparación de histórico pre-fix.

## Validación

Ver `scripts/validate-empty-result-guard.sql`.
