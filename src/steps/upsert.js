const crypto = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

function normalizeCopy(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, '\n')
    .toLowerCase();
}

function computeCopyHash(text) {
  return crypto.createHash('md5').update(normalizeCopy(text)).digest('hex');
}

function parseApifyTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toDateOnly(collectedAt) {
  return collectedAt.split('T')[0];
}

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

function findRawAd(rawJson, adArchiveId) {
  for (const item of rawJson) {
    if (getAdArchiveId(item) === adArchiveId) {
      return item;
    }
  }

  return null;
}

function extractAdText(item) {
  if (item.ad_text) return item.ad_text;
  if (item.adText) return item.adText;
  if (Array.isArray(item.adCreativeBodies) && item.adCreativeBodies[0]) {
    return item.adCreativeBodies[0];
  }
  if (Array.isArray(item.ad_creative_bodies) && item.ad_creative_bodies[0]) {
    return item.ad_creative_bodies[0];
  }
  if (item.body) return item.body;
  return null;
}

function extractPlatforms(item) {
  const platforms = item.platforms ?? item.publisherPlatforms ?? item.publisher_platforms;

  if (Array.isArray(platforms)) {
    return platforms;
  }

  return null;
}

function extractAdFormat(item) {
  return item.ad_format ?? item.adFormat ?? item.displayFormat ?? item.format ?? null;
}

function buildAdFromRaw(rawItem, entityId, snapshotId, collectedAt) {
  const adArchiveId = getAdArchiveId(rawItem);
  const adText = extractAdText(rawItem);
  const dateOnly = toDateOnly(collectedAt);
  const updatedAt = new Date().toISOString();

  return {
    entity_id: entityId,
    snapshot_id: snapshotId,
    ad_archive_id: adArchiveId,
    first_seen_at: dateOnly,
    last_seen_at: dateOnly,
    is_active: true,
    ad_text: adText,
    cta_text: null,
    landing_url: null,
    platforms: extractPlatforms(rawItem),
    ad_format: extractAdFormat(rawItem),
    image_url: null,
    video_url: null,
    creative_hash: null,
    copy_hash: computeCopyHash(adText),
    ad_creation_date: parseApifyTimestamp(
      rawItem.ad_creation_date ?? rawItem.adCreationDate ?? rawItem.adCreationTime ?? rawItem.creationTime,
    ),
    ad_start_date: parseApifyTimestamp(
      rawItem.ad_start_date
        ?? rawItem.adStartDate
        ?? rawItem.ad_delivery_start_time
        ?? rawItem.delivery_start_time,
    ),
    ad_end_date: parseApifyTimestamp(
      rawItem.ad_end_date
        ?? rawItem.adEndDate
        ?? rawItem.ad_delivery_stop_time
        ?? rawItem.delivery_stop_time,
    ),
    ad_library_url: rawItem.ad_library_url ?? rawItem.adLibraryUrl ?? rawItem.ad_snapshot_url ?? null,
    updated_at: updatedAt,
  };
}

async function loadAdInfoMap(entityId, adArchiveIds) {
  const adInfoMap = new Map();

  if (adArchiveIds.length === 0) {
    return adInfoMap;
  }

  const { data, error } = await supabase
    .from('ads')
    .select('id, ad_archive_id, copy_hash')
    .eq('entity_id', entityId)
    .in('ad_archive_id', adArchiveIds);

  if (error) {
    throw new Error(`Failed to fetch ad info for entity ${entityId}: ${error.message}`);
  }

  for (const row of data || []) {
    if (row.ad_archive_id) {
      adInfoMap.set(String(row.ad_archive_id), {
        id: row.id,
        copy_hash: row.copy_hash ?? null,
      });
    }
  }

  return adInfoMap;
}

function buildRecordToVersion(adId, fields) {
  return {
    ad_id: adId,
    ad_text: fields.ad_text,
    cta_text: fields.cta_text,
    landing_url: fields.landing_url,
    platforms: fields.platforms,
    ad_format: fields.ad_format,
    image_url: fields.image_url,
    video_url: fields.video_url,
    creative_hash: fields.creative_hash,
    copy_hash: fields.copy_hash,
  };
}

function buildVersionFieldsFromRaw(rawItem, adText, copyHash) {
  return {
    ad_text: adText,
    cta_text: null,
    landing_url: null,
    platforms: extractPlatforms(rawItem),
    ad_format: extractAdFormat(rawItem),
    image_url: null,
    video_url: null,
    creative_hash: null,
    copy_hash: copyHash,
  };
}

