const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { saveDailyKnowledge } = require('./daily-knowledge');
const { DAILY_KNOWLEDGE_KIND } = require('./daily-knowledge-kinds');
const {
  HISTORY_WINDOW_DAYS,
  isValidDateOnly,
  todayUtc,
} = require('../routes/reports');
const { shiftDateUtc } = require('../activity/dates');

const OWN_ADS_BRIEF_VERSION = 1;
const MODEL_ARCHITECT = 'claude-sonnet-4-6';
const MODEL_AUDITOR = 'gpt-4o';
const GUARD_TTL_MS = 10 * 60 * 1000;

const OWN_ADS_STATES = Object.freeze([
  'collection_in_progress',
  'collection_failed',
  'no_campaigns_found',
  'has_data',
  'no_metrics_for_date',
  'no_successful_run',
]);

// date -> { acquiredAt, promise }
const activeOwnAdsRuns = new Map();

class OwnAdsBriefError extends Error {
  constructor(status, body) {
    super((body && body.error) || 'Own Ads Brief error');
    this.status = status;
    this.body = body;
  }
}

const OWN_ADS_CLAUDE_SYSTEM_PROMPT = `Sos el analista de Own Ads de Credizona Uruguay.

Analizás ÚNICAMENTE el rendimiento de la pauta propia de Credizona en Meta Ads.
No analizás competidores. No analizás el mercado. No cruzás señales externas.

Recibís un JSON de contexto (buildOwnAdsContext). Respondé EXCLUSIVAMENTE con JSON válido.
Sin markdown. Sin bloques de código. Sin texto fuera del JSON.

REGLAS ABSOLUTAS
- No inventes métricas, campañas, tendencias ni causas.
- No menciones competidores, eventos de mercado, activity_metrics, presión competitiva ni cross-analysis.
- No hables de leads, conversiones, aprobaciones, revenue, ROAS, CPL ni CPA.
- actions / actions_value NO están disponibles: no los discutás.
- Solo podés usar: spend, impressions, clicks, frequency (cuando existan en el contexto).
- Copiá context.confidence EXACTAMENTE en el campo confidence del JSON (es un valor determinístico del backend; no lo recalcules).
- Copiá context.state EXACTAMENTE en el campo state del JSON.

COMPORTAMIENTO POR ESTADO
- collection_in_progress: decí que la recolección está en curso y que aún no hay resultados. Sin métricas ni especulación.
- collection_failed: decí que hubo una falla técnica de recolección y que NO se puede determinar con certeza si hay campañas. NO digas que no hay campañas. Sin métricas ni recomendaciones basadas en datos ausentes.
- no_campaigns_found: afirmá claramente "No hay campañas activas." No inventes análisis de performance cero ni recomendaciones de optimización sobre campañas inexistentes.
- no_metrics_for_date: decí que hay datos en otras fechas de la ventana, pero no para la fecha solicitada. No fabriques valores de ese día.
- no_successful_run: decí que todavía no existe una recolección Own Ads exitosa. No inferas estado de campañas.
- has_data: analizá solo spend, impressions, clicks, frequency y tendencias demostradas dentro de la ventana de 30 días.

SCHEMA OBLIGATORIO (todas las claves, sin claves extra)
{
  "state": "collection_in_progress|collection_failed|no_campaigns_found|has_data|no_metrics_for_date|no_successful_run",
  "headline": "",
  "summary": "",
  "metrics": { "spend": null, "impressions": null, "clicks": null, "frequency": null },
  "highlights": [],
  "alerts": [],
  "recommendations": [],
  "confidence": "none|low|medium|high",
  "dataCoverage": {
    "requestedDate": "YYYY-MM-DD",
    "windowFrom": "YYYY-MM-DD",
    "windowTo": "YYYY-MM-DD",
    "daysWithData": 0,
    "successfulRuns": 0
  }
}

dataCoverage debe reflejar el contexto recibido (no inventar cobertura).
Escribí headline/summary/highlights/alerts/recommendations en español, tono ejecutivo y sobrio.`;

