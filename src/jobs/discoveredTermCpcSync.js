'use strict';

/**
 * Job: discovered_term_cpc_sync
 * Cadence: POST /jobs/run-discovered-term-cpc-sync (also chained after discovery refresh)
 *
 * Pending Trends discoveries (no confirmed_search_terms decision) without any
 * prior discovered_term_cpc_estimates row for that term → Keyword Planner (UY)
 * → append discovered_term_cpc_estimates.
 *
 * Terms that already have at least one estimate are skipped (no auto-refresh).
 */

const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  fetchKeywordHistoricalMetrics,
  KEYWORD_BATCH_MAX,
  normalizeKeywordKey,
} = require('../clients/googleAdsKeywordPlanner');

/**
 * @param {object|null} metrics
 * @returns {'imported'|'no_data'}
 */
function classifyMetrics(metrics) {
  if (metrics && metrics.hasUsefulMetrics) return 'imported';
  return 'no_data';
}

/**
 * Latest Trends discovery row per (seed, term, query_type) that is still
 * undecided (no confirmed_search_terms match). Excludes SERP-import pending.
 *
 * @returns {Promise<Array<{ discoveryId: string, term: string, seed: string, queryType: string }>>}
 */
async function listPendingTrendsDiscoveries() {
  const { data: discoveries, error: discErr } = await supabase
    .from('search_term_discoveries')
    .select('id, seed, term, query_type, discovered_at')
    .order('discovered_at', { ascending: false })
    .limit(2000);
  if (discErr) {
    throw new Error(`Failed to fetch search_term_discoveries: ${discErr.message}`);
  }

  const latestByKey = new Map();
  for (const row of discoveries || []) {
    const key = `${row.seed}::${row.term}::${row.query_type}`;
    if (!latestByKey.has(key)) latestByKey.set(key, row);
  }

  const { data: decided, error: decErr } = await supabase
    .from('confirmed_search_terms')
    .select('term');
  if (decErr) {
    throw new Error(`Failed to fetch confirmed_search_terms: ${decErr.message}`);
  }
  const decidedLower = new Set(
    (decided || []).map((d) => String(d.term || '').trim().toLowerCase()).filter(Boolean),
  );

  const pending = [];
  for (const row of latestByKey.values()) {
    const term = String(row.term || '').trim();
    if (!term) continue;
    const lower = term.toLowerCase();
    if (decidedLower.has(lower)) continue;
    pending.push({
      discoveryId: String(row.id),
      term,
      seed: row.seed,
      queryType: row.query_type,
    });
  }
  return pending;
}

/**
 * Terms (normalized) that already have at least one CPC estimate row.
 * @returns {Promise<Set<string>>}
 */
async function loadTermsWithExistingEstimates() {
  const { data, error } = await supabase
    .from('discovered_term_cpc_estimates')
    .select('term_snapshot');
  if (error) {
    throw new Error(
      `Failed to fetch discovered_term_cpc_estimates: ${error.message}`,
    );
  }
  const set = new Set();
  (data || []).forEach((row) => {
    const key = normalizeKeywordKey(row && row.term_snapshot);
    if (key) set.add(key);
  });
  return set;
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   syncRunId: string,
 *   pendingTotal: number,
 *   skippedAlreadyEstimated: number,
 *   totalProcessed: number,
 *   imported: number,
 *   noData: number,
 *   errors: number,
 *   currencyCode: string|null,
 *   details: object[],
 * }>}
 */
