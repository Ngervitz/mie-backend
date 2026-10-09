# ELM fallback: checklist de activación

**Estado global: NO apto para producción.** Salvo los marcados RECIBIDO/CONFIRMADO, todos los ítems
siguientes están **abiertos** (BLOQUEANTES). No se activa ningún flag mientras quede uno abierto.
Terminar el código no habilita nada.

Cada ítem se cierra solo con la evidencia indicada, archivada (link o archivo), fecha y responsable.

| # | Ítem | Estado | Evidencia requerida para cerrar |
|---|---|---|---|
| 1a | URLs S1/S2 (RESTlets NetSuite) | RECIBIDO | Recibidas de ELM (Fabián). Son de **producción**: no hay URLs de test. Se cargan solo como variables de entorno (`ELM_SERVICE_1_URL`, `ELM_SERVICE_2_URL`); nunca en el repo, tests, documentos ni logs. El cliente valida que sean `https`, host `*.restlets.api.netsuite.com`, path `restlet.nl` con `script` y `deploy`, y la misma cuenta en ambas. |
| 1b | Credenciales OAuth 1.0 (TBA, HMAC-SHA256) | RECIBIDAS — pendientes de carga segura y validación | Cargar `ELM_CONSUMER_KEY`, `ELM_CONSUMER_SECRET`, `ELM_TOKEN_ID`, `ELM_TOKEN_SECRET` solo en Railway (variables selladas), con `ELM_CLIENT_ENABLED` apagado. Validación = ítem 1c. Las credenciales circularon fuera de un canal seguro: ver ítem 1d. |
| 1c | Prueba real de conexión | PENDIENTE (ABIERTO) | Ventana acordada con ELM y autorización expresa. Un caso controlado por servicio (preferentemente un CI de prueba indicado por ELM, para no generar un lead real), registrando HTTP, `result` y latencia. Confirmar en esa prueba: firma aceptada (sin 401/403), formato de `result`, tipo de `TrackingId` (hoy se envía como string) y que el postback devuelve el `TrackingId` de S2 como `internal_id`. Transporte implementado (`createNetSuiteElmClient`) y probado solo con mocks. |
| 1d | Rotación de credenciales de producción | PENDIENTE (ABIERTO) | Rotación del token (y consumer si ELM lo indica) antes del piloto, entregada por canal seguro y cargada directo en Railway. Confirmación escrita de ELM de la revocación de las credenciales anteriores. |
| 2 | `TrackingId` | CONFIRMADO por ELM: solo en S2 | S1 no lleva `TrackingId`. S2 envía `TrackingId = cz_solicitud_id`. El postback se asocia por `internal_id` (campo documentado); un `TrackingId` en el postback solo se acepta si coincide con `internal_id` y nunca se usa solo. La verificación del eco queda en el ítem 1c. |
| 3 | `source = "copanel"` | CONFIRMADO por ELM | `copanel` en S1 y S2, sin depender de la base SMS/Meta/orgánica. El origen comercial se guarda aparte (`commercial_origin`) y nunca se envía. |
| 3b | Mapeos de formato del payload | ABIERTO | Confirmación escrita de ELM de los valores de `activityType` por relación laboral (`ELM_ACTIVITY_TYPE_MAP_JSON`), formato de `dateOfBirth` (`ELM_DATE_OF_BIRTH_FORMAT`) y de `mobilephone` (`ELM_MOBILE_PHONE_FORMAT`). Sin ellos, todo envío queda bloqueado (`manual_review` `elm_config_incomplete`). |
| 4 | Autenticación del postback y operación real | ABIERTO (código implementado) | Implementado: header `X-Credizona-Postback-Token` contra `ELM_POSTBACK_TOKEN_CURRENT` (y `ELM_POSTBACK_TOKEN_PREVIOUS` durante una rotación), comparación en tiempo constante, 401 genérico, 503 mientras no haya un token válido configurado, autenticación antes de parsear el cuerpo y antes de cualquier acceso a la base, ruta montada antes de `requireAuth`. Falta: generar el token (32 bytes aleatorios en hex, fuera del repo), entregarlo a ELM por canal seguro, cargarlo en Railway, confirmación de ELM de que envía ese header en cada postback, y prueba real: `Convertido` asociado por `internal_id`, estados intermedios, reintentos y duplicados. |
| 5 | Auditoría de seguridad del webhook CDV | ABIERTO | Revisión del webhook CDV en CZ: autenticación, claves hoy hardcodeadas en el código CZ (rotación y traslado a configuración), y asociación por CI sin filtrar estado (puede mover a 11 una solicitud en 12/13). Hallazgos resueltos o aceptados por escrito. |
| 6 | Clasificación probada de rechazos reales de CDV | ABIERTO | Lista cerrada de `status` CDV que son rechazo crediticio genuino, validada con casos reales (muestra con conteos). Solo esos inician el fallback; errores técnicos de CDV nunca. |
| 7 | Concurrencia real en PostgreSQL con `SKIP LOCKED` | VERIFICADO LOCAL (repetir en rama) | Prueba con ≥ 2 conexiones reales en una base **no productiva** (rama Supabase o Postgres local): claims disjuntos, una evaluación por CI, `elm_retry_step` concurrente → un solo reintento, `elm_resolve_process` contra postback concurrente → `stale`. PGlite (una sola conexión) no lo cubre. Ejecutado con `scripts/db-local-provider-fallback-c1-realpg.js` (PostgreSQL 17.10 local temporal, 8 conexiones, 1A+1B+3A+3B+C1): todo OK, incluido el claim único por CI entre orígenes y el reintento BCU. Repetir en una rama Supabase al aplicar las migraciones. |
| 8 | Migraciones aplicadas y verificadas | ABIERTO | 1A y 1B ya aplicadas en prod (0 filas). Pendientes **3A** (`20261008_provider_fallback_requests.sql`) y **3B** (`20261009_elm_phase3b_operations.sql`), en ese orden, primero en una rama y luego en prod. Verificar tablas, firmas únicas (`elm_claim_process` de 10 argumentos, `provider_fallback_finalize` de 9), RLS sin políticas y grants. El código 3B requiere 3B aplicada: se despliega junto con la migración, nunca antes. |
| 9 | Integración CZ | ABIERTO | Estados nuevos insertados en `solicitudes_estados` (ver `ELM-FALLBACK-CZ-CONTRACT.md`), compare-and-set, cron CZ de reconciliación (`deliveries/pending` + `ack`), recuperación sin navegador probada, `fromApi` excluido, secreto HMAC dedicado fuera de los fuentes. |
| 10 | Consentimiento contractual | ABIERTO | Revisión legal del texto de consentimiento para compartir datos con ELM. Persistencia server-side de versión y fecha de aceptación (hoy el checkbox solo se valida en el cliente). Contrato con ELM firmado. |
| 11 | Piloto controlado con flags y kill switch | ABIERTO | Plan escrito: allowlist por CI en CZ, volumen máximo diario, responsables, monitoreo de la cola de revisión, criterio de corte. Kill switch probado (ver abajo). |

