/**
 * AI Visibility routes — weekly provider prompts + deterministic mention detection.
 * Isolated module: registered from server.js (same pattern as /email).
 * No auth on POST /run (same criterion as POST /email/process-queue).
 */

const express = require('express');
const logger = require('../lib/logger');
const supabase = require('../clients/supabase');
const {
  runWeeklyVisibilityCheck,
  runSinglePromptCheck,
  runAdHocCheck,
} = require('../services/ai-visibility/runner');

const router = express.Router();

const ALLOWED_CATEGORIES = [
  'descubrimiento',
  'elegibilidad',
  'comparacion',
  'marca',
];

/**
 * @param {{ text: unknown, category: unknown }} opts
 */
async function createPromptRow({ text, category }) {
  const promptText = typeof text === 'string' ? text.trim() : '';
  if (!promptText) {
    const err = new Error('text must be a non-empty string');
    err.statusCode = 400;
    throw err;
  }
  if (!ALLOWED_CATEGORIES.includes(category)) {
    const err = new Error(
      'category must be one of: ' + ALLOWED_CATEGORIES.join(', '),
    );
    err.statusCode = 400;
    throw err;
  }

  const { data, error } = await supabase
    .from('ai_visibility_prompts')
    .insert({ text: promptText, category, active: true })
    .select('id, text, category, active, created_at, updated_at')
    .single();

  if (error) {
    const err = new Error(error.message || 'Failed to create prompt');
    err.statusCode = 500;
    throw err;
  }
  return data;
}

/**
 * Strict positive integer id from path/query (digits only).
 * @param {unknown} raw
 * @returns {number|null}
 */
function parsePositiveIntId(raw) {
  if (raw == null) return null;
  const s = String(raw);
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function formatWeekOf(value) {
  if (value == null) return null;
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/**
 * Keep newest row per (week_of, provider): max fetched_at, then max id.
 * @param {object[]} rows
 * @returns {Map<string, Map<string, object>>}
 */
function dedupeRowsByWeekProvider(rows) {
  /** @type {Map<string, Map<string, object>>} */
  const byWeek = new Map();
  for (const row of rows || []) {
    const week = formatWeekOf(row && row.week_of);
    const provider = row && row.provider != null ? String(row.provider) : '';
    if (!week || !provider) continue;
    if (!byWeek.has(week)) byWeek.set(week, new Map());
    const byProv = byWeek.get(week);
    const prev = byProv.get(provider);
    if (!prev) {
      byProv.set(provider, row);
      continue;
    }
    const tNew = new Date(row.fetched_at).getTime();
    const tOld = new Date(prev.fetched_at).getTime();
    const idNew = Number(row.id) || 0;
    const idOld = Number(prev.id) || 0;
    if (
      tNew > tOld ||
      (tNew === tOld && idNew > idOld) ||
      (Number.isNaN(tOld) && !Number.isNaN(tNew))
    ) {
      byProv.set(provider, row);
    }
  }
  return byWeek;
}

/**
 * First occurrence of each entity_id (or name fallback) in array order.
 * @param {unknown} mentioned
 * @returns {{ entity_id: string, name: string, key: string }[]}
 */
function dedupeMentionsInRow(mentioned) {
  if (!Array.isArray(mentioned)) return [];
  const seen = new Set();
  const out = [];
  for (const item of mentioned) {
    if (!item || typeof item !== 'object') continue;
    const rawId =
      item.entity_id != null ? String(item.entity_id).trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    let key;
    let entityId;
    if (rawId) {
      key = rawId;
      entityId = rawId;
    } else if (name) {
      const normalized = name.toLowerCase().replace(/\s+/g, ' ').trim();
      key = 'name:' + normalized;
      entityId = key;
      logger.warn('AI Visibility history mention missing entity_id', {
        name,
      });
    } else {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entity_id: entityId, name: name || entityId, key });
  }
  return out;
}

/**
 * @param {{ id: number|string, text: string }} prompt
 * @param {object[]} rows
 */
function buildHistoryPayload(prompt, rows) {
  const byWeek = dedupeRowsByWeekProvider(rows);
  const weeks = Array.from(byWeek.keys()).sort();

  if (!weeks.length) {
    return {
      prompt: { id: prompt.id, text: prompt.text },
      weeks: [],
      coverage: [],
      entities: [],
      credizona: { series: [] },
    };
  }

  /** @type {Map<string, { entity_id: string, name: string, total: number, byWeek: Map<string, number[]> }>} */
  const entityMap = new Map();
  /** @type {Map<string, number>} */
  const credizonaByWeek = new Map();
  const coverage = [];

  for (const week of weeks) {
    const providers = byWeek.get(week);
    coverage.push({
      week_of: week,
      successful_providers: providers.size,
    });
    let credCount = 0;

    for (const row of providers.values()) {
      if (row.mentions_credizona === true) credCount += 1;
      const mentions = dedupeMentionsInRow(row.mentioned_entities);
      mentions.forEach((mention, index) => {
        const rank = index + 1;
        if (!entityMap.has(mention.key)) {
          entityMap.set(mention.key, {
            entity_id: mention.entity_id,
            name: mention.name,
            total: 0,
            byWeek: new Map(),
          });
        }
        const ent = entityMap.get(mention.key);
        if (
          mention.name &&
          (!ent.name || String(ent.entity_id).startsWith('name:'))
        ) {
          ent.name = mention.name;
        }
        if (!ent.byWeek.has(week)) ent.byWeek.set(week, []);
        ent.byWeek.get(week).push(rank);
        ent.total += 1;
      });
    }
    credizonaByWeek.set(week, credCount);
  }

  const entities = Array.from(entityMap.values())
    .map((ent) => {
      const series = weeks.map((week) => {
        const ranks = ent.byWeek.get(week);
        if (!ranks || !ranks.length) {
          return { week_of: week, mention_count: 0, avg_rank: null };
        }
        const sum = ranks.reduce((a, b) => a + b, 0);
        const avg = Math.round((sum / ranks.length) * 100) / 100;
        return {
          week_of: week,
          mention_count: ranks.length,
          avg_rank: avg,
        };
      });
      const totalMentions = series.reduce((s, p) => s + p.mention_count, 0);
      return {
        entity_id: String(ent.entity_id),
        name: ent.name,
        series,
        _sortTotal: totalMentions,
      };
    })
    .sort((a, b) => {
      if (b._sortTotal !== a._sortTotal) return b._sortTotal - a._sortTotal;
      return String(a.name).localeCompare(String(b.name), 'es');
    })
    .map((ent) => ({
      entity_id: ent.entity_id,
      name: ent.name,
      series: ent.series,
    }));

  return {
    prompt: { id: prompt.id, text: prompt.text },
    weeks,
    coverage,
    entities,
    credizona: {
      series: weeks.map((week) => ({
        week_of: week,
        mention_count: credizonaByWeek.get(week) || 0,
      })),
    },
  };
}

/**
 * GET /ai-visibility/prompts
 * Active prompts for the dashboard list.
 */
router.get('/prompts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ai_visibility_prompts')
      .select('id, text, category')
      .eq('active', true)
      .order('id', { ascending: true });

    if (error) {
      logger.error('GET /ai-visibility/prompts failed', {
        error: error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ prompts: data || [] });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /ai-visibility/prompts unexpected', { error: message });
    return res.status(500).json({ error: message });
  }
});

