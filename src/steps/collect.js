const supabase = require('../clients/supabase');
const { buildApifyInput, runActor } = require('../clients/apify');
const logger = require('../lib/logger');

async function collect() {
  logger.info('Collect started');

  const { data: entities, error } = await supabase.from('monitored_entities').select('*');

  if (error) {
    logger.error('Failed to fetch monitored_entities', { error: error.message });
    throw new Error(error.message);
  }

  const results = [];
  let successfulEntities = 0;
  let failedEntities = 0;
  let totalAdsCollected = 0;

  for (const entity of entities) {
    const entityId = entity.id;
    const entityName = entity.name;

    logger.info('Entity collect started', { entityId, entityName });

    const url = (entity.ad_library_url || '').trim();

    if (!url) {
      failedEntities += 1;
      logger.error(`[${entity.name}] ad_library_url is empty or missing`);
      continue;
    }

    try {
      const ads = await runActor(buildApifyInput(url));
      const adsCount = ads.length;
      const collectedAt = new Date().toISOString();

      totalAdsCollected += adsCount;
      successfulEntities += 1;

      results.push({
        entityId,
        entityName,
        adsCount,
        collectedAt,
      });

      logger.info('Entity collect completed', {
        entityId,
        entityName,
        adsCount,
      });
    } catch (err) {
      failedEntities += 1;
      logger.error('Entity collect failed', {
        entityId,
        entityName,
        error: err.message,
      });
    }
  }

  const summary = {
    status: 'collect_complete',
    successfulEntities,
    failedEntities,
    totalAdsCollected,
    results,
  };

  logger.info('Collect finished', {
    successfulEntities,
    failedEntities,
    totalAdsCollected,
  });

  return summary;
}

module.exports = { collect };
