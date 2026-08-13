'use strict';

/**
 * Claude comparative analysis of a CPC sync_run (post deterministic classification).
 * Reuses AI Visibility Anthropic HTTP helpers (fetchWithTimeout, env key/model).
 * Does NOT use web_search. Does NOT modify classification_status / efficiency_score.
 */

const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  fetchWithTimeout,
  isAbortError,
  PROVIDER_TIMEOUT_MS,
} = require('../services/ai-visibility/interface');
const {
  bidRawToUnit,
  CLASSIFICATION_VERSION,
} = require('../lib/keywordOpportunityClassification');

const SOURCE_TABLES = Object.freeze([
  'keyword_cpc_estimates',
  'discovered_term_cpc_estimates',
]);

const RELATIONSHIPS = new Set([
  'same_intent',
  'related_intent',
  'possible_redundancy',
]);

const MAX_SUGGESTED_NEW_TERMS = 5;
const MAX_COMPARATIVE = 12;

const DEFAULT_MODEL = 'claude-haiku-4-5';

const TERM_COLUMN = {
  keyword_cpc_estimates: 'query_text_snapshot',
  discovered_term_cpc_estimates: 'term_snapshot',
};

function normalizeKeywordKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Same rules as collectGoogleSerpImports.normalizeSearchTerm (whitespace collapse). */
function normalizeSearchTerm(term) {
  return String(term || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function resolveAnthropicConfig() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const modelName = (
    process.env.KEYWORD_RUN_ANALYSIS_MODEL ||
    process.env.AI_VISIBILITY_ANTHROPIC_MODEL ||
    DEFAULT_MODEL
  ).trim();
  if (!apiKey) return null;
  return { apiKey, modelName };
}

/**
 * @param {string} sourceTable
 */
function assertSourceTable(sourceTable) {
  if (!SOURCE_TABLES.includes(sourceTable)) {
    const err = new Error(
      `Invalid source_table: ${sourceTable}. Allowed: ${SOURCE_TABLES.join(', ')}`,
    );
    err.code = 'INVALID_SOURCE_TABLE';
    throw err;
  }
  return sourceTable;
}

/**
 * @param {string} syncRunId
 * @param {'keyword_cpc_estimates'|'discovered_term_cpc_estimates'} sourceTable
 */
async function loadClassifiedRows(syncRunId, sourceTable) {
  assertSourceTable(sourceTable);
  const termCol = TERM_COLUMN[sourceTable];
  const { data, error } = await supabase
    .from(sourceTable)
    .select(
      [
        'id',
        termCol,
        'avg_monthly_searches',
        'competition_level',
        'low_top_of_page_bid_raw',
        'high_top_of_page_bid_raw',
        'currency_code',
        'efficiency_score',
        'classification_status',
        'classification_version',
      ].join(', '),
    )
    .eq('sync_run_id', syncRunId);

  if (error) {
    const err = new Error(`Failed to load ${sourceTable}: ${error.message}`);
    err.code = 'SYNC_RUN_LOAD_FAILED';
    throw err;
  }

  return (data || []).map((row) => {
    const term = row[termCol] != null ? String(row[termCol]) : '';
    const lowUnit = bidRawToUnit(row.low_top_of_page_bid_raw);
    const highUnit = bidRawToUnit(row.high_top_of_page_bid_raw);
    return {
      term,
      avg_monthly_searches:
        row.avg_monthly_searches != null
          ? Number(row.avg_monthly_searches)
          : null,
      competition_level:
        row.competition_level != null ? String(row.competition_level) : null,
      low_top_of_page_bid: lowUnit,
      high_top_of_page_bid: highUnit,
      currency_code:
        row.currency_code != null ? String(row.currency_code) : null,
      efficiency_score:
        row.efficiency_score != null &&
        Number.isFinite(Number(row.efficiency_score))
          ? Number(row.efficiency_score)
          : null,
      classification_status:
        row.classification_status != null
          ? String(row.classification_status)
          : null,
      classification_version:
        row.classification_version != null
          ? String(row.classification_version)
          : null,
    };
  });
}

function buildSystemPrompt() {
  return [
    'Sos un analista comparativo de keywords de búsqueda (Google Ads Keyword Planner).',
    'Recibís SOLO datos ya medidos y clasificados por un sistema determinístico.',
    '',
    'PROHIBIDO:',
    '- modificar classification_status o efficiency_score;',
    '- inventar CPC, volumen, competencia o bids;',
    '- estimar profit, ROI, break-even, conversión, CPL, ingresos o pérdidas;',
    '- afirmar que una keyword NUEVA (sin medir) es más barata, tiene menor competencia o más volumen;',
    '- presentar hipótesis semánticas como datos observados.',
    '',
    'PERMITIDO:',
    '- comparar keywords MEDIDAS usando volumen, competencia, bids, efficiency_score y classification_status;',
    '- identificar intención igual/relacionada o posible redundancia;',
    '- preferir entre dos términos MEDIDOS cuando los datos lo justifiquen;',
    '- proponer hasta 5 variantes semánticas para MEDIR después (hipótesis, no hechos).',
    '',
    'Respondé ÚNICAMENTE con un JSON válido (sin markdown) con este shape:',
    '{',
    '  "summary_text": "2-3 líneas ejecutivas sobre oportunidades relativas de ESTA corrida",',
    '  "comparative_analysis": [',
    '    {',
    '      "term_a": "...",',
    '      "term_b": "...",',
    '      "relationship": "same_intent|related_intent|possible_redundancy",',
    '      "preferred_measured_term": "..." | null,',
    '      "reason": "..."',
    '    }',
    '  ],',
    '  "suggested_new_terms": [',
    '    { "term": "...", "reason": "...", "related_to_terms": ["..."] }',
    '  ]',
    '}',
    '',
    'comparative_analysis y suggested_new_terms pueden ser [].',
    'No inventes parejas ni sugieras 5 términos si no hay hipótesis sólidas.',
    'term_a, term_b y related_to_terms deben ser términos del input medido (texto exacto).',
    'preferred_measured_term solo puede ser term_a, term_b o null.',
  ].join('\n');
}

function buildUserPayload(rows) {
  return JSON.stringify(
    {
      instruction:
        'Analizá estas keywords medidas. classification_status y efficiency_score son INPUTS fijos.',
      keywords: rows,
    },
    null,
    0,
  );
}

/**
 * @param {string} rawText
 */
function extractJsonObject(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    const err = new Error('Empty Claude response');
    err.code = 'LLM_EMPTY_RESPONSE';
    throw err;
  }
  let candidate = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidate = fence[1].trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) candidate = candidate.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    const err = new Error('Claude response is not valid JSON');
    err.code = 'LLM_INVALID_JSON';
    err.cause = e;
    throw err;
  }
}

