const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

function toSnapshotDate(collectedAt) {
  if (!collectedAt) {
    throw new Error('collectedAt is required');
  }

  const date = new Date(collectedAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid collectedAt: ${collectedAt}`);
  }

  return date.toISOString().split('T')[0];
}

async function saveSnapshot({ entityId, ads, collectedAt, apifyRunId }) {
  if (!entityId) {
    throw new Error('entityId is required');
  }

  const adsArray = Array.isArray(ads) ? ads : [];
  const adsFound = adsArray.length;
  const status = adsFound > 0 ? 'success' : 'empty';

  // One snapshot per entity per day.
  // First run performs INSERT.
  // Subsequent runs on the same day UPDATE the existing snapshot.
  const { data, error } = await supabase
    .from('ad_snapshots')
    .upsert(
      {
        entity_id: entityId,
        snapshot_date: toSnapshotDate(collectedAt),
        raw_json: adsArray,
        ads_found: adsFound,
        status,
        apify_run_id: apifyRunId ?? null,
      },
      {
        onConflict: 'entity_id,snapshot_date',
        ignoreDuplicates: false,
      },
    )
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to insert ad_snapshots for entity ${entityId}: ${error.message}`);
  }

  logger.info('Snapshot saved', {
    entityId,
    adsFound,
    snapshotId: data.id,
    snapshotsInserted: 1,
  });

  return { snapshotId: data.id, snapshotsInserted: 1 };
}

module.exports = { saveSnapshot };
