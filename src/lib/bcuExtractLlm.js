'use strict';

/**
 * OpenAI vision pass1 for bcu_v1 (Stage 0 spike behavior, production module).
 * No HTTP retries. No rereads. No ops decisions.
 */

const { BCU_V1_JSON_SCHEMA } = require('./bcuExtractSchema');
const {
  BCU_V1_SYSTEM_PROMPT,
  BCU_V1_USER_TEXT,
} = require('./bcuExtractPrompt');
const {
  OPENAI_TIMEOUT_MS,
  BCU_EXTRACT_MODEL_DEFAULT,
  BCU_EXTRACT_DETAIL_DEFAULT,
} = require('./bcuExtractTiming');

const OPENAI_CHAT_COMPLETIONS_URL =
  'https://api.openai.com/v1/chat/completions';

function resolveApiKey(override) {
  if (override != null && String(override).trim()) {
    return String(override).trim();
  }
  return String(process.env.OPENAI_API_KEY || '').trim();
}

function resolveModel(override) {
  if (override != null && String(override).trim()) {
    return String(override).trim();
  }
  const fromEnv = String(process.env.BCU_EXTRACT_MODEL || '').trim();
  return fromEnv || BCU_EXTRACT_MODEL_DEFAULT;
}

function resolveDetail(override) {
  if (override != null && String(override).trim()) {
    return String(override).trim();
  }
  const fromEnv = String(process.env.BCU_EXTRACT_DETAIL || '').trim();
  return fromEnv || BCU_EXTRACT_DETAIL_DEFAULT;
}

/**
 * Cost estimate only when usage tokens are present AND both USD/1M rates are
 * supplied (opts or env). Otherwise NULL — never invent spike/historical prices.
 *
 * Env (optional, both required together):
 *   BCU_EXTRACT_USD_PER_1M_INPUT
 *   BCU_EXTRACT_USD_PER_1M_OUTPUT
 *
 * @returns {number|null}
 */
function estimateCostUsd(usage, pricing) {
  const rates = pricing || resolvePricingFromEnv();
  if (!rates) return null;
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    return null;
  }
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
    return null;
  }
  if (
    typeof rates.inputPer1M !== 'number' ||
    !Number.isFinite(rates.inputPer1M) ||
    rates.inputPer1M < 0
  ) {
    return null;
  }
  if (
    typeof rates.outputPer1M !== 'number' ||
    !Number.isFinite(rates.outputPer1M) ||
    rates.outputPer1M < 0
  ) {
    return null;
  }
  const usd =
    (input / 1e6) * rates.inputPer1M + (output / 1e6) * rates.outputPer1M;
  return Number(usd.toFixed(6));
}

function resolvePricingFromEnv() {
  const inputRaw = process.env.BCU_EXTRACT_USD_PER_1M_INPUT;
  const outputRaw = process.env.BCU_EXTRACT_USD_PER_1M_OUTPUT;
  if (inputRaw == null || outputRaw == null) return null;
  if (String(inputRaw).trim() === '' || String(outputRaw).trim() === '') {
    return null;
  }
  const inputPer1M = Number(inputRaw);
  const outputPer1M = Number(outputRaw);
  if (!Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M)) {
    return null;
  }
  if (inputPer1M < 0 || outputPer1M < 0) return null;
  return { inputPer1M: inputPer1M, outputPer1M: outputPer1M };
}

function sanitizeErrorMessage(raw) {
  const s = String(raw || 'unknown').slice(0, 500);
  return s.replace(/sk-[a-zA-Z0-9]+/g, '[redacted]');
}

function bufferToDataUrl(buffer, mime) {
  return 'data:' + mime + ';base64,' + buffer.toString('base64');
}

/**
 * @param {{ buffer: Buffer, contentType: string, apiKey?: string, model?: string, detail?: string, timeoutMs?: number, fetchImpl?: typeof fetch, pricing?: {inputPer1M:number,outputPer1M:number}|null }} opts
 */
async function extractBcuV1FromImage(opts) {
  const apiKey = resolveApiKey(opts && opts.apiKey);
  if (!apiKey) {
    const err = new Error('OpenAI API key is not configured');
    err.code = 'OPENAI_NOT_CONFIGURED';
    err.statusCode = 500;
    throw err;
  }

  const model = resolveModel(opts && opts.model);
  const detail = resolveDetail(opts && opts.detail);
  const timeoutMs =
    opts && opts.timeoutMs != null ? opts.timeoutMs : OPENAI_TIMEOUT_MS;
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const mime = opts.contentType;
  const dataUrl = bufferToDataUrl(opts.buffer, mime);

  const body = {
    model: model,
    temperature: 0,
    max_completion_tokens: 8192,
    messages: [
      { role: 'system', content: BCU_V1_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: BCU_V1_USER_TEXT },
          {
            type: 'image_url',
            image_url: { url: dataUrl, detail: detail },
          },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'bcu_v1_extraction',
        strict: true,
        schema: BCU_V1_JSON_SCHEMA,
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);
  const started = Date.now();
  let response;
  let rawText = '';
  try {
    response = await fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    rawText = await response.text();
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - started;
    const aborted =
      err &&
      (err.name === 'AbortError' ||
        err.code === 'ABORT_ERR' ||
        /aborted|abort/i.test(String(err.message || '')));
    return {
      ok: false,
      outcome: aborted ? 'timeout' : 'network_error',
      model: model,
      detail: detail,
      latency_ms: latencyMs,
      http_status: null,
      usage: null,
      cost_usd_estimated: null,
      extraction: null,
      error: sanitizeErrorMessage(
        aborted
          ? 'OpenAI request timed out after ' + timeoutMs + 'ms'
          : err && err.message
            ? err.message
            : 'network_error',
      ),
    };
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - started;
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (_e) {
    data = null;
  }

  const usage = data && data.usage ? data.usage : null;
  const cost = estimateCostUsd(usage, opts && opts.pricing);

  if (!response.ok) {
    const apiMsg =
      data && data.error && data.error.message
        ? data.error.message
        : 'OpenAI HTTP ' + response.status;
    return {
      ok: false,
      outcome: 'http_error',
      model: model,
      detail: detail,
      latency_ms: latencyMs,
      http_status: response.status,
      usage: usage,
      cost_usd_estimated: cost,
      extraction: null,
      error: sanitizeErrorMessage(apiMsg),
    };
  }

  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  let extraction = null;
  let parseError = null;
  try {
    if (typeof content === 'string') {
      extraction = JSON.parse(content);
    } else if (content && typeof content === 'object') {
      extraction = content;
    } else {
      parseError = 'empty_content';
    }
  } catch (err) {
    parseError = err && err.message ? err.message : 'JSON_PARSE_FAIL';
  }

  if (parseError || !extraction) {
    return {
      ok: false,
      outcome: 'parse_error',
      model: model,
      detail: detail,
      latency_ms: latencyMs,
      http_status: response.status,
      usage: usage,
      cost_usd_estimated: cost,
      extraction: null,
      error: sanitizeErrorMessage(parseError || 'empty_content'),
    };
  }

  return {
    ok: true,
    outcome: 'ok',
    model: model,
    detail: detail,
    latency_ms: latencyMs,
    http_status: response.status,
    usage: usage,
    cost_usd_estimated: cost,
    extraction: extraction,
    error: null,
  };
}

module.exports = {
  OPENAI_CHAT_COMPLETIONS_URL,
  extractBcuV1FromImage,
  estimateCostUsd,
  resolvePricingFromEnv,
  resolveModel,
  resolveDetail,
  sanitizeErrorMessage,
  bufferToDataUrl,
};
