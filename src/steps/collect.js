const supabase = require('../clients/supabase');
const { buildApifyInput, runActor } = require('../clients/apify');
const { saveSnapshot } = require('./snapshot');
const { reconcileEntity } = require('./reconcile');
const { upsertAds } = require('./upsert');
const { deactivateDisappearedAds } = require('./deactivate');
const { saveAdVersions } = require('./version');
const logger = require('../lib/logger');

function toReconcileCounts(reconcileResult) {
  return {
    new: reconcileResult.new.length,
    reactivated: reconcileResult.reactivated.length,
    persistent: reconcileResult.persistent.length,
    disappeared: reconcileResult.disappeared.length,
  };
}

async function collect(entityId) {
  const mode = entityId ? 'single-entity' : 'full';
  logger.info('Collect started', {
    mode,
    ...(entityId && { entityId }),
  });

  let query = supabase.from('monitored_entities').select('*');

  if (entityId) {
    query = query.eq('id', entityId);
  }

  const { data: entities, error } = await query;

  if (error) {
    logger.error('Failed to fetch monitored_entities', { error: error.message });
    throw new Error(error.message);
  }

  const results = [];
  let successfulEntities = 0;
  let failedEntities = 0;
  let totalAdsCollected = 0;
  let totalSnapshotsInserted = 0;
  let totalReconciledEntities = 0;

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
      const { items, apifyRunId } = await runActor(buildApifyInput(url));
      const ads = Array.isArray(items) ? items : [];
      const adsCount = ads.length;
      const collectedAt = new Date().toISOString();

      totalAdsCollected += adsCount;

      logger.info('Entity collect completed', {
        entityId,
        entityName,
        adsCount,
      });

      try {
        const { snapshotId, snapshotsInserted } = await saveSnapshot({
          entityId,
          ads,
          collectedAt,
          apifyRunId,
        });

        totalSnapshotsInserted += snapshotsInserted;

        logger.info('Entity snapshot completed', {
          entityId,
          entityName,
          adsCount,
          snapshotsInserted,
          snapshotId,
        });

        try {
          const reconcileResult = await reconcileEntity({ entityId, snapshotId });
          const reconciled = toReconcileCounts(reconcileResult);

          totalReconciledEntities += 1;

          logger.info('Entity reconcile finished', {
            entityId,
            entityName,
            snapshotId,
            reconciled,
          });

          try {
            const upsertResult = await upsertAds({
              entityId,
              snapshotId,
              reconciled: reconcileResult,
              collectedAt,
            });

            const { recordsToVersion, ...upserted } = upsertResult;

            try {
              const deactivated = await deactivateDisappearedAds({
                entityId,
                disappeared: reconcileResult.disappeared,
              });

              try {
                const versioned = await saveAdVersions({
                  recordsToVersion,
                  detectedAt: collectedAt,
                });

                successfulEntities += 1;

                results.push({
                  entityId,
                  entityName,
                  adsCount,
                  snapshotsInserted,
                  reconciled,
                  upserted,
                  deactivated,
                  versioned,
                  collectedAt,
                });

                logger.info('Entity version finished', {
                  entityId,
                  entityName,
                  snapshotId,
                  versioned,
                });
              } catch (versionErr) {
                failedEntities += 1;
                logger.error('Entity version failed', {
                  entityId,
                  entityName,
                  snapshotId,
                  error: versionErr.message,
                });
              }
            } catch (deactivateErr) {
              failedEntities += 1;
              logger.error('Entity deactivate failed', {
                entityId,
                entityName,
                snapshotId,
                error: deactivateErr.message,
              });
            }

            logger.info('Entity upsert finished', {
              entityId,
              entityName,
              snapshotId,
              upserted,
            });
          } catch (upsertErr) {
            failedEntities += 1;
            logger.error('Entity upsert failed', {
              entityId,
              entityName,
              snapshotId,
              error: upsertErr.message,
            });
          }
        } catch (reconcileErr) {
          failedEntities += 1;
          logger.error('Entity reconcile failed', {
            entityId,
            entityName,
            snapshotId,
            error: reconcileErr.message,
          });
        }
      } catch (snapshotErr) {
        failedEntities += 1;
        logger.error('Entity snapshot failed', {
          entityId,
          entityName,
          adsCount,
          error: snapshotErr.message,
        });
      }
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
    status: 'version_complete',
    successfulEntities,
    failedEntities,
    totalAdsCollected,
    totalSnapshotsInserted,
    totalReconciledEntities,
    results,
  };

  logger.info('Version run finished', {
    mode,
    successfulEntities,
    failedEntities,
    totalAdsCollected,
    totalSnapshotsInserted,
    totalReconciledEntities,
  });

  return summary;
}

module.exports = { collect };
