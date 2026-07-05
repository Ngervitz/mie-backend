-- MIE Empty Result Confirmation Guard — validation queries

-- 1. Snapshots por status (incluye legacy empty)
SELECT status, COUNT(*) AS rows
FROM ad_snapshots
GROUP BY status
ORDER BY rows DESC;

-- 2. Último snapshot del día por entidad (estado operativo)
SELECT DISTINCT ON (entity_id)
  entity_id,
  snapshot_date,
  created_at,
  status,
  ads_found,
  apify_run_id
FROM ad_snapshots
ORDER BY entity_id, snapshot_date DESC, created_at DESC;

-- 3. Días con múltiples corridas (evidencia append-only + retry)
SELECT entity_id, snapshot_date, COUNT(*) AS runs,
       array_agg(status ORDER BY created_at) AS statuses
FROM ad_snapshots
GROUP BY entity_id, snapshot_date
HAVING COUNT(*) > 1
ORDER BY runs DESC;

-- 4. Patrón retry: empty_unconfirmed seguido de success el mismo día
SELECT a.entity_id, a.snapshot_date,
       a.created_at AS first_at, a.status AS first_status,
       b.created_at AS second_at, b.status AS second_status
FROM ad_snapshots a
JOIN ad_snapshots b
  ON b.entity_id = a.entity_id
 AND b.snapshot_date = a.snapshot_date
 AND b.created_at > a.created_at
WHERE a.status = 'empty_unconfirmed'
  AND b.status = 'success';

-- 5. empty_unconfirmed recientes (no deben tener eventos de desactivación el mismo día)
SELECT s.entity_id, s.snapshot_date, s.created_at, s.status,
       COUNT(e.id) AS events_same_day
FROM ad_snapshots s
LEFT JOIN events e
  ON e.entity_id = s.entity_id
 AND e.detected_at = s.snapshot_date
 AND e.event_type = 'ad_deactivated'
WHERE s.status = 'empty_unconfirmed'
GROUP BY s.id, s.entity_id, s.snapshot_date, s.created_at, s.status
ORDER BY s.created_at DESC;

-- 6. empty_confirmed sin par confirmado (ventana 24-72h + continuidad manual)
SELECT entity_id, snapshot_date, created_at, status
FROM ad_snapshots
WHERE status IN ('empty_confirmed', 'empty')
ORDER BY entity_id, created_at;

-- 7. Ads activos por entidad (no deben caer a 0 por un solo empty_unconfirmed)
SELECT me.name, COUNT(a.id) FILTER (WHERE a.is_active) AS active_ads
FROM monitored_entities me
LEFT JOIN ads a ON a.entity_id = me.id
GROUP BY me.id, me.name
ORDER BY active_ads ASC;

-- 8. Eventos de desactivación por entidad/día
SELECT me.name, e.detected_at, COUNT(*) AS deactivations
FROM events e
JOIN monitored_entities me ON me.id = e.entity_id
WHERE e.event_type = 'ad_deactivated'
GROUP BY me.name, e.detected_at
ORDER BY e.detected_at DESC, deactivations DESC;

-- 9. Días sin snapshot en ventana (auditoría manual de continuidad)
-- Reemplazar fechas y entity_id:
-- SELECT d::date AS missing_day
-- FROM generate_series('2026-06-01'::date, '2026-06-05'::date, '1 day') d
-- WHERE NOT EXISTS (
--   SELECT 1 FROM ad_snapshots s
--   WHERE s.entity_id = 'ENTITY_UUID'
--     AND s.snapshot_date = d::date
-- );