const OWN_ADS_GPT_SYSTEM_PROMPT = `Recibís un análisis Own Ads en JSON (contrato Claude) más el contexto Own Ads mínimo.

Tu trabajo es EXCLUSIVAMENTE auditoría y redacción. No sos un segundo analista. No creás inteligencia nueva.

REGLAS
- Nunca inventes hechos ni métricas.
- Nunca agregues leads, conversiones, revenue, ROAS, CPL, CPA.
- Nunca introduzcas competidores, mercado, eventos o cross-analysis. Si aparecen, elimínalos.
- Nunca cambies el state. En particular: NUNCA transformes collection_failed o collection_in_progress en no_campaigns_found (ni en ningún otro estado).
- Preservá confidence exactamente como viene.
- Preservá dataCoverage y metrics numéricos demostrados; no rellenes nulls con ceros inventados.
- Mejorá claridad y tono en español ejecutivo.
- Devolvé EXACTAMENTE el mismo schema JSON (mismas claves obligatorias, sin claves extra).

Respondé solo JSON válido.`;

function toIntToken(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function extractJsonObject(text) {
  let candidate = String(text).trim();
  candidate = candidate
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }
  return safeJsonParse(candidate);
}

function normalizeRunDate(date) {
  if (date !== undefined && date !== null && date !== '') {
    return String(date);
  }
  return todayUtc();
}

function getReportingDateFromRun(run) {
  if (!run || !run.raw_json || typeof run.raw_json !== 'object') return null;
  const d = run.raw_json.reportingDate;
  return d ? String(d) : null;
}

/**
 * Deterministic confidence — same principle as Activity V1 confidence_level
 * (calendar coverage based, not a model's subjective guess).
 * - none: state !== has_data
 * - low: has_data && daysWithData < 7
 * - medium: has_data && 7 <= daysWithData < 21
 * - high: has_data && daysWithData >= 21
 */
function computeOwnAdsConfidence(state, daysWithData) {
  if (state !== 'has_data') return 'none';
  const days = Number(daysWithData) || 0;
  if (days < 7) return 'low';
  if (days < 21) return 'medium';
  return 'high';
}

function isGuardStale(entry) {
  if (!entry || !entry.acquiredAt) return true;
  return Date.now() - entry.acquiredAt > GUARD_TTL_MS;
}

function tryAcquireOwnAdsGuard(date) {
  const existing = activeOwnAdsRuns.get(date);
  if (existing && !isGuardStale(existing)) {
    return { ok: false, entry: existing };
  }
  if (existing && isGuardStale(existing)) {
    activeOwnAdsRuns.delete(date);
    logger.warn('Own Ads Brief guard expired by TTL; releasing stale lock', {
      date,
      acquiredAt: existing.acquiredAt,
      ttlMs: GUARD_TTL_MS,
    });
  }
  const entry = { acquiredAt: Date.now(), promise: null };
  activeOwnAdsRuns.set(date, entry);
  return { ok: true, entry };
}

function releaseOwnAdsGuard(date) {
  activeOwnAdsRuns.delete(date);
}

async function resolveSelfEntity() {
  const { data, error } = await supabase
    .from('monitored_entities')
    .select('id, name')
    .eq('is_self', true)
    .limit(1);

  if (error) {
    throw new Error(`Failed to load self entity: ${error.message}`);
  }
  if (!data || !data.length || !data[0].id) {
    throw new Error('No monitored_entities row with is_self=true');
  }
  return { entityId: data[0].id, entityName: data[0].name };
}

async function loadRunsForEntity(entityId) {
  const { data, error } = await supabase
    .from('own_ad_metric_runs')
    .select('run_id, entity_id, status, started_at, finished_at, created_at, raw_json, source')
    .eq('entity_id', entityId)
    .order('started_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load own_ad_metric_runs: ${error.message}`);
  }
  return data || [];
}

function pickLatestAttemptForDate(runs, requestedDate) {
  const matches = (runs || []).filter(
    (r) => getReportingDateFromRun(r) === requestedDate,
  );
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const sa = String(a.started_at || '');
    const sb = String(b.started_at || '');
    if (sa !== sb) return sb.localeCompare(sa);
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  return matches[0];
}

