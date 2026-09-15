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

/** Optional env: trim whitespace/newlines from Railway copy-paste; empty → null. */
function optionalTrimmedEnv(name) {
  const value = process.env[name];
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
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
  // SESSION_SECRET required for cookie HMAC. Missing → 503 on gated routes.
  sessionSecret: process.env.SESSION_SECRET || null,
  // ONE-TIME bootstrap only (POST /admin/bootstrap-first-admin).
  // After the first admin exists, REMOVE this env var — it is not a login fallback.
  dashboardLoginPassword: process.env.DASHBOARD_LOGIN_PASSWORD || null,
  // Optional at boot. When set, X-Cron-Key header can authenticate cron-job.org.
  cronSecret: process.env.CRON_SECRET || null,
  // Optional at boot. Required for POST /tracking/events HMAC from Credizona.
  czTrackingHmacSecret: optionalTrimmedEnv('CZ_TRACKING_HMAC_SECRET'),
  // Optional at boot. Required to sign/verify email unsubscribe tokens.
  // No fallback to SESSION_SECRET.
  emailUnsubscribeHmacSecret: optionalTrimmedEnv(
    'EMAIL_UNSUBSCRIBE_HMAC_SECRET',
  ),
  // Optional at boot. Public Janus origin for email unsubscribe links (no trailing slash).
  // Do NOT reuse SMS_SHORT_LINK_BASE_URL.
  emailPublicBaseUrl: optionalTrimmedEnv('EMAIL_PUBLIC_BASE_URL'),
  // Optional at boot. Legacy single-campaign id (Stage 2B wave1).
  // The 3-step Encuesta sequence does NOT read this — use STEP1/2/3 below.
  rechazadosSurveyInviteCampaignId: optionalTrimmedEnv(
    'RECHAZADOS_SURVEY_INVITE_CAMPAIGN_ID',
  ),
  // Optional at boot. Independent campaigns for Encuesta catch-up sequence.
  rechazadosSurveyInviteStep1CampaignId: optionalTrimmedEnv(
    'RECHAZADOS_SURVEY_INVITE_STEP1_CAMPAIGN_ID',
  ),
  rechazadosSurveyInviteStep2CampaignId: optionalTrimmedEnv(
    'RECHAZADOS_SURVEY_INVITE_STEP2_CAMPAIGN_ID',
  ),
  rechazadosSurveyInviteStep3CampaignId: optionalTrimmedEnv(
    'RECHAZADOS_SURVEY_INVITE_STEP3_CAMPAIGN_ID',
  ),
  // Optional at boot — required when POST /jobs/run-serp-import-sync runs.
  serperApiKey: process.env.SERPER_API_KEY || null,
  // Optional at boot — required when POST /jobs/run-keyword-cpc-sync runs.
  // Trimmed: Railway copy-paste often leaves trailing \n (illegal in gRPC metadata).
  // GOOGLE_ADS_LOGIN_CUSTOMER_ID only when OAuth is against an MCC managing COPANEL.
  googleAdsDeveloperToken: optionalTrimmedEnv('GOOGLE_ADS_DEVELOPER_TOKEN'),
  googleAdsClientId: optionalTrimmedEnv('GOOGLE_ADS_CLIENT_ID'),
  googleAdsClientSecret: optionalTrimmedEnv('GOOGLE_ADS_CLIENT_SECRET'),
  googleAdsRefreshToken: optionalTrimmedEnv('GOOGLE_ADS_REFRESH_TOKEN'),
  googleAdsCustomerId: optionalTrimmedEnv('GOOGLE_ADS_CUSTOMER_ID'),
  googleAdsLoginCustomerId: optionalTrimmedEnv('GOOGLE_ADS_LOGIN_CUSTOMER_ID'),
};
