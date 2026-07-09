const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

// Aligned with the real `events` table schema:
//   id                  uuid    (DB-generated, not inserted)
//   entity_id           uuid    NOT NULL
//   ad_id               uuid    NULL
//   event_type          text    NOT NULL (new_ad | copy_changed | ad_reactivated | ad_deactivated)
//   severity            integer NULL
//   detected_at         date    NOT NULL
//   previous_version_id uuid    NULL
//   new_version_id      uuid    NULL
//   previous_value      text    NULL
//   new_value           text    NULL (copy_hash for copy_changed; never full ad text)
//   created_at          timestamptz (DB-generated, not inserted)

const SEVERITY = {
  new_ad: 2,
  copy_changed: 2,
  ad_reactivated: 2,
  ad_deactivated: 1,
};

// At most one row per (entity_id, ad_id, detected_at) for these types (DB partial UNIQUE).
const DEDUP_EVENT_TYPES = new Set(['new_ad', 'ad_reactivated', 'ad_deactivated']);

function toDateOnly(collectedAt) {
  return collectedAt.split('T')[0];
}

function eventDedupKey(adId, eventType) {
  return `${adId}|${eventType}`;
}

async function loadAdIdMap(entityId, adArchiveIds) {
  const map = new Map();

  if (adArchiveIds.length === 0) {
    return map;
  }

  const { data, error } = await supabase
    .from('ads')
    .select('id, ad_archive_id')
    .eq('entity_id', entityId)
    .in('ad_archive_id', adArchiveIds);

  if (error) {
    throw new Error(`Failed to map ad ids for entity ${entityId}: ${error.message}`);
  }

  for (const row of data || []) {
    if (row.ad_archive_id) {
      map.set(String(row.ad_archive_id), row.id);
    }
  }

  return map;
}

async function loadExistingDedupKeys(entityId, detectedAt) {
  const { data, error } = await supabase
    .from('events')
    .select('ad_id, event_type')
    .eq('entity_id', entityId)
    .eq('detected_at', detectedAt)
    .in('event_type', [...DEDUP_EVENT_TYPES])
    .not('ad_id', 'is', null);

  if (error) {
    throw new Error(`Failed to load existing events for dedup (entity ${entityId}): ${error.message}`);
  }

  const keys = new Set();
  for (const row of data || []) {
    keys.add(eventDedupKey(row.ad_id, row.event_type));
  }

  return keys;
}

function logEventOmitted({ entityId, adArchiveId, adId, eventType, detectedAt, reason }) {
  logger.warn('Event omitted', {
    entity_id: entityId,
    ...(adArchiveId !== undefined && { ad_archive_id: adArchiveId }),
    ...(adId !== undefined && { ad_id: adId }),
    event_type: eventType,
    detected_at: detectedAt,
    reason,
  });
}

