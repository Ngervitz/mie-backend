const express = require('express');
const { dailySync } = require('../jobs/dailySync');
const { runActivity } = require('../activity/runActivity');
const { collectOwnMetrics } = require('../steps/collectOwnMetrics');
const { collectOwnAdChanges } = require('../steps/collectOwnAdChanges');
const { calculateUruguayHolidays } = require('../steps/calculateUruguayHolidays');
const { collectBpsPaymentCalendar } = require('../steps/collectBpsPaymentCalendar');
const { collectSearchTrends } = require('../steps/collectSearchTrends');
const { runOwnAdsBrief } = require('../services/own-ads-brief');
const { isValidDateOnly, todayUtc } = require('../activity/dates');
const env = require('../config/env');
const logger = require('../lib/logger');

const router = express.Router();

const jobState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
};

const activityJobState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
};

const metaJobState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
};

const ownAdChangesJobState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
};

router.get('/status', (req, res) => {
  res.json({
    status: jobState.status,
    startedAt: jobState.startedAt,
    finishedAt: jobState.finishedAt,
    lastResult: jobState.lastResult,
    lastError: jobState.lastError,
  });
});

const runSyncHandler = (req, res) => {
  if (jobState.status === 'running') {
    return res.status(409).json({
      error: 'Sync already in progress',
      status: jobState.status,
      startedAt: jobState.startedAt,
    });
  }

  let entityId;
  const rawEntityId = req.body?.entity_id ?? req.query?.entity_id;

  if (rawEntityId !== undefined && rawEntityId !== null) {
    entityId = String(rawEntityId).trim();
    if (!entityId) {
      return res.status(400).json({
        error: 'entity_id must be a non-empty string',
      });
    }
  }

  jobState.status = 'running';
  jobState.startedAt = new Date().toISOString();
  jobState.finishedAt = null;
  jobState.lastResult = null;
  jobState.lastError = null;

  logger.info('POST /jobs/run-sync — sync started', {
    mode: entityId ? 'single-entity' : 'full',
    ...(entityId && { entityId }),
  });

  dailySync(entityId)
    .then(async (result) => {
      jobState.status = 'idle';
      jobState.finishedAt = new Date().toISOString();
      jobState.lastResult = result;
      logger.info('Sync completed', {
        successfulEntities: result.successfulEntities,
        failedEntities: result.failedEntities,
        totalAdsCollected: result.totalAdsCollected,
        totalSnapshotsInserted: result.totalSnapshotsInserted,
        totalReconciledEntities: result.totalReconciledEntities,
      });

      // Sibling branches after successful Sync (same gate). Never mutate jobState here.
      const successfulEntityIds = (result.results || [])
        .map((r) => r.entityId)
        .filter(Boolean);

      if (successfulEntityIds.length === 0) {
        logger.info('Activity skipped after sync', {
          reason: 'no successful entities',
          failedEntities: result.failedEntities,
          successfulEntities: result.successfulEntities,
        });
        logger.info('Meta own-metrics skipped after sync', {
          reason: 'no successful entities',
          failedEntities: result.failedEntities,
          successfulEntities: result.successfulEntities,
        });
        return;
      }

      const activityBranch = (async () => {
        if (activityJobState.status === 'running') {
          logger.info('Activity skipped after sync', {
            reason: 'activity already running',
            startedAt: activityJobState.startedAt,
          });
          return;
        }

        const executionDate = todayUtc();

        activityJobState.status = 'running';
        activityJobState.startedAt = new Date().toISOString();
        activityJobState.finishedAt = null;
        activityJobState.lastResult = null;
        activityJobState.lastError = null;

        logger.info('Activity chained after sync — started', {
          executionDate,
          entityCount: successfulEntityIds.length,
          skippedFailedEntities: result.failedEntities || 0,
        });

        try {
          const aggregated = {
            status: 'activity_complete',
            executionDate,
            entitiesProcessed: 0,
            entitiesFailed: 0,
            rowsInserted: 0,
            results: [],
          };

          for (const successEntityId of successfulEntityIds) {
            try {
              const activityResult = await runActivity({
                entityId: successEntityId,
                executionDate,
              });
              aggregated.entitiesProcessed += activityResult.entitiesProcessed || 0;
              aggregated.entitiesFailed += activityResult.entitiesFailed || 0;
              aggregated.rowsInserted += activityResult.rowsInserted || 0;
              if (Array.isArray(activityResult.results)) {
                aggregated.results.push(...activityResult.results);
              }
            } catch (entityErr) {
              aggregated.entitiesFailed += 1;
              logger.error('Activity chained entity failed', {
                entityId: successEntityId,
                executionDate,
                error: entityErr && entityErr.message ? entityErr.message : 'unknown',
              });
            }
          }

          activityJobState.status = 'idle';
          activityJobState.finishedAt = new Date().toISOString();
          activityJobState.lastResult = aggregated;
          logger.info('Activity job completed', {
            entitiesProcessed: aggregated.entitiesProcessed,
            entitiesFailed: aggregated.entitiesFailed,
            rowsInserted: aggregated.rowsInserted,
            executionDate: aggregated.executionDate,
          });
        } catch (err) {
          activityJobState.status = 'idle';
          activityJobState.finishedAt = new Date().toISOString();
          activityJobState.lastError = err && err.message ? err.message : 'unknown';
          logger.error('Activity job failed', {
            error: err && err.message ? err.message : 'unknown',
          });
        }
      })();

      // Metrics + own-ads brief + changes — gated as one metaBranch for auto chain only.
      const metaBranch = (async () => {
        if (!env.metaAgenteEnabled) {
          logger.info('metaBranch skipped — META_AGENTE_ENABLED=false');
          return;
        }

        const metricsBranch = (async () => {
          if (metaJobState.status === 'running') {
            logger.info('Meta own-metrics skipped after sync', {
              reason: 'meta already running',
              startedAt: metaJobState.startedAt,
            });
            return;
          }

          metaJobState.status = 'running';
          metaJobState.startedAt = new Date().toISOString();
          metaJobState.finishedAt = null;
          metaJobState.lastResult = null;
          metaJobState.lastError = null;

          logger.info('Meta own-metrics chained after sync — started');

          try {
            const metaResult = await collectOwnMetrics();
            metaJobState.status = 'idle';
            metaJobState.finishedAt = new Date().toISOString();
            metaJobState.lastResult = metaResult;
            logger.info('Meta own-metrics job completed', {
              runId: metaResult.runId,
              campaignsFound: metaResult.campaignsFound,
              rowsInserted: metaResult.rowsInserted,
              reportingDate: metaResult.reportingDate,
            });

            // Isolated Own Ads Brief — only after successful Meta collection.
            try {
              if (metaResult && metaResult.reportingDate) {
                logger.info('Own Ads Brief chained after meta — started', {
                  reportingDate: metaResult.reportingDate,
                });
                const ownAdsResult = await runOwnAdsBrief({
                  date: metaResult.reportingDate,
                  skipIfRunning: true,
                });
                if (ownAdsResult && ownAdsResult.skipped) {
                  logger.info('Own Ads Brief chained after meta — skipped', {
                    reason: ownAdsResult.reason,
                    reportingDate: metaResult.reportingDate,
                  });
                } else {
                  logger.info('Own Ads Brief chained after meta — completed', {
                    reportingDate: metaResult.reportingDate,
                    state: ownAdsResult && ownAdsResult.state,
                  });
                }
              } else {
                logger.info('Own Ads Brief skipped after meta', {
                  reason: 'missing reportingDate on meta result',
                });
              }
            } catch (ownAdsErr) {
              logger.error('Own Ads Brief after meta failed', {
                error:
                  ownAdsErr && ownAdsErr.message
                    ? ownAdsErr.message
                    : 'unknown',
              });
            }
          } catch (err) {
            metaJobState.status = 'idle';
            metaJobState.finishedAt = new Date().toISOString();
            metaJobState.lastError =
              err && err.message ? err.message : 'unknown';
            logger.error('Meta own-metrics job failed', {
              error: err && err.message ? err.message : 'unknown',
            });
            logger.info('Own Ads Brief skipped after meta', {
              reason: 'meta collection failed',
              error: err && err.message ? err.message : 'unknown',
            });
          }
        })();

        // Sibling of metricsBranch — capture-only; never touches metrics / Own Ads Brief.
        const changesBranch = (async () => {
          if (ownAdChangesJobState.status === 'running') {
            logger.info('Meta own-ad-changes skipped after sync', {
              reason: 'own-ad-changes already running',
              startedAt: ownAdChangesJobState.startedAt,
            });
            return;
          }

          ownAdChangesJobState.status = 'running';
          ownAdChangesJobState.startedAt = new Date().toISOString();
          ownAdChangesJobState.finishedAt = null;
          ownAdChangesJobState.lastResult = null;
          ownAdChangesJobState.lastError = null;

          logger.info('Meta own-ad-changes chained after sync — started');

          try {
            const changesResult = await collectOwnAdChanges();
            ownAdChangesJobState.status = 'idle';
            ownAdChangesJobState.finishedAt = new Date().toISOString();
            ownAdChangesJobState.lastResult = changesResult;
            logger.info('Meta own-ad-changes job completed', {
              runId: changesResult.runId,
              changesFound: changesResult.changesFound,
              eventsInserted: changesResult.eventsInserted,
              reportingDate: changesResult.reportingDate,
            });
          } catch (err) {
            ownAdChangesJobState.status = 'idle';
            ownAdChangesJobState.finishedAt = new Date().toISOString();
            ownAdChangesJobState.lastError =
              err && err.message ? err.message : 'unknown';
            logger.error('Meta own-ad-changes job failed', {
              error: err && err.message ? err.message : 'unknown',
            });
          }
        })();

        await Promise.all([metricsBranch, changesBranch]);
      })();

      await Promise.all([activityBranch, metaBranch]);
    })
    .catch((err) => {
      jobState.status = 'idle';
      jobState.finishedAt = new Date().toISOString();
      jobState.lastError = err.message;
      logger.error('Sync failed', { error: err.message });
      logger.info('Activity skipped after sync', {
        reason: 'sync failed',
        error: err.message,
      });
      logger.info('Meta own-metrics skipped after sync', {
        reason: 'sync failed',
        error: err.message,
      });
      logger.info('Meta own-ad-changes skipped after sync', {
        reason: 'sync failed',
        error: err.message,
      });
    });

  res.status(202).json({
    message: 'Sync started',
    status: 'running',
    startedAt: jobState.startedAt,
  });
};

