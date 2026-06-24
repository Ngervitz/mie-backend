const { collect } = require('../steps/collect');
const logger = require('../lib/logger');

async function runSync() {
  logger.info('runSync started');
  return collect();
}

module.exports = { runSync };
