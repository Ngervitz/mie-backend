const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { DAILY_KNOWLEDGE_KIND } = require('./daily-knowledge-kinds');

const TABLE = 'daily_knowledge';

// Persistence-only service for Hugo's canonical Daily Knowledge object.
// No business logic, no Claude, no GPT — just read/write of the daily record.

/**
 * Persist (insert or replace) one Daily Knowledge row for a date + kind.
 * UNIQUE(date, kind). Optional `kind` defaults to competitor so existing callers
 * (saveDailyKnowledge({ date, knowledge, version, generatedAt })) stay unchanged.
 */
async function saveDailyKnowledge({
  date,
  knowledge,
  version,
  generatedAt,
  kind = DAILY_KNOWLEDGE_KIND.COMPETITOR,
}) {
  const resolvedKind = kind || DAILY_KNOWLEDGE_KIND.COMPETITOR;
  const startedMs = Date.now();
  logger.info('Daily Knowledge save started', { date, version, kind: resolvedKind });

  // Cheap existence probe so we can log save vs update accurately.
  let alreadyExists = false;
  try {
    const { data: existing } = await supabase
      .from(TABLE)
      .select('date')
      .eq('date', date)
      .eq('kind', resolvedKind)
      .maybeSingle();
    alreadyExists = Boolean(existing && existing.date);
  } catch (probeErr) {
    // Non-fatal: probe is only used to pick the log message.
    alreadyExists = false;
  }

  const row = {
    date,
    kind: resolvedKind,
    knowledge,
    version,
    generated_at: generatedAt,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: 'date,kind' });

  if (error) {
    logger.error('Daily Knowledge save failed', {
      date,
      kind: resolvedKind,
      error: error.message,
    });
    return { ok: false, error };
  }

  const durationMs = Date.now() - startedMs;
  if (alreadyExists) {
    logger.info('Daily Knowledge updated', {
      date,
      version,
      kind: resolvedKind,
      durationMs,
    });
  } else {
    logger.info('Daily Knowledge saved', {
      date,
      version,
      kind: resolvedKind,
      durationMs,
    });
  }

  return { ok: true };
}

/**
 * Load the canonical Daily Knowledge JSON for a date (+ optional kind).
 * Second arg defaults to competitor so loadDailyKnowledge(date) is unchanged.
 */
async function loadDailyKnowledge(date, kind = DAILY_KNOWLEDGE_KIND.COMPETITOR) {
  const resolvedKind = kind || DAILY_KNOWLEDGE_KIND.COMPETITOR;
  const { data, error } = await supabase
    .from(TABLE)
    .select('knowledge, version, generated_at')
    .eq('date', date)
    .eq('kind', resolvedKind)
    .maybeSingle();

  if (error) {
    logger.error('Daily Knowledge load failed', {
      date,
      kind: resolvedKind,
      error: error.message,
    });
    return null;
  }

  if (!data) {
    return null;
  }

  return data.knowledge;
}

module.exports = {
  saveDailyKnowledge,
  loadDailyKnowledge,
  DAILY_KNOWLEDGE_KIND,
};
