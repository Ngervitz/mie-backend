/**
 * Weekly AI Visibility runner — deterministic detection, max 4 concurrent provider calls.
 */

const supabase = require('../../clients/supabase');
const logger = require('../../lib/logger');
const { detectMentions, detectCredizona } = require('./detector');
const { OpenAiVisibilityProvider } = require('./providers/openai');
const { AnthropicVisibilityProvider } = require('./providers/anthropic');
const { GeminiVisibilityProvider } = require('./providers/gemini');
const { PerplexityVisibilityProvider } = require('./providers/perplexity');

const TZ = 'America/Montevideo';
const MAX_CONCURRENCY = 4;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const PROVIDER_SPECS = [
  { id: 'openai', create: () => new OpenAiVisibilityProvider() },
  { id: 'anthropic', create: () => new AnthropicVisibilityProvider() },
  { id: 'gemini', create: () => new GeminiVisibilityProvider() },
  { id: 'perplexity', create: () => new PerplexityVisibilityProvider() },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Civil YYYY-MM-DD in America/Montevideo for an Instant.
 * @param {Date} [date]
 */
function formatYmdMontevideo(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}

/**
 * Weekday short name (Mon..Sun) for a civil YMD interpreted in Montevideo.
 * Uruguay is UTC-3 year-round; midday UTC maps to local morning/noon.
 * @param {string} ymd
 */
function weekdayShortForYmd(ymd) {
  const probe = new Date(`${ymd}T15:00:00.000Z`);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
  }).format(probe);
}

/**
 * @param {string} ymd
 * @param {number} deltaDays
 */
