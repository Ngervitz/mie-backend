# Run History Integrity — `ad_snapshots` append-only

## Qué cambió

`ad_snapshots` es **append-only**: cada corrida del pipeline inserta una fila nueva. No se sobrescribe evidencia histórica (`raw_json`, `ads_found`, `status`, `apify_run_id`).

- **Una fila = una corrida** (un `apify_run_id` por run, cuando Apify lo devuelve).
- **`snapshot_date`** es dimensión de calendario (`YYYY-MM-DD`), **no** clave única.
- Un trigger en DB bloquea cualquier `UPDATE` sobre filas existentes.

Migración principal: `migrations/20260703_run_history_integrity.sql`

## Antes del deploy

1. Ejecutar `scripts/audit-run-history-paso0.sql` en Supabase SQL Editor.
2. Aplicar la migración principal.
3. Si la query de duplicados `apify_run_id` devuelve **cero filas**, aplicar además `migrations/20260703_run_history_integrity_apify_unique.sql`. Si hay duplicados, **omitir** ese archivo hasta resolverlos.

## Código

`src/steps/snapshot.js` — `saveSnapshot()` hace **insert-only**. Si existe el índice parcial único en `apify_run_id` y se reintenta el mismo run, devuelve el snapshot existente sin modificarlo (idempotencia de reintento, no causa raíz del bug Creditel).

## Histórico pre-fix

Los datos anteriores al deploy **no tienen garantía de integridad estructural del pipeline** (p. ej. snapshots sobrescritos por upsert). Este fix garantiza persistencia **a partir del deploy**; no repara ni valida extracción histórica.

## Fuera de alcance (riesgos conocidos)

- **maxResults** de Apify (límite por entidad).
- **Extracción completa** de la Ad Library.
- **Atomicidad global** del pipeline: si el proceso falla entre el insert de `ad_snapshots` y el de `ads`, puede quedar un snapshot sin ads correspondientes.
- **Datos ya sobrescritos** antes del fix.

## Consumidores futuros (Activity, dashboards)

No leer `ad_snapshots` directamente para métricas de actividad. Usar `events` o una capa derivada / VIEW (`latest snapshot per day`). Esa VIEW **no** se implementó en este ticket por falta de consumidor; es convención documentada, no enforced por permisos DB.

## Validación post-fix

Queries en `scripts/audit-run-history-paso0.sql` (sección "Post-fix validation").

Verificar inmutabilidad (debe fallar):

```sql
UPDATE ad_snapshots SET ads_found = ads_found WHERE id = (SELECT id FROM ad_snapshots LIMIT 1);
-- Expected: MIE Integrity Error: ad_snapshots rows are immutable; insert a new run row instead
```
