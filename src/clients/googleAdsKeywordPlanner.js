'use strict';

/**
 * Google Ads Keyword Planner client (GenerateKeywordHistoricalMetrics).
 * Credentials from process.env (Railway). Optional login_customer_id for MCC.
 * Bid fields returned raw (micros as given by the API) — no conversion.
 */

const { GoogleAdsApi, enums, ResourceNames } = require('google-ads-api');
const env = require('../config/env');
const logger = require('../lib/logger');

/** Uruguay country criterion — Google Ads geo target CSV. */
const GEO_URUGUAY = ResourceNames.geoTargetConstant(2342);
/** Spanish language constant. */
const LANGUAGE_SPANISH = ResourceNames.languageConstant(1003);

/** API max keywords per GenerateKeywordHistoricalMetrics request. */
const KEYWORD_BATCH_MAX = 10_000;
const KEYWORD_PLANNER_TIMEOUT_MS = 30_000;

/**
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<T>}
 * @template T
 */
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.code = 'GOOGLE_ADS_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

function normalizeCustomerId(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits || null;
}

const GOOGLE_ADS_ENV_NAMES = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
];

/**
 * TEMP diagnostic: lengths / whitespace flags on RAW process.env (pre-trim).
 * Never includes credential values.
 * @param {string} name
 */
function inspectGoogleAdsEnvRaw(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return {
      name,
      present: false,
      length: 0,
      endsWithNewline: false,
      hasLeadingWhitespace: false,
      hasTrailingWhitespace: false,
      containsNewline: false,
      trimmedLength: 0,
      trimChangedLength: false,
    };
  }
  const s = String(raw);
  const trimmed = s.trim();
  return {
    name,
    present: true,
    length: s.length,
    endsWithNewline: /[\r\n]$/.test(s),
    hasLeadingWhitespace: /^\s/.test(s),
    hasTrailingWhitespace: /\s$/.test(s),
    containsNewline: /[\r\n]/.test(s),
    trimmedLength: trimmed.length,
    trimChangedLength: trimmed.length !== s.length,
  };
}

/** @returns {ReturnType<typeof inspectGoogleAdsEnvRaw>[]} */
function getGoogleAdsEnvDiagnostics() {
  return GOOGLE_ADS_ENV_NAMES.map(inspectGoogleAdsEnvRaw);
}

function requireAdsConfig() {
  const diagnostics = getGoogleAdsEnvDiagnostics();
  const suspicious = diagnostics.filter(
    (d) =>
      d.present &&
      (d.containsNewline ||
        d.hasLeadingWhitespace ||
        d.hasTrailingWhitespace ||
        d.trimChangedLength),
  );
  logger.warn('Google Ads env diagnostic (no secrets)', {
    vars: diagnostics,
    suspicious: suspicious.map((d) => d.name),
  });

  const developerToken = env.googleAdsDeveloperToken;
  const clientId = env.googleAdsClientId;
  const clientSecret = env.googleAdsClientSecret;
  const refreshToken = env.googleAdsRefreshToken;
  const customerId = normalizeCustomerId(env.googleAdsCustomerId);
  const loginCustomerId = normalizeCustomerId(env.googleAdsLoginCustomerId);

  const missing = [];
  if (!developerToken) missing.push('GOOGLE_ADS_DEVELOPER_TOKEN');
  if (!clientId) missing.push('GOOGLE_ADS_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_ADS_CLIENT_SECRET');
  if (!refreshToken) missing.push('GOOGLE_ADS_REFRESH_TOKEN');
  if (!customerId) missing.push('GOOGLE_ADS_CUSTOMER_ID');

  if (missing.length) {
    const err = new Error(
      `Google Ads not configured (missing: ${missing.join(', ')})`,
    );
    err.code = 'GOOGLE_ADS_CONFIG_MISSING';
    err.envDiagnostics = diagnostics;
    throw err;
  }

  return {
    developerToken,
    clientId,
    clientSecret,
    refreshToken,
    customerId,
    loginCustomerId,
    envDiagnostics: diagnostics,
  };
}

