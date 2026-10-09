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
  // Optional at boot. Dedicated HMAC for Credizona → JANUS miplan handoff emit.
  // MUST NOT reuse CZ_TRACKING_HMAC_SECRET.
  czMiplanHandoffHmacSecret: optionalTrimmedEnv(
    'CZ_MIPLAN_HANDOFF_HMAC_SECRET',
  ),
  // Optional at boot. Dedicated HMAC for Credizona → JANUS provider fallback
  // (/internal/providers/v1/fallback/*). MUST NOT reuse any other secret (reuse → 503).
  czProviderFallbackHmacSecret: optionalTrimmedEnv(
    'CZ_PROVIDER_FALLBACK_HMAC_SECRET',
  ),
  // Optional at boot. Bearer secret for Mi Plan BE → JANUS handoff redeem.
  // MUST NOT reuse dashboard session / tracking secrets.
  miplanHandoffRedeemSecret: optionalTrimmedEnv(
    'MIPLAN_HANDOFF_REDEEM_SECRET',
  ),
  // Optional at boot. Mi Deuda Stage 2 pull (POST /jobs/run-miplan-debt-optin-sync):
  // Mi Plan backend base URL + dedicated Bearer for its S2S opt-in export.
  // MUST NOT reuse MIPLAN_HANDOFF_REDEEM_SECRET. Either missing → job reports not_configured.
  miplanExportBaseUrl: optionalTrimmedEnv('MIPLAN_EXPORT_BASE_URL'),
  miplanJanusExportSecret: optionalTrimmedEnv('MIPLAN_JANUS_EXPORT_SECRET'),
  // Deliver Credizona V2 surveys (P7 = loan purpose) in the Mi Plan handoff.
  // Default false; only the string "true" (case-insensitive) enables.
  // While false, V2 surveys are withheld from the handoff (never downgraded to V1).
  miplanHandoffSurveyV2Enabled:
    String(optionalTrimmedEnv('MIPLAN_HANDOFF_SURVEY_V2_ENABLED') || '')
      .toLowerCase() === 'true',
  // Optional at boot. Comma-separated browser origins allowed to POST /miplan/v1/interest.
  // Unset → https://www.credizona.com.uy, https://credizona.com.uy.
  miplanInterestAllowedOrigins: optionalTrimmedEnv('MIPLAN_INTEREST_ALLOWED_ORIGINS'),
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
  // Optional at boot. Fail-closed for NORMAL survey-invite orchestration when
  // unset/invalid at job/evaluate time. ISO-8601 with timezone required.
  rechazadosSurveyInviteNormalCutoffAt: optionalTrimmedEnv(
    'RECHAZADOS_SURVEY_INVITE_NORMAL_CUTOFF_AT',
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
