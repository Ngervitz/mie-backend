'use strict';

/**
 * On-demand Keyword Planner measure: one API call, optional writes to
 * discovered_term_cpc_estimates and/or keyword_cpc_estimates.
 *
 * Absolute gates only — never classifyAndPersistSyncRun (n=1 ranking is
 * not comparable to batch runs). Weekly jobs stay append-only and do not
 * use this skip.
 */

const { randomUUID } = require('crypto');
const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  fetchKeywordHistoricalMetrics,
  normalizeKeywordKey,
} = require('../clients/googleAdsKeywordPlanner');
const {
  applyAbsoluteClassificationGates,
} = require('../lib/keywordOpportunityClassification');

const AI_SUGGESTION_SEED = 'ai_suggestion';
const SERP_MONITORED_TERM_SEED = 'serp_monitored_term';
const ALLOWED_SEEDS = new Set([AI_SUGGESTION_SEED, SERP_MONITORED_TERM_SEED]);
const DISCOVERED_LOOKUP_PAGE_SIZE = 1000;

const DISCOVERED_SELECT = [
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
].join(', ');

const KEYWORD_CPC_SELECT = [
  'id',
  'monitored_query_id',
  'query_text_snapshot',
  'avg_monthly_searches',
  'low_top_of_page_bid_raw',
  'high_top_of_page_bid_raw',
  'currency_code',
  'competition_level',
  'classification_status',
  'sync_run_id',
  'fetched_at',
].join(', ');

function httpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function numOrNull(value) {
  return value != null ? value : null;
}

/**
 * Same "already measured" criterion as discoveredTermCpcSync:
 * normalizeKeywordKey(term_snapshot). Latest fetched_at wins.
 *
 * @param {string} term
 */
async function findExistingDiscoveredTermEstimate(term) {
  const want = normalizeKeywordKey(term);
  if (!want) return null;

  for (let from = 0; ; from += DISCOVERED_LOOKUP_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('discovered_term_cpc_estimates')
      .select(DISCOVERED_SELECT)
      .order('fetched_at', { ascending: false })
      .range(from, from + DISCOVERED_LOOKUP_PAGE_SIZE - 1);
    if (error) {
      throw httpError(
        `Failed to fetch discovered_term_cpc_estimates: ${error.message}`,
        500,
        'EXISTING_ESTIMATE_LOOKUP_FAILED',
      );
    }
    const rows = data || [];
    for (const row of rows) {
      const key = normalizeKeywordKey(row && row.term_snapshot);
      if (key && key === want) return row;
    }
    if (rows.length < DISCOVERED_LOOKUP_PAGE_SIZE) break;
  }
  return null;
}

/**
 * Any row for this monitored_query_id counts as already measured (on-demand).
 *
 * @param {string} monitoredQueryId
 */
async function findLatestKeywordCpcByQueryId(monitoredQueryId) {
  const id = monitoredQueryId != null ? String(monitoredQueryId).trim() : '';
  if (!id) return null;

  const { data, error } = await supabase
    .from('keyword_cpc_estimates')
    .select(KEYWORD_CPC_SELECT)
    .eq('monitored_query_id', id)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw httpError(
      `Failed to fetch keyword_cpc_estimates: ${error.message}`,
      500,
      'EXISTING_KEYWORD_CPC_LOOKUP_FAILED',
    );
  }
  return data || null;
}

function mapDiscoveredSide(row, { alreadyMeasured }) {
  if (!row) return null;
  return {
    skipped: alreadyMeasured,
    alreadyMeasured,
    estimateId: row.id != null ? String(row.id) : null,
    discoveryId:
      row.discovery_id != null ? String(row.discovery_id) : null,
    avgMonthlySearches: numOrNull(row.avg_monthly_searches),
    lowTopOfPageBidRaw: numOrNull(row.low_top_of_page_bid_raw),
    highTopOfPageBidRaw: numOrNull(row.high_top_of_page_bid_raw),
    currencyCode: row.currency_code != null ? row.currency_code : null,
    competitionLevel:
      row.competition_level != null ? row.competition_level : null,
    classificationStatus:
      row.classification_status != null ? row.classification_status : null,
    syncRunId: row.sync_run_id != null ? String(row.sync_run_id) : null,
  };
}

