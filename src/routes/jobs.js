const express = require('express');
const { dailySync } = require('../jobs/dailySync');
const { runActivity } = require('../activity/runActivity');
const { isValidDateOnly } = require('../activity/dates');
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
    .then((result) => {
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
    })
    .catch((err) => {
      jobState.status = 'idle';
      jobState.finishedAt = new Date().toISOString();
      jobState.lastError = err.message;
      logger.error('Sync failed', { error: err.message });
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

module.exports = router;