async function insertEvents({
  entityId,
  entityName,
  reconcileResult,
  deactivateResult,
  recordsToVersion,
  collectedAt,
}) {
  if (!entityId) {
    throw new Error('entityId is required');
  }

  if (!collectedAt) {
    throw new Error('collectedAt is required');
  }

  if (reconcileResult?.skipped) {
    logger.info('Entity events skipped', {
      entityId,
      reason: reconcileResult.reason || 'reconcile_skipped',
    });
    return { inserted: 0, byType: {}, skipped: true, reason: reconcileResult.reason };
  }

  const detectedAt = toDateOnly(collectedAt);
  const newIds = reconcileResult?.new || [];
  const reactivatedIds = reconcileResult?.reactivated || [];
  const deactivatedIds = deactivateResult?.deactivatedIds || [];
  const versionRecords = Array.isArray(recordsToVersion) ? recordsToVersion : [];

  logger.info('Entity events started', {
    entityId,
    newAd: newIds.length,
    reactivated: reactivatedIds.length,
    deactivated: deactivatedIds.length,
    versionRecords: versionRecords.length,
  });

  const archiveIds = [
    ...new Set([
      ...newIds.map(String),
      ...reactivatedIds.map(String),
      ...deactivatedIds.map(String),
    ]),
  ];

  const adIdMap = await loadAdIdMap(entityId, archiveIds);
  const existingDedupKeys = await loadExistingDedupKeys(entityId, detectedAt);
  const batchDedupKeys = new Set();

  const rows = [];
  const byType = {};
  let deduplicated = 0;

  function pushEvent(eventType, adId, extra = {}) {
    if (!adId) {
      return;
    }

    if (DEDUP_EVENT_TYPES.has(eventType)) {
      const key = eventDedupKey(adId, eventType);

      if (batchDedupKeys.has(key)) {
        deduplicated += 1;
        logEventOmitted({
          entityId,
          adId,
          eventType,
          detectedAt,
          reason: 'duplicate_in_batch',
        });
        return;
      }

      if (existingDedupKeys.has(key)) {
        deduplicated += 1;
        logEventOmitted({
          entityId,
          adId,
          eventType,
          detectedAt,
          reason: 'already_recorded',
        });
        return;
      }

      batchDedupKeys.add(key);
    }

    rows.push({
      entity_id: entityId,
      ad_id: adId,
      event_type: eventType,
      severity: SEVERITY[eventType] ?? null,
      detected_at: detectedAt,
      previous_version_id: extra.previous_version_id ?? null,
      new_version_id: extra.new_version_id ?? null,
      previous_value: extra.previous_value ?? null,
      new_value: extra.new_value ?? null,
    });

    byType[eventType] = (byType[eventType] || 0) + 1;
  }

  const newAdUuids = new Set();
  for (const archiveId of newIds) {
    const adId = adIdMap.get(String(archiveId));
    if (!adId) {
      logEventOmitted({
        entityId,
        adArchiveId: String(archiveId),
        eventType: 'new_ad',
        detectedAt,
        reason: 'missing_ad_id',
      });
    } else {
      newAdUuids.add(adId);
    }
    pushEvent('new_ad', adId);
  }

  for (const archiveId of reactivatedIds) {
    const adId = adIdMap.get(String(archiveId));
    if (!adId) {
      logEventOmitted({
        entityId,
        adArchiveId: String(archiveId),
        eventType: 'ad_reactivated',
        detectedAt,
        reason: 'missing_ad_id',
      });
    }
    pushEvent('ad_reactivated', adId);
  }

  for (const archiveId of deactivatedIds) {
    pushEvent('ad_deactivated', adIdMap.get(String(archiveId)));
  }

  for (const record of versionRecords) {
    if (record.ad_id && !newAdUuids.has(record.ad_id)) {
      pushEvent('copy_changed', record.ad_id, {
        new_value: record.copy_hash ?? null,
      });
    }
  }

  if (rows.length === 0) {
    logger.info('Entity events finished', {
      entityId,
      inserted: 0,
      deduplicated,
    });
    return { inserted: 0, byType: {}, deduplicated };
  }

  // Row-by-row insert: a single multi-row INSERT aborts the whole batch on any
  // UNIQUE violation (PostgreSQL). Partial UNIQUE indexes cannot use PostgREST
  // ignoreDuplicates/onConflict (no WHERE predicate support). Pre-dedup above
  // handles the common case; per-row 23505 skip handles races / second sync.
  let inserted = 0;

  for (const row of rows) {
    const { error } = await supabase.from('events').insert(row);

    if (error) {
      if (error.code === '23505') {
        deduplicated += 1;
        logger.warn('Event insert conflict (skipped)', {
          entity_id: row.entity_id,
          ad_id: row.ad_id,
          event_type: row.event_type,
          detected_at: row.detected_at,
          reason: 'unique_violation',
        });
        continue;
      }

      throw new Error(`Failed to insert events for entity ${entityId}: ${error.message}`);
    }

    inserted += 1;
  }

  logger.info('Entity events finished', {
    entityId,
    inserted,
    deduplicated,
    byType,
  });

  return { inserted, byType, deduplicated };
}

module.exports = { insertEvents, DEDUP_EVENT_TYPES };