function mapKeywordCpcSide(row, { alreadyMeasured }) {
  if (!row) return null;
  return {
    skipped: alreadyMeasured,
    alreadyMeasured,
    estimateId: row.id != null ? String(row.id) : null,
    avgMonthlySearches: numOrNull(row.avg_monthly_searches),
    lowTopOfPageBidRaw: numOrNull(row.low_top_of_page_bid_raw),
    highTopOfPageBidRaw: numOrNull(row.high_top_of_page_bid_raw),
    currencyCode: row.currency_code != null ? row.currency_code : null,
    competitionLevel:
      row.competition_level != null ? row.competition_level : null,
    classificationStatus:
      row.classification_status != null ? row.classification_status : null,
    syncRunId: row.sync_run_id != null ? String(row.sync_run_id) : null,
  };
}

function plannerMetricsPayload(metrics, currencyCode) {
  return {
    avgMonthlySearches:
      metrics && metrics.avgMonthlySearches != null
        ? metrics.avgMonthlySearches
        : null,
    lowTopOfPageBidRaw:
      metrics && metrics.lowTopOfPageBidRaw != null
        ? metrics.lowTopOfPageBidRaw
        : null,
    highTopOfPageBidRaw:
      metrics && metrics.highTopOfPageBidRaw != null
        ? metrics.highTopOfPageBidRaw
        : null,
    currencyCode: currencyCode != null ? currencyCode : null,
    competitionLevel:
      metrics && metrics.competitionLevel != null
        ? metrics.competitionLevel
        : null,
  };
}