/**
 * @param {unknown} parsed
 * @param {Set<string>} measuredTermsExact
 */
function validateAnalysisOutput(parsed, measuredTermsExact) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('Analysis root must be an object');
    err.code = 'LLM_VALIDATION_FAILED';
    throw err;
  }
  const summary =
    typeof parsed.summary_text === 'string' ? parsed.summary_text.trim() : '';
  if (!summary) {
    const err = new Error('summary_text is required');
    err.code = 'LLM_VALIDATION_FAILED';
    throw err;
  }

  const comparativeRaw = Array.isArray(parsed.comparative_analysis)
    ? parsed.comparative_analysis
    : null;
  if (!comparativeRaw) {
    const err = new Error('comparative_analysis must be an array');
    err.code = 'LLM_VALIDATION_FAILED';
    throw err;
  }
  if (comparativeRaw.length > MAX_COMPARATIVE) {
    const err = new Error(
      `comparative_analysis exceeds max ${MAX_COMPARATIVE}`,
    );
    err.code = 'LLM_VALIDATION_FAILED';
    throw err;
  }

  const comparative_analysis = [];
  for (const item of comparativeRaw) {
    if (!item || typeof item !== 'object') {
      const err = new Error('Invalid comparative_analysis item');
      err.code = 'LLM_VALIDATION_FAILED';
      throw err;
    }
    const term_a = typeof item.term_a === 'string' ? item.term_a.trim() : '';
    const term_b = typeof item.term_b === 'string' ? item.term_b.trim() : '';
    const relationship =
      typeof item.relationship === 'string' ? item.relationship.trim() : '';
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    if (!term_a || !term_b || !reason) {
      const err = new Error('comparative_analysis fields incomplete');
      err.code = 'LLM_VALIDATION_FAILED';
      throw err;
    }
    if (!measuredTermsExact.has(term_a) || !measuredTermsExact.has(term_b)) {
      const err = new Error(
        `comparative_analysis terms must exist in measured set: ${term_a} / ${term_b}`,
      );
      err.code = 'LLM_VALIDATION_FAILED';
      throw err;
    }
    if (!RELATIONSHIPS.has(relationship)) {
      const err = new Error(`Invalid relationship: ${relationship}`);
      err.code = 'LLM_VALIDATION_FAILED';
      throw err;
    }
    let preferred = item.preferred_measured_term;
    if (preferred === undefined) preferred = null;
    if (preferred !== null) {
      if (typeof preferred !== 'string' || !preferred.trim()) {
        const err = new Error('preferred_measured_term invalid');
        err.code = 'LLM_VALIDATION_FAILED';
        throw err;
      }
      preferred = preferred.trim();
      if (preferred !== term_a && preferred !== term_b) {
        const err = new Error(
          'preferred_measured_term must be term_a, term_b, or null',
        );
        err.code = 'LLM_VALIDATION_FAILED';
        throw err;
      }
    }
    comparative_analysis.push({
      term_a,
      term_b,
      relationship,
      preferred_measured_term: preferred,
      reason,
    });
  }

  const suggestedRaw = Array.isArray(parsed.suggested_new_terms)
    ? parsed.suggested_new_terms
    : null;
  if (!suggestedRaw) {
    const err = new Error('suggested_new_terms must be an array');
    err.code = 'LLM_VALIDATION_FAILED';
    throw err;
  }
  if (suggestedRaw.length > MAX_SUGGESTED_NEW_TERMS) {
    const err = new Error(
      `suggested_new_terms exceeds max ${MAX_SUGGESTED_NEW_TERMS}`,
    );
    err.code = 'LLM_VALIDATION_FAILED';
    throw err;
  }

  const suggested_new_terms = [];
  for (const item of suggestedRaw) {
    if (!item || typeof item !== 'object') {
      const err = new Error('Invalid suggested_new_terms item');
      err.code = 'LLM_VALIDATION_FAILED';
      throw err;
    }
    const term = typeof item.term === 'string' ? item.term.trim() : '';
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    if (!term || !reason) {
      const err = new Error('suggested_new_terms requires term + reason');
      err.code = 'LLM_VALIDATION_FAILED';
      throw err;
    }
    const relatedRaw = Array.isArray(item.related_to_terms)
      ? item.related_to_terms
      : [];
    const related_to_terms = [];
    for (const r of relatedRaw) {
      if (typeof r !== 'string' || !r.trim()) {
        const err = new Error('related_to_terms must be non-empty strings');
        err.code = 'LLM_VALIDATION_FAILED';
        throw err;
      }
      const rt = r.trim();
      if (!measuredTermsExact.has(rt)) {
        const err = new Error(
          `related_to_terms must reference measured terms: ${rt}`,
        );
        err.code = 'LLM_VALIDATION_FAILED';
        throw err;
      }
      related_to_terms.push(rt);
    }
    suggested_new_terms.push({ term, reason, related_to_terms });
  }

  return { summary_text: summary, comparative_analysis, suggested_new_terms };
}

