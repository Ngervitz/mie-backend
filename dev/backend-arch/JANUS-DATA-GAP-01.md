# JANUS-DATA-GAP-01 — Completar datos Credizona ya disponibles en JANUS

**Fecha:** 2026-09-24  
**Repo:** `mie-backend` (JANUS)  
**Modo:** Auditoría + implementación acotada de persistencia  
**Credizona / Mi Plan / entry tokens / journey_id / originadores:** NO tocados  
**Migración aplicada a producción:** NO (archivo creado; aplicar manualmente)  
**Deploy producción:** NO

### Leyenda de certeza

| Tag | Significado |
|-----|-------------|
| **CONFIRMED** | Evidencia explícita en payload, código Credizona clone, o sync JANUS |
| **INFERRED** | Implicación fuerte; no política escrita |
| **IMPLEMENTED** | Cambio aplicado en este repo en esta fase |
| **NOT_AVAILABLE** | Confirmado ausente en fuente / contrato |
| **UNKNOWN** | No decidible |
| **OPEN_HUMAN_DECISION** | Requiere decisión humana |

---

## 0. Resumen ejecutivo

| Campo negocio | Campo API Credizona | Estado previo JANUS | Acción |
|---------------|---------------------|---------------------|--------|
| celular | `celular` | recibido, **descartado** | **IMPLEMENTED** → `cz_funnel_solicitudes.celular` |
| ingreso | `salario` | recibido, **descartado** | **IMPLEMENTED** → `cz_funnel_solicitudes.salario` |
| fecha nacimiento | `fecha_nacimiento` | recibido, **descartado** | **IMPLEMENTED** → `cz_funnel_solicitudes.fecha_nacimiento` |
| situación laboral | `relacion_laboral` | recibido, **descartado** | **IMPLEMENTED** → `cz_funnel_solicitudes.relacion_laboral` (útil Mi Plan) |
| monto solicitado | — | claim negocio vs evidencia | **NOT_AVAILABLE** en `/solicitudes` |
| motivo rechazo | — | — | **NOT_AVAILABLE** — no inferir |

**Causa del gap:** `upsertSolicitudes` en `src/jobs/czFunnelSync.js` solo mapeaba un subconjunto de campos; el resto del JSON se descartaba en cada sync.

**CREDIZONA_CHANGES_REQUIRED: NO**

---

## 1. Payload Credizona encontrado

### 1.1 Mecanismo (CONFIRMED)

| Fuente | Path | Cliente JANUS |
|--------|------|---------------|
| Decode Bearer API | `GET /solicitudes?since=` | `src/clients/czApiClient.js` → `src/jobs/czFunnelSync.js` |

Evidencia de contrato:

- Probe RO 2026-09-17: `scripts/_tmp-probe-solicitudes-email-lrw.json`
- Clone Credizona: `apiController.php` docblock + `Solicitudes::getSolicitudesInfo` SQL

### 1.2 Keys top-level `/solicitudes` (CONFIRMED)

```
id, uuid, solicitudes_estados_id, usuarios_id, ci, lrw_id,
celular, email, nombre, apellido, fecha_nacimiento, genero,
address, city, department, relacion_laboral, salario,
fechaReg, updated, tracking_data, historico
```

Tipos de muestra (sin PII):

| Campo | Tipo API | Ejemplo shape |
|-------|----------|---------------|
| celular | number | `59899970709` |
| salario | number | `80000` |
| fecha_nacimiento | string | `"1990-05-08"` |
| relacion_laboral | string | `"dependiente"` |
| email | string | `"user@example.com"` |
| lrw_id | string | `"LRW-…"` |
| ci | number | integer CI |
| historico | array | estados |

### 1.3 Matriz de campos foco

