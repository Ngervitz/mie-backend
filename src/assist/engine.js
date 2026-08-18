'use strict';

/**
 * PROTOCOL (do not blur):
 * - Tools requested by Claude use real Anthropic tool_use / tool_result only.
 *   Never fabricate an assistant tool_use block.
 * - Memory-forced verifications run BEFORE the first model response. They are
 *   preloaded evidence in the system prompt, not tool_result — there is no
 *   prior model tool_use to attach them to. They still count as real
 *   tool_executions and populate the exact-args cache.
 *
 * Dedupe: cache key is toolName + JSON.stringify(args) as received.
 * Known limit: does not detect semantic equivalence or key-order variants.
 */

const crypto = require('crypto');
const logger = require('../lib/logger');
const { ASSIST_SYSTEM_PROMPT } = require('./systemPrompt');
const { createMessage: defaultCreateMessage } = require('./anthropicClient');
const {
  buildDefaultRegistry,
  anthropicToolDefinitions,
} = require('./tools/registry');
const { error: errorEnvelope } = require('./toolContract');
const {
  AssistExecutionBudget,
  RUNAWAY_GUARD_MAX_CLAUDE_CALLS,
  estimateContextTokens,
} = require('./budget');
const { matchKnownEntities } = require('./entityMatch');
const {
  loadActiveCompetitorNames,
  loadMemoriesForEntities,
  historicalArgsForTool,
  entityNamesForIndex,
  saveMemoryRecord,
} = require('./memories');
const {
  loadTurnNumber,
  loadTokenTotals,
  saveTokenLog,
} = require('./tokenLogs');

const MAX_MESSAGE_CHARS = 8000;
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_CONTENT_CHARS = 4000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function extractText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

function toolUseBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use' && b.id && b.name);
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const item of history) {
    if (!item || typeof item !== 'object') continue;
    const role =
      item.role === 'assistant'
        ? 'assistant'
        : item.role === 'user'
          ? 'user'
          : null;
    if (!role) continue;
    const content =
      typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) continue;
    out.push({
      role,
      content: content.slice(0, MAX_HISTORY_CONTENT_CHARS),
    });
  }
  return out.slice(-MAX_HISTORY_ITEMS);
}

function resolveConversationId(raw) {
  const s = raw != null ? String(raw).trim() : '';
  if (UUID_RE.test(s)) return s;
  return crypto.randomUUID();
}

function cacheKey(toolName, args) {
  return String(toolName) + '\n' + JSON.stringify(args || {});
}

function logExecution({
  toolName,
  status,
  startedAt,
  finishedAt,
  retried,
  errorMessage,
  fromCache,
  forcedByMemory,
  toolArgs,
}) {
  const args =
    toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs)
      ? { ...toolArgs }
      : {};
  return {
    tool_name: toolName,
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    retried: Boolean(retried),
    error_message: errorMessage || null,
    from_cache: Boolean(fromCache),
    forced_by_memory: Boolean(forcedByMemory),
    tool_args: args,
  };
}

function buildSystemPrompt(memoryBlock, budgetEvents) {
  const parts = [ASSIST_SYSTEM_PROMPT];
  if (memoryBlock) parts.push('', memoryBlock);
  if (budgetEvents && budgetEvents.length) {
    parts.push(
      '',
      'EVENTOS DE PRESUPUESTO DE ESTE TURNO (mención obligatoria en la respuesta final, no discrecional):',
      JSON.stringify(budgetEvents),
    );
  }
  return parts.join('\n');
}

function formatMemoryBlock(items) {
  if (!items || !items.length) return '';
  return [
    'MEMORIA ANALÍTICA CROSS-SESIÓN (no es verdad presente):',
    'Las conclusiones históricas son de otros turnos. Nunca las trates como observación actual.',
    'La verificación forzada (si existe) es evidencia precargada, no un tool_result de este turno.',
    JSON.stringify(items, null, 0),
  ].join('\n');
}