/**
 * Load existing catalog keys for dedupe (normalizeKeywordKey + normalizeSearchTerm).
 */
async function loadExistingTermKeys() {
  const keys = new Set();

  const add = (raw) => {
    const t = raw != null ? String(raw).trim() : '';
    if (!t) return;
    const k1 = normalizeKeywordKey(t);
    const k2 = normalizeSearchTerm(t);
    if (k1) keys.add(k1);
    if (k2) keys.add(k2);
  };

  const { data: serp, error: serpErr } = await supabase
    .from('serp_monitored_queries')
    .select('query_text, query_text_normalized');
  if (serpErr) throw new Error(`serp_monitored_queries: ${serpErr.message}`);
  (serp || []).forEach((r) => {
    add(r.query_text);
    add(r.query_text_normalized);
  });

  const { data: confirmed, error: confErr } = await supabase
    .from('confirmed_search_terms')
    .select('term');
  if (confErr) throw new Error(`confirmed_search_terms: ${confErr.message}`);
  (confirmed || []).forEach((r) => add(r.term));

  const { data: discoveries, error: discErr } = await supabase
    .from('search_term_discoveries')
    .select('term')
    .limit(5000);
  if (discErr) throw new Error(`search_term_discoveries: ${discErr.message}`);
  (discoveries || []).forEach((r) => add(r.term));

  return keys;
}

