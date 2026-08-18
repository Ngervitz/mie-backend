'use strict';

const logger = require('../lib/logger');
const { fetchWithTimeout, isAbortError, DEFAULT_TIMEOUT_MS } = require('./http');

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function resolveAssistAnthropicConfig() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const modelName = (
    process.env.ASSIST_ANTHROPIC_MODEL || DEFAULT_MODEL
  ).trim();
  if (!apiKey) return null;
  return { apiKey, modelName };
}

/**
 * Raw Messages API call (no SDK). Same transport as the rest of mie-backend.
 * @param {{
 *   system: string,
 *   messages: object[],
 *   tools?: object[],
 *   maxTokens?: number,
 *   timeoutMs?: number,
 *   apiKey?: string,
 *   modelName?: string,
 * }} args
 */
async function createMessage(args) {
  const cfg = resolveAssistAnthropicConfig();
  const apiKey = (args && args.apiKey) || (cfg && cfg.apiKey);
  const modelName = (args && args.modelName) || (cfg && cfg.modelName);
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY not configured');
    err.code = 'PROVIDER_NOT_CONFIGURED';
    throw err;
  }

  const body = {
    model: modelName,
    max_tokens: args && args.maxTokens ? args.maxTokens : 4096,
    system: args.system,
    messages: args.messages,
  };
  if (args && Array.isArray(args.tools) && args.tools.length > 0) {
    body.tools = args.tools;
  }

  const timeoutMs =
    args && args.timeoutMs != null ? args.timeoutMs : DEFAULT_TIMEOUT_MS;

  let response;
  try {
    response = await fetchWithTimeout(
      ANTHROPIC_MESSAGES_URL,
      {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  } catch (err) {
    if (isAbortError(err)) {
      const e = new Error(
        `Anthropic request timed out after ${timeoutMs}ms`,
      );
      e.code = 'TIMEOUT';
      e.transient = true;
      throw e;
    }
    const e = new Error(err && err.message ? err.message : 'network error');
    e.code = 'NETWORK_ERROR';
    e.transient = true;
    throw e;
  }

  const rawBody = await response.text();
  let data = null;
  try {
    data = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const msg =
      data && data.error && data.error.message
        ? String(data.error.message)
        : `HTTP ${response.status}`;
    const e = new Error(msg);
    e.code =
      (data && data.error && data.error.type) || `HTTP_${response.status}`;
    e.httpStatus = response.status;
    if (
      response.status === 429 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {
      e.transient = true;
    }
    logger.error('Assist Anthropic HTTP error', {
      httpStatus: response.status,
      code: e.code,
    });
    throw e;
  }

  return data;
}

module.exports = {
  DEFAULT_MODEL,
  ANTHROPIC_VERSION,
  resolveAssistAnthropicConfig,
  createMessage,
};
