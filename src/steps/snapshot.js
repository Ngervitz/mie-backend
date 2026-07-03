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
  const snapshotDate = toSnapshotDate(collectedAt);

  const row = {
    entity_id: entityId,
    snapshot_date: snapshotDate,
    raw_json: adsArray,
    ads_found: adsFound,
    status,
    apify_run_id: apifyRunId ?? null,
  };

  const { data, error } = await supabase
    .from('ad_snapshots')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505' && apifyRunId) {
      const { data: existing, error: fetchError } = await supabase
        .from('ad_snapshots')
        .select('id, ads_found, status')
        .eq('apify_run_id', apifyRunId)
        .maybeSingle();

      if (!fetchError && existing) {
        logger.info('Snapshot deduplicated by apify_run_id', {
          entityId,
          apifyRunId,
          snapshotId: existing.id,
          snapshotsInserted: 0,
        });

        return {
          snapshotId: existing.id,
          snapshotsInserted: 0,
          adsFound: existing.ads_found,
          status: existing.status,
        };
      }
    }

    throw new Error(`Failed to insert ad_snapshots for entity ${entityId}: ${error.message}`);
  }

  logger.info('Snapshot saved', {
    entityId,
    adsFound,
    snapshotId: data.id,
    snapshotsInserted: 1,
  });

  return {
    snapshotId: data.id,
    snapshotsInserted: 1,
    adsFound,
    status,
  };
}

module.exports = { saveSnapshot };
