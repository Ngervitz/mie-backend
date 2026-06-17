const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

async function runSync() {
  logger.info('runSync started (Phase 1 stub)');

  const { data, error } = await supabase.from('monitored_entities').select('*');

  if (error) {
    logger.error('Failed to fetch monitored_entities', { error: error.message });
    throw new Error(error.message);
  }

  logger.info('Fetched monitored_entities', { count: data.length });

  return {
    status: 'stub',
    entitiesFound: data.length,
    message: 'Phase 1 stub — pipeline steps not yet implemented',
  };
}

module.exports = { runSync };