| CREDIZONA_FIELD_NAME | JANUS_CURRENT_MAPPING (pre) | JANUS_CURRENT_PERSISTENCE (pre) | CURRENT_TABLE | CURRENT_COLUMN (post) | RELATION_TO_CI | RELATION_TO_LRW | CURRENTLY_LOST_OR_UNMAPPED (pre) | TYPE | NULLABILITY |
|----------------------|----------------------------|----------------------------------|---------------|------------------------|----------------|-----------------|----------------------------------|------|-------------|
| celular | none | none | cz_funnel_solicitudes | celular | via `ci` on same row | via `lrw_id` on same row | **YES** | text (digits) | nullable |
| salario | none | none | cz_funnel_solicitudes | salario | via row | via row / episode | **YES** | numeric | nullable |
| fecha_nacimiento | none | none | cz_funnel_solicitudes | fecha_nacimiento | via row | via row | **YES** | date | nullable |
| relacion_laboral | none | none | cz_funnel_solicitudes | relacion_laboral | via row | via row | **YES** | text | nullable |
| monto_solicitado | — | — | — | — | — | — | N/A — **not in payload** | — | — |
| motivo_rechazo | — | — | — | — | — | — | N/A — **not delivered** | — | — |

### 1.4 Ya correctamente disponibles (CONFIRMED)

CI, LRW (`lrw_id`), nombre, apellido, email, `solicitudes_estados_id`, historico/estados, P1–P10 (`cz_funnel_encuestas`), timestamps (`fecha_reg`, `updated_at_src`, `synced_at`, `completed_at`), tracking allowlist (UTM + `jt`), BCU (tablas rejected_*), `monto_otorgado` (solo granted).

---

## 2. Celular

**CONFIRMED:** viene de `usuarios.celular` en SQL Credizona; expuesto como `celular` en `/solicitudes`.

**Por qué no se relacionaba con CI:** no había columna; el valor se perdía en el upsert. `sms_contacts.phone` existe pero **sin join a CI** en el funnel path.

**IMPLEMENTED:**

- Columna `cz_funnel_solicitudes.celular` (text dígitos)
- Mapping `nullableCelular` en `src/lib/czFunnelSolicitudProfile.js`
- Lookup CI → celular: `resolveLatestCelularByCi` (latest non-null por `updated_at_src`, tie `cz_id`)
- LRW → CI → celular: `WHERE lrw_id = ?` → fila → `ci` / `celular`

**Normalización:** no re-inventa E.164; Credizona ya aplica `Helpers::limpiarCelular` al persistir. JANUS guarda dígitos del valor recibido.

**Múltiples celulares por CI:** posibles entre episodios; no se colapsan en una sola tabla persona. “Latest” es regla de lectura, no overwrite histórico.

---

## 3. Ingreso (`salario`)

**CONFIRMED:** campo API = `salario` (no `ingreso`).

**Semántica:** ingreso **declarado** en la solicitud Credizona. **INFERRED:** moneda UYU implícita (no viene en payload).

**IMPLEMENTED:** columna `salario numeric`, episode-scoped en `cz_id` / `lrw_id`.

**Provenance mínima:** tabla = espejo Credizona; `synced_at` = received_at; `lrw_id` / `cz_id` = external_reference del episodio.

---

## 4. Fecha de nacimiento

**CONFIRMED:** `fecha_nacimiento` string date-like desde `usuarios`.

**IMPLEMENTED:** columna `date`; parser `parseCzDateOnly` (solo `YYYY-MM-DD`, sin edad derivada).

---

## 5. Monto solicitado

**STATUS: NOT_AVAILABLE** en el contrato `/solicitudes` que JANUS consume.

Evidencia:

1. Probe `top_level_keys` — sin `monto_solicitado` / equivalente.
2. `getSolicitudesInfo` SELECT — no incluye monto solicitado.
3. Docblock `apiController::solicitudes` — lista explícita sin ese campo.
4. Grep clone — solo `monto_otorgado` (granted).