/**
 * @param {object} opts
 */
async function runAssistTurn(opts) {
  const message =
    opts && typeof opts.message === 'string' ? opts.message.trim() : '';
  if (!message) {
    const err = new Error('message is required');
    err.code = 'INVALID_MESSAGE';
    err.statusCode = 400;
    throw err;
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    const err = new Error(`message exceeds ${MAX_MESSAGE_CHARS} characters`);
    err.code = 'INVALID_MESSAGE';
    err.statusCode = 400;
    throw err;
  }

  const registry =
    opts && opts.registry ? opts.registry : buildDefaultRegistry();
  const createMessage =
    opts && opts.createMessage ? opts.createMessage : defaultCreateMessage;
  const history = sanitizeHistory(
    opts && opts.conversationHistory ? opts.conversationHistory : [],
  );
  // Production uses AssistExecutionBudget. opts.budget is a test seam only.
  const budget =
    opts && opts.budget ? opts.budget : AssistExecutionBudget;
  const conversationId = resolveConversationId(
    opts && opts.conversationId,
  );
  const supabase = opts && opts.supabase ? opts.supabase : null;
  const now = opts && opts.now;

  const loadNames =
    opts && opts.loadActiveCompetitorNames
      ? opts.loadActiveCompetitorNames
      : loadActiveCompetitorNames;
  const loadMemories =
    opts && opts.loadMemoriesForEntities
      ? opts.loadMemoriesForEntities
      : loadMemoriesForEntities;
  const persistMemory =
    opts && opts.saveMemoryRecord ? opts.saveMemoryRecord : saveMemoryRecord;
  const persistTokenLog =
    opts && opts.saveTokenLog ? opts.saveTokenLog : saveTokenLog;
  const nextTurnNumber =
    opts && opts.loadTurnNumber ? opts.loadTurnNumber : loadTurnNumber;
  const tokenTotalsFn =
    opts && opts.loadTokenTotals ? opts.loadTokenTotals : loadTokenTotals;

  let turnNumber = 1;
  try {
    turnNumber = await nextTurnNumber(conversationId, supabase);
  } catch (err) {
    logger.warn('Assist turn_number unavailable', {
      error: err && err.message ? err.message : 'unknown',
    });
  }

  const tools = anthropicToolDefinitions(registry);
  const toolExecutions = [];
  const budgetEvents = [];
  /** @type {Map<string, { envelope: object, retried: boolean }>} */
  const cache = new Map();
  let toolRoundsUsed = 0;
  let toolExecutionsUsed = 0;
  let claudeCalls = 0;
  let runningInputTotal = 0;
  let runningOutputTotal = 0;
  try {
    const prev = await tokenTotalsFn(conversationId, supabase);
    runningInputTotal = prev.input || 0;
    runningOutputTotal = prev.output || 0;
  } catch (err) {
    logger.warn('Assist token totals unavailable', {
      error: err && err.message ? err.message : 'unknown',
    });
  }

  async function executeRealTool(toolName, rawArgs, { forcedByMemory }) {
    const args =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs
        : {};
    const key = cacheKey(toolName, args);
    if (cache.has(key)) {
      const hit = cache.get(key);
      return {
        envelope: hit.envelope,
        retried: hit.retried,
        fromCache: true,
      };
    }

    const startedAt = new Date().toISOString();
    let retried = false;
    const entry = registry[toolName];
    let envelope;
    try {
      if (!entry || typeof entry.execute !== 'function') {
        envelope = errorEnvelope(`Unknown tool: ${toolName}`, 'events');
      } else {
        toolExecutionsUsed += 1;
        envelope = await entry.execute(args, {
          now,
          supabase: supabase || undefined,
          onRetry: () => {
            retried = true;
          },
          forceToolError: Boolean(opts && opts.forceToolError),
        });
      }
    } catch (err) {
      envelope = errorEnvelope(
        err && err.message ? err.message : 'Tool execution failed',
        'events',
      );
    }
    const finishedAt = new Date().toISOString();
    const status =
      envelope && envelope.status ? String(envelope.status) : 'error';
    if (entry && typeof entry.execute === 'function') {
      cache.set(key, { envelope, retried });
    }
    toolExecutions.push(
      logExecution({
        toolName,
        status,
        startedAt,
        finishedAt,
        retried,
        errorMessage:
          status === 'error' || status === 'not_implemented'
            ? envelope && envelope.error_message
              ? String(envelope.error_message)
              : 'error'
            : null,
        fromCache: false,
        forcedByMemory,
        toolArgs: args,
      }),
    );
    return { envelope, retried, fromCache: false };
  }

  let knownNames = [];
  try {
    knownNames = await loadNames(supabase);
  } catch (err) {
    logger.warn('Assist competitor names unavailable', {
      error: err && err.message ? err.message : 'unknown',
    });
  }
  const matchedEntities = matchKnownEntities(message, knownNames);

  let memoryPairs = [];
  try {
    memoryPairs = await loadMemories(matchedEntities, supabase);
  } catch (err) {
    logger.warn('Assist memories unavailable', {
      error: err && err.message ? err.message : 'unknown',
    });
  }

  const memoryContextItems = [];
  const entitiesToVerify = [
    ...new Set(memoryPairs.map((p) => p.entityName).filter(Boolean)),
  ];
  const verificationByEntity = new Map();

  for (const entityName of entitiesToVerify) {
    if (toolExecutionsUsed >= budget.max_tool_executions) break;
    const toolName = 'get_competitor_activity';
    const pair = memoryPairs.find((p) => p.entityName === entityName);
    const hist = historicalArgsForTool(pair && pair.memory, toolName);
    const args = { ...hist, entity: entityName };
    const entry = registry[toolName];
    if (!entry || typeof entry.execute !== 'function') {
      verificationByEntity.set(entityName, {
        unverifiable: true,
        payload: null,
      });
      continue;
    }
    const result = await executeRealTool(toolName, args, {
      forcedByMemory: true,
    });
    verificationByEntity.set(entityName, {
      unverifiable: false,
      payload: {
        ...result.envelope,
        retried: Boolean(result.retried),
      },
    });
  }

  for (const pair of memoryPairs) {
    const toolName = 'get_competitor_activity';
    const entry = registry[toolName];
    const ver = verificationByEntity.get(pair.entityName);
    if (!entry || typeof entry.execute !== 'function') {
      memoryContextItems.push({
        entity_name: pair.entityName,
        conclusion: pair.memory.conclusion,
        evidence: pair.memory.evidence,
        created_at: pair.memory.created_at,
        verification: null,
        note: 'evidencia histórica sin verificación disponible hoy',
      });
      continue;
    }
    memoryContextItems.push({
      entity_name: pair.entityName,
      conclusion: pair.memory.conclusion,
      evidence: pair.memory.evidence,
      created_at: pair.memory.created_at,
      verification: ver && ver.payload ? ver.payload : null,
    });
  }

  const memoryBlock = formatMemoryBlock(memoryContextItems);
  const messages = history.concat([{ role: 'user', content: message }]);

  async function callClaude({ toolsEnabled }) {
    const system = buildSystemPrompt(memoryBlock, budgetEvents);
    const toolsArg = toolsEnabled ? tools : [];
    const estimate = estimateContextTokens({
      system,
      messages,
      tools: toolsArg,
    });
    if (
      estimate + budget.reserved_final_response_tokens >
      budget.max_context_tokens
    ) {
      return { blocked: true, estimate };
    }
    claudeCalls += 1;
    const response = await createMessage({
      system,
      messages,
      tools: toolsArg.length ? toolsArg : undefined,
      maxTokens: budget.reserved_final_response_tokens,
    });
    const usage = response && response.usage ? response.usage : {};
    const inputTokens =
      usage.input_tokens != null ? Number(usage.input_tokens) : null;
    const outputTokens =
      usage.output_tokens != null ? Number(usage.output_tokens) : null;
    runningInputTotal += Number(inputTokens) || 0;
    runningOutputTotal += Number(outputTokens) || 0;
    try {
      await persistTokenLog(
        {
          conversation_id: conversationId,
          turn_number: turnNumber,
          call_index: claudeCalls - 1,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          conversation_context_tokens_estimated: estimate,
          conversation_input_tokens_total: runningInputTotal,
          conversation_output_tokens_total: runningOutputTotal,
        },
        supabase,
      );
    } catch (err) {
      logger.warn('Assist token log failed', {
        error: err && err.message ? err.message : 'unknown',
      });
    }
    return { blocked: false, response, estimate };
  }

  async function finalCallWithoutTools(reasonEvent) {
    if (reasonEvent) budgetEvents.push(reasonEvent);
    const attempt = await callClaude({ toolsEnabled: false });
    if (attempt.blocked) {
      logger.warn('Assist context budget blocks even the final call', {
        estimate: attempt.estimate,
      });
      return {
        reply:
          'No pude completar el turno: el presupuesto de contexto no alcanza para una respuesta final. No inventé datos.',
        stopReason: 'context_budget_exhausted',
        toolExecutions,
        rounds: toolRoundsUsed,
        toolRoundsUsed,
        toolExecutionsUsed,
        budgetEvents,
        conversationId,
        turnNumber,
      };
    }
    const content =
      attempt.response && Array.isArray(attempt.response.content)
        ? attempt.response.content
        : [];
    return {
      reply: extractText(content),
      stopReason:
        attempt.response && attempt.response.stop_reason
          ? String(attempt.response.stop_reason)
          : 'end_turn',
      toolExecutions,
      rounds: toolRoundsUsed,
      toolRoundsUsed,
      toolExecutionsUsed,
      budgetEvents,
      conversationId,
      turnNumber,
      usage: attempt.response && attempt.response.usage,
    };
  }

  while (true) {
    if (claudeCalls >= RUNAWAY_GUARD_MAX_CLAUDE_CALLS) {
      logger.warn('Assist runaway guard hit', { claudeCalls });
      return {
        reply:
          'No pude terminar el análisis: se alcanzó el tope interno de vueltas del motor. No inventé el resto.',
        stopReason: 'runaway_guard',
        toolExecutions,
        rounds: toolRoundsUsed,
        toolRoundsUsed,
        toolExecutionsUsed,
        budgetEvents,
        conversationId,
        turnNumber,
      };
    }

    const preSystem = buildSystemPrompt(memoryBlock, budgetEvents);
    const preEstimate = estimateContextTokens({
      system: preSystem,
      messages,
      tools,
    });
    if (
      preEstimate + budget.reserved_final_response_tokens >
      budget.max_context_tokens
    ) {
      if (claudeCalls === 0) {
        return finalCallWithoutTools({
          type: 'context_budget_exhausted',
          context_tokens_used: preEstimate,
          context_token_limit: budget.max_context_tokens,
        });
      }
      return finalCallWithoutTools({
        type: 'context_budget_exhausted',
        context_tokens_used: preEstimate,
        context_token_limit: budget.max_context_tokens,
      });
    }

    const attempt = await callClaude({ toolsEnabled: true });
    if (attempt.blocked) {
      return finalCallWithoutTools({
        type: 'context_budget_exhausted',
        context_tokens_used: attempt.estimate,
        context_token_limit: budget.max_context_tokens,
      });
    }

    const content = Array.isArray(attempt.response.content)
      ? attempt.response.content
      : [];
    const stopReason =
      attempt.response && attempt.response.stop_reason
        ? String(attempt.response.stop_reason)
        : 'end_turn';

    if (stopReason !== 'tool_use') {
      const reply = extractText(content);
      await maybePersistMemory({
        reply,
        toolExecutions,
        cache,
        conversationId,
        persistMemory,
        supabase,
      });
      return {
        reply,
        stopReason,
        toolExecutions,
        rounds: toolRoundsUsed,
        toolRoundsUsed,
        toolExecutionsUsed,
        budgetEvents,
        conversationId,
        turnNumber,
        usage: attempt.response && attempt.response.usage,
      };
    }

    if (
      toolRoundsUsed >= budget.max_tool_rounds ||
      toolExecutionsUsed >= budget.max_tool_executions
    ) {
      messages.push({ role: 'assistant', content });
      const uses = toolUseBlocks(content);
      const skipped = uses.map((block) => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify({
          ...errorEnvelope('tool_budget_exhausted', 'events'),
          retried: false,
        }),
      }));
      messages.push({ role: 'user', content: skipped });
      return finalCallWithoutTools({
        type: 'tool_budget_exhausted',
        max_tool_rounds: budget.max_tool_rounds,
        max_tool_executions: budget.max_tool_executions,
        tool_rounds_used: toolRoundsUsed,
        tool_executions_used: toolExecutionsUsed,
      });
    }

    toolRoundsUsed += 1;
    messages.push({ role: 'assistant', content });
    const uses = toolUseBlocks(content);
    const toolResults = [];
    let exhaustedMidBatch = false;

    for (const block of uses) {
      const args =
        block.input && typeof block.input === 'object' ? block.input : {};
      const key = cacheKey(block.name, args);
      if (cache.has(key)) {
        const hit = cache.get(key);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            ...hit.envelope,
            retried: Boolean(hit.retried),
          }),
        });
        continue;
      }

      if (toolExecutionsUsed >= budget.max_tool_executions) {
        exhaustedMidBatch = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            ...errorEnvelope('tool_budget_exhausted', 'events'),
            retried: false,
          }),
        });
        continue;
      }

      const result = await executeRealTool(block.name, args, {
        forcedByMemory: false,
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify({
          ...result.envelope,
          retried: Boolean(result.retried),
        }),
      });
    }

    messages.push({ role: 'user', content: toolResults });

    if (exhaustedMidBatch) {
      return finalCallWithoutTools({
        type: 'tool_budget_exhausted',
        max_tool_rounds: budget.max_tool_rounds,
        max_tool_executions: budget.max_tool_executions,
        tool_rounds_used: toolRoundsUsed,
        tool_executions_used: toolExecutionsUsed,
      });
    }
  }
}

