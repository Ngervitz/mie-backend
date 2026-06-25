const app = require('./app');
const env = require('./config/env');
const { dailySync } = require('./jobs/dailySync');
const logger = require('./lib/logger');

app.listen(env.port, () => {
  logger.info('MIE Backend listening', { port: env.port, nodeEnv: env.nodeEnv });

  if (process.env.RUN_DAILY_SYNC_ON_BOOT === 'true') {
    setImmediate(() => {
      (async () => {
        try {
          logger.info('Auto-sync on boot started');
          const result = await dailySync();
          logger.info('Auto-sync on boot completed', {
            successfulEntities: result.successfulEntities,
            failedEntities: result.failedEntities,
            totalAdsCollected: result.totalAdsCollected,
            totalSnapshotsInserted: result.totalSnapshotsInserted,
            totalReconciledEntities: result.totalReconciledEntities,
          });
        } catch (err) {
          logger.error('Auto-sync on boot failed', { error: err.message });
        }
      })();
    });
    return;
  }

  logger.info('Auto-sync on boot disabled');
});