router.post('/run-sync', runSyncHandler);
router.get('/run-sync', runSyncHandler);

router.get('/activity-status', (req, res) => {
  res.json({
    status: activityJobState.status,
    startedAt: activityJobState.startedAt,
    finishedAt: activityJobState.finishedAt,
    lastResult: activityJobState.lastResult,
    lastError: activityJobState.lastError,
  });
});

const runActivityHandler = (req, res) => {
  if (activityJobState.status === 'running') {
    return res.status(409).json({
      error: 'Activity job already in progress',
      status: activityJobState.status,
      startedAt: activityJobState.startedAt,
    });
  }

  let entityId;
  const rawEntityId = req.body?.entity_id ?? req.query?.entity_id;
  if (rawEntityId !== undefined && rawEntityId !== null) {
    entityId = String(rawEntityId).trim();
    if (!entityId) {
      return res.status(400).json({ error: 'entity_id must be a non-empty string' });
    }
  }

  let executionDate;
  const rawDate = req.body?.date ?? req.query?.date;
  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    executionDate = String(rawDate).trim();
    if (!isValidDateOnly(executionDate)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
  }

  activityJobState.status = 'running';
  activityJobState.startedAt = new Date().toISOString();
  activityJobState.finishedAt = null;
  activityJobState.lastResult = null;
  activityJobState.lastError = null;

  logger.info('POST /jobs/run-activity — started', {
    ...(entityId && { entityId }),
    ...(executionDate && { executionDate }),
  });

  runActivity({ entityId, executionDate })
    .then((result) => {
      activityJobState.status = 'idle';
      activityJobState.finishedAt = new Date().toISOString();
      activityJobState.lastResult = result;
      logger.info('Activity job completed', {
        entitiesProcessed: result.entitiesProcessed,
        entitiesFailed: result.entitiesFailed,
        rowsInserted: result.rowsInserted,
      });
    })
    .catch((err) => {
      activityJobState.status = 'idle';
      activityJobState.finishedAt = new Date().toISOString();
      activityJobState.lastError = err.message;
      logger.error('Activity job failed', { error: err.message });
    });

  res.status(202).json({
    message: 'Activity started',
    status: 'running',
    startedAt: activityJobState.startedAt,
  });
};

