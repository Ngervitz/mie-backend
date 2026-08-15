'use strict';

/**
 * Keyword opportunity classification (deterministic, per sync_run_id).
 * Version: keyword_opportunity_v1
 *
 * Persistence: columns on the estimate rows themselves (not a separate table).
 * Supabase JS has no multi-statement transaction API — all results are computed
 * first, then written; on any write failure we clear classification columns for
 * the whole sync_run_id and surface classificationFailed.
 */

const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const CLASSIFICATION_VERSION = 'keyword_opportunity_v1';
const MIN_MONTHLY_SEARCHES = 10;
const BID_MICROS_PER_UNIT = 1_000_000;

function normalizeKeywordKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const STATUS = {
  DISCARDED_HIGH_COMPETITION: 'discarded_high_competition',
  DISCARDED_LOW_VOLUME: 'discarded_low_volume',
  INSUFFICIENT_BID_DATA: 'insufficient_bid_data',
  RECOMMENDED: 'recommended',
  EVALUATE: 'evaluate',
  LOW_PRIORITY: 'low_priority',
};

/** @type {Readonly<Record<'keyword_cpc_estimates'|'discovered_term_cpc_estimates', string>>} */
const TERM_COLUMN = {
  keyword_cpc_estimates: 'query_text_snapshot',
  discovered_term_cpc_estimates: 'term_snapshot',
};

/**
 * @param {unknown} raw
 * @returns {number|null} bid in account currency units, or null if invalid
 */
function bidRawToUnit(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / BID_MICROS_PER_UNIT;
}

/**
 * Absolute pre-ranking gates only (HIGH / low volume / missing bid).
 * Terms that pass return classification_status null — caller must NOT apply
 * the 30/40/30 relative ranking when n=1 (that collapse is meaningless).
 *
 * @param {{
 *   competition_level?: unknown,
 *   avg_monthly_searches?: unknown,
 *   high_top_of_page_bid_raw?: unknown,
 * }} row
 * @returns {{
 *   classification_status: string|null,
 *   efficiency_score: null,
 *   classification_version: string|null,
 *   bidUnit: number|null,
 *   avgMonthlySearches: number|null,
 *   competitionLevel: string|null,
 * }}
 */
function applyAbsoluteClassificationGates(row) {
  const comp =
    row && row.competition_level != null
      ? String(row.competition_level).trim().toUpperCase()
      : null;
  const avg =
    row &&
    row.avg_monthly_searches != null &&
    Number.isFinite(Number(row.avg_monthly_searches))
      ? Number(row.avg_monthly_searches)
      : null;
  const bidUnit = bidRawToUnit(row && row.high_top_of_page_bid_raw);

  if (comp === 'HIGH') {
    return {
      classification_status: STATUS.DISCARDED_HIGH_COMPETITION,
      efficiency_score: null,
      classification_version: CLASSIFICATION_VERSION,
      bidUnit,
      avgMonthlySearches: avg,
      competitionLevel: comp,
    };
  }

  if (avg == null || avg < MIN_MONTHLY_SEARCHES) {
    return {
      classification_status: STATUS.DISCARDED_LOW_VOLUME,
      efficiency_score: null,
      classification_version: CLASSIFICATION_VERSION,
      bidUnit,
      avgMonthlySearches: avg,
      competitionLevel: comp,
    };
  }

  if (bidUnit == null) {
    return {
      classification_status: STATUS.INSUFFICIENT_BID_DATA,
      efficiency_score: null,
      classification_version: CLASSIFICATION_VERSION,
      bidUnit: null,
      avgMonthlySearches: avg,
      competitionLevel: comp,
    };
  }

  return {
    classification_status: null,
    efficiency_score: null,
    classification_version: null,
    bidUnit,
    avgMonthlySearches: avg,
    competitionLevel: comp,
  };
}

/**
 * Pure classification of one sync_run's rows (no I/O).
 * @param {Array<{
 *   id: string,
 *   term: string,
 *   avg_monthly_searches: number|null,
 *   competition_level: string|null,
 *   high_top_of_page_bid_raw: number|null,
 * }>} rows
 * @returns {Array<{
 *   id: string,
 *   classification_status: string,
 *   efficiency_score: number|null,
 *   classification_version: string,
 *   bidUnit: number|null,
 *   term: string,
 *   avgMonthlySearches: number|null,
 *   competitionLevel: string|null,
 * }>}
 */
function classifyRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  /** @type {ReturnType<typeof classifyRows>} */
  const out = [];
  /** @type {Array<{ id: string, term: string, score: number, avg: number|null, comp: string|null, bidUnit: number }>} */
  const scored = [];

  for (const row of list) {
    const id = String(row.id);
    const term = row.term != null ? String(row.term) : '';
    const gate = applyAbsoluteClassificationGates(row);

    if (gate.classification_status) {
      out.push({
        id,
        term,
        classification_status: gate.classification_status,
        efficiency_score: gate.efficiency_score,
        classification_version: gate.classification_version,
        bidUnit: gate.bidUnit,
        avgMonthlySearches: gate.avgMonthlySearches,
        competitionLevel: gate.competitionLevel,
      });
      continue;
    }

    const score = gate.avgMonthlySearches / gate.bidUnit;
    scored.push({
      id,
      term,
      score,
      avg: gate.avgMonthlySearches,
      comp: gate.competitionLevel,
      bidUnit: gate.bidUnit,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ka = normalizeKeywordKey(a.term);
    const kb = normalizeKeywordKey(b.term);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const n = scored.length;
  const nTop = Math.floor(n * 0.3);
  const nBottom = Math.floor(n * 0.3);
  // nMid = n - nTop - nBottom

  /** @type {string[]} */
  const provisional = new Array(n);
  for (let i = 0; i < n; i += 1) {
    if (i < nTop) provisional[i] = STATUS.RECOMMENDED;
    else if (i >= n - nBottom) provisional[i] = STATUS.LOW_PRIORITY;
    else provisional[i] = STATUS.EVALUATE;
  }

  // Tie merge: equal scores share the best (lowest-index) tier in the group.
  const tierRank = {
    [STATUS.RECOMMENDED]: 0,
    [STATUS.EVALUATE]: 1,
    [STATUS.LOW_PRIORITY]: 2,
  };
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && scored[j].score === scored[i].score) j += 1;
    let best = provisional[i];
    for (let k = i; k < j; k += 1) {
      if (tierRank[provisional[k]] < tierRank[best]) best = provisional[k];
    }
    for (let k = i; k < j; k += 1) provisional[k] = best;
    i = j;
  }

  for (let idx = 0; idx < n; idx += 1) {
    const s = scored[idx];
    out.push({
      id: s.id,
      term: s.term,
      classification_status: provisional[idx],
      efficiency_score: s.score,
      classification_version: CLASSIFICATION_VERSION,
      bidUnit: s.bidUnit,
      avgMonthlySearches: s.avg,
      competitionLevel: s.comp,
    });
  }

  return out;
}

/**
 * @param {'keyword_cpc_estimates'|'discovered_term_cpc_estimates'} table
 * @param {string} syncRunId
 */
async function clearClassificationForSyncRun(table, syncRunId) {
  const { error } = await supabase
    .from(table)
    .update({
      classification_status: null,
      efficiency_score: null,
      classification_version: null,
    })
    .eq('sync_run_id', syncRunId);
  if (error) {
    logger.error('Failed to clear classification after partial write', {
      table,
      syncRunId,
      error: error.message,
    });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Classify all estimate rows for a sync_run_id and persist columns.
 * @param {'keyword_cpc_estimates'|'discovered_term_cpc_estimates'} table
 * @param {string} syncRunId
 */
async function classifyAndPersistSyncRun(table, syncRunId) {
  const termCol = TERM_COLUMN[table];
  if (!termCol) {
    const err = new Error(`Unsupported classification table: ${table}`);
    err.code = 'CLASSIFICATION_BAD_TABLE';
    throw err;
  }
  if (!syncRunId) {
    const err = new Error('syncRunId is required for classification');
    err.code = 'CLASSIFICATION_MISSING_SYNC_RUN';
    throw err;
  }

  const { data, error: fetchErr } = await supabase
    .from(table)
    .select(
      [
        'id',
        termCol,
        'avg_monthly_searches',
        'competition_level',
        'high_top_of_page_bid_raw',
      ].join(', '),
    )
    .eq('sync_run_id', syncRunId);

  if (fetchErr) {
    const err = new Error(
      `Failed to load ${table} for classification: ${fetchErr.message}`,
    );
    err.code = 'CLASSIFICATION_FETCH_FAILED';
    throw err;
  }

  const rows = (data || []).map((r) => ({
    id: r.id,
    term: r[termCol],
    avg_monthly_searches: r.avg_monthly_searches,
    competition_level: r.competition_level,
    high_top_of_page_bid_raw: r.high_top_of_page_bid_raw,
  }));

  if (!rows.length) {
    return {
      ok: true,
      syncRunId,
      table,
      classificationVersion: CLASSIFICATION_VERSION,
      total: 0,
      counts: {},
      results: [],
      transactionNote:
        'No multi-statement DB transaction available via Supabase JS; nothing to write.',
    };
  }

  // Full set computed before any write.
  const results = classifyRows(rows);

  const counts = {};
  for (const r of results) {
    counts[r.classification_status] =
      (counts[r.classification_status] || 0) + 1;
  }

  // Persist: one update per row (Supabase JS cannot UPDATE DISTINCT values
  // atomically across rows). On any failure, clear the whole sync_run_id.
  const writeErrors = [];
  for (const r of results) {
    const { error: updErr } = await supabase
      .from(table)
      .update({
        classification_status: r.classification_status,
        efficiency_score: r.efficiency_score,
        classification_version: r.classification_version,
      })
      .eq('id', r.id)
      .eq('sync_run_id', syncRunId);

    if (updErr) {
      writeErrors.push({ id: r.id, error: updErr.message });
    }
  }

  if (writeErrors.length) {
    const cleared = await clearClassificationForSyncRun(table, syncRunId);
    const err = new Error(
      `Classification persist failed for ${writeErrors.length}/${results.length} rows; cleared sync_run_id=${syncRunId}`,
    );
    err.code = 'CLASSIFICATION_PERSIST_FAILED';
    err.writeErrors = writeErrors;
    err.clearAttempt = cleared;
    throw err;
  }

  return {
    ok: true,
    syncRunId,
    table,
    classificationVersion: CLASSIFICATION_VERSION,
    total: results.length,
    counts,
    results,
    transactionNote:
      'Supabase JS has no multi-row transaction; computed all statuses first, then wrote per-row. On any write failure the whole sync_run_id classification columns are cleared.',
  };
}

module.exports = {
  CLASSIFICATION_VERSION,
  MIN_MONTHLY_SEARCHES,
  BID_MICROS_PER_UNIT,
  STATUS,
  bidRawToUnit,
  applyAbsoluteClassificationGates,
  classifyRows,
  classifyAndPersistSyncRun,
};
