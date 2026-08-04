/**
 * OpenAI adapter — HTTP Responses API + native web_search tool (no SDK).
 */

const {
  buildResult,
  assertPromptText,
  fetchWithTimeout,
  isAbortError,
} = require('../interface');

const DEFAULT_MODEL = 'gpt-4o-mini';
const PROVIDER_ID = 'openai';

function resolveConfig() {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  const modelName = (
    process.env.AI_VISIBILITY_OPENAI_MODEL ||
    DEFAULT_MODEL
  ).trim();
  if (!apiKey) return null;
  return { apiKey, modelName };
}

/**
 * Extract assistant text from Responses API payload.
 * @param {any} data
 * @returns {string}
 */
function extractResponsesText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const parts = [];
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (!item || item.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (
        (block.type === 'output_text' || block.type === 'text') &&
        typeof block.text === 'string'
      ) {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n').trim();
}

class OpenAiVisibilityProvider {
  /**
   * @param {{ apiKey: string, modelName: string }|null} [config]
   */
  constructor(config = resolveConfig()) {
    this.config = config;
    this.modelName = (config && config.modelName) || DEFAULT_MODEL;
  }

  /**
   * @param {string} promptText
   * @returns {Promise<import('../interface').AiVisibilityResult>}
   */
  async ask(promptText) {
    const started = Date.now();
    let modelName = this.modelName;

    try {
      assertPromptText(promptText);
    } catch (err) {
      return buildResult({
        status: 'error',
        rawText: null,
        error: err && err.message ? err.message : 'Invalid promptText',
        errorCode: 'INVALID_PROMPT',
        httpStatus: null,
        modelName,
        latencyMs: Date.now() - started,
      });
    }

    if (!this.config) {
      return buildResult({
        status: 'not_configured',
        rawText: null,
        error: 'OpenAI API key is not configured',
        errorCode: 'PROVIDER_NOT_CONFIGURED',
        httpStatus: null,
        modelName,
        latencyMs: 0,
      });
    }

    const { apiKey } = this.config;
    modelName = this.config.modelName;

    try {
      const response = await fetchWithTimeout(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: modelName,
            temperature: 0.2,
            tools: [{ type: 'web_search' }],
            input: promptText.trim(),
          }),
        },
      );

      const latencyMs = Date.now() - started;
      let data = null;
      const rawBody = await response.text();
      if (rawBody) {
        try {
          data = JSON.parse(rawBody);
        } catch {
          data = null;
        }
      }

      if (!response.ok) {
        const msg =
          (data && (data.error && data.error.message)) ||
          `OpenAI HTTP ${response.status}`;
        return buildResult({
          status: 'error',
          rawText: null,
          error: String(msg),
          errorCode:
            (data && data.error && data.error.code) ||
            `HTTP_${response.status}`,
          httpStatus: response.status,
          modelName,
          latencyMs,
        });
      }

      const rawText = extractResponsesText(data);
      if (!rawText) {
        return buildResult({
          status: 'error',
          rawText: null,
          error: 'OpenAI response contained no text output',
          errorCode: 'EMPTY_RESPONSE',
          httpStatus: response.status,
          modelName,
          latencyMs,
        });
      }

      const usage = data && data.usage ? data.usage : {};
      return buildResult({
        status: 'success',
        rawText,
        error: null,
        errorCode: null,
        httpStatus: response.status,
        modelName,
        latencyMs,
        inputTokens:
          usage.input_tokens != null ? Number(usage.input_tokens) : null,
        outputTokens:
          usage.output_tokens != null ? Number(usage.output_tokens) : null,
      });
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (isAbortError(err)) {
        return buildResult({
          status: 'error',
          rawText: null,
          error: 'OpenAI request timed out after 30s',
          errorCode: 'TIMEOUT',
          httpStatus: null,
          modelName,
          latencyMs,
        });
      }
      return buildResult({
        status: 'error',
        rawText: null,
        error: err && err.message ? String(err.message) : 'OpenAI request failed',
        errorCode: 'NETWORK_ERROR',
        httpStatus: null,
        modelName,
        latencyMs,
      });
    }
  }
}

module.exports = { OpenAiVisibilityProvider, resolveConfig, DEFAULT_MODEL, PROVIDER_ID };
