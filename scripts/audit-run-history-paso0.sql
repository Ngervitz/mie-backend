-- MIE Run History Integrity — PASO 0 (bug scope) + PASO 1 (schema audit)
-- Run in Supabase SQL Editor before applying migrations.

-- =============================================================================
-- PASO 0 — Bug scope
-- =============================================================================

-- Caso conocido: snapshot con ads_found distinto de ads que apuntan (incl. empty + huérfanos)
SELECT s.id, s.entity_id, s.snapshot_date, s.status, s.ads_found,
       COUNT(a.id) AS ads_apuntando
FROM ad_snapshots s
LEFT JOIN ads a ON a.snapshot_id = s.id
GROUP BY s.id, s.entity_id, s.snapshot_date, s.status, s.ads_found
HAVING s.ads_found != COUNT(a.id);

-- Entidades distintas con el patrón anterior
SELECT COUNT(DISTINCT s.entity_id) AS entidades_con_desajuste
FROM ad_snapshots s
LEFT JOIN ads a ON a.snapshot_id = s.id
GROUP BY s.id, s.entity_id, s.snapshot_date, s.status, s.ads_found
HAVING s.ads_found != COUNT(a.id);

-- Duplicados existentes de apify_run_id (bloquea migración apify unique si hay filas)
SELECT apify_run_id, COUNT(*)
FROM ad_snapshots
WHERE apify_run_id IS NOT NULL
GROUP BY apify_run_id
HAVING COUNT(*) > 1;

-- apify_run_id nulo: frecuencia por status
SELECT status, COUNT(*)
FROM ad_snapshots
WHERE apify_run_id IS NULL
GROUP BY status;

-- =============================================================================
-- PASO 1 — Schema real
-- =============================================================================

SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.ad_snapshots'::regclass;

SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.ads'::regclass;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('ad_snapshots', 'ads');

SELECT column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'ad_snapshots'
ORDER BY ordinal_position;

-- =============================================================================
-- Post-fix validation (run after migration + deploy)
-- =============================================================================

-- Múltiples corridas preservadas
SELECT
  entity_id,
  snapshot_date,
  created_at,
  ads_found,
  status,
  apify_run_id
FROM ad_snapshots
ORDER BY entity_id, snapshot_date, created_at;

-- Volumen por día
SELECT
  snapshot_date,
  COUNT(*) AS runs
FROM ad_snapshots
GROUP BY snapshot_date
ORDER BY snapshot_date DESC;

-- Volumen por entidad/día
SELECT
  entity_id,
  snapshot_date,
  COUNT(*) AS runs
FROM ad_snapshots
GROUP BY entity_id, snapshot_date
ORDER BY runs DESC;

-- apify_run_id duplicado
SELECT apify_run_id, COUNT(*)
FROM ad_snapshots
WHERE apify_run_id IS NOT NULL
GROUP BY apify_run_id
HAVING COUNT(*) > 1;

-- Orphan ads
SELECT COUNT(*) AS orphan_ads
FROM ads a
LEFT JOIN ad_snapshots s ON s.id = a.snapshot_id
WHERE a.snapshot_id IS NOT NULL
  AND s.id IS NULL;

-- Snapshots con raw_json vacío (jsonb)
SELECT id, entity_id, snapshot_date, status, ads_found,
       jsonb_array_length(COALESCE(raw_json, '[]'::jsonb)) AS raw_json_len
FROM ad_snapshots
WHERE jsonb_typeof(COALESCE(raw_json, '[]'::jsonb)) = 'array'
  AND jsonb_array_length(COALESCE(raw_json, '[]'::jsonb)) = 0
  AND ads_found > 0;