## Flags y variables (todas apagadas o vacías por defecto)

Solo el string `true` (sin distinguir mayúsculas) habilita un flag.

| Variable | Efecto | Valor actual requerido |
|---|---|---|
| `PROVIDER_FALLBACK_START_ENABLED` | Acepta `POST /internal/providers/v1/fallback/start` | apagado |
| `PROVIDER_FALLBACK_WORKER_ENABLED` | El cron `POST /jobs/run-provider-fallback-worker` procesa jobs | apagado |
| `PROVIDER_FALLBACK_CZ_AUTOMATIC_ENABLED` | El orquestador acepta `trigger_origin = cz_automatic` | apagado |
| `PROVIDER_FALLBACK_IMMEDIATE_KICK_ENABLED` | `start` corre el worker de inmediato | apagado |
| `CZ_PROVIDER_FALLBACK_HMAC_SECRET` | Secreto dedicado CZ↔JANUS | vacío (sin él, las rutas responden 503) |
| `ELM_CLIENT_ENABLED` | Habilita el cliente real ELM (NetSuite). Apagado: ninguna llamada sale, aunque las demás variables estén cargadas | **apagado** hasta autorización expresa (ítems 1c, 1d) |
| `ELM_SERVICE_1_URL`, `ELM_SERVICE_2_URL` | URLs RESTlet S1/S2 | cargar solo en Railway (ítem 1a); nunca en el repo |
| `ELM_CONSUMER_KEY`, `ELM_CONSUMER_SECRET`, `ELM_TOKEN_ID`, `ELM_TOKEN_SECRET` | Credenciales OAuth 1.0 TBA | cargar solo en Railway tras la rotación (ítems 1b, 1d). Si falta o es inválida una, el cliente queda deshabilitado (`elm_transport_config_incomplete`, informa solo nombres de variables) |
| `ELM_POSTBACK_TOKEN_CURRENT` | Token que ELM envía en `X-Credizona-Postback-Token`. Hex, ≥ 64 caracteres (32 bytes aleatorios), distinto de cualquier otro secreto JANUS | vacío (sin él, `POST /elm/postback` responde 503) hasta el ítem 4 |
| `ELM_POSTBACK_TOKEN_PREVIOUS` | Token anterior, aceptado solo mientras dura una rotación; quitarlo al terminarla. Si está cargado e inválido, todo el endpoint queda en 503 | vacío |
| `ELM_HTTP_TIMEOUT_MS` | Timeout por llamada; vencido → `unknown`, sin reintento | default del código |
| `ELM_ACTIVITY_TYPE_MAP_JSON`, `ELM_DATE_OF_BIRTH_FORMAT`, `ELM_MOBILE_PHONE_FORMAT` | Formato del payload | vacíos hasta confirmación ELM |
| `ELM_RETRY_SAFE_ERROR_CODES` | Códigos `technical_error` que pueden reenviarse | **vacío**: nada se reintenta. Solo agregar un código con evidencia escrita de ELM de que esa respuesta no produjo efectos (p. ej. `elm_provider_bcu_error`) |
| `ELM_TECHNICAL_RETRY_MAX_ATTEMPTS` / `_BACKOFF_SECONDS` / `_BACKOFF_MAX_SECONDS` | Límite y backoff de reintentos | 3 / 300 / 21600 por defecto |
| `PROVIDER_REVIEW_SLA_JSON` | Prioridad y plazo de la cola de revisión por motivo | por defecto `normal` / 24 h (provisorio hasta que operaciones lo defina) |

## Kill switch (orden de corte)

1. CZ: apagar el flag de activación del lado CZ (las solicitudes nuevas vuelven a terminar en 3 como hoy).
2. JANUS: `PROVIDER_FALLBACK_START_ENABLED` apagado (start responde 503) y
   `PROVIDER_FALLBACK_WORKER_ENABLED` apagado (no se procesan jobs; los `queued` esperan sin enviar).
3. Los procesos `in_flight` vencen a `unknown` y van a `manual_review`. Nunca se reenvían.
4. Los resultados finales ya calculados siguen disponibles en `deliveries/pending` para que CZ los aplique.

Prueba requerida del kill switch (ítem 11): con jobs en cola, apagar los flags y verificar 0 llamadas a
ELM, 0 cambios de outcome y entrega intacta de los finales ya calculados.