function pickLatestSuccessfulRunForDate(runs, requestedDate) {
  const matches = (runs || []).filter(
    (r) =>
      r.status === 'success' && getReportingDateFromRun(r) === requestedDate,
  );
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const sa = String(a.started_at || '');
    const sb = String(b.started_at || '');
    if (sa !== sb) return sb.localeCompare(sa);
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  return matches[0];
}

function filterSuccessfulRunsInWindow(runs, windowFrom, windowTo) {
  return (runs || []).filter((r) => {
    if (r.status !== 'success') return false;
    const d = getReportingDateFromRun(r);
    if (!d) return false;
    return d >= windowFrom && d <= windowTo;
  });
}

async function loadOwnAdsMetrics(entityId, windowFrom, windowTo) {
  const { data, error } = await supabase
    .from('own_ad_metrics')
    .select(
      'id, entity_id, run_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, frequency, created_at',
    )
    .eq('entity_id', entityId)
    .gte('metric_date', windowFrom)
    .lte('metric_date', windowTo)
    .order('metric_date', { ascending: true });

  if (error) {
    throw new Error(`Failed to load own_ad_metrics: ${error.message}`);
  }
  return data || [];
}

function summarizeRunMeta(run) {
  if (!run) return {};
  const raw = run.raw_json && typeof run.raw_json === 'object' ? run.raw_json : {};
  return {
    runId: run.run_id || null,
    status: run.status || null,
    startedAt: run.started_at || null,
    finishedAt: run.finished_at || null,
    reportingDate: raw.reportingDate || null,
    reportingRange: raw.reportingRange || null,
    campaignsFound:
      typeof raw.campaignsFound === 'number' ? raw.campaignsFound : null,
    metricsInserted:
      typeof raw.metricsInserted === 'number' ? raw.metricsInserted : null,
    noCampaignsFound:
      typeof raw.noCampaignsFound === 'boolean' ? raw.noCampaignsFound : null,
  };
}

function aggregateRequestedDateMetrics(rows) {
  if (!rows.length) {
    return {
      spend: null,
      impressions: null,
      clicks: null,
      frequency: null,
    };
  }
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let freqSum = 0;
  let freqCount = 0;
  for (const row of rows) {
    if (row.spend != null && Number.isFinite(Number(row.spend))) {
      spend += Number(row.spend);
    }
    if (row.impressions != null && Number.isFinite(Number(row.impressions))) {
      impressions += Number(row.impressions);
    }
    if (row.clicks != null && Number.isFinite(Number(row.clicks))) {
      clicks += Number(row.clicks);
    }
    if (row.frequency != null && Number.isFinite(Number(row.frequency))) {
      freqSum += Number(row.frequency);
      freqCount += 1;
    }
  }
  return {
    spend,
    impressions,
    clicks,
    frequency: freqCount > 0 ? freqSum / freqCount : null,
  };
}

