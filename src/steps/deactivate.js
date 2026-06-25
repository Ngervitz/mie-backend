const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

async function deactivateDisappearedAds({ entityId, disappeared }) {
  if (!entityId) {
    throw new Error('entityId is required');
  }

  const disappearedIds = Array.isArray(disappeared) ? disappeared : [];

  logger.info('Entity deactivate started', {
    entityId,
    disappeared: disappearedIds.length,
  });

  if (disappearedIds.length === 0) {
    logger.info('Entity deactivate finished', {
      entityId,
      deactivated: 0,
      skipped: 0,
    });
    return { deactivated: 0, skipped: 0, deactivatedIds: [] };
  }

  const updatedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from('ads')
    .update({
      is_active: false,
      updated_at: updatedAt,
    })
    .eq('entity_id', entityId)
    .eq('is_active', true)
    .in('ad_archive_id', disappearedIds)
    .select('id, ad_archive_id');

  if (error) {
    throw new Error(`Failed to deactivate ads for entity ${entityId}: ${error.message}`);
  }

  const deactivatedIds = (data || [])
    .map((row) => row.ad_archive_id)
    .filter((id) => id !== null && id !== undefined)
    .map(String);
  const deactivated = (data || []).length;
  const skipped = disappearedIds.length - deactivated;

  logger.info('Entity deactivate finished', {
    entityId,
    disappeared: disappearedIds.length,
    deactivated,
    skipped,
  });

  // deactivatedIds is internal-only (consumed by Events); not exposed publicly.
  return { deactivated, skipped, deactivatedIds };
}

module.exports = { deactivateDisappearedAds };