/**
 * @param {Array<{term:string,reason:string,related_to_terms:string[]}>} suggestions
 * @param {Set<string>} existingKeys
 * @param {Set<string>} measuredKeys
 */
function dedupeSuggestedTerms(suggestions, existingKeys, measuredKeys) {
  let llm_suggestions_received = suggestions.length;
  let llm_suggestions_deduplicated_existing = 0;
  let llm_suggestions_deduplicated_internal = 0;
  const seen = new Set();
  const kept = [];

  for (const s of suggestions) {
    const key = normalizeKeywordKey(s.term);
    const keySerp = normalizeSearchTerm(s.term);
    if (!key) {
      llm_suggestions_deduplicated_internal += 1;
      continue;
    }
    if (measuredKeys.has(key) || measuredKeys.has(keySerp)) {
      llm_suggestions_deduplicated_existing += 1;
      logger.info('keyword run analysis suggestion dropped (already measured)', {
        term: s.term,
      });
      continue;
    }
    if (existingKeys.has(key) || existingKeys.has(keySerp)) {
      llm_suggestions_deduplicated_existing += 1;
      logger.info('keyword run analysis suggestion dropped (exists in catalog)', {
        term: s.term,
      });
      continue;
    }
    if (seen.has(key)) {
      llm_suggestions_deduplicated_internal += 1;
      logger.info('keyword run analysis suggestion dropped (internal dup)', {
        term: s.term,
      });
      continue;
    }
    seen.add(key);
    kept.push(s);
  }

  return {
    kept,
    metrics: {
      llm_suggestions_received,
      llm_suggestions_deduplicated_existing,
      llm_suggestions_deduplicated_internal,
      llm_suggestions_persisted: kept.length,
    },
  };
}

/**
 * Call Anthropic Messages API (same transport as AI Visibility; no tools).
 * @param {{apiKey:string, modelName:string}} config
 * @param {string} userContent
 */
async function callClaudeJson(config, userContent) {
  const started = Date.now();
  let response;
  try {
    response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.modelName,
          max_tokens: 4096,
          temperature: 0.2,
          system: buildSystemPrompt(),
          messages: [{ role: 'user', content: userContent }],
        }),
      },
      PROVIDER_TIMEOUT_MS,
    );
  } catch (err) {
    if (isAbortError(err)) {
      const e = new Error(
        `Anthropic request timed out after ${PROVIDER_TIMEOUT_MS}ms`,
      );
      e.code = 'TIMEOUT';
      throw e;
    }
    const e = new Error(err && err.message ? err.message : 'network error');
    e.code = 'NETWORK_ERROR';
    throw e;
  }

  const latencyMs = Date.now() - started;
  const rawBody = await response.text();
  let data = null;
  try {
    data = JSON.parse(rawBody);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const apiType =
      data && data.error && data.error.type ? String(data.error.type) : null;
    const msg =
      data && data.error && data.error.message
        ? String(data.error.message)
        : `HTTP ${response.status}`;
    const e = new Error(msg);
    e.code = apiType || `HTTP_${response.status}`;
    e.httpStatus = response.status;
    throw e;
  }

  const content = data && Array.isArray(data.content) ? data.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  const rawText = parts.join('\n').trim();
  if (!rawText) {
    const e = new Error('Empty Claude text blocks');
    e.code = 'EMPTY_RESPONSE';
    throw e;
  }

  return {
    rawText,
    modelName: config.modelName,
    latencyMs,
    inputTokens:
      data && data.usage && data.usage.input_tokens != null
        ? Number(data.usage.input_tokens)
        : null,
    outputTokens:
      data && data.usage && data.usage.output_tokens != null
        ? Number(data.usage.output_tokens)
        : null,
  };
}