async function upsertAds({ entityId, snapshotId, reconciled, collectedAt }) {
  if (!entityId) {
    throw new Error('entityId is required');
  }

  if (!snapshotId) {
    throw new Error('snapshotId is required');
  }

  if (!collectedAt) {
    throw new Error('collectedAt is required');
  }

  if (!reconciled) {
    throw new Error('reconciled is required');
  }

  const newIds = reconciled.new || [];
  const reactivatedIds = reconciled.reactivated || [];
  const persistentIds = reconciled.persistent || [];
  const disappearedIds = reconciled.disappeared || [];

  const counters = {
    inserted: 0,
    reactivated: 0,
    persistentUpdated: 0,
    persistentUnchanged: 0,
    copyChanged: 0,
    skippedDisappeared: disappearedIds.length,
  };

  logger.info('Entity upsert started', {
    entityId,
    snapshotId,
    new: newIds.length,
    reactivated: reactivatedIds.length,
    persistent: persistentIds.length,
    disappeared: disappearedIds.length,
  });

  if (newIds.length === 0 && reactivatedIds.length === 0 && persistentIds.length === 0) {
    logger.info('Entity upsert finished', { entityId, snapshotId, ...counters });
    return { ...counters, recordsToVersion: [] };
  }

  const { data: snapshot, error: snapshotError } = await supabase
    .from('ad_snapshots')
    .select('raw_json')
    .eq('id', snapshotId)
    .eq('entity_id', entityId)
    .single();

  if (snapshotError || !snapshot) {
    throw new Error(`Snapshot not found: ${snapshotId} for entity ${entityId}`);
  }

  const rawJson = Array.isArray(snapshot.raw_json) ? snapshot.raw_json : [];
  const dateOnly = toDateOnly(collectedAt);
  const updatedAt = new Date().toISOString();
  const recordsToVersion = [];

  const adInfoMap = await loadAdInfoMap(entityId, [
    ...reactivatedIds,
    ...persistentIds,
  ]);

  const rowsToInsert = [];

  for (const adArchiveId of newIds) {
    const rawItem = findRawAd(rawJson, adArchiveId);

    if (!rawItem) {
      logger.warn('Raw ad not found for new ad_archive_id, skipping', {
        entityId,
        snapshotId,
        adArchiveId,
      });
      continue;
    }

    rowsToInsert.push(buildAdFromRaw(rawItem, entityId, snapshotId, collectedAt));
  }

  if (rowsToInsert.length > 0) {
    const { data: insertedAds, error: insertError } = await supabase
      .from('ads')
      .insert(rowsToInsert)
      .select('id, ad_text, cta_text, landing_url, platforms, ad_format, image_url, video_url, creative_hash, copy_hash');

    if (insertError) {
      throw new Error(`Failed to insert ads for entity ${entityId}: ${insertError.message}`);
    }

    counters.inserted = insertedAds.length;

    for (const ad of insertedAds) {
      recordsToVersion.push(buildRecordToVersion(ad.id, ad));
    }
  }

  for (const adArchiveId of reactivatedIds) {
    const rawItem = findRawAd(rawJson, adArchiveId);

    if (!rawItem) {
      logger.warn('Raw ad not found for reactivated ad_archive_id, skipping', {
        entityId,
        snapshotId,
        adArchiveId,
      });
      continue;
    }

    const adText = extractAdText(rawItem);
    const newCopyHash = computeCopyHash(adText);
    const adInfo = adInfoMap.get(adArchiveId);
    const previousCopyHash = adInfo?.copy_hash ?? null;
    const copyChanged = newCopyHash !== previousCopyHash;

    if (copyChanged) {
      counters.copyChanged += 1;
    }

    const { error: updateError } = await supabase
      .from('ads')
      .update({
        is_active: true,
        snapshot_id: snapshotId,
        last_seen_at: dateOnly,
        ad_text: adText,
        platforms: extractPlatforms(rawItem),
        copy_hash: newCopyHash,
        updated_at: updatedAt,
      })
      .eq('entity_id', entityId)
      .eq('ad_archive_id', adArchiveId);

    if (updateError) {
      throw new Error(
        `Failed to reactivate ad ${adArchiveId} for entity ${entityId}: ${updateError.message}`,
      );
    }

    if (copyChanged && adInfo?.id) {
      recordsToVersion.push(
        buildRecordToVersion(
          adInfo.id,
          buildVersionFieldsFromRaw(rawItem, adText, newCopyHash),
        ),
      );
    }

    counters.reactivated += 1;
  }

  for (const adArchiveId of persistentIds) {
    const rawItem = findRawAd(rawJson, adArchiveId);

    if (!rawItem) {
      logger.warn('Raw ad not found for persistent ad_archive_id, skipping', {
        entityId,
        snapshotId,
        adArchiveId,
      });
      continue;
    }

    const adText = extractAdText(rawItem);
    const newCopyHash = computeCopyHash(adText);
    const adInfo = adInfoMap.get(adArchiveId);
    const previousCopyHash = adInfo?.copy_hash ?? null;

    if (newCopyHash !== previousCopyHash) {
      const { error: updateError } = await supabase
        .from('ads')
        .update({
          ad_text: adText,
          platforms: extractPlatforms(rawItem),
          copy_hash: newCopyHash,
          snapshot_id: snapshotId,
          last_seen_at: dateOnly,
          updated_at: updatedAt,
        })
        .eq('entity_id', entityId)
        .eq('ad_archive_id', adArchiveId);

      if (updateError) {
        throw new Error(
          `Failed to update persistent ad ${adArchiveId} for entity ${entityId}: ${updateError.message}`,
        );
      }

      counters.persistentUpdated += 1;
      counters.copyChanged += 1;

      if (adInfo?.id) {
        recordsToVersion.push(
          buildRecordToVersion(
            adInfo.id,
            buildVersionFieldsFromRaw(rawItem, adText, newCopyHash),
          ),
        );
      }
    } else {
      const { error: updateError } = await supabase
        .from('ads')
        .update({
          last_seen_at: dateOnly,
          snapshot_id: snapshotId,
          updated_at: updatedAt,
        })
        .eq('entity_id', entityId)
        .eq('ad_archive_id', adArchiveId);

      if (updateError) {
        throw new Error(
          `Failed to touch persistent ad ${adArchiveId} for entity ${entityId}: ${updateError.message}`,
        );
      }

      counters.persistentUnchanged += 1;
    }
  }

  logger.info('Entity upsert finished', {
    entityId,
    snapshotId,
    inserted: counters.inserted,
    reactivated: counters.reactivated,
    persistentUpdated: counters.persistentUpdated,
    persistentUnchanged: counters.persistentUnchanged,
    copyChanged: counters.copyChanged,
    skippedDisappeared: counters.skippedDisappeared,
  });

  return { ...counters, recordsToVersion };
}

module.exports = { upsertAds };
