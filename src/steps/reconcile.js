const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

function getAdArchiveId(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const id = item.adArchiveId ?? item.adArchiveID ?? item.ad_archive_id ?? item.id;

  if (id === null || id === undefined) {
    return null;
  }

  const normalizedId = String(id).trim();

  if (!normalizedId) {
    return null;
  }

  return normalizedId;
}

async function loadSnapshot(entityId, snapshotId) {
  if (snapshotId) {
    const { data, error } = await supabase
      .from('ad_snapshots')
      .select('*')
      .eq('id', snapshotId)
      .eq('entity_id', entityId)
      .single();

    if (error || !data) {
      throw new Error(`Snapshot not found: ${snapshotId} for entity ${entityId}`);
    }

    return data;
  }

  const { data, error } = await supabase
    .from('ad_snapshots')
    .select('*')
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch latest snapshot for entity ${entityId}: ${error.message}`);
  }

  if (!data) {
    throw new Error(`No snapshot found for entity ${entityId}`);
  }

  return data;
}

async function reconcileEntity({ entityId, snapshotId }) {
  if (!entityId) {
    throw new Error('entityId is required');
  }

  const snapshot = await loadSnapshot(entityId, snapshotId);
  const rawJson = Array.isArray(snapshot.raw_json) ? snapshot.raw_json : [];

  const apifyIdsToday = new Set();

  for (const item of rawJson) {
    const adArchiveId = getAdArchiveId(item);

    if (!adArchiveId) {
      logger.warn('Ad item missing archive ID, skipping', {
        entityId,
        snapshotId: snapshot.id,
      });
      continue;
    }

    apifyIdsToday.add(adArchiveId);
  }

  const { data: adsRows, error: adsError } = await supabase
    .from('ads')
    .select('ad_archive_id, is_active')
    .eq('entity_id', entityId);

  if (adsError) {
    throw new Error(`Failed to fetch ads for entity ${entityId}: ${adsError.message}`);
  }

  const dbActive = new Set();
  const dbInactive = new Set();

  for (const row of adsRows || []) {
    if (!row.ad_archive_id) {
      continue;
    }

    const adArchiveId = String(row.ad_archive_id);

    if (row.is_active === true) {
      dbActive.add(adArchiveId);
    } else if (row.is_active === false) {
      dbInactive.add(adArchiveId);
    }
  }

  const newIds = [];
  const reactivatedIds = [];
  const persistentIds = [];

  for (const id of apifyIdsToday) {
    if (!dbActive.has(id) && !dbInactive.has(id)) {
      newIds.push(id);
    } else if (dbInactive.has(id)) {
      reactivatedIds.push(id);
    } else if (dbActive.has(id)) {
      persistentIds.push(id);
    }
  }

  const disappearedIds = [];

  for (const id of dbActive) {
    if (!apifyIdsToday.has(id)) {
      disappearedIds.push(id);
    }
  }

  logger.info('Entity reconcile completed', {
    entityId,
    snapshotId: snapshot.id,
    new: newIds.length,
    reactivated: reactivatedIds.length,
    persistent: persistentIds.length,
    disappeared: disappearedIds.length,
  });

  return {
    snapshotId: snapshot.id,
    new: newIds,
    reactivated: reactivatedIds,
    persistent: persistentIds,
    disappeared: disappearedIds,
  };
}

module.exports = { reconcileEntity, getAdArchiveId };
