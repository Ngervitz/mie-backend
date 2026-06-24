const { runSync } = require('../pipeline/runSync');
const logger = require('../lib/logger');

async function dailySync(entityId) {
  logger.info('dailySync invoked', {
    mode: entityId ? 'single-entity' : 'full',
    ...(entityId && { entityId }),
  });
  return runSync(entityId);
}

module.exports = { dailySync };