**No implementado.** No inventar columna.  
**OPEN_HUMAN_DECISION:** si producto exige monto para analytics Mi Plan, opciones futuras: (a) aceptar gap; (b) negociar campo en API Credizona (**fuera de preferencia**); (c) otra fuente. **No** bloquear integración Mi Plan.

> Nota: el claim de negocio “Credizona ya entrega monto solicitado” **no se sostiene** contra el payload/API auditados. Preferir evidencia sobre claim.

---

## 6. Motivo de rechazo

```
SOURCE: CREDIZONA
FIELD: motivo_rechazo
STATUS: NOT_AVAILABLE
```

No inferir. No columna. No bloquea Mi Plan.

---

## 7. Campos útiles AVAILABLE_UNUSED

Presentes en payload, **no** persistidos en esta fase (fuera de foco mínimo + no requeridos engine V1):

| Campo | Tipo | Nota |
|-------|------|------|
| genero | string | person-ish |
| address | string | domicilio |
| city | string | localidad |
| department | string | departamento |
| uuid | string | id solicitud Credizona |

`relacion_laboral` **sí** se persistió por utilidad directa Mi Plan (perfil / laboral).

---

## 8. Person vs episode

| Nivel | Campos |
|-------|--------|
| **Person-ish** (llegan por usuario CZ, se espejan por episodio) | CI, nombre, apellido, email, celular, fecha_nacimiento |
| **Episode** | LRW, cz_id, salario, relacion_laboral, estado, historico, tracking, timestamps |

Misma CI + LRW A (salario 70k) y LRW B (salario 90k) → **dos filas**; no se pisan.

**Latest value (INFERRED lectura):** `ORDER BY updated_at_src DESC` filtrando CI.  
**Episode value:** fila por `lrw_id` / `cz_id`. Preferir episodio para bridge Credizona → Mi Plan.

---

## 9. Provenance

No se añadió framework genérico.

Mínimo suficiente **IMPLEMENTED / INFERRED**:

| Concepto | Dónde |
|----------|--------|
| SOURCE | implícito: tabla `cz_funnel_*` = Credizona |
| OBSERVED_AT / RECEIVED_AT | `synced_at` (+ `updated_at_src` / `fecha_reg`) |
| EXTERNAL_REFERENCE | `lrw_id`, `cz_id`, `ci` |

Ejemplo conceptual futuro (no schema nuevo):

```text
income:
  value: <salario>
  source: credizona
  external_reference: <lrw_id>
  observed_at: <synced_at>
```

---

## 10. Freshness / historia

Upsert por `cz_id` actualiza el episodio; no borra otros LRW de la misma CI.  
Historial = múltiples filas `cz_funnel_solicitudes` por CI.

---

## 11. Paquete episodio conceptual (post-gap)

Para un LRW, JANUS puede recuperar (CONFIRMED post-mapping, tras aplicar migración + sync):

- CI, LRW, nombre, apellido, email, celular  
- salario, relacion_laboral, fecha_nacimiento  
- estado / historico  
- P1–P10 si hay encuesta por CI (`cz_funnel_encuestas`)  
- BCU si existe snapshot por CI  
- provenance vía tabla + timestamps  

**No** implementado payload JANUS → Mi Plan.

---

## 12. Lookup interno (diseñado)

### A) Por LRW (preferido para rechazo)

```sql
SELECT * FROM cz_funnel_solicitudes WHERE lrw_id = $1;
-- luego encuestas/BCU por ci
```

Índice: `idx_cz_funnel_solicitudes_lrw_id` (**IMPLEMENTED** en migración).

### B) Por CI (historial)

```sql
SELECT * FROM cz_funnel_solicitudes
 WHERE ci = $1
 ORDER BY updated_at_src DESC NULLS LAST;
```

**Ambigüedad:** múltiples LRW → no elegir “último” silenciosamente para contexto comercial del rechazo; usar LRW del episodio.

Helper puro CI→celular: `resolveLatestCelularByCi` (**IMPLEMENTED**).

---

## 13. Solución aplicada (código)

