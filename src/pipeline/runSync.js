const { collect } = require('../steps/collect');
const logger = require('../lib/logger');

async function runSync(entityId) {
  logger.info('runSync started', {
    mode: entityId ? 'single-entity' : 'full',
    ...(entityId && { entityId }),
  });
  return collect(entityId);
}

module.exports = { runSync };
