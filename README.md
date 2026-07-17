# MIE Backend

Meta Intelligence Engine

Monitoreo competitivo basado en Meta Ad Library.

## Script local: discovery refresh de Google Trends

`scripts/local-discovery-refresh.js` corre el refresh mensual de related queries
de Google Trends **desde una máquina local, no desde Railway**.

- **Por qué:** el endpoint `relatedsearches` de Google devuelve 429 persistente
  a la IP de datacenter de Railway cuando la respuesta trae contenido real
  (verificado en producción); desde una IP residencial funciona en segundos.
- **Cómo:** `node scripts/local-discovery-refresh.js`, con un `.env` local en la
  raíz del repo (gitignoreado) que tenga `SUPABASE_URL` y
  `SUPABASE_SERVICE_ROLE_KEY` (la service role key es necesaria: la tabla
  `search_term_discoveries` tiene RLS sin política de INSERT para `anon`).
- **Cadencia:** manual, aproximadamente una vez por mes. Cada corrida agrega un
  snapshot nuevo (la tabla es append-only por diseño).