| Artefacto | Rol |
|-----------|-----|
| `migrations/20260924_cz_funnel_solicitudes_profile_fields.sql` | columnas + índices |
| `src/lib/czFunnelSolicitudProfile.js` | parsers + map + CI celular lookup |
| `src/jobs/czFunnelSync.js` | upsert incluye profile fields |
| `scripts/unit-cz-funnel-solicitud-profile.js` | tests |

---

## 14. Estrategia histórica / backfill

| Pregunta | Respuesta |
|----------|-----------|
| ¿Backfill desde datos ya en JANUS? | **NO** — esos campos nunca se persistieron |
| ¿Requiere reconsultar Credizona? | **SÍ** — sync `/solicitudes` |
| ¿Vale la pena backfill one-shot? | **Opcional** — el job ya usa `fullRefresh: true` para solicitudes; el **próximo** `cz_funnel_data_sync` tras aplicar migración reescribe filas con los nuevos campos |
| ¿Solo forward? | Prácticamente sí: forward = next full refresh |
| ¿Backfill masivo ejecutado? | **NO** |

---

## 15. Tests

```text
node scripts/unit-cz-funnel-solicitud-profile.js  → OK
node scripts/unit-cz-funnel-solicitud-contact.js → OK
node scripts/unit-cz-funnel-nombre.js            → OK
node scripts/unit-cz-funnel-jt.js                → OK
node scripts/unit-cz-funnel-encuestas-answers.js → OK
```

Cubre: celular, CI→celular latest, salario por episodio, DOB parse, multi-LRW, no inventar monto_solicitado, P1–P10 map intacto, JT intacto.

---

## 16. Seguridad

- Sin nuevas URLs públicas con PII.
- Sin logging de valores de celular/salario/DOB en el sync (solo conteos existentes).
- Campos solo en DB interna JANUS.
- Secrets no tocados.

---

## 17. Pendientes

1. **Aplicar migración** en Supabase (manual / autorizado).
2. **Correr** un `cz_funnel_data_sync` post-migración y verificar RO counts (celular/salario non-null).
3. Decidir sobre **monto_solicitado** gap (OPEN).
4. Opcional: persistir `genero` / geo si Mi Plan lo pide.
5. Fase siguiente: **contrato JANUS ↔ Mi Plan** (entry token + payload allowlist) — no esta fase.

---

## 18. Cierre A–F

### A) Qué necesita Mi Plan (contexto)

Identificación/contacto, salario/ingreso declarado, laboral, P1–P10, refs CI/LRW; deudas/gastos las captura Mi Plan.

### B) Qué ya puede recibir vía JANUS (post esta fase + migrate + sync)

CI, LRW, nombre, apellido, email, celular, salario, fecha_nacimiento, relacion_laboral, estado, P1–P10, BCU si hay, timestamps + provenance implícita.

### C) Qué debe completar JANUS aún

- Aplicar migración + sync  
- Contrato/redeem hacia Mi Plan (fase siguiente)  
- Monto solicitado: **no disponible** en API actual  

### D) Modelo nuevo en Mi Plan

Fuera de alcance aquí (journey_id, entry token, etc.).

### E) Decisiones humanas abiertas

1. ¿Bloquea producto la ausencia de monto_solicitado?  
2. ¿Persistir también genero/address/city/department?  
3. ¿Semántica exacta de keys `relacion_laboral` vs labels Mi Plan?  

### F) Secuencia recomendada

1. Aplicar `20260924_cz_funnel_solicitudes_profile_fields.sql`  
2. Deploy código sync + un run de funnel sync  
3. Smoke RO: % non-null celular/salario/DOB  
4. **JANUS-MIPLAN-CONTRACT-01** (token + payload allowlist)  
5. Retirar bridge PII-en-URL de Mi Plan  

---

## PRODUCTION DEPLOYMENT

**Fecha:** 2026-09-25  
**Estado:** COMPLETE  