/**
 * POST /ai-visibility/prompts
 * Body: { text, category }
 */
router.post('/prompts', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const prompt = await createPromptRow({
      text: body.text,
      category: body.category,
    });
    return res.status(201).json({ prompt });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    const status = err && err.statusCode ? err.statusCode : 500;
    logger.error('POST /ai-visibility/prompts failed', { error: message });
    return res.status(status).json({ error: message });
  }
});

/**
 * GET /ai-visibility/prompts/:promptId/history
 * Weekly mention evolution for one prompt (success rows only, deduped).
 */
router.get('/prompts/:promptId/history', async (req, res) => {
  const promptId = parsePositiveIntId(req.params.promptId);
  if (promptId == null) {
    return res
      .status(400)
      .json({ error: 'promptId must be a positive integer' });
  }

  try {
    const { data: prompt, error: promptError } = await supabase
      .from('ai_visibility_prompts')
      .select('id, text')
      .eq('id', promptId)
      .maybeSingle();

    if (promptError) {
      logger.error('GET /ai-visibility/prompts/:promptId/history prompt failed', {
        promptId,
        error: promptError.message,
      });
      return res.status(500).json({ error: promptError.message });
    }

    if (!prompt) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    const { data: rows, error: rowsError } = await supabase
      .from('ai_visibility_responses')
      .select(
        [
          'id',
          'provider',
          'model_name',
          'week_of',
          'status',
          'mentioned_entities',
          'mentions_credizona',
          'fetched_at',
        ].join(','),
      )
      .eq('prompt_id', promptId)
      .eq('status', 'success')
      .order('week_of', { ascending: true })
      .order('fetched_at', { ascending: false });

    if (rowsError) {
      logger.error('GET /ai-visibility/prompts/:promptId/history rows failed', {
        promptId,
        error: rowsError.message,
      });
      return res.status(500).json({ error: rowsError.message });
    }

    const payload = buildHistoryPayload(prompt, rows || []);
    return res.status(200).json(payload);
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /ai-visibility/prompts/:promptId/history unexpected', {
      promptId,
      error: message,
    });
    return res.status(500).json({ error: message });
  }
});

/**
 * GET /ai-visibility/responses
 * Latest week_of present in ai_visibility_responses + all rows for that week.
 */
