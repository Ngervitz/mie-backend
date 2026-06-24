const express = require('express');
const { dailySync } = require('../jobs/dailySync');
const logger = require('../lib/logger');

const router = express.Router();

const jobState = {
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

router.post('/run-sync', (req, res) => {
  if (jobState.status === 'running') {
    return res.status(409).json({
      error: 'Sync already in progress',
      status: jobState.status,
      startedAt: jobState.startedAt,
    });
  }

  let entityId;
  const rawEntityId = req.body?.entity_id;

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
});

module.exports = router;