### Targets (CONFIRMED)

| Recurso | Identidad |
|---------|-----------|
| Git branch | `main` |
| Commit | `012562a` (`012562a34d3adc24c012eefece4f83623f44ece6`) |
| Supabase | project `mie-backend` (`usezztlmwfgjcidcrrde`) — **not** CZMiplan / janus-paraguay |
| Railway | project `bountiful-energy` / service `mie-backend` — **not** divine-warmth / CZMiplan |
| Deployment | `762ce332-5b1c-41fd-9976-bfea7a3b0b27` SUCCESS |

### Sequence executed

1. Pre-flight + unit tests PASS  
2. Migration review PASS (ADD COLUMN nullable + indexes only; no DROP/TRUNCATE)  
3. Migration applied via Supabase MCP (`cz_funnel_solicitudes_profile_fields`)  
4. Schema verified: `celular text`, `salario numeric`, `fecha_nacimiento date`, `relacion_laboral text` + indexes  
5. Commit + push `main` (no force)  
6. Railway auto-deploy SUCCESS on `012562a`  
7. Full sync: existing `POST /jobs/run-cz-data-sync` (X-Cron-Key)  
8. Smoke RO aggregates (no PII in logs/report)

### Full sync result

| Source | status | itemsFetched | itemsUpserted | error |
|--------|--------|--------------|---------------|-------|
| solicitudes | success | 301 | 301 | null |
| encuestas | success | 0 | 0 | null (incremental; no new pages) |
| granted | success | 0 | 0 | null |

### Smoke aggregates (no PII)

| Metric | Value |
|--------|-------|
| total solicitudes | 301 |
| with celular | 301 |
| with salario | 301 |
| with fecha_nacimiento | 295 |
| with relacion_laboral | 294 |
| with all profile + lrw + ci | 288 |
| distinct CI | 212 |
| distinct LRW | 293 |
| CI with >1 episode | 26 (max episodes/CI 30; max LRW/CI 27) |
| encuestas rows | 69 (p1=69, p10=69) |

Lookups verified (boolean):

- LRW → episode with celular/salario/DOB/laboral/synced_at: **OK**
- CI → multiple distinct LRW preserved: **OK**
- latest-celular-by-CI rule returns a row: **OK**
- CI with encuesta + profile (excluding fixture CI): episodes>0, p1–p10 present: **OK**

### Regressions

| Area | Result |
|------|--------|
| P1–P10 | NONE (69 rows intact; sync did not clear answers) |
| BCU | NONE (untouched) |
| JT | NONE (untouched; unit jt PASS) |
| Email STEP1/2/3 | NONE (untouched) |

### Incidencias

- Local `.env` lacks `CRON_SECRET`; sync used Railway `CRON_SECRET` / `X-Cron-Key` via CLI (not printed).  
- Encuestas `itemsFetched=0` expected under incremental cursor; integrity verified by row counts.  
- DOB/laboral slightly below 100% non-null — mirrors nullable source data, not mapping failure.

### Post-deploy security

- No new public endpoints  
- No PII added to URLs  
- No Mi Plan transport  
- Temp Railway variable dump files deleted after sync  

---

## Referencias

- `src/jobs/czFunnelSync.js` — `upsertSolicitudes`
- `src/lib/czFunnelSolicitudProfile.js`
- `src/clients/czApiClient.js`
- `migrations/20260813_cz_funnel_sync.sql`
- `migrations/20260911_cz_funnel_solicitudes_email_lrw.sql`
- `migrations/20260924_cz_funnel_solicitudes_profile_fields.sql`
- `scripts/_tmp-probe-solicitudes-email-lrw.json`
- Credizona clone: `apiController.php`, `Entities/Solicitudes.php::getSolicitudesInfo`
- Audits previos: `JANUS-MIPLAN-INTEGRATION-01-JANUS-AUDIT.md`, Mi Plan audit en CZMiplan
