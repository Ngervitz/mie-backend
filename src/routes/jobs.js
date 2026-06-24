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

  jobState.status = 'running';
  jobState.startedAt = new Date().toISOString();
  jobState.finishedAt = null;
  jobState.lastResult = null;
  jobState.lastError = null;

  logger.info('POST /jobs/run-sync — sync started');

  dailySync()
    .then((result) => {
      jobState.status = 'idle';
      jobState.finishedAt = new Date().toISOString();
      jobState.lastResult = result;
      logger.info('Sync completed', {
        successfulEntities: result.successfulEntities,
        failedEntities: result.failedEntities,
        totalAdsCollected: result.totalAdsCollected,
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
