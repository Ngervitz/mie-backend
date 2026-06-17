const { runSync } = require('../pipeline/runSync');
const logger = require('../lib/logger');

async function dailySync() {
  logger.info('dailySync invoked');
  return runSync();
}

module.exports = { dailySync };
