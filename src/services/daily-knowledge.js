const supabase = require('../clients/supabase');
const logger = require('../lib/logger');

const TABLE = 'daily_knowledge';

// Persistence-only service for Hugo's canonical Daily Knowledge object.
// No business logic, no Claude, no GPT — just read/write of the daily record.

// Persist (insert or replace) one Daily Knowledge row for a date.
// One row per date is guaranteed by a UNIQUE(date) constraint + onConflict.
async function saveDailyKnowledge({ date, knowledge, version, generatedAt }) {
  const startedMs = Date.now();
  logger.info('Daily Knowledge save started', { date, version });

  // Cheap existence probe so we can log save vs update accurately.
  let alreadyExists = false;
  try {
    const { data: existing } = await supabase
      .from(TABLE)
      .select('id')
      .eq('date', date)
      .maybeSingle();
    alreadyExists = Boolean(existing && existing.id);
  } catch (probeErr) {
    // Non-fatal: probe is only used to pick the log message.
    alreadyExists = false;
  }

  const row = {
    date,
    knowledge,
    version,
    generated_at: generatedAt,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'date' });

  if (error) {
    logger.error('Daily Knowledge save failed', { date, error: error.message });
    return { ok: false, error };
  }

  const durationMs = Date.now() - startedMs;
  if (alreadyExists) {
    logger.info('Daily Knowledge updated', { date, version, durationMs });
  } else {
    logger.info('Daily Knowledge saved', { date, version, durationMs });
  }

  return { ok: true };
}

// Load the canonical Daily Knowledge JSON for a date. Returns null when absent.
async function loadDailyKnowledge(date) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('knowledge, version, generated_at')
    .eq('date', date)
    .maybeSingle();

  if (error) {
    logger.error('Daily Knowledge load failed', { date, error: error.message });
    return null;
  }

  if (!data) {
    return null;
  }

  return data.knowledge;
}

module.exports = { saveDailyKnowledge, loadDailyKnowledge };
