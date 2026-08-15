'use strict';

/**
 * Measure one Claude-suggested term (not a Trends discovery) with Keyword Planner.
 * Creates a minimal search_term_discoveries row so discovered_term_cpc_estimates
 * can satisfy its NOT NULL FK, then fetches a single keyword.
 *
 * Classification: absolute gates only — never classifyAndPersistSyncRun (n=1
 * relative ranking is not comparable to batch runs).
 */

const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { fetchKeywordHistoricalMetrics, normalizeKeywordKey } = require('../clients/googleAdsKeywordPlanner');
const {
  applyAbsoluteClassificationGates,
} = require('../lib/keywordOpportunityClassification');

const AI_SUGGESTION_SEED = 'ai_suggestion';

function httpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Same "already measured" criterion as discoveredTermCpcSync:
 * loadTermsWithExistingEstimates + normalizeKeywordKey(term_snapshot).
 * If several rows share the key, the latest fetched_at is returned (batch only
 * needs existence; the UI needs one estimate).
 *
 * @param {string} term
 */
async function findExistingDiscoveredTermEstimate(term) {
  const want = normalizeKeywordKey(term);
  if (!want) return null;

  const { data, error } = await supabase
    .from('discovered_term_cpc_estimates')
    .select(
      [
        'id',
        'discovery_id',
        'term_snapshot',
        'avg_monthly_searches',
        'low_top_of_page_bid_raw',
        'high_top_of_page_bid_raw',
        'currency_code',
        'competition_level',
        'classification_status',
        'sync_run_id',
        'fetched_at',
      ].join(', '),
    )
    .order('fetched_at', { ascending: false });
  if (error) {
    throw httpError(
      `Failed to fetch discovered_term_cpc_estimates: ${error.message}`,
      500,
      'EXISTING_ESTIMATE_LOOKUP_FAILED',
    );
  }

  for (const row of data || []) {
    const key = normalizeKeywordKey(row && row.term_snapshot);
    if (key && key === want) return row;
  }
  return null;
}

/**
 * @param {{ term: unknown, reason?: unknown }} body
 * @returns {Promise<{
 *   ok: true,
 *   measured: true,
 *   estimateId: string,
 *   discoveryId: string,
 *   term: string,
 *   avgMonthlySearches: number|null,
 *   lowTopOfPageBidRaw: number|null,
 *   highTopOfPageBidRaw: number|null,
 *   currencyCode: string|null,
 *   competitionLevel: string|null,
 *   classificationStatus: string|null,
 *   syncRunId: string,
 * }>}
 */
