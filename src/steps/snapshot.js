const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const VALID_STATUSES = new Set(['success', 'empty_confirmed', 'empty_unconfirmed']);

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

function resolveSnapshotStatus({ adsFound, status }) {
  if (status) {
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`Invalid snapshot status: ${status}`);
    }
    return status;
  }

  return adsFound > 0 ? 'success' : 'empty_confirmed';
}

async function saveSnapshot({ entityId, ads, collectedAt, apifyRunId, status }) {
  if (!entityId) {
    throw new Error('entityId is required');
  }

  const adsArray = Array.isArray(ads) ? ads : [];
  const adsFound = adsArray.length;
  const resolvedStatus = resolveSnapshotStatus({ adsFound, status });
  const snapshotDate = toSnapshotDate(collectedAt);

  const row = {
    entity_id: entityId,
    snapshot_date: snapshotDate,
    raw_json: adsArray,
    ads_found: adsFound,
    status: resolvedStatus,
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
    status: resolvedStatus,
    snapshotId: data.id,
    snapshotsInserted: 1,
  });

  return {
    snapshotId: data.id,
    snapshotsInserted: 1,
    adsFound,
    status: resolvedStatus,
  };
}

module.exports = { saveSnapshot, VALID_STATUSES };
