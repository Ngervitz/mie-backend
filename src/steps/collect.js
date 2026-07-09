const supabase = require('../clients/supabase');
const { buildApifyInput, runActorWithRetry } = require('../clients/apify');
const { saveSnapshot } = require('./snapshot');
const { reconcileEntity } = require('./reconcile');
const { upsertAds } = require('./upsert');
const { deactivateDisappearedAds } = require('./deactivate');
const { saveAdVersions } = require('./version');
const { insertEvents } = require('./events');
const logger = require('../lib/logger');

function toReconcileCounts(reconcileResult) {
  return {
    new: reconcileResult.new.length,
    reactivated: reconcileResult.reactivated.length,
    persistent: reconcileResult.persistent.length,
    disappeared: reconcileResult.disappeared.length,
  };
}

function createApifyMetrics() {
  return {
    retriesExecuted: 0,
    retriesSucceeded: 0,
    retriesFailed: 0,
    runsWithRetry: 0,
  };
}

function mergeApifyMetrics(total, partial) {
  if (!partial) {
    return;
  }

  total.retriesExecuted += partial.retriesExecuted || 0;
  total.retriesSucceeded += partial.retriesSucceeded || 0;
  total.retriesFailed += partial.retriesFailed || 0;
  if ((partial.retriesExecuted || 0) > 0) {
    total.runsWithRetry += 1;
  }
}

async function persistActorAttempts({ entityId, attempts, finalStatus }) {
  const snapshots = [];
  let pipelineSnapshotId = null;
  let pipelineStatus = finalStatus;

  if (attempts.length === 2) {
    const first = attempts[0];
    const firstCollectedAt = new Date().toISOString();
    const firstSnapshot = await saveSnapshot({
      entityId,
      ads: [],
      collectedAt: firstCollectedAt,
      apifyRunId: first.apifyRunId,
      status: 'empty_unconfirmed',
    });
    snapshots.push(firstSnapshot);

    const second = attempts[1];
    const secondCollectedAt = new Date().toISOString();
    const secondStatus = second.adsFound > 0 ? 'success' : 'empty_unconfirmed';
    const secondSnapshot = await saveSnapshot({
      entityId,
      ads: second.items,
      collectedAt: secondCollectedAt,
      apifyRunId: second.apifyRunId,
      status: secondStatus,
    });
    snapshots.push(secondSnapshot);

    pipelineSnapshotId = secondSnapshot.snapshotId;
    pipelineStatus = secondStatus;
  } else {
    const attempt = attempts[0];
    const collectedAt = new Date().toISOString();
    const snapshot = await saveSnapshot({
      entityId,
      ads: attempt.items,
      collectedAt,
      apifyRunId: attempt.apifyRunId,
      status: finalStatus,
    });
    snapshots.push(snapshot);
    pipelineSnapshotId = snapshot.snapshotId;
    pipelineStatus = snapshot.status;
  }

  return {
    snapshots,
    pipelineSnapshotId,
    pipelineStatus,
    snapshotsInserted: snapshots.reduce((sum, s) => sum + (s.snapshotsInserted || 0), 0),
  };
}

async function collect(entityId) {
  const mode = entityId ? 'single-entity' : 'full';
  logger.info('Collect started', {
    mode,
    ...(entityId && { entityId }),
  });

  let query = supabase.from('monitored_entities').select('*').eq('is_self', false);

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
  const apifyMetrics = createApifyMetrics();

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
      const actorResult = await runActorWithRetry(buildApifyInput(url));
      mergeApifyMetrics(apifyMetrics, actorResult.metrics);

      const ads = Array.isArray(actorResult.items) ? actorResult.items : [];
      const adsCount = ads.length;
      const collectedAt = new Date().toISOString();

      totalAdsCollected += adsCount;

      logger.info('Entity collect completed', {
        entityId,
        entityName,
        adsCount,
        actorStatus: actorResult.status,
        retried: actorResult.retried,
        attempts: actorResult.attempts.length,
      });

      try {
        const persistence = await persistActorAttempts({
          entityId,
          attempts: actorResult.attempts,
          finalStatus: actorResult.status,
        });

        const { pipelineSnapshotId: snapshotId, pipelineStatus, snapshotsInserted } = persistence;
        totalSnapshotsInserted += snapshotsInserted;

        logger.info('Entity snapshot completed', {
          entityId,
          entityName,
          adsCount,
          snapshotsInserted,
          snapshotId,
          status: pipelineStatus,
        });

        if (pipelineStatus === 'empty_unconfirmed') {
          successfulEntities += 1;
          results.push({
            entityId,
            entityName,
            adsCount,
            snapshotsInserted,
            snapshotId,
            status: pipelineStatus,
            pipelineSkipped: true,
            skipReason: 'empty_unconfirmed',
            apifyAttempts: actorResult.attempts,
            collectedAt,
          });
          continue;
        }

        try {
          const reconcileResult = await reconcileEntity({ entityId, snapshotId });

          if (reconcileResult.skipped) {
            successfulEntities += 1;
            results.push({
              entityId,
              entityName,
              adsCount,
              snapshotsInserted,
              snapshotId,
              status: pipelineStatus,
              pipelineSkipped: true,
              skipReason: reconcileResult.reason,
              reconciled: toReconcileCounts(reconcileResult),
              apifyAttempts: actorResult.attempts,
              collectedAt,
            });
            continue;
          }

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
              const deactivateResult = await deactivateDisappearedAds({
                entityId,
                disappeared: reconcileResult.disappeared,
              });

              const { deactivatedIds, ...deactivated } = deactivateResult;

              try {
                const versioned = await saveAdVersions({
                  recordsToVersion,
                  detectedAt: collectedAt,
                });

                logger.info('Entity version finished', {
                  entityId,
                  entityName,
                  snapshotId,
                  versioned,
                });

                try {
                  const events = await insertEvents({
                    entityId,
                    entityName,
                    reconcileResult,
                    deactivateResult,
                    recordsToVersion,
                    collectedAt,
                  });

                  successfulEntities += 1;

                  results.push({
                    entityId,
                    entityName,
                    adsCount,
                    snapshotsInserted,
                    status: pipelineStatus,
                    reconciled,
                    upserted,
                    deactivated,
                    versioned,
                    events,
                    collectedAt,
                  });

                  logger.info('Entity events finished', {
                    entityId,
                    entityName,
                    snapshotId,
                    events,
                  });
                } catch (eventsErr) {
                  failedEntities += 1;
                  logger.error('Entity events failed', {
                    entityId,
                    entityName,
                    snapshotId,
                    error: eventsErr.message,
                  });
                }
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

  const retryRatePercent = apifyMetrics.runsWithRetry > 0
    ? Math.round((apifyMetrics.runsWithRetry / entities.length) * 10000) / 100
    : 0;

  const summary = {
    status: 'events_complete',
    successfulEntities,
    failedEntities,
    totalAdsCollected,
    totalSnapshotsInserted,
    totalReconciledEntities,
    apifyRetryMetrics: {
      ...apifyMetrics,
      retryRatePercent,
      estimatedExtraRuns: apifyMetrics.retriesExecuted,
    },
    results,
  };

  logger.info('Events run finished', {
    mode,
    successfulEntities,
    failedEntities,
    totalAdsCollected,
    totalSnapshotsInserted,
    totalReconciledEntities,
    apifyRetryMetrics: summary.apifyRetryMetrics,
  });

  return summary;
}

module.exports = { collect };