async function buildOwnAdsContext({ date: inputDate } = {}) {
  const date = inputDate ? String(inputDate) : todayUtc();
  if (!isValidDateOnly(date)) {
    throw new Error(`Invalid date: ${date}. Use YYYY-MM-DD.`);
  }

  const windowFrom = shiftDateUtc(date, -(HISTORY_WINDOW_DAYS - 1));
  const windowTo = date;
  const window = {
    from: windowFrom,
    to: windowTo,
    days: HISTORY_WINDOW_DAYS,
  };

  const { entityId, entityName } = await resolveSelfEntity();
  const runs = await loadRunsForEntity(entityId);
  const latestAttemptForDate = pickLatestAttemptForDate(runs, date);
  const latestSuccessfulRunForDate = pickLatestSuccessfulRunForDate(runs, date);
  const successfulRunsInWindow = filterSuccessfulRunsInWindow(
    runs,
    windowFrom,
    windowTo,
  );

  const empty = {
    state: 'no_successful_run',
    date,
    window,
    metrics: [],
    runMeta: {},
    coverage: {
      entityId,
      entityName,
      daysWithData: 0,
      successfulRunsInWindow: successfulRunsInWindow.length,
    },
    confidence: 'none',
  };

  // State 0 — collection_in_progress
  if (latestAttemptForDate && latestAttemptForDate.status === 'running') {
    return {
      ...empty,
      state: 'collection_in_progress',
      runMeta: summarizeRunMeta(latestAttemptForDate),
      confidence: 'none',
    };
  }

  // State 1 — collection_failed
  if (latestAttemptForDate && latestAttemptForDate.status === 'failed') {
    return {
      ...empty,
      state: 'collection_failed',
      runMeta: summarizeRunMeta(latestAttemptForDate),
      confidence: 'none',
    };
  }

  // State 2 — no_campaigns_found
  if (latestSuccessfulRunForDate) {
    const raw = latestSuccessfulRunForDate.raw_json || {};
    if (raw.noCampaignsFound === true) {
      return {
        ...empty,
        state: 'no_campaigns_found',
        runMeta: summarizeRunMeta(latestSuccessfulRunForDate),
        confidence: 'none',
      };
    }
  }

  const allMetrics = await loadOwnAdsMetrics(entityId, windowFrom, windowTo);
  const requestedMetrics = allMetrics.filter((m) => m.metric_date === date);
  const daysWithData = new Set(
    allMetrics.map((m) => m.metric_date).filter(Boolean),
  ).size;

  // State 3 — has_data
  if (requestedMetrics.length > 0) {
    const context = {
      state: 'has_data',
      date,
      window,
      metrics: allMetrics,
      requestedDateMetrics: requestedMetrics,
      aggregatedRequested: aggregateRequestedDateMetrics(requestedMetrics),
      runMeta: summarizeRunMeta(
        latestSuccessfulRunForDate || latestAttemptForDate,
      ),
      coverage: {
        entityId,
        entityName,
        daysWithData,
        successfulRunsInWindow: successfulRunsInWindow.length,
      },
      confidence: 'none',
    };
    context.confidence = computeOwnAdsConfidence(
      context.state,
      context.coverage.daysWithData,
    );
    return context;
  }

  // State 4 — no_metrics_for_date
  if (successfulRunsInWindow.length > 0) {
    return {
      ...empty,
      state: 'no_metrics_for_date',
      metrics: allMetrics,
      runMeta: summarizeRunMeta(latestSuccessfulRunForDate || latestAttemptForDate),
      coverage: {
        entityId,
        entityName,
        daysWithData,
        successfulRunsInWindow: successfulRunsInWindow.length,
      },
      confidence: 'none',
    };
  }

  // State 5 — no_successful_run
  return {
    ...empty,
    state: 'no_successful_run',
    runMeta: summarizeRunMeta(latestAttemptForDate),
    confidence: 'none',
  };
}

function buildOwnAdsClaudeUserPrompt(context) {
  return `CONTEXTO OWN ADS (JSON). Analizá solo este objeto. Devolvé el schema JSON obligatorio.

${JSON.stringify(context, null, 2)}`;
}

function buildOwnAdsGptUserPrompt(claudeAnalysis, context) {
  return `ANÁLISIS CLAUDE (JSON a auditar):
${JSON.stringify(claudeAnalysis, null, 2)}

CONTEXTO OWN ADS (verificación; sin competidores):
${JSON.stringify(
  {
    state: context.state,
    date: context.date,
    window: context.window,
    confidence: context.confidence,
    coverage: context.coverage,
    runMeta: context.runMeta,
    aggregatedRequested: context.aggregatedRequested || null,
  },
  null,
  2,
)}`;
}