function createCustomer() {
  const cfg = requireAdsConfig();
  const api = new GoogleAdsApi({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    developer_token: cfg.developerToken,
  });

  /** @type {Record<string, string>} */
  const customerOpts = {
    customer_id: cfg.customerId,
    refresh_token: cfg.refreshToken,
  };
  // MCC → child: set GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager account.
  // Direct COPANEL OAuth: leave unset.
  if (cfg.loginCustomerId) {
    customerOpts.login_customer_id = cfg.loginCustomerId;
  }

  return { customer: api.Customer(customerOpts), cfg };
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toNullableInt(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    const n = Number(String(value));
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * @param {unknown} competition
 * @returns {string|null}
 */
function competitionLevelToString(competition) {
  if (competition == null) return null;
  if (typeof competition === 'string') {
    const s = competition.trim();
    return s || null;
  }
  const n = Number(competition);
  const map = {
    [enums.KeywordPlanCompetitionLevel.UNSPECIFIED]: 'UNSPECIFIED',
    [enums.KeywordPlanCompetitionLevel.UNKNOWN]: 'UNKNOWN',
    [enums.KeywordPlanCompetitionLevel.LOW]: 'LOW',
    [enums.KeywordPlanCompetitionLevel.MEDIUM]: 'MEDIUM',
    [enums.KeywordPlanCompetitionLevel.HIGH]: 'HIGH',
  };
  if (Object.prototype.hasOwnProperty.call(map, n)) return map[n];
  return String(competition);
}

function normalizeKeywordKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Account currency (ISO). Keyword Planner bid micros are in this currency.
 * Confirmed at runtime in production — not assumed here.
 * @param {ReturnType<GoogleAdsApi['Customer']>} customer
 * @returns {Promise<string|null>}
 */
async function fetchCustomerCurrencyCode(customer) {
  const rows = await withTimeout(
    customer.query(`SELECT customer.currency_code FROM customer LIMIT 1`),
    KEYWORD_PLANNER_TIMEOUT_MS,
    'Google Ads customer.currency_code',
  );
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  const code =
    row && row.customer && row.customer.currency_code
      ? String(row.customer.currency_code).trim()
      : '';
  return code || null;
}

/**
 * @param {object} metrics
 */
function mapKeywordMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    return {
      avgMonthlySearches: null,
      lowTopOfPageBidRaw: null,
      highTopOfPageBidRaw: null,
      competitionLevel: null,
      hasUsefulMetrics: false,
    };
  }

  const avgMonthlySearches = toNullableInt(metrics.avg_monthly_searches);
  const lowTopOfPageBidRaw = toNullableInt(metrics.low_top_of_page_bid_micros);
  const highTopOfPageBidRaw = toNullableInt(
    metrics.high_top_of_page_bid_micros,
  );
  const competitionLevel = competitionLevelToString(metrics.competition);

  const competitionUseful =
    competitionLevel === 'LOW' ||
    competitionLevel === 'MEDIUM' ||
    competitionLevel === 'HIGH';

  const hasUsefulMetrics =
    avgMonthlySearches != null ||
    lowTopOfPageBidRaw != null ||
    highTopOfPageBidRaw != null ||
    competitionUseful;

  return {
    avgMonthlySearches,
    lowTopOfPageBidRaw,
    highTopOfPageBidRaw,
    competitionLevel,
    hasUsefulMetrics,
  };
}

/**
 * Call Keyword Planner for an array of keyword strings (Uruguay / Spanish).
 * Returns one entry per input keyword (matched via text / close_variants).
 *
 * @param {string[]} keywords
 * @returns {Promise<{
 *   currencyCode: string|null,
 *   resultsByKeyword: Map<string, {
 *     text: string|null,
 *     closeVariants: string[],
 *     avgMonthlySearches: number|null,
 *     lowTopOfPageBidRaw: number|null,
 *     highTopOfPageBidRaw: number|null,
 *     competitionLevel: string|null,
 *     hasUsefulMetrics: boolean,
 *     raw: object|null,
 *   }>,
 * }>}
 */
