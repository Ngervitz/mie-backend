'use strict';

const logger = require('../lib/logger');
const { ASSIST_SYSTEM_PROMPT } = require('./systemPrompt');
const { createMessage: defaultCreateMessage } = require('./anthropicClient');
const {
  buildDefaultRegistry,
  anthropicToolDefinitions,
} = require('./tools/registry');
const { error: errorEnvelope } = require('./toolContract');

const MAX_MESSAGE_CHARS = 8000;
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_CONTENT_CHARS = 4000;

/**
 * Runaway circuit breaker only — not a product cost/turn limit.
 * Product caps can be passed later via options.limits.maxToolRounds
 * without changing tool implementations.
 */
const RUNAWAY_GUARD_MAX_ROUNDS = 16;

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
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
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

function logExecution({
  toolName,
  status,
  startedAt,
  finishedAt,
  retried,
  errorMessage,
}) {
  return {
    tool_name: toolName,
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    retried: Boolean(retried),
    error_message: errorMessage || null,
  };
}

/**
 * @param {{
 *   message: string,
 *   conversationHistory?: object[],
 *   registry?: object,
 *   createMessage?: Function,
 *   limits?: { maxToolRounds?: number },
 *   now?: Date,
 * }} opts
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
    const err = new Error(
      `message exceeds ${MAX_MESSAGE_CHARS} characters`,
    );
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

  const productCap =
    opts &&
    opts.limits &&
    Number.isFinite(Number(opts.limits.maxToolRounds))
      ? Number(opts.limits.maxToolRounds)
      : null;
  const maxRounds =
    productCap != null
      ? Math.min(productCap, RUNAWAY_GUARD_MAX_ROUNDS)
      : RUNAWAY_GUARD_MAX_ROUNDS;

  const messages = history.concat([{ role: 'user', content: message }]);
  const tools = anthropicToolDefinitions(registry);
  const toolExecutions = [];

  let round = 0;
  while (true) {
    round += 1;
    if (round > maxRounds) {
      logger.warn('Assist runaway guard hit', { round, maxRounds });
      return {
        reply:
          'No pude terminar el análisis: se alcanzó el tope interno de vueltas del motor. No inventé el resto.',
        stopReason: 'runaway_guard',
        toolExecutions,
        rounds: round - 1,
      };
    }

    const response = await createMessage({
      system: ASSIST_SYSTEM_PROMPT,
      messages,
      tools,
    });

    const content = response && Array.isArray(response.content)
      ? response.content
      : [];
    const stopReason = response && response.stop_reason
      ? String(response.stop_reason)
      : 'end_turn';

    if (stopReason !== 'tool_use') {
      return {
        reply: extractText(content),
        stopReason,
        toolExecutions,
        rounds: round,
        usage: response && response.usage ? response.usage : null,
      };
    }

    messages.push({ role: 'assistant', content });

    const uses = toolUseBlocks(content);
    const toolResults = [];
    for (const block of uses) {
      const startedAt = new Date().toISOString();
      let retried = false;
      const entry = registry[block.name];
      let envelope;
      try {
        if (!entry || typeof entry.execute !== 'function') {
          envelope = errorEnvelope(
            `Unknown tool: ${block.name}`,
            'events',
          );
        } else {
          envelope = await entry.execute(block.input || {}, {
            now: opts && opts.now,
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
      toolExecutions.push(
        logExecution({
          toolName: block.name,
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
        }),
      );
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify({
          ...envelope,
          retried: Boolean(retried),
        }),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

module.exports = {
  RUNAWAY_GUARD_MAX_ROUNDS,
  MAX_MESSAGE_CHARS,
  runAssistTurn,
  sanitizeHistory,
  extractText,
};
