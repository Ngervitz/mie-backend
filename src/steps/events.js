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

function toDateOnly(collectedAt) {
  return collectedAt.split('T')[0];
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

  const rows = [];
  const byType = {};

  function pushEvent(eventType, adId, extra = {}) {
    if (!adId) {
      return;
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

  // new_ad: one per ad classified as `new` by Reconcile.
  const newAdUuids = new Set();
  for (const archiveId of newIds) {
    const adId = adIdMap.get(String(archiveId));
    if (adId) {
      newAdUuids.add(adId);
    }
    pushEvent('new_ad', adId);
  }

  // ad_reactivated: one per ad classified as `reactivated` by Reconcile.
  for (const archiveId of reactivatedIds) {
    pushEvent('ad_reactivated', adIdMap.get(String(archiveId)));
  }

  // ad_deactivated: only for ads actually updated by Deactivate (not skipped).
  for (const archiveId of deactivatedIds) {
    pushEvent('ad_deactivated', adIdMap.get(String(archiveId)));
  }

  // copy_changed: from recordsToVersion, excluding the initial version of new ads.
  // recordsToVersion already carries ad_id (uuid) and copy_hash; no recompute.
  // new_value stores the copy_hash only (never the full ad text).
  for (const record of versionRecords) {
    if (record.ad_id && !newAdUuids.has(record.ad_id)) {
      pushEvent('copy_changed', record.ad_id, {
        new_value: record.copy_hash ?? null,
      });
    }
  }

  if (rows.length === 0) {
    logger.info('Entity events finished', { entityId, inserted: 0 });
    return { inserted: 0, byType: {} };
  }

  const { error } = await supabase.from('events').insert(rows);

  if (error) {
    throw new Error(`Failed to insert events for entity ${entityId}: ${error.message}`);
  }

  logger.info('Entity events finished', {
    entityId,
    inserted: rows.length,
    byType,
  });

  return { inserted: rows.length, byType };
}

module.exports = { insertEvents };
