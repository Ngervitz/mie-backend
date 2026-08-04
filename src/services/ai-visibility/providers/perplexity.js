/**
 * Perplexity adapter — HTTP chat/completions (Sonar searches by default, no SDK).
 */

const {
  buildResult,
  assertPromptText,
  fetchWithTimeout,
  isAbortError,
} = require('../interface');

const DEFAULT_MODEL = 'sonar';
const PROVIDER_ID = 'perplexity';

function resolveConfig() {
  const apiKey = (process.env.PERPLEXITY_API_KEY || '').trim();
  const modelName = (
    process.env.AI_VISIBILITY_PERPLEXITY_MODEL ||
    DEFAULT_MODEL
  ).trim();
  if (!apiKey) return null;
  return { apiKey, modelName };
}

/**
 * @param {any} data
 * @returns {string}
 */
function extractChatText(data) {
  const choice =
    data && Array.isArray(data.choices) && data.choices[0] ? data.choices[0] : null;
  const content =
    choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content
      : '';
  return content.trim();
}

class PerplexityVisibilityProvider {
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
        error: 'Perplexity API key is not configured',
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
        'https://api.perplexity.ai/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: modelName,
            temperature: 0.2,
            messages: [
              {
                role: 'user',
                content: promptText.trim(),
              },
            ],
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
          (data && data.error && typeof data.error === 'string' && data.error) ||
          `Perplexity HTTP ${response.status}`;
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

      const rawText = extractChatText(data);
      if (!rawText) {
        return buildResult({
          status: 'error',
          rawText: null,
          error: 'Perplexity response contained no text',
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
          usage.prompt_tokens != null ? Number(usage.prompt_tokens) : null,
        outputTokens:
          usage.completion_tokens != null
            ? Number(usage.completion_tokens)
            : null,
      });
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (isAbortError(err)) {
        return buildResult({
          status: 'error',
          rawText: null,
          error: 'Perplexity request timed out after 30s',
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
          err && err.message
            ? String(err.message)
            : 'Perplexity request failed',
        errorCode: 'NETWORK_ERROR',
        httpStatus: null,
        modelName,
        latencyMs,
      });
    }
  }
}

module.exports = {
  PerplexityVisibilityProvider,
  resolveConfig,
  DEFAULT_MODEL,
  PROVIDER_ID,
};
