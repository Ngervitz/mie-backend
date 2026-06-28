const { randomUUID } = require('crypto');
const { askHugo } = require('./hugo-ask');
const logger = require('../lib/logger');

// OpenAI-compatible wrapper around the existing Hugo engine (askHugo).
// It performs no intelligence of its own: it validates an OpenAI Chat
// Completions payload, extracts question + history, calls askHugo, and maps
// the result back to the OpenAI response shape. Authentication is handled by
// the route, not here.

const MAX_HISTORY_ITEMS = 3;

// Local, dependency-free UTC date. Routes must never become a dependency of
// services, so this is intentionally duplicated here.
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Structured error carrying an OpenAI-compatible status + body.
class OpenAiError extends Error {
  constructor(status, body) {
    super((body && body.error && body.error.message) || 'OpenAI wrapper error');
    this.status = status;
    this.body = body;
  }
}

function errBody(message, type, code) {
  return { error: { message, type, code } };
}

// Build [{ question, answer }] from complete user→assistant pairs that occur
// strictly before the final user message. Incomplete pairs, system/tool/
// function roles, non-string content and empty strings are ignored.
function extractHistory(messages, lastUserIndex) {
  const pairs = [];
  let pendingUser = null;

  for (let i = 0; i < lastUserIndex; i += 1) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'user') {
      pendingUser = typeof m.content === 'string' && m.content.trim() ? m.content.trim() : null;
    } else if (m.role === 'assistant') {
      if (pendingUser && typeof m.content === 'string' && m.content.trim()) {
        pairs.push({ question: pendingUser, answer: m.content.trim() });
      }
      pendingUser = null;
    }
    // system / tool / function messages are ignored.
  }

  return pairs.slice(-MAX_HISTORY_ITEMS);
}

async function handleOpenAiChatCompletion(payload) {
  const startedMs = Date.now();
  const date = todayUtc();
  logger.info('Hugo OpenAI wrapper started', { date });

  try {
    const body = payload && typeof payload === 'object' ? payload : {};

    if (body.stream === true) {
      throw new OpenAiError(400, errBody('Streaming not supported.', 'invalid_request_error', 'streaming_not_supported'));
    }

    const messages = body.messages;
    if (!Array.isArray(messages)) {
      throw new OpenAiError(400, errBody('Messages array is required.', 'invalid_request_error', 'missing_messages'));
    }

    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i] && messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) {
      throw new OpenAiError(400, errBody('No user message found.', 'invalid_request_error', 'missing_user_message'));
    }

    const finalUser = messages[lastUserIndex];
    if (typeof finalUser.content !== 'string') {
      throw new OpenAiError(400, errBody('Last user message must contain string content.', 'invalid_request_error', 'invalid_message_content'));
    }
    const question = finalUser.content.trim();
    if (!question) {
      throw new OpenAiError(400, errBody('Last user message must contain string content.', 'invalid_request_error', 'invalid_message_content'));
    }

    const history = extractHistory(messages, lastUserIndex);

    let data;
    try {
      data = await askHugo({ date, question, history });
    } catch (err) {
      if (err && err.status === 404) {
        throw new OpenAiError(404, errBody('Daily Knowledge not found for requested date.', 'invalid_request_error', 'daily_knowledge_missing'));
      }
      throw new OpenAiError(502, errBody('Failed to generate Hugo answer.', 'server_error', 'ask_failed'));
    }

    const model = typeof body.model === 'string' && body.model.trim() ? body.model : 'hugo-ask-v1';

    const response = {
      id: `hugo-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            // Spoken output: ONLY the answer text, never metadata.
            content: data && typeof data.answer === 'string' ? data.answer : '',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    logger.info('Hugo OpenAI wrapper completed', {
      durationMs: Date.now() - startedMs,
      historyItems: history.length,
      date,
      status: 200,
    });

    return response;
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : 500;
    logger.error('Hugo OpenAI wrapper failed', {
      durationMs: Date.now() - startedMs,
      date,
      status,
    });
    throw err;
  }
}

module.exports = { handleOpenAiChatCompletion, OpenAiError };