/**
 * @param {{ syncRunId: string, sourceTable: string }} args
 */
async function generateKeywordRunAnalysis({ syncRunId, sourceTable }) {
  const table = assertSourceTable(sourceTable);
  if (!syncRunId) {
    const err = new Error('syncRunId is required');
    err.code = 'MISSING_SYNC_RUN_ID';
    throw err;
  }

  const config = resolveAnthropicConfig();
  if (!config) {
    const err = new Error('ANTHROPIC_API_KEY not configured');
    err.code = 'PROVIDER_NOT_CONFIGURED';
    throw err;
  }

  const rows = await loadClassifiedRows(syncRunId, table);
  const rowCountTotal = rows.length;
  const rowCountSent = rows.length;

  if (!rowCountTotal) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_rows',
      syncRunId,
      sourceTable: table,
      rowCountTotal: 0,
      rowCountSent: 0,
    };
  }

  const measuredExact = new Set(rows.map((r) => r.term).filter(Boolean));
  const measuredKeys = new Set();
  measuredExact.forEach((t) => {
    measuredKeys.add(normalizeKeywordKey(t));
    measuredKeys.add(normalizeSearchTerm(t));
  });

  const classificationVersion =
    rows.find((r) => r.classification_version)?.classification_version ||
    CLASSIFICATION_VERSION;

  let llm;
  try {
    llm = await callClaudeJson(config, buildUserPayload(rows));
  } catch (err) {
    logger.error('keyword run analysis Claude call failed', {
      syncRunId,
      sourceTable: table,
      error: err && err.message ? err.message : 'unknown',
      code: err && err.code ? err.code : null,
    });
    throw err;
  }

  let validated;
  try {
    const parsed = extractJsonObject(llm.rawText);
    validated = validateAnalysisOutput(parsed, measuredExact);
  } catch (err) {
    logger.error('keyword run analysis validation failed', {
      syncRunId,
      sourceTable: table,
      error: err && err.message ? err.message : 'unknown',
      code: err && err.code ? err.code : 'LLM_VALIDATION_FAILED',
      rawPreview: String(llm.rawText || '').slice(0, 500),
    });
    throw err;
  }

  const existingKeys = await loadExistingTermKeys();
  const { kept, metrics } = dedupeSuggestedTerms(
    validated.suggested_new_terms,
    existingKeys,
    measuredKeys,
  );

  logger.info('keyword run analysis suggestion metrics', {
    syncRunId,
    sourceTable: table,
    ...metrics,
  });

  const { data: upserted, error: upsertErr } = await supabase
    .from('sync_run_summaries')
    .upsert(
      {
        sync_run_id: syncRunId,
        source_table: table,
        summary_text: validated.summary_text,
        structured_analysis: validated.comparative_analysis,
        suggested_new_terms: kept,
        classification_version: classificationVersion,
        model_used: llm.modelName,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'sync_run_id,source_table' },
    )
    .select('id, sync_run_id, source_table, generated_at')
    .single();

  if (upsertErr) {
    const err = new Error(`Failed to upsert sync_run_summaries: ${upsertErr.message}`);
    err.code = 'SUMMARY_UPSERT_FAILED';
    throw err;
  }

  return {
    ok: true,
    syncRunId,
    sourceTable: table,
    summaryId: upserted && upserted.id ? upserted.id : null,
    summaryText: validated.summary_text,
    comparativeAnalysis: validated.comparative_analysis,
    suggestedNewTerms: kept,
    classificationVersion,
    modelUsed: llm.modelName,
    rowCountTotal,
    rowCountSent,
    suggestionMetrics: metrics,
    latencyMs: llm.latencyMs,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
  };
}

module.exports = {
  SOURCE_TABLES,
  generateKeywordRunAnalysis,
  loadClassifiedRows,
  validateAnalysisOutput,
  dedupeSuggestedTerms,
  extractJsonObject,
  assertSourceTable,
};