router.post('/run-activity', runActivityHandler);
router.get('/run-activity', runActivityHandler);

router.get('/metaagente-status', (req, res) => {
  res.json({
    status: metaJobState.status,
    startedAt: metaJobState.startedAt,
    finishedAt: metaJobState.finishedAt,
    lastResult: metaJobState.lastResult,
    lastError: metaJobState.lastError,
  });
});

const runMetaAgenteHandler = (req, res) => {
  if (metaJobState.status === 'running') {
    return res.status(409).json({
      error: 'Meta own-metrics job already in progress',
      status: metaJobState.status,
      startedAt: metaJobState.startedAt,
    });
  }

  metaJobState.status = 'running';
  metaJobState.startedAt = new Date().toISOString();
  metaJobState.finishedAt = null;
  metaJobState.lastResult = null;
  metaJobState.lastError = null;

  logger.info('POST /jobs/run-metaagente — started');

  collectOwnMetrics()
    .then((result) => {
      metaJobState.status = 'idle';
      metaJobState.finishedAt = new Date().toISOString();
      metaJobState.lastResult = result;
      logger.info('Meta own-metrics job completed', {
        runId: result.runId,
        campaignsFound: result.campaignsFound,
        rowsInserted: result.rowsInserted,
      });
    })
    .catch((err) => {
      metaJobState.status = 'idle';
      metaJobState.finishedAt = new Date().toISOString();
      metaJobState.lastError = err.message;
      logger.error('Meta own-metrics job failed', { error: err.message });
    });

  res.status(202).json({
    message: 'Meta own-metrics started',
    status: 'running',
    startedAt: metaJobState.startedAt,
  });
};

