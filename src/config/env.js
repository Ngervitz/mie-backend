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
  // Optional at boot. If either is missing, auth middleware fail-closes:
  // every request gets 503 { error: 'Login no configurado' } (no open access).
  dashboardLoginPassword: process.env.DASHBOARD_LOGIN_PASSWORD || null,
  sessionSecret: process.env.SESSION_SECRET || null,
  // Optional at boot. When set, X-Cron-Key header can authenticate cron-job.org.
  cronSecret: process.env.CRON_SECRET || null,
  // Optional at boot — required when POST /jobs/run-serp-import-sync runs.
  serperApiKey: process.env.SERPER_API_KEY || null,
};