async function measureSuggestedTerm({ term: termRaw, reason } = {}) {
  const term = termRaw != null ? String(termRaw).trim() : '';
  if (!term) {
    throw httpError('term es requerido', 400, 'TERM_REQUIRED');
  }

  const existing = await findExistingDiscoveredTermEstimate(term);
  if (existing) {
    logger.info('measureSuggestedTerm already measured', {
      estimateId: existing.id,
      discoveryId: existing.discovery_id,
      term,
    });
    return {
      ok: true,
      measured: true,
      alreadyMeasured: true,
      estimateId: String(existing.id),
      discoveryId:
        existing.discovery_id != null ? String(existing.discovery_id) : null,
      term,
      avgMonthlySearches:
        existing.avg_monthly_searches != null
          ? existing.avg_monthly_searches
          : null,
      lowTopOfPageBidRaw:
        existing.low_top_of_page_bid_raw != null
          ? existing.low_top_of_page_bid_raw
          : null,
      highTopOfPageBidRaw:
        existing.high_top_of_page_bid_raw != null
          ? existing.high_top_of_page_bid_raw
          : null,
      currencyCode: existing.currency_code,
      competitionLevel: existing.competition_level,
      classificationStatus: existing.classification_status,
      syncRunId:
        existing.sync_run_id != null ? String(existing.sync_run_id) : null,
    };
  }

  const reasonNote =
    reason != null && String(reason).trim() ? String(reason).trim() : null;

  const { data: discovery, error: discErr } = await supabase
    .from('search_term_discoveries')
    .insert({
      seed: AI_SUGGESTION_SEED,
      term,
      query_type: 'top',
      score: null,
      formatted_value: null,
      raw_json: null,
    })
    .select('id, term')
    .single();

  if (discErr || !discovery) {
    logger.error('measureSuggestedTerm discovery insert failed', {
      term,
      error: discErr && discErr.message ? discErr.message : 'no row',
    });
    throw httpError(
      discErr && discErr.message
        ? discErr.message
        : 'Failed to insert search_term_discoveries',
      500,
      'DISCOVERY_INSERT_FAILED',
    );
  }

  const discoveryId = String(discovery.id);
  logger.info('measureSuggestedTerm discovery created', {
    discoveryId,
    term,
    reason: reasonNote,
  });

  let currencyCode = null;
  let metrics = null;
  try {
    const fetched = await fetchKeywordHistoricalMetrics([term]);
    currencyCode = fetched.currencyCode;
    metrics = fetched.resultsByKeyword.get(term) || null;
  } catch (err) {
    const message = err && err.message ? err.message : 'Keyword Planner failed';
    const code =
      err && err.code ? err.code : 'GOOGLE_ADS_KEYWORD_PLANNER_ERROR';
    logger.error('measureSuggestedTerm Keyword Planner failed', {
      discoveryId,
      term,
      error: message,
      code,
    });
    const wrapped = httpError(message, 502, code);
    wrapped.googleAdsError = err && err.googleAdsError ? err.googleAdsError : undefined;
    throw wrapped;
  }

  const gates = applyAbsoluteClassificationGates({
    competition_level:
      metrics && metrics.competitionLevel != null ? metrics.competitionLevel : null,
    avg_monthly_searches:
      metrics && metrics.avgMonthlySearches != null
        ? metrics.avgMonthlySearches
        : null,
    high_top_of_page_bid_raw:
      metrics && metrics.highTopOfPageBidRaw != null
        ? metrics.highTopOfPageBidRaw
        : null,
  });

  const syncRunId = randomUUID();
  const row = {
    discovery_id: discoveryId,
    term_snapshot: term,
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
      metrics && metrics.competitionLevel != null ? metrics.competitionLevel : null,
    sync_run_id: syncRunId,
    classification_status: gates.classification_status,
    efficiency_score: gates.efficiency_score,
    classification_version: gates.classification_version,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('discovered_term_cpc_estimates')
    .insert(row)
    .select('id')
    .single();

  if (insertErr || !inserted) {
    const message =
      insertErr && insertErr.message
        ? insertErr.message
        : 'Failed to insert discovered_term_cpc_estimates';
    logger.error('measureSuggestedTerm estimate insert failed', {
      discoveryId,
      term,
      syncRunId,
      error: message,
    });
    throw httpError(message, 500, 'DISCOVERED_TERM_CPC_INSERT_FAILED');
  }

  logger.info('measureSuggestedTerm measured', {
    discoveryId,
    estimateId: inserted.id,
    term,
    syncRunId,
    classificationStatus: gates.classification_status,
  });

  return {
    ok: true,
    measured: true,
    alreadyMeasured: false,
    estimateId: String(inserted.id),
    discoveryId,
    term,
    avgMonthlySearches: row.avg_monthly_searches,
    lowTopOfPageBidRaw: row.low_top_of_page_bid_raw,
    highTopOfPageBidRaw: row.high_top_of_page_bid_raw,
    currencyCode: row.currency_code,
    competitionLevel: row.competition_level,
    classificationStatus: gates.classification_status,
    syncRunId,
  };
}

module.exports = {
  AI_SUGGESTION_SEED,
  measureSuggestedTerm,
};
