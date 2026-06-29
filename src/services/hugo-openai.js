const { randomUUID } = require('crypto');
const { askHugo } = require('./hugo-ask');
const logger = require('../lib/logger');

// OpenAI-compatible wrapper around the existing Hugo engine (askHugo).
// It performs no intelligence of its own: it validates an OpenAI Chat
// Completions payload, extracts question + history, calls askHugo, and maps
// the result back to the OpenAI response shape (non-stream JSON or SSE stream).
// Authentication is handled by the route, not here.

const MAX_HISTORY_ITEMS = 3;
const STREAM_WORDS_PER_CHUNK = 20;

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

// Validate the payload, extract question + history, and call askHugo.
// Returns { date, model, answer, historyItems }. Throws OpenAiError.
// The `stream` flag is intentionally NOT handled here — the caller decides
// how to deliver the answer (JSON vs SSE).
async function resolveCompletion(payload) {
  const date = todayUtc();
  const body = payload && typeof payload === 'object' ? payload : {};

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
  const answer = data && typeof data.answer === 'string' ? data.answer : '';

  return { date, model, answer, historyItems: history.length };
}

// Split text into ~N-word chunks. Spacing is preserved across chunks so that
// concatenating the streamed deltas reconstructs the original answer.
function chunkAnswer(text, wordsPerChunk) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const piece = words.slice(i, i + wordsPerChunk).join(' ');
    chunks.push(i === 0 ? piece : ' ' + piece);
  }
  return chunks;
}

// Non-streaming: returns a full OpenAI chat.completion object.
async function handleOpenAiChatCompletion(payload) {
  const startedMs = Date.now();
  let date = todayUtc();
  logger.info('Hugo OpenAI wrapper started', { date });

  try {
    const resolved = await resolveCompletion(payload);
    date = resolved.date;

    const response = {
      id: `hugo-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: resolved.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            // Spoken output: ONLY the answer text, never metadata.
            content: resolved.answer,
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
      historyItems: resolved.historyItems,
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

// Streaming: writes the answer as OpenAI-compatible SSE chunks to `res`.
// Validation/ask errors are thrown BEFORE any header/body is written, so the
// route can still map them to a JSON error response.
async function streamOpenAiChatCompletion(payload, res) {
  const startedMs = Date.now();
  let date = todayUtc();
  logger.info('Hugo OpenAI wrapper started', { date });

  let resolved;
  try {
    resolved = await resolveCompletion(payload);
    date = resolved.date;
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : 500;
    logger.error('Hugo OpenAI wrapper failed', {
      durationMs: Date.now() - startedMs,
      date,
      status,
    });
    throw err;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const id = `hugo-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = resolved.model;

  const sendChunk = (delta, finishReason) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const pieces = chunkAnswer(resolved.answer, STREAM_WORDS_PER_CHUNK);
  pieces.forEach(function (piece, index) {
    const delta = index === 0
      ? { role: 'assistant', content: piece }
      : { content: piece };
    sendChunk(delta, null);
  });

  sendChunk({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();

  logger.info('Hugo OpenAI wrapper completed', {
    durationMs: Date.now() - startedMs,
    historyItems: resolved.historyItems,
    date,
    status: 200,
  });
}

module.exports = { handleOpenAiChatCompletion, streamOpenAiChatCompletion, OpenAiError };
