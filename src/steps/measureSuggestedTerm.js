'use strict';

/**
 * Measure one Claude-suggested term (not a Trends discovery) with Keyword Planner.
 * Thin wrapper over measureKeywordPlannerTerm (discovered writer only).
 *
 * Classification: absolute gates only — never classifyAndPersistSyncRun (n=1
 * relative ranking is not comparable to batch runs).
 */

const {
  AI_SUGGESTION_SEED,
  SERP_MONITORED_TERM_SEED,
  measureKeywordPlannerTerm,
} = require('./measureKeywordPlannerTerm');

const ALLOWED_SEEDS = new Set([AI_SUGGESTION_SEED, SERP_MONITORED_TERM_SEED]);

function httpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * @param {{ term: unknown, reason?: unknown, seed?: unknown }} body
 * @returns {Promise<{
 *   ok: true,
 *   measured: true,
 *   alreadyMeasured: boolean,
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
async function measureSuggestedTerm({ term: termRaw, reason, seed: seedRaw } = {}) {
  const term = termRaw != null ? String(termRaw).trim() : '';
  if (!term) {
    throw httpError('term es requerido', 400, 'TERM_REQUIRED');
  }
  const seed =
    seedRaw != null && String(seedRaw).trim()
      ? String(seedRaw).trim()
      : AI_SUGGESTION_SEED;
  if (!ALLOWED_SEEDS.has(seed)) {
    throw httpError('seed no soportado', 400, 'INVALID_SEED');
  }

  const result = await measureKeywordPlannerTerm({
    term,
    writeDiscovered: { seed, reason },
  });
  const discovered = result.discovered || {};
  return {
    ok: true,
    measured: true,
    alreadyMeasured: Boolean(discovered.alreadyMeasured),
    estimateId: discovered.estimateId != null ? String(discovered.estimateId) : null,
    discoveryId:
      discovered.discoveryId != null ? String(discovered.discoveryId) : null,
    term: result.term,
    avgMonthlySearches:
      discovered.avgMonthlySearches != null
        ? discovered.avgMonthlySearches
        : result.avgMonthlySearches,
    lowTopOfPageBidRaw:
      discovered.lowTopOfPageBidRaw != null
        ? discovered.lowTopOfPageBidRaw
        : result.lowTopOfPageBidRaw,
    highTopOfPageBidRaw:
      discovered.highTopOfPageBidRaw != null
        ? discovered.highTopOfPageBidRaw
        : result.highTopOfPageBidRaw,
    currencyCode:
      discovered.currencyCode != null
        ? discovered.currencyCode
        : result.currencyCode,
    competitionLevel:
      discovered.competitionLevel != null
        ? discovered.competitionLevel
        : result.competitionLevel,
    classificationStatus:
      discovered.classificationStatus != null
        ? discovered.classificationStatus
        : result.classificationStatus,
    syncRunId:
      discovered.syncRunId != null
        ? String(discovered.syncRunId)
        : result.syncRunId,
  };
}

module.exports = {
  AI_SUGGESTION_SEED,
  SERP_MONITORED_TERM_SEED,
  measureSuggestedTerm,
};