function addCalendarDays(ymd, deltaDays) {
  const m = YMD_RE.exec(ymd);
  if (!m) throw new Error(`Invalid YMD: ${ymd}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d) + deltaDays * 86_400_000;
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * @param {string} ymd
 */
function isRealCalendarDate(ymd) {
  const m = YMD_RE.exec(ymd);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

function daysBackToMonday(weekdayShort) {
  const map = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  if (map[weekdayShort] == null) {
    throw new Error(`Unexpected weekday: ${weekdayShort}`);
  }
  return map[weekdayShort];
}

/**
 * @param {string|undefined|null} weekOf
 * @returns {string} YYYY-MM-DD Monday
 */
function resolveWeekOf(weekOf) {
  if (weekOf == null || weekOf === '') {
    const today = formatYmdMontevideo(new Date());
    const back = daysBackToMonday(weekdayShortForYmd(today));
    return addCalendarDays(today, -back);
  }

  if (typeof weekOf !== 'string' || !YMD_RE.test(weekOf)) {
    throw new Error('week_of must be a YYYY-MM-DD string');
  }
  if (!isRealCalendarDate(weekOf)) {
    throw new Error('week_of is not a real calendar date');
  }
  const wd = weekdayShortForYmd(weekOf);
  if (wd !== 'Mon') {
    throw new Error('week_of must be a Monday (America/Montevideo calendar)');
  }
  return weekOf;
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const n = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  const workers = [];
  for (let w = 0; w < n; w += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * @param {object} row
 */
async function upsertResponse(row) {
  const { error } = await supabase.from('ai_visibility_responses').upsert(row, {
    onConflict: 'prompt_id,provider,model_name,week_of',
  });
  if (error) {
    throw new Error(error.message || 'Upsert failed');
  }
}

/**
 * @param {{ weekOf?: string }} [opts]
 */
async function runWeeklyVisibilityCheck({ weekOf } = {}) {
  const week_of = resolveWeekOf(weekOf);

  logger.info('AI Visibility weekly check started', {
    week_of,
    providers: PROVIDER_SPECS.length,
  });

  const {
    data: prompts,
    error: promptsError,
  } = await supabase
    .from('ai_visibility_prompts')
    .select('id, text, category')
    .eq('active', true)
    .order('id', { ascending: true });

  if (promptsError) {
    logger.error('AI Visibility prompts query failed', {
      error: promptsError.message,
    });
    throw new Error(`Failed to load prompts: ${promptsError.message}`);
  }

  const {
    data: entities,
    error: entitiesError,
  } = await supabase
    .from('monitored_entities')
    .select('id, name, aliases')
    .eq('is_self', false)
    .eq('active', true)
    .order('id', { ascending: true });

  if (entitiesError) {
    logger.error('AI Visibility entities query failed', {
      error: entitiesError.message,
    });
    throw new Error(`Failed to load entities: ${entitiesError.message}`);
  }

  const promptList = Array.isArray(prompts) ? prompts : [];
  const entityList = Array.isArray(entities) ? entities : [];

  const providers = PROVIDER_SPECS.map((spec) => ({
    id: spec.id,
    instance: spec.create(),
  }));

  /** @type {{ prompt: object, providerId: string, instance: object }[]} */
  const jobs = [];
  for (const prompt of promptList) {
    for (const provider of providers) {
      jobs.push({
        prompt,
        providerId: provider.id,
        instance: provider.instance,
      });
    }
  }

  logger.info('AI Visibility jobs queued', {
    week_of,
    prompts: promptList.length,
    providers: providers.length,
    jobs: jobs.length,
  });

  let success = 0;
  let errorCount = 0;
  let not_configured = 0;
  let attempted = 0;

  await mapPool(jobs, MAX_CONCURRENCY, async (job) => {
    attempted += 1;
    const promptId = job.prompt.id;
    const promptText = job.prompt.text;
    const providerId = job.providerId;

    let result;
    try {
      result = await job.instance.ask(promptText);
    } catch (err) {
      result = {
        status: 'error',
        rawText: null,
        error: err && err.message ? String(err.message) : 'Unexpected adapter error',
        errorCode: 'ADAPTER_THROW',
        httpStatus: null,
        modelName:
          (job.instance && job.instance.modelName) || 'unknown',
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
      };
    }

    if (!result || typeof result !== 'object') {
      result = {
        status: 'error',
        rawText: null,
        error: 'Adapter returned invalid result',
        errorCode: 'INVALID_RESULT',
        httpStatus: null,
        modelName: 'unknown',
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
      };
    }

    const status = result.status;
    let mentions_credizona = false;
    let mentioned_entities = [];

    if (status === 'success' && result.rawText) {
      mentions_credizona = detectCredizona(result.rawText);
      mentioned_entities = detectMentions(result.rawText, entityList);
    }

    const row = {
      prompt_id: promptId,
      prompt_text_snapshot: promptText,
      provider: providerId,
      model_name: result.modelName || 'unknown',
      week_of,
      status,
      raw_response: status === 'success' ? result.rawText : null,
      error:
        status === 'success'
          ? null
          : result.error || (status === 'not_configured' ? 'not configured' : 'error'),
      error_code: status === 'success' ? null : result.errorCode || null,
      http_status: result.httpStatus != null ? result.httpStatus : null,
      mentions_credizona,
      mentioned_entities,
      latency_ms: result.latencyMs != null ? result.latencyMs : null,
      input_tokens: result.inputTokens != null ? result.inputTokens : null,
      output_tokens: result.outputTokens != null ? result.outputTokens : null,
      fetched_at: new Date().toISOString(),
    };

    try {
      await upsertResponse(row);
      if (status === 'success') success += 1;
      else if (status === 'not_configured') not_configured += 1;
      else errorCount += 1;
    } catch (upsertErr) {
      errorCount += 1;
      logger.error('AI Visibility upsert failed', {
        prompt_id: promptId,
        provider: providerId,
        model_name: row.model_name,
        error_code: 'UPSERT_FAILED',
        http_status: null,
        error: upsertErr && upsertErr.message ? upsertErr.message : 'upsert failed',
      });
    }

    if (status !== 'success') {
      logger.warn('AI Visibility combination finished with non-success', {
        prompt_id: promptId,
        provider: providerId,
        model_name: row.model_name,
        error_code: row.error_code,
        http_status: row.http_status,
        error: row.error,
      });
    }
  });

  const summary = {
    week_of,
    prompts: promptList.length,
    providers: PROVIDER_SPECS.length,
    attempted,
    success,
    error: errorCount,
    not_configured,
  };

  logger.info('AI Visibility weekly check finished', summary);
  return summary;
}

module.exports = {
  runWeeklyVisibilityCheck,
  resolveWeekOf,
  formatYmdMontevideo,
};
