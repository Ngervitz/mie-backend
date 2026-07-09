# Reactivated Ads — contrato de métricas (pre-Activity V1)

## 1. Doble conteo

### ¿`ads.first_seen_at` permanece intacto en reactivación?

**Sí.** Evidencia:

- Se asigna solo en `buildAdFromRaw()` al **insert** de anuncios nuevos (`upsert.js` L103).
- El `UPDATE` de reactivación (`upsert.js` L315–327) actualiza `is_active`, `snapshot_id`, `last_seen_at`, `ad_text`, `platforms`, `copy_hash`, `updated_at` — **no incluye `first_seen_at`**.

### ¿Riesgo de doble conteo New Ads + Reactivated Ads?

**No**, en el pipeline actual:

- `reconcileEntity()` clasifica cada `ad_archive_id` en **exactamente una** categoría: `new`, `reactivated`, `persistent` o `disappeared` (`reconcile.js` L161–168).
- Un ad inactivo en DB que reaparece en Apify va a `reactivated`, no a `new`.
- `new` solo si no existe en `dbActive` ni `dbInactive`.
- Eventos: `new_ad` solo para `newIds`; `ad_reactivated` solo para `reactivatedIds` (`events.js`).

**Fix implementado:** ninguno (comportamiento ya correcto).

---

## 2. Eventos omitidos silenciosamente

Si `loadAdIdMap()` no resuelve `ad_id` para un reactivado, `pushEvent` no inserta la fila.

**Hardening implementado** (`events.js`): `logger.warn('Reactivated event omitted', { entity_id, ad_archive_id, event_type: 'ad_reactivated', detected_at, reason: 'missing_ad_id' })`.

El sync no se interrumpe.

---

## 3. Fuente oficial de Reactivated Ads

**Hoy en reportes** (`reports.js`): Reactivated Ads = conteo de filas `events` con `event_type = 'ad_reactivated'`, agregadas por `detected_at` (día).

```11:16:src/routes/reports.js
const EVENT_TYPE_TO_STAT = {
  new_ad: 'newAds',
  copy_changed: 'copyChanges',
  ad_reactivated: 'reactivations',
  ad_deactivated: 'deactivations',
};
```

**No depende de:** `is_active`, `last_seen_at`, `first_seen_at`.

**Nota:** New Ads en reportes actuales también viene de `events.new_ad`, no de `ads.first_seen_at`. El contrato Activity V1 (abajo) separa fuentes; al implementar Activity, usar las fuentes del contrato final.

---

## 4. Contrato de `detected_at`

`detected_at` = **fecha (UTC, `YYYY-MM-DD`) en que MIE detectó la reactivación** en un sync exitoso.

**No representa** la fecha exacta en que Meta reactivó el anuncio en Ad Library.

**Riesgo aceptado:** MIE observa en corridas discretas (típicamente diarias). La reactivación real en Meta puede ocurrir horas antes del sync. `detected_at` es la dimensión de **detección operativa**, no de plataforma.

Derivado de `collectedAt` del sync (`events.js` `toDateOnly(collectedAt)`).

---

## 5. Hugo — disclaimer de fechas

**Decisión:** sí, debe propagarse cuando Hugo mencione reactivaciones con fecha.

**Wording seguro:**

- ✅ "Detectamos la reactivación el día X."
- ✅ "MIE registró una reactivación el X."
- ❌ "Meta reactivó el anuncio el día X."

**Justificación:** Hugo consume `buildHugoContext()` basado en `events.detected_at`. Eso es evidencia de detección MIE, no certeza de timing Meta. Afirmar Meta sería sobreinterpretación.

Implementación Hugo: convención documentada; prompt de Hugo Brain ya exige separar observación de hipótesis. Activity V1 / Hugo pueden citar esta convención al mostrar fechas.

---

## 6. Auditoría de tabla `events`

### En el repositorio

| Pregunta | Respuesta |
|----------|-----------|
| ¿Append-only en código? | **Sí** — solo `.insert()` en `events.js` L161 |
| ¿UPDATE en código? | **No** |
| ¿UPSERT en código? | **No** |
| ¿DELETE en código? | **No** |
| ¿Migraciones `events` en repo? | **No** — solo `ad_snapshots` |
| ¿Trigger de inmutabilidad DB? | **No demostrado** — no hay migración `events` en repo |
| ¿Puede sobrescribirse evidencia histórica vía pipeline? | **No** vía código actual |
| ¿Riesgo duplicado `(ad_id, event_type, detected_at)`? | **Mitigado** — dedup en `events.js` + migración `20260706_events_dedup.sql` (partial UNIQUE en `new_ad`, `ad_reactivated`, `ad_deactivated`) |

### ¿Conviene UNIQUE `(entity_id, ad_id, event_type, detected_at)`?

**Justificación para evaluar (no implementado):**

- **A favor:** idempotencia si se re-ejecuta sync el mismo día.
- **En contra:** un mismo ad podría legítimamente desactivarse y reactivarse dos veces el mismo día calendario (dos eventos válidos); UNIQUE estricto bloquearía el segundo.
- **Recomendación:** no agregar UNIQUE sin definir si el pipeline debe ser idempotente por corrida (`apify_run_id`) vs por día. Dejar para Activity V1.

---

## 7. Contrato definitivo de métricas

### New Ads

| | |
|--|--|
| **Fuente** | `ads.first_seen_at` (Activity V1) / hoy reportes usan `events.event_type = 'new_ad'` + `detected_at` |
| **Regla** | Cuenta anuncios cuya **primera detección** cae dentro de la ventana |
| **Filtro `is_active`** | No filtra |
| **¿Incluye reactivaciones?** | **No.** Reactivados conservan `first_seen_at` original; no vuelven a `new` en reconcile |

### Reactivated Ads

| | |
|--|--|
| **Fuente** | `events` donde `event_type = 'ad_reactivated'` |
| **Dimensión temporal** | `events.detected_at` |
| **Regla** | Cuenta reactivaciones **detectadas** dentro de la ventana |

### Persistence

| | |
|--|--|
| **Fuente** | `ads.is_active = true` |
| **Regla** | Presencia actual únicamente |
| **No mide** | Antigüedad, estabilidad, convicción |