function validateOwnAdsClaudeContract(analysis, expectedState, expectedConfidence) {
  if (!analysis || typeof analysis !== 'object') {
    throw new OwnAdsBriefError(502, { error: 'Invalid Own Ads Claude JSON' });
  }
  const required = [
    'state',
    'headline',
    'summary',
    'metrics',
    'highlights',
    'alerts',
    'recommendations',
    'confidence',
    'dataCoverage',
  ];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(analysis, key)) {
      throw new OwnAdsBriefError(502, {
        error: 'Own Ads Claude JSON missing key',
        detail: key,
      });
    }
  }
  if (!OWN_ADS_STATES.includes(analysis.state)) {
    throw new OwnAdsBriefError(502, {
      error: 'Own Ads Claude JSON invalid state',
      detail: analysis.state,
    });
  }
  // Enforce backend facts — never trust model drift on state/confidence.
  analysis.state = expectedState;
  analysis.confidence = expectedConfidence;
  if (!analysis.metrics || typeof analysis.metrics !== 'object') {
    analysis.metrics = {
      spend: null,
      impressions: null,
      clicks: null,
      frequency: null,
    };
  }
  if (!Array.isArray(analysis.highlights)) analysis.highlights = [];
  if (!Array.isArray(analysis.alerts)) analysis.alerts = [];
  if (!Array.isArray(analysis.recommendations)) analysis.recommendations = [];
  return analysis;
}

async function callOwnAdsClaude(context) {
  const startedMs = Date.now();
  logger.info('Own Ads Claude request started', { model: MODEL_ARCHITECT });

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_ARCHITECT,
        max_tokens: 4000,
        temperature: 0.2,
        system: OWN_ADS_CLAUDE_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildOwnAdsClaudeUserPrompt(context) },
        ],
      }),
    });
  } catch (err) {
    throw new OwnAdsBriefError(502, {
      error: 'Claude API error',
      detail: 'Network request failed',
    });
  }

  if (!response.ok) {
    throw new OwnAdsBriefError(502, {
      error: 'Claude API error',
      detail: `HTTP ${response.status}`,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new OwnAdsBriefError(502, {
      error: 'Invalid JSON from Claude',
      raw: 'Non-JSON response body',
    });
  }

  const text =
    data && data.content && data.content[0] ? data.content[0].text : undefined;
  if (typeof text !== 'string') {
    throw new OwnAdsBriefError(502, {
      error: 'Invalid JSON from Claude',
      raw: 'Missing content text',
    });
  }

  const parsed = extractJsonObject(text);
  if (!parsed.ok) {
    throw new OwnAdsBriefError(502, { error: 'Invalid JSON from Claude' });
  }

  const rawUsage = data && data.usage ? data.usage : {};
  return {
    analysis: validateOwnAdsClaudeContract(
      parsed.value,
      context.state,
      context.confidence,
    ),
    durationMs: Date.now() - startedMs,
    usage: {
      inputTokens: toIntToken(rawUsage.input_tokens),
      outputTokens: toIntToken(rawUsage.output_tokens),
      totalTokens:
        toIntToken(rawUsage.input_tokens) + toIntToken(rawUsage.output_tokens),
    },
  };
}

async function callOwnAdsGpt(claudeAnalysis, context) {
  const startedMs = Date.now();
  logger.info('Own Ads GPT request started', { model: MODEL_AUDITOR });

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_AUDITOR,
        max_tokens: 4000,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: OWN_ADS_GPT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildOwnAdsGptUserPrompt(claudeAnalysis, context),
          },
        ],
      }),
    });
  } catch (err) {
    throw new OwnAdsBriefError(502, {
      error: 'GPT API error',
      detail: 'Network request failed',
    });
  }

  if (!response.ok) {
    throw new OwnAdsBriefError(502, {
      error: 'GPT API error',
      detail: `HTTP ${response.status}`,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new OwnAdsBriefError(502, {
      error: 'Invalid JSON from GPT',
      raw: 'Non-JSON response body',
    });
  }

  const text =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message
      ? data.choices[0].message.content
      : undefined;

  if (typeof text !== 'string') {
    throw new OwnAdsBriefError(502, {
      error: 'Invalid JSON from GPT',
      raw: 'Missing content text',
    });
  }

  const parsed = extractJsonObject(text);
  if (!parsed.ok) {
    throw new OwnAdsBriefError(502, { error: 'Invalid JSON from GPT' });
  }

  const audited = validateOwnAdsClaudeContract(
    parsed.value,
    context.state,
    context.confidence,
  );

  const rawUsage = data && data.usage ? data.usage : {};
  return {
    output: audited,
    durationMs: Date.now() - startedMs,
    usage: {
      inputTokens: toIntToken(rawUsage.prompt_tokens),
      outputTokens: toIntToken(rawUsage.completion_tokens),
      totalTokens:
        toIntToken(rawUsage.prompt_tokens)
        + toIntToken(rawUsage.completion_tokens),
    },
  };
}

async function executeRunOwnAdsBrief({ date }) {
  const startedMs = Date.now();
  logger.info('Own Ads Brief run started', { date });

  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    throw new OwnAdsBriefError(500, {
      error: 'Missing required Hugo environment variables',
    });
  }

  const context = await buildOwnAdsContext({ date });
  // confidence already set inside buildOwnAdsContext for has_data;
  // ensure all states have deterministic confidence.
  context.confidence = computeOwnAdsConfidence(
    context.state,
    context.coverage && context.coverage.daysWithData,
  );

  logger.info('Own Ads context built', {
    date: context.date,
    state: context.state,
    confidence: context.confidence,
  });

  const claudeResult = await callOwnAdsClaude(context);
  const gptResult = await callOwnAdsGpt(claudeResult.analysis, context);

  const generatedAt = new Date().toISOString();
  const knowledge = {
    date: context.date,
    kind: DAILY_KNOWLEDGE_KIND.OWN_ADS,
    state: gptResult.output.state,
    brief: gptResult.output,
    context: {
      window: context.window,
      coverage: context.coverage,
      runMeta: context.runMeta,
      confidence: context.confidence,
    },
    version: OWN_ADS_BRIEF_VERSION,
    generatedAt,
    meta: {
      durationMs: Date.now() - startedMs,
      claudeDurationMs: claudeResult.durationMs,
      gptDurationMs: gptResult.durationMs,
      modelArchitect: MODEL_ARCHITECT,
      modelAuditor: MODEL_AUDITOR,
      usage: {
        claude: claudeResult.usage,
        gpt: gptResult.usage,
      },
    },
  };

  try {
    await saveDailyKnowledge({
      date: context.date,
      knowledge,
      version: OWN_ADS_BRIEF_VERSION,
      generatedAt,
      kind: DAILY_KNOWLEDGE_KIND.OWN_ADS,
    });
  } catch (persistErr) {
    logger.error('Own Ads Brief save failed', {
      date: context.date,
      error: persistErr && persistErr.message ? persistErr.message : 'unknown',
    });
  }

  logger.info('Own Ads Brief run completed', {
    date: context.date,
    state: knowledge.state,
    durationMs: knowledge.meta.durationMs,
  });

  return knowledge;
}

