const { runSync } = require('../pipeline/runSync');
const { runHugo } = require('../services/hugo-brain');
const logger = require('../lib/logger');

async function dailySync(entityId) {
  logger.info('dailySync invoked', {
    mode: entityId ? 'single-entity' : 'full',
    ...(entityId && { entityId }),
  });

  const syncResult = await runSync(entityId);

  // Sync is the primary job. Daily Knowledge generation is an additional step
  // that reuses the exact same orchestration as POST /hugo/run (runHugo also
  // persists via saveDailyKnowledge). A Hugo failure must never roll back the
  // synchronization or stop the scheduler — log it and return the sync result.
  logger.info('Daily sync completed');
  logger.info('Generating Daily Knowledge...');
  const hugoStartedMs = Date.now();
  try {
    await runHugo({ joinIfActive: true });
    logger.info('Daily Knowledge generated successfully.', {
      durationMs: Date.now() - hugoStartedMs,
    });
  } catch (err) {
    logger.error('Generating Daily Knowledge failed.', {
      durationMs: Date.now() - hugoStartedMs,
      error: err && err.message ? err.message : 'unknown',
    });
  }

  return syncResult;
}

module.exports = { dailySync };