async function fetchKeywordHistoricalMetrics(keywords) {
  const list = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k || '').trim())
    .filter(Boolean);

  if (!list.length) {
    return { currencyCode: null, resultsByKeyword: new Map() };
  }

  if (list.length > KEYWORD_BATCH_MAX) {
    const err = new Error(
      `Too many keywords for one Keyword Planner call (${list.length} > ${KEYWORD_BATCH_MAX})`,
    );
    err.code = 'GOOGLE_ADS_BATCH_TOO_LARGE';
    throw err;
  }

  const { customer, cfg } = createCustomer();

  let currencyCode = null;
  try {
    currencyCode = await fetchCustomerCurrencyCode(customer);
  } catch (err) {
    logger.warn('Google Ads currency_code fetch failed', {
      error: err && err.message ? err.message : 'unknown',
      code: err && err.code ? err.code : null,
    });
  }

  const request = {
    customer_id: cfg.customerId,
    keywords: list,
    geo_target_constants: [GEO_URUGUAY],
    language: LANGUAGE_SPANISH,
    keyword_plan_network: enums.KeywordPlanNetwork.GOOGLE_SEARCH,
  };

  let response;
  try {
    response = await withTimeout(
      customer.keywordPlanIdeas.generateKeywordHistoricalMetrics(request),
      KEYWORD_PLANNER_TIMEOUT_MS,
      'Google Ads GenerateKeywordHistoricalMetrics',
    );
  } catch (err) {
    if (err && err.code === 'GOOGLE_ADS_TIMEOUT') {
      err.envDiagnostics = cfg.envDiagnostics;
      throw err;
    }
    const wrapped = new Error(
      err && err.message
        ? err.message
        : 'Google Ads Keyword Planner request failed',
    );
    wrapped.code =
      err && err.code ? err.code : 'GOOGLE_ADS_KEYWORD_PLANNER_ERROR';
    wrapped.cause = err;
    wrapped.envDiagnostics = cfg.envDiagnostics;
    throw wrapped;
  }

  const apiResults = response && Array.isArray(response.results)
    ? response.results
    : [];

  /** @type {Map<string, object>} */
  const byKey = new Map();

  for (const result of apiResults) {
    if (!result || typeof result !== 'object') continue;
    const text = result.text != null ? String(result.text) : null;
    const closeVariants = Array.isArray(result.close_variants)
      ? result.close_variants.map((v) => String(v))
      : [];
    const mapped = mapKeywordMetrics(result.keyword_metrics);
    const entry = {
      text,
      closeVariants,
      ...mapped,
      raw: result,
    };

    const keys = new Set();
    if (text) keys.add(normalizeKeywordKey(text));
    closeVariants.forEach((v) => keys.add(normalizeKeywordKey(v)));
    keys.forEach((key) => {
      if (!key) return;
      if (!byKey.has(key) || (entry.hasUsefulMetrics && !byKey.get(key).hasUsefulMetrics)) {
        byKey.set(key, entry);
      }
    });
  }

  /** @type {Map<string, object>} */
  const resultsByKeyword = new Map();
  for (const kw of list) {
    const hit = byKey.get(normalizeKeywordKey(kw)) || null;
    resultsByKeyword.set(kw, hit);
  }

  return { currencyCode, resultsByKeyword };
}

module.exports = {
  fetchKeywordHistoricalMetrics,
  normalizeCustomerId,
  normalizeKeywordKey,
  getGoogleAdsEnvDiagnostics,
  KEYWORD_BATCH_MAX,
  KEYWORD_PLANNER_TIMEOUT_MS,
  GEO_URUGUAY,
  LANGUAGE_SPANISH,
};