/**
 * Shared Own Ads Brief entrypoint (manual route + daily pipeline).
 * @param {{ date?: string, skipIfRunning?: boolean }} [options]
 * skipIfRunning: internal callers log+skip instead of HTTP 409.
 */
async function runOwnAdsBrief({ date, skipIfRunning = false } = {}) {
  const runDate = normalizeRunDate(date);
  const acquire = tryAcquireOwnAdsGuard(runDate);

  if (!acquire.ok) {
    if (skipIfRunning) {
      logger.info('Own Ads Brief skipped — already running', {
        date: runDate,
      });
      return { skipped: true, reason: 'already_running', date: runDate };
    }
    throw new OwnAdsBriefError(409, {
      error: 'Own Ads Brief already in progress',
      date: runDate,
    });
  }

  try {
    const promise = executeRunOwnAdsBrief({ date: runDate });
    acquire.entry.promise = promise;
    return await promise;
  } finally {
    releaseOwnAdsGuard(runDate);
  }
}

module.exports = {
  buildOwnAdsContext,
  runOwnAdsBrief,
  computeOwnAdsConfidence,
  buildOwnAdsClaudeUserPrompt,
  buildOwnAdsGptUserPrompt,
  OwnAdsBriefError,
  OWN_ADS_STATES,
  OWN_ADS_BRIEF_VERSION,
  DAILY_KNOWLEDGE_KIND,
};