router.post('/run-metaagente', runMetaAgenteHandler);
router.get('/run-metaagente', runMetaAgenteHandler);

router.get('/own-ad-changes-status', (req, res) => {
  res.json({
    status: ownAdChangesJobState.status,
    startedAt: ownAdChangesJobState.startedAt,
    finishedAt: ownAdChangesJobState.finishedAt,
    lastResult: ownAdChangesJobState.lastResult,
    lastError: ownAdChangesJobState.lastError,
  });
});

const runOwnAdChangesHandler = (req, res) => {
  if (ownAdChangesJobState.status === 'running') {
    return res.status(409).json({
      error: 'Own ad changes job already in progress',
      status: ownAdChangesJobState.status,
      startedAt: ownAdChangesJobState.startedAt,
    });
  }

  ownAdChangesJobState.status = 'running';
  ownAdChangesJobState.startedAt = new Date().toISOString();
  ownAdChangesJobState.finishedAt = null;
  ownAdChangesJobState.lastResult = null;
  ownAdChangesJobState.lastError = null;

  logger.info('POST /jobs/run-own-ad-changes — started');

  collectOwnAdChanges()
    .then((result) => {
      ownAdChangesJobState.status = 'idle';
      ownAdChangesJobState.finishedAt = new Date().toISOString();
      ownAdChangesJobState.lastResult = result;
      logger.info('Meta own-ad-changes job completed', {
        runId: result.runId,
        changesFound: result.changesFound,
        eventsInserted: result.eventsInserted,
        reportingDate: result.reportingDate,
      });
    })
    .catch((err) => {
      ownAdChangesJobState.status = 'idle';
      ownAdChangesJobState.finishedAt = new Date().toISOString();
      ownAdChangesJobState.lastError = err.message;
      logger.error('Meta own-ad-changes job failed', { error: err.message });
    });

  res.status(202).json({
    message: 'Own ad changes started',
    status: 'running',
    startedAt: ownAdChangesJobState.startedAt,
  });
};

router.post('/run-own-ad-changes', runOwnAdChangesHandler);
router.get('/run-own-ad-changes', runOwnAdChangesHandler);

// --- Economic calendar (standalone, manual trigger; NOT chained into daily sync) ---
const economicCalendarJobState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
};

router.get('/economic-calendar-status', (req, res) => {
  res.json({
    status: economicCalendarJobState.status,
    startedAt: economicCalendarJobState.startedAt,
    finishedAt: economicCalendarJobState.finishedAt,
    lastResult: economicCalendarJobState.lastResult,
    lastError: economicCalendarJobState.lastError,
  });
});

