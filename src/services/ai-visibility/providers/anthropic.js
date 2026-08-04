/**
 * Anthropic adapter — HTTP Messages API + web_search_20250305 (no SDK).
 * rawText = concatenation of text content blocks only (skip tool_use / tool_result).
 */

const {
  buildResult,
  assertPromptText,
  fetchWithTimeout,
  isAbortError,
} = require('../interface');

const DEFAULT_MODEL = 'claude-haiku-4-5';
const PROVIDER_ID = 'anthropic';

function resolveConfig() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const modelName = (
    process.env.AI_VISIBILITY_ANTHROPIC_MODEL ||
    DEFAULT_MODEL
  ).trim();
  if (!apiKey) return null;
  return { apiKey, modelName };
}

/**
 * @param {any} data
 * @returns {string}
 */
function extractTextBlocks(data) {
  const content = data && Array.isArray(data.content) ? data.content : [];
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

class AnthropicVisibilityProvider {
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
        error: 'Anthropic API key is not configured',
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
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: modelName,
            max_tokens: 2048,
            temperature: 0.2,
            tools: [
              {
                type: 'web_search_20250305',
                name: 'web_search',
                max_uses: 5,
              },
            ],
            messages: [{ role: 'user', content: promptText.trim() }],
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
          `Anthropic HTTP ${response.status}`;
        return buildResult({
          status: 'error',
          rawText: null,
          error: String(msg),
          errorCode:
            (data && data.error && data.error.type) ||
            `HTTP_${response.status}`,
          httpStatus: response.status,
          modelName,
          latencyMs,
        });
      }

      const rawText = extractTextBlocks(data);
      if (!rawText) {
        return buildResult({
          status: 'error',
          rawText: null,
          error: 'Anthropic response contained no text blocks',
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
          error: 'Anthropic request timed out after 30s',
          errorCode: 'TIMEOUT',
          httpStatus: null,
          modelName,
          latencyMs,
        });
      }
      return buildResult({
        status: 'error',
        rawText: null,
        error:
          err && err.message ? String(err.message) : 'Anthropic request failed',
        errorCode: 'NETWORK_ERROR',
        httpStatus: null,
        modelName,
        latencyMs,
      });
    }
  }
}

module.exports = {
  AnthropicVisibilityProvider,
  resolveConfig,
  DEFAULT_MODEL,
  PROVIDER_ID,
};