router.get('/responses', async (req, res) => {
  try {
    const { data: weekRows, error: weekErr } = await supabase
      .from('ai_visibility_responses')
      .select('week_of')
      .order('week_of', { ascending: false })
      .limit(1);

    if (weekErr) {
      logger.error('GET /ai-visibility/responses week query failed', {
        error: weekErr.message,
      });
      return res.status(500).json({ error: weekErr.message });
    }

    if (
      !Array.isArray(weekRows) ||
      weekRows.length === 0 ||
      !weekRows[0].week_of
    ) {
      return res.status(200).json({ week_of: null, responses: [] });
    }

    const latestWeek = weekRows[0].week_of;

    const { data: responses, error: listErr } = await supabase
      .from('ai_visibility_responses')
      .select(
        [
          'prompt_id',
          'prompt_text_snapshot',
          'provider',
          'model_name',
          'week_of',
          'status',
          'raw_response',
          'error',
          'error_code',
          'mentions_credizona',
          'mentioned_entities',
          'fetched_at',
        ].join(','),
      )
      .eq('week_of', latestWeek)
      .order('prompt_id', { ascending: true })
      .order('provider', { ascending: true })
      .order('model_name', { ascending: true });

    if (listErr) {
      logger.error('GET /ai-visibility/responses list failed', {
        error: listErr.message,
      });
      return res.status(500).json({ error: listErr.message });
    }

    return res.status(200).json({
      week_of: latestWeek,
      responses: responses || [],
    });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    logger.error('GET /ai-visibility/responses unexpected', { error: message });
    return res.status(500).json({ error: message });
  }
});

/**
 * POST /ai-visibility/run-adhoc
 * Body: { text, save?: boolean, category? }
 * Must be registered before /run/:promptId so "adhoc" is not parsed as an id.
 */
router.post('/run-adhoc', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }

    const save = body.save === true;

    if (save) {
      if (!body.category) {
        return res
          .status(400)
          .json({ error: 'category is required when save is true' });
      }
      const prompt = await createPromptRow({
        text,
        category: body.category,
      });
      const result = await runSinglePromptCheck({ promptId: prompt.id });
      return res.status(200).json({ saved: true, prompt, result });
    }

    const results = await runAdHocCheck({ text });
    return res.status(200).json({ saved: false, results });
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    const status = err && err.statusCode ? err.statusCode : 500;
    const isValidation =
      /week_of|YYYY-MM-DD|Monday|calendar date|promptId must be|text must be|category must be/i.test(
        message,
      );
    logger.error('POST /ai-visibility/run-adhoc failed', { error: message });
    return res.status(isValidation ? 400 : status).json({ error: message });
  }
});

/**
 * POST /ai-visibility/run/:promptId
 * Run all providers for a single active prompt (current Monday week).
 * Registered before POST /run so path params are unambiguous.
 */
router.post('/run/:promptId', async (req, res) => {
  const rawId = req.params.promptId;
  const promptId = Number(rawId);

  if (!Number.isInteger(promptId) || promptId <= 0) {
    return res.status(400).json({ error: 'promptId must be a positive integer' });
  }

  try {
    const summary = await runSinglePromptCheck({ promptId });
    return res.status(200).json(summary);
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    if (err && err.code === 'PROMPT_NOT_FOUND') {
      logger.warn('POST /ai-visibility/run/:promptId not found', {
        promptId,
        error: message,
      });
      return res.status(404).json({ error: message });
    }

    const isValidation =
      /week_of|YYYY-MM-DD|Monday|calendar date|promptId must be/i.test(
        message,
      );

    logger.error('POST /ai-visibility/run/:promptId failed', {
      promptId,
      error: message,
    });

    return res.status(isValidation ? 400 : 500).json({ error: message });
  }
});

/**
 * POST /ai-visibility/run
 * Body optional: { "week_of": "YYYY-MM-DD" } (must be a Monday if provided)
 */
router.post('/run', async (req, res) => {
  const body = req.body;

  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }

  const payload = body && typeof body === 'object' ? body : {};
  const keys = Object.keys(payload);
  for (const key of keys) {
    if (key !== 'week_of') {
      return res.status(400).json({
        error: 'Only optional field "week_of" is accepted',
      });
    }
  }

  const weekOf =
    payload.week_of === undefined ? undefined : payload.week_of;

  if (weekOf !== undefined && typeof weekOf !== 'string') {
    return res.status(400).json({ error: 'week_of must be a string when provided' });
  }

  try {
    const summary = await runWeeklyVisibilityCheck(
      weekOf === undefined ? {} : { weekOf },
    );
    return res.status(200).json(summary);
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    const isValidation =
      /week_of|YYYY-MM-DD|Monday|calendar date/i.test(message);

    logger.error('POST /ai-visibility/run failed', {
      error: message,
    });

    return res.status(isValidation ? 400 : 500).json({ error: message });
  }
});

module.exports = router;