const runEconomicCalendarHandler = (req, res) => {
  if (economicCalendarJobState.status === 'running') {
    return res.status(409).json({
      error: 'Economic calendar job already in progress',
      status: economicCalendarJobState.status,
      startedAt: economicCalendarJobState.startedAt,
    });
  }

  economicCalendarJobState.status = 'running';
  economicCalendarJobState.startedAt = new Date().toISOString();
  economicCalendarJobState.finishedAt = null;
  economicCalendarJobState.lastResult = null;
  economicCalendarJobState.lastError = null;

  logger.info('POST /jobs/run-economic-calendar — started');

  (async () => {
    const result = { holidays: null, bps: null };
    // Holidays are deterministic/idempotent — run first, independently.
    result.holidays = await calculateUruguayHolidays();
    try {
      result.bps = await collectBpsPaymentCalendar();
    } catch (bpsErr) {
      // BPS scrape failure must not mask a successful holiday calculation.
      result.bps = {
        error: bpsErr && bpsErr.message ? bpsErr.message : 'unknown',
      };
      logger.error('BPS scrape failed within economic calendar job', {
        error: bpsErr && bpsErr.message ? bpsErr.message : 'unknown',
      });
    }
    return result;
  })()
    .then((result) => {
      economicCalendarJobState.status = 'idle';
      economicCalendarJobState.finishedAt = new Date().toISOString();
      economicCalendarJobState.lastResult = result;
      logger.info('Economic calendar job completed', {
        holidaysUpserted: result.holidays && result.holidays.eventsUpserted,
        bpsUpserted: result.bps && result.bps.eventsUpserted,
        bpsError: result.bps && result.bps.error,
      });
    })
    .catch((err) => {
      economicCalendarJobState.status = 'idle';
      economicCalendarJobState.finishedAt = new Date().toISOString();
      economicCalendarJobState.lastError = err.message;
      logger.error('Economic calendar job failed', { error: err.message });
    });

  res.status(202).json({
    message: 'Economic calendar started',
    status: 'running',
    startedAt: economicCalendarJobState.startedAt,
  });
};

router.post('/run-economic-calendar', runEconomicCalendarHandler);
router.get('/run-economic-calendar', runEconomicCalendarHandler);

// --- Search trends (standalone, manual trigger; NOT chained into daily sync) ---
const searchTrendsJobState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
};

router.get('/search-trends-status', (req, res) => {
  res.json({
    status: searchTrendsJobState.status,
    startedAt: searchTrendsJobState.startedAt,
    finishedAt: searchTrendsJobState.finishedAt,
    lastResult: searchTrendsJobState.lastResult,
    lastError: searchTrendsJobState.lastError,
  });
});

const runSearchTrendsHandler = (req, res) => {
  if (searchTrendsJobState.status === 'running') {
    return res.status(409).json({
      error: 'Search trends job already in progress',
      status: searchTrendsJobState.status,
      startedAt: searchTrendsJobState.startedAt,
    });
  }

  searchTrendsJobState.status = 'running';
  searchTrendsJobState.startedAt = new Date().toISOString();
  searchTrendsJobState.finishedAt = null;
  searchTrendsJobState.lastResult = null;
  searchTrendsJobState.lastError = null;

  logger.info('POST /jobs/run-search-trends — started');

  collectSearchTrends()
    .then((result) => {
      searchTrendsJobState.status = 'idle';
      searchTrendsJobState.finishedAt = new Date().toISOString();
      searchTrendsJobState.lastResult = result;
      logger.info('Search trends job completed', {
        totalTerms: result.totalTerms,
        succeededCount: result.succeededCount,
        failedCount: result.failedCount,
        rowsUpserted: result.rowsUpserted,
      });
    })
    .catch((err) => {
      searchTrendsJobState.status = 'idle';
      searchTrendsJobState.finishedAt = new Date().toISOString();
      searchTrendsJobState.lastError = err.message;
      logger.error('Search trends job failed', { error: err.message });
    });

  res.status(202).json({
    message: 'Search trends started',
    status: 'running',
    startedAt: searchTrendsJobState.startedAt,
  });
};

router.post('/run-search-trends', runSearchTrendsHandler);
router.get('/run-search-trends', runSearchTrendsHandler);

module.exports = router;