async function runDiscoveredTermCpcSync() {
  const syncRunId = randomUUID();
  const summary = {
    ok: true,
    syncRunId,
    pendingTotal: 0,
    skippedAlreadyEstimated: 0,
    totalProcessed: 0,
    imported: 0,
    noData: 0,
    errors: 0,
    currencyCode: null,
    details: [],
  };

  const pending = await listPendingTrendsDiscoveries();
  summary.pendingTotal = pending.length;

  const already = await loadTermsWithExistingEstimates();
  const toFetch = [];
  for (const item of pending) {
    const key = normalizeKeywordKey(item.term);
    if (key && already.has(key)) {
      summary.skippedAlreadyEstimated += 1;
      continue;
    }
    toFetch.push(item);
  }

  logger.info('discovered_term_cpc_sync started', {
    syncRunId,
    pendingTotal: summary.pendingTotal,
    toFetch: toFetch.length,
    skippedAlreadyEstimated: summary.skippedAlreadyEstimated,
  });

  if (!toFetch.length) {
    logger.info('discovered_term_cpc_sync finished — nothing to fetch', {
      syncRunId,
      pendingTotal: summary.pendingTotal,
      skippedAlreadyEstimated: summary.skippedAlreadyEstimated,
    });
    return summary;
  }

  if (toFetch.length > KEYWORD_BATCH_MAX) {
    const err = new Error(
      `Pending discoveries (${toFetch.length}) exceed Keyword Planner batch max (${KEYWORD_BATCH_MAX})`,
    );
    err.code = 'GOOGLE_ADS_BATCH_TOO_LARGE';
    throw err;
  }

  const keywordTexts = toFetch.map((t) => t.term);

  let currencyCode = null;
  /** @type {Map<string, object|null>} */
  let resultsByKeyword = new Map();

  try {
    const fetched = await fetchKeywordHistoricalMetrics(keywordTexts);
    currencyCode = fetched.currencyCode;
    resultsByKeyword = fetched.resultsByKeyword;
    summary.currencyCode = currencyCode;
  } catch (err) {
    const message = err && err.message ? err.message : 'unknown';
    const code = err && err.code ? err.code : 'GOOGLE_ADS_KEYWORD_PLANNER_ERROR';
    const envDiagnostics =
      err && Array.isArray(err.envDiagnostics) ? err.envDiagnostics : null;
    const googleAdsError =
      err && err.googleAdsError
        ? err.googleAdsError
        : {
            message,
            code,
            googleErrorCodes: err && err.googleErrorCodes ? err.googleErrorCodes : [],
            googleMessages: err && err.googleMessages ? err.googleMessages : [],
            requestId: err && err.googleRequestId ? err.googleRequestId : null,
            grpcCode: err && err.grpcCode != null ? err.grpcCode : null,
          };
    logger.error('discovered_term_cpc_sync Keyword Planner call failed', {
      syncRunId,
      error: message,
      code,
      googleAdsError,
      envDiagnostics,
    });

    for (const item of toFetch) {
      summary.totalProcessed += 1;
      summary.errors += 1;
      summary.details.push({
        discoveryId: item.discoveryId,
        term: item.term,
        outcome: 'error',
        error: message,
        code,
        estimateId: null,
      });
    }
    summary.ok = false;
    summary.googleAdsError = googleAdsError;
    if (envDiagnostics) summary.envDiagnostics = envDiagnostics;
    return summary;
  }

  const rowsToInsert = [];
  for (const item of toFetch) {
    summary.totalProcessed += 1;
    const metrics = resultsByKeyword.get(item.term) || null;
    const outcome = classifyMetrics(metrics);
    rowsToInsert.push({
      item,
      outcome,
      row: {
        discovery_id: item.discoveryId,
        term_snapshot: item.term,
        avg_monthly_searches:
          metrics && metrics.avgMonthlySearches != null
            ? metrics.avgMonthlySearches
            : null,
        low_top_of_page_bid_raw:
          metrics && metrics.lowTopOfPageBidRaw != null
            ? metrics.lowTopOfPageBidRaw
            : null,
        high_top_of_page_bid_raw:
          metrics && metrics.highTopOfPageBidRaw != null
            ? metrics.highTopOfPageBidRaw
            : null,
        currency_code: currencyCode,
        competition_level:
          metrics && metrics.competitionLevel != null
            ? metrics.competitionLevel
            : null,
        sync_run_id: syncRunId,
      },
    });
  }

  if (rowsToInsert.length) {
    const { data: inserted, error: insertErr } = await supabase
      .from('discovered_term_cpc_estimates')
      .insert(rowsToInsert.map((r) => r.row))
      .select('id, discovery_id');

    if (insertErr) {
      const message = insertErr.message || 'insert failed';
      logger.error('discovered_term_cpc_sync insert failed', {
        syncRunId,
        error: message,
      });
      for (const item of rowsToInsert) {
        summary.errors += 1;
        summary.details.push({
          discoveryId: item.item.discoveryId,
          term: item.item.term,
          outcome: 'error',
          error: message,
          code: 'DISCOVERED_TERM_CPC_INSERT_FAILED',
          estimateId: null,
        });
      }
      summary.ok = false;
      return summary;
    }

    const idByDiscovery = new Map();
    (inserted || []).forEach((row) => {
      if (row && row.discovery_id) {
        idByDiscovery.set(String(row.discovery_id), row.id);
      }
    });

    for (const entry of rowsToInsert) {
      const estimateId =
        idByDiscovery.get(String(entry.item.discoveryId)) || null;
      if (entry.outcome === 'imported') summary.imported += 1;
      else summary.noData += 1;
      summary.details.push({
        discoveryId: entry.item.discoveryId,
        term: entry.item.term,
        outcome: entry.outcome,
        estimateId,
        avgMonthlySearches: entry.row.avg_monthly_searches,
        lowTopOfPageBidRaw: entry.row.low_top_of_page_bid_raw,
        highTopOfPageBidRaw: entry.row.high_top_of_page_bid_raw,
        competitionLevel: entry.row.competition_level,
        currencyCode: entry.row.currency_code,
        error: null,
        code: null,
      });
    }
  }

  logger.info('discovered_term_cpc_sync finished', {
    syncRunId,
    pendingTotal: summary.pendingTotal,
    skippedAlreadyEstimated: summary.skippedAlreadyEstimated,
    totalProcessed: summary.totalProcessed,
    imported: summary.imported,
    noData: summary.noData,
    errors: summary.errors,
    currencyCode: summary.currencyCode,
  });

  return summary;
}

module.exports = {
  runDiscoveredTermCpcSync,
  listPendingTrendsDiscoveries,
};