async function maybePersistMemory({
  reply,
  toolExecutions,
  cache,
  conversationId,
  persistMemory,
  supabase,
}) {
  const cacheSuccess = [];
  cache.forEach((val, key) => {
    if (val && val.envelope && val.envelope.status === 'success') {
      const toolName = key.split('\n')[0];
      let args = {};
      try {
        args = JSON.parse(key.slice(toolName.length + 1) || '{}');
      } catch {
        args = {};
      }
      cacheSuccess.push({
        tool_name: toolName,
        tool_args: args,
        tool_result_snapshot: {
          ...val.envelope,
          retried: Boolean(val.retried),
        },
        checked_at:
          val.envelope.meta && val.envelope.meta.checked_at
            ? val.envelope.meta.checked_at
            : null,
      });
    }
  });
  if (!reply || !cacheSuccess.length) return;
  const evidence = cacheSuccess;
  const envelopes = evidence.map((e) => e.tool_result_snapshot);
  const entityNames = entityNamesForIndex(reply, envelopes);
  try {
    await persistMemory(
      {
        conversationId,
        conclusion: reply,
        evidence,
        entityNames,
      },
      supabase,
    );
  } catch (err) {
    logger.warn('Assist memory persist failed', {
      error: err && err.message ? err.message : 'unknown',
    });
  }
}

module.exports = {
  MAX_MESSAGE_CHARS,
  runAssistTurn,
  sanitizeHistory,
  extractText,
  resolveConversationId,
  cacheKey,
};
