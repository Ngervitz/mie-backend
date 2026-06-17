require('dotenv').config();

const logger = require('../lib/logger');

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    logger.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }

  return value;
}

const port = parseInt(process.env.PORT || '3000', 10);

if (Number.isNaN(port)) {
  logger.error('PORT must be a valid number');
  process.exit(1);
}

module.exports = {
  port,
  nodeEnv: process.env.NODE_ENV || 'development',
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  apifyToken: requireEnv('APIFY_TOKEN'),
  apifyActorId: requireEnv('APIFY_ACTOR_ID'),
};