async function insertDiscoveredEstimate({
  term,
  seed,
  reasonNote,
  metrics,
  currencyCode,
  gates,
  syncRunId,
}) {
  const { data: discovery, error: discErr } = await supabase
    .from('search_term_discoveries')
    .insert({
      seed,
      term,
      query_type: 'top',
      score: null,
      formatted_value: null,
      raw_json: null,
    })
    .select('id, term')
    .single();

  if (discErr || !discovery) {
    logger.error('measureKeywordPlannerTerm discovery insert failed', {
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
  logger.info('measureKeywordPlannerTerm discovery created', {
    discoveryId,
    term,
    seed,
    reason: reasonNote,
  });

  const payload = plannerMetricsPayload(metrics, currencyCode);
  const row = {
    discovery_id: discoveryId,
    term_snapshot: term,
    avg_monthly_searches: payload.avgMonthlySearches,
    low_top_of_page_bid_raw: payload.lowTopOfPageBidRaw,
    high_top_of_page_bid_raw: payload.highTopOfPageBidRaw,
    currency_code: payload.currencyCode,
    competition_level: payload.competitionLevel,
    sync_run_id: syncRunId,
    classification_status: gates.classification_status,
    efficiency_score: gates.efficiency_score,
    classification_version: gates.classification_version,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('discovered_term_cpc_estimates')
    .insert(row)
    .select(DISCOVERED_SELECT)
    .single();

  if (insertErr || !inserted) {
    const message =
      insertErr && insertErr.message
        ? insertErr.message
        : 'Failed to insert discovered_term_cpc_estimates';
    logger.error('measureKeywordPlannerTerm discovered insert failed', {
      discoveryId,
      term,
      syncRunId,
      error: message,
    });
    throw httpError(message, 500, 'DISCOVERED_TERM_CPC_INSERT_FAILED');
  }

  return inserted;
}

async function insertKeywordCpcEstimate({
  monitoredQueryId,
  queryTextSnapshot,
  metrics,
  currencyCode,
  gates,
  syncRunId,
}) {
  const payload = plannerMetricsPayload(metrics, currencyCode);
  const row = {
    monitored_query_id: monitoredQueryId,
    query_text_snapshot: queryTextSnapshot,
    avg_monthly_searches: payload.avgMonthlySearches,
    low_top_of_page_bid_raw: payload.lowTopOfPageBidRaw,
    high_top_of_page_bid_raw: payload.highTopOfPageBidRaw,
    currency_code: payload.currencyCode,
    competition_level: payload.competitionLevel,
    sync_run_id: syncRunId,
    classification_status: gates.classification_status,
    efficiency_score: gates.efficiency_score,
    classification_version: gates.classification_version,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('keyword_cpc_estimates')
    .insert(row)
    .select(KEYWORD_CPC_SELECT)
    .single();

  if (insertErr || !inserted) {
    const message =
      insertErr && insertErr.message
        ? insertErr.message
        : 'Failed to insert keyword_cpc_estimates';
    logger.error('measureKeywordPlannerTerm keyword_cpc insert failed', {
      monitoredQueryId,
      term: queryTextSnapshot,
      syncRunId,
      error: message,
    });
    throw httpError(message, 500, 'KEYWORD_CPC_INSERT_FAILED');
  }

  return inserted;
}

/**
 * One Planner fetch. Independent skips per table. Stub search_term_discoveries
 * is created only after a successful Planner call.
 *
 * Does not touch confirmed_search_terms, Serper, or classifyAndPersistSyncRun.
 *
 * @param {{
 *   term: unknown,
 *   writeDiscovered?: { seed?: unknown, reason?: unknown } | null,
 *   writeKeywordCpc?: { monitoredQueryId: unknown } | null,
 * }} opts
 */
async function measureKeywordPlannerTerm({
  term: termRaw,
  writeDiscovered,
  writeKeywordCpc,
} = {}) {
  const term = termRaw != null ? String(termRaw).trim() : '';
  if (!term) {
    throw httpError('term es requerido', 400, 'TERM_REQUIRED');
  }

  const doDiscovered = Boolean(writeDiscovered);
  const monitoredQueryId =
    writeKeywordCpc && writeKeywordCpc.monitoredQueryId != null
      ? String(writeKeywordCpc.monitoredQueryId).trim()
      : '';
  const doKeywordCpc = Boolean(writeKeywordCpc) && Boolean(monitoredQueryId);

  if (Boolean(writeKeywordCpc) && !monitoredQueryId) {
    throw httpError(
      'monitoredQueryId es requerido',
      400,
      'QUERY_ID_REQUIRED',
    );
  }
  if (!doDiscovered && !doKeywordCpc) {
    throw httpError('Nada que medir', 400, 'NO_WRITE_TARGET');
  }

  let seed = AI_SUGGESTION_SEED;
  let reasonNote = null;
  if (doDiscovered) {
    seed =
      writeDiscovered.seed != null && String(writeDiscovered.seed).trim()
        ? String(writeDiscovered.seed).trim()
        : AI_SUGGESTION_SEED;
    if (!ALLOWED_SEEDS.has(seed)) {
      throw httpError('seed no soportado', 400, 'INVALID_SEED');
    }
    reasonNote =
      writeDiscovered.reason != null && String(writeDiscovered.reason).trim()
        ? String(writeDiscovered.reason).trim()
        : null;
  }

  const existingDiscovered = doDiscovered
    ? await findExistingDiscoveredTermEstimate(term)
    : null;
  const existingKeyword = doKeywordCpc
    ? await findLatestKeywordCpcByQueryId(monitoredQueryId)
    : null;

  const needDiscovered = doDiscovered && !existingDiscovered;
  const needKeywordCpc = doKeywordCpc && !existingKeyword;

  if (!needDiscovered && !needKeywordCpc) {
    const discovered = doDiscovered
      ? mapDiscoveredSide(existingDiscovered, { alreadyMeasured: true })
      : null;
    const keywordCpc = doKeywordCpc
      ? mapKeywordCpcSide(existingKeyword, { alreadyMeasured: true })
      : null;
    logger.info('measureKeywordPlannerTerm already measured', {
      term,
      discoveredEstimateId: discovered && discovered.estimateId,
      keywordCpcEstimateId: keywordCpc && keywordCpc.estimateId,
    });
    const source = discovered || keywordCpc;
    return {
      term,
      fetched: false,
      metrics: null,
      avgMonthlySearches: source ? source.avgMonthlySearches : null,
      lowTopOfPageBidRaw: source ? source.lowTopOfPageBidRaw : null,
      highTopOfPageBidRaw: source ? source.highTopOfPageBidRaw : null,
      currencyCode: source ? source.currencyCode : null,
      competitionLevel: source ? source.competitionLevel : null,
      classificationStatus: source ? source.classificationStatus : null,
      syncRunId: source ? source.syncRunId : null,
      discovered,
      keywordCpc,
    };
  }

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
    logger.error('measureKeywordPlannerTerm Keyword Planner failed', {
      term,
      error: message,
      code,
    });
    const wrapped = httpError(message, 502, code);
    wrapped.googleAdsError =
      err && err.googleAdsError ? err.googleAdsError : undefined;
    throw wrapped;
  }

  const gates = applyAbsoluteClassificationGates({
    competition_level:
      metrics && metrics.competitionLevel != null
        ? metrics.competitionLevel
        : null,
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
  const payload = plannerMetricsPayload(metrics, currencyCode);

  let discovered = doDiscovered
    ? existingDiscovered
      ? mapDiscoveredSide(existingDiscovered, { alreadyMeasured: true })
      : null
    : null;
  let keywordCpc = doKeywordCpc
    ? existingKeyword
      ? mapKeywordCpcSide(existingKeyword, { alreadyMeasured: true })
      : null
    : null;

  if (needDiscovered) {
    const inserted = await insertDiscoveredEstimate({
      term,
      seed,
      reasonNote,
      metrics,
      currencyCode,
      gates,
      syncRunId,
    });
    discovered = mapDiscoveredSide(inserted, { alreadyMeasured: false });
  }

  if (needKeywordCpc) {
    const inserted = await insertKeywordCpcEstimate({
      monitoredQueryId,
      queryTextSnapshot: term,
      metrics,
      currencyCode,
      gates,
      syncRunId,
    });
    keywordCpc = mapKeywordCpcSide(inserted, { alreadyMeasured: false });
  }

  logger.info('measureKeywordPlannerTerm measured', {
    term,
    syncRunId,
    fetched: true,
    discoveredEstimateId: discovered && discovered.estimateId,
    discoveredAlreadyMeasured: Boolean(discovered && discovered.alreadyMeasured),
    keywordCpcEstimateId: keywordCpc && keywordCpc.estimateId,
    keywordCpcAlreadyMeasured: Boolean(keywordCpc && keywordCpc.alreadyMeasured),
    classificationStatus: gates.classification_status,
  });

  return {
    term,
    fetched: true,
    metrics,
    avgMonthlySearches: payload.avgMonthlySearches,
    lowTopOfPageBidRaw: payload.lowTopOfPageBidRaw,
    highTopOfPageBidRaw: payload.highTopOfPageBidRaw,
    currencyCode: payload.currencyCode,
    competitionLevel: payload.competitionLevel,
    classificationStatus: gates.classification_status,
    syncRunId,
    discovered,
    keywordCpc,
  };
}

module.exports = {
  AI_SUGGESTION_SEED,
  SERP_MONITORED_TERM_SEED,
  measureKeywordPlannerTerm,
  findExistingDiscoveredTermEstimate,
  findLatestKeywordCpcByQueryId,
};
