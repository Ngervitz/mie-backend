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
  // Optional at boot — validated when collectOwnMetrics runs.
  metaMarketingApiToken: process.env.META_MARKETING_API_TOKEN || null,
  metaAdAccountId: process.env.META_AD_ACCOUNT_ID || null,
  metaMarketingApiVersion: process.env.META_MARKETING_API_VERSION || 'v25.0',
  // Pause automatic metaBranch after sync (metrics + own-ads brief + changes).
  // Default true; only the string "false" (case-insensitive) disables.
  metaAgenteEnabled:
    String(process.env.META_AGENTE_ENABLED ?? 'true').toLowerCase() !== 'false',
};
