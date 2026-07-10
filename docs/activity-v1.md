# MIE Activity V1

Cálculo y persistencia de métricas de actividad competitiva. **Sin narrativa Hugo.**

## PASO 0 — Entidades participantes

Evidencia en código (`src/steps/collect.js`):

```js
supabase.from('monitored_entities').select('*').eq('is_self', false)
```

| Campo | Evidencia | Uso en Activity |
|-------|-----------|-----------------|
| `id` | uuid FK en ads/events/snapshots | Sí |
| `name` | logs / reportes | Solo logging |
| `is_self` | `collect.js` + `reports.js` | **Excluir** `is_self=true` |
| `ad_library_url` | collect | No |
| `active` | mencionado en datos reales (Verde) | **No filtrar** — el pipeline no lo usa; el ticket prohíbe asumir que identifica entidades activas |

**Decisión:** Activity usa exactamente el mismo filtro que Collect: `is_self = false`.

## Tabla `activity_metrics`

Append-only. Sin UNIQUE. Vigente del día:

```sql
ORDER BY created_at DESC
```

Migración: `migrations/20260710_activity_metrics.sql`

`execution_date`, `current_window_start`, `current_window_end` son tipo **DATE**.

## Métricas

| metric_type | Fuente | Ventana | baseline / delta / change |
|-------------|--------|---------|---------------------------|
| `new_ads` | `ads.first_seen_at` en `[start, end)` | 7 días semiabierta | **Sí** — único con baseline, delta y change |
| `reactivated_ads` | `events` `ad_reactivated` / `detected_at` | misma ventana | **null** — solo `observed_value` |
| `persistence` | `COUNT(ads)` donde `is_active=true` | no aplica | **null** — solo `observed_value` |

New Ads y Reactivated Ads **siempre** se persisten por separado.

## Cobertura

Por cada día del bloque: snapshot vigente = `ORDER BY created_at DESC` (primera fila).

Día válido solo si `status IN ('success', 'empty_confirmed')`.

- `empty` → **inválido**
- `empty_unconfirmed` → **inválido**
- sin snapshot → **inválido**

Si un día falla → bloque inválido. Ventana actual inválida → `coverage_valid=false`, `change_relevant=null`, sin alertas. Bloques históricos inválidos se excluyen del baseline.

## Confianza (`days_of_history`)

```
days_of_history = execution_date - MIN(first_seen_at)   -- días calendario
```

| Días | confidence_level | Cambio |
|------|------------------|--------|
| 0–13 | `none` | Nunca |
| 14–34 | `low` | Condiciones 1–2 |
| 35–55 | `medium` | 1–2–3 (3 solo si hay `baseline_std`) |
| 56+ | `high` | igual |

Antigüedad ≠ cobertura.

## Baseline

Bloques de 7 días no solapados, máx. 12, previos a la ventana actual. Solo bloques con cobertura válida.

- `baseline_mean`: ≥ 1 bloque válido
- `baseline_std`: ≥ 4 bloques válidos (sample std); si no, `null` y condición 3 no se evalúa

## Cambio (solo `new_ads`) — heurísticas V1

```
MIN_ABSOLUTE_DELTA = 3
MIN_PERCENT_DELTA = 0.5
STD_MULTIPLIER = 1.5
```

1. `abs(delta) >= 3`
2. `abs(delta) / max(baseline_mean, 1) >= 0.5`
3. `abs(delta) >= max(2, baseline_std * 1.5)` — solo si existe `baseline_std`

`delta_value = abs(observed_value - baseline_mean)` se **persiste siempre** (cuando hay mean).

## Anti-flapping

Anclado a calendario:

```
ayer = execution_date - 1 día
```

Fila vigente de ayer: `WHERE execution_date = ayer ORDER BY created_at DESC LIMIT 1`.

- Si no hay fila de ayer → `change_relevant_yesterday = false`, `consecutive_change_days` base 0
- `change_detected_today = change_relevant_today AND NOT change_relevant_yesterday`
- Supresión 7 días misma dirección, salvo `delta_hoy >= delta_alerta_persistido * 1.75`
- `consecutive_change_days` solo vs `execution_date - 1`

## Versionado

```
RULESET_VERSION = 'v1.0'
```

Se persiste en cada fila. Alertas viejas **nunca** se recalculan con reglas nuevas; se usa el `delta_value` almacenado.

## API

```
POST /jobs/run-activity
GET  /jobs/run-activity
GET  /jobs/activity-status
```

Body/query opcionales: `entity_id`, `date` (YYYY-MM-DD).

## Fuera de alcance

Hugo Brain, frontend, maxResults, Meta Agente, cambios a reconcile/upsert/deactivate/snapshot.
