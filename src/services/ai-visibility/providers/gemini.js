/**
 * Gemini adapter — HTTP generateContent + google_search grounding (no SDK).
 * Key convention: GEMINI_API_KEY (no prior project convention).
 */

const {
  buildResult,
  assertPromptText,
  fetchWithTimeout,
  isAbortError,
} = require('../interface');

const DEFAULT_MODEL = 'gemini-2.0-flash';
const PROVIDER_ID = 'gemini';

function resolveConfig() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const modelName = (
    process.env.AI_VISIBILITY_GEMINI_MODEL ||
    DEFAULT_MODEL
  ).trim();
  if (!apiKey) return null;
  return { apiKey, modelName };
}

/**
 * @param {any} data
 * @returns {string}
 */
function extractGeminiText(data) {
  const candidates = data && Array.isArray(data.candidates) ? data.candidates : [];
  const partsOut = [];
  for (const cand of candidates) {
    const parts =
      cand && cand.content && Array.isArray(cand.content.parts)
        ? cand.content.parts
        : [];
    for (const part of parts) {
      if (part && typeof part.text === 'string') partsOut.push(part.text);
    }
  }
  return partsOut.join('\n').trim();
}

class GeminiVisibilityProvider {
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
        error: 'Gemini API key is not configured',
        errorCode: 'PROVIDER_NOT_CONFIGURED',
        httpStatus: null,
        modelName,
        latencyMs: 0,
      });
    }

    const { apiKey } = this.config;
    modelName = this.config.modelName;
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(modelName)}:generateContent`;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: promptText.trim() }],
            },
          ],
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      });

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
          (data && data.error && data.error.message) ||
          `Gemini HTTP ${response.status}`;
        return buildResult({
          status: 'error',
          rawText: null,
          error: String(msg),
          errorCode:
            (data && data.error && String(data.error.status || data.error.code)) ||
            `HTTP_${response.status}`,
          httpStatus: response.status,
          modelName,
          latencyMs,
        });
      }

      const rawText = extractGeminiText(data);
      if (!rawText) {
        return buildResult({
          status: 'error',
          rawText: null,
          error: 'Gemini response contained no text',
          errorCode: 'EMPTY_RESPONSE',
          httpStatus: response.status,
          modelName,
          latencyMs,
        });
      }

      const usage = data && data.usageMetadata ? data.usageMetadata : {};
      return buildResult({
        status: 'success',
        rawText,
        error: null,
        errorCode: null,
        httpStatus: response.status,
        modelName,
        latencyMs,
        inputTokens:
          usage.promptTokenCount != null ? Number(usage.promptTokenCount) : null,
        outputTokens:
          usage.candidatesTokenCount != null
            ? Number(usage.candidatesTokenCount)
            : null,
      });
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (isAbortError(err)) {
        return buildResult({
          status: 'error',
          rawText: null,
          error: 'Gemini request timed out after 30s',
          errorCode: 'TIMEOUT',
          httpStatus: null,
          modelName,
          latencyMs,
        });
      }
      return buildResult({
        status: 'error',
        rawText: null,
        error: err && err.message ? String(err.message) : 'Gemini request failed',
        errorCode: 'NETWORK_ERROR',
        httpStatus: null,
        modelName,
        latencyMs,
      });
    }
  }
}

module.exports = { GeminiVisibilityProvider, resolveConfig, DEFAULT_MODEL, PROVIDER_ID };
