const { buildHugoContext } = require('../routes/reports');
const logger = require('../lib/logger');

const MODEL_ARCHITECT = 'claude-sonnet-4-6';
const MODEL_AUDITOR = 'gpt-4o';

// Static, estimate-only model pricing (USD per 1M tokens). Actual billing may differ.
const PRICING = {
  claude: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  gpt: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
};

const PRICING_NOTE =
  'Estimated using static model prices configured in Hugo Brain; actual provider billing may differ.';

function toIntToken(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function round6(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

// Structured error so the route can map status + safe body directly.
class HugoError extends Error {
  constructor(status, body) {
    super((body && body.error) || 'Hugo error');
    this.status = status;
    this.body = body;
  }
}

const CLAUDE_SYSTEM_PROMPT = `Sos Hugo, Director de Inteligencia Competitiva de Credizona Uruguay.

Vas a recibir como input el JSON completo generado por buildHugoContext(). Analizá exclusivamente esa información y transformala en un objeto de inteligencia estructurada.

No inventes datos.

No asumas información que no exista en el contexto.

Tu trabajo consiste en transformar señales del mercado en un objeto JSON de inteligencia estructurada.

NO escribís emails.

NO escribís dashboards.

NO escribís texto para voz.

Solo devolvés inteligencia.

Respondé exclusivamente JSON válido.

Sin markdown.

Sin bloques de código.

Sin texto antes ni después del JSON.

COMPETIDORES ESTRATÉGICOS

- Creditel
- Crédito de Valor
- Pronto+
- Cash
- Crediton
- Credifama

REGLAS

1. Separá siempre observaciones de hipótesis.

2. Nunca presentes hipótesis como hechos.

3. Si history.daysAvailable < 7:
- no hables de tendencias
- indicá que el historial todavía es limitado

4. Nunca hables de inversión publicitaria.

Podés hablar de:
- presión publicitaria
- intensidad de pauta
- volumen de anuncios

5. No llames "campaña nueva" a una reactivación.

6. Considerá activeAds como contexto de presencia actual.

7. Si un competidor estratégico desactiva muchos anuncios sin reemplazarlos, es una señal. Si los reemplaza con anuncios nuevos, interpretalo como rotación.

8. Si tres o más competidores estratégicos muestran movimientos el mismo día, eso aumenta la importancia del briefing.

9. attentionLevel ya fue calculado de forma determinística por el backend. No lo modifiques. Utilizalo únicamente como contexto para construir el briefing.

10. Nunca omitas información relevante del contexto de entrada. Si un dato significativo existe en buildHugoContext() (por ejemplo competidores estratégicos activos, activeAds, newAds, pausedAds o attentionLevel), debe aparecer reflejado explícitamente en observations, hypotheses o marketInventory.

NIVELES

- normal
- interesting
- high_activity
- strategic_movement

SCHEMA

{
  "attentionLevel":"normal|interesting|high_activity|strategic_movement",

  "attentionLabel":"texto corto",

  "keyTakeaway":"la única idea que un CEO debería recordar hoy",

  "headline":"una oración",

  "executiveSummary":{

      "whatHappened":"...",

      "whyItMatters":"...",

      "unknowns":"..."
  },

  "context":{

      "daysAvailable":0,

      "historyConfidence":"low|medium|high",

      "canInferTrends":true
  },

  "observations":[

      {

          "observationId":"obs_1",

          "entity":"",

          "isStrategic":true,

          "observation":"",

          "importance":"high|medium|low",

          "evidence":{

              "newAds":0,

              "pausedAds":0,

              "activeAds":0

          }

      }

  ],

  "hypotheses":[

      {

          "entity":"",

          "hypothesis":"",

          "confidence":"low|medium|high",

          "confidenceReason":"",

          "supportedBy":[

              "obs_1",

              "obs_2"

          ]

      }

  ],

  "executiveActions":[

      {

          "priority":"high|medium|low",

          "action":"",

          "reason":""

      }

  ],

  "watchTomorrow":[

      {

          "entity":"",

          "signal":"",

          "ifTrue":""

      }

  ],

  "quietStrategicEntities":[

  ],

  "marketInventory":{

      "top3":[

          {

              "entity":"",

              "activeAds":0

          }

      ]

  }
}

Si el día fue tranquilo:

- observations puede tener 1 o 2 elementos.
- hypotheses puede quedar vacío.
- executiveActions puede tener una única acción de prioridad baja.`;

const GPT_SYSTEM_PROMPT = `Recibís un JSON generado por Hugo.

Tu trabajo es exclusivamente de auditoría y renderizado.

No sos un segundo analista.

Nunca inventes hechos.

Nunca agregues competidores.

Nunca modifiques cantidades, métricas, entidades ni eventos detectados por Hugo.

Solo podés corregir:

- interpretación
- consistencia lógica
- estructura
- claridad
- tono

Si detectás un error evidente (por ejemplo una tendencia afirmada con menos de siete días de historia), corregilo sin alterar los datos objetivos.

AUDITORÍA

Verificá:

- hipótesis presentadas como hechos
- tendencias con menos de siete días de historia
- inconsistencias entre attentionLevel y observations
- acciones demasiado genéricas
- executiveSummary completo:
  - whatHappened
  - whyItMatters
  - unknowns

Corregí únicamente cuando sea necesario.

RENDERIZADO

EMAIL

Asunto

[attentionLabel] — [headline]

HTML

- Buen día, Nicolás.
- Nivel de atención destacado.
- keyTakeaway.
- executiveSummary integrado naturalmente.
- Lo más relevante (observations high y medium).
- Qué mirar mañana.
- Sin movimientos hoy: quietStrategicEntities.

Generar también versión plain text.

DASHBOARD

{
  "attentionLevel":"",
  "attentionLabel":"",
  "keyTakeaway":"",
  "headline":"",
  "summary":"",
  "topObservations":[],
  "executiveActions":[],
  "watchTomorrow":[]
}

VOZ

Máximo 120 palabras.

Comenzar con:

"Buen día, Nicolás."

Usar keyTakeaway como apertura.

Hablar como una persona.

No usar listas.

No sonar como un reporte leído.

Integrar executiveSummary de forma conversacional.

Cerrar con una recomendación concreta o con:

"Sin novedades relevantes hoy."

SALIDA

Devolver exclusivamente JSON válido con esta forma:

{
  "auditedAnalysis": {},
  "email":{
      "subject":"",
      "html":"",
      "text":""
  },
  "dashboard":{
  },
  "voice":{
      "script":"",
      "approxSeconds":0
  }
}

auditedAnalysis debe contener SIEMPRE el objeto completo de inteligencia generado por Hugo, auditado y corregido únicamente si fue necesario. Nunca devuelvas auditedAnalysis vacío.

Sin markdown.

Sin texto antes ni después del JSON.`;

function buildClaudeUserPrompt(hugoContext) {
  return `Analizá este contexto de mercado y devolvé tu análisis en el JSON estructurado definido en el system prompt.

CONTEXTO:
${JSON.stringify(hugoContext, null, 2)}

Devolvé SOLO JSON válido.`;
}

function buildGptUserPrompt(claudeAnalysis, hugoContext) {
  return `Auditá y formateá este análisis estructurado de Hugo.

No agregues hechos nuevos.
No cambies el attentionLevel.
Separá hechos de hipótesis.
Devolvé SOLO JSON válido.

ANÁLISIS DE CLAUDE:
${JSON.stringify(claudeAnalysis, null, 2)}

CONTEXTO ORIGINAL:
${JSON.stringify(hugoContext, null, 2)}`;
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// Tolerant extraction for model output that may be wrapped in Markdown fences
// or surrounded by extra prose. Strips ```json / ``` fences, then isolates the
// outermost { ... } block before parsing.
function extractJsonObject(text) {
  let candidate = String(text).trim();

  // Remove Markdown code fences (```json ... ``` or ``` ... ```).
  candidate = candidate
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }

  return safeJsonParse(candidate);
}

async function callClaude(hugoContext) {
  const startedMs = Date.now();
  logger.info('Claude request started', { model: MODEL_ARCHITECT });

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_ARCHITECT,
        max_tokens: 2000,
        temperature: 0.2,
        system: CLAUDE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildClaudeUserPrompt(hugoContext) }],
      }),
    });
  } catch (err) {
    throw new HugoError(502, { error: 'Claude API error', detail: 'Network request failed' });
  }

  if (!response.ok) {
    const raw = await response.text();
    throw new HugoError(502, { error: 'Claude API error', status: response.status, raw });
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new HugoError(502, { error: 'Invalid JSON from Claude', raw: 'Non-JSON response body' });
  }

  const text = data && data.content && data.content[0] ? data.content[0].text : undefined;

  if (typeof text !== 'string') {
    throw new HugoError(502, { error: 'Invalid JSON from Claude', raw: 'Missing content text' });
  }

  // TEMPORARY diagnostic: log the full raw Claude text before parsing.
  logger.info('Claude raw response (diagnostic)', { rawText: text });

  const parsed = extractJsonObject(text);
  if (!parsed.ok) {
    throw new HugoError(502, { error: 'Invalid JSON from Claude', raw: text });
  }

  const rawUsage = data && data.usage ? data.usage : {};
  const inputTokens = toIntToken(rawUsage.input_tokens);
  const outputTokens = toIntToken(rawUsage.output_tokens);

  logger.info('Claude response parsed', { model: MODEL_ARCHITECT });

  return {
    analysis: parsed.value,
    durationMs: Date.now() - startedMs,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

async function callGpt(claudeAnalysis, hugoContext) {
  const startedMs = Date.now();
  logger.info('GPT request started', { model: MODEL_AUDITOR });

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_AUDITOR,
        max_tokens: 2500,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: GPT_SYSTEM_PROMPT },
          { role: 'user', content: buildGptUserPrompt(claudeAnalysis, hugoContext) },
        ],
      }),
    });
  } catch (err) {
    throw new HugoError(502, { error: 'GPT API error', detail: 'Network request failed' });
  }

  if (!response.ok) {
    throw new HugoError(502, { error: 'GPT API error', detail: `HTTP ${response.status}` });
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new HugoError(502, { error: 'Invalid JSON from GPT', raw: 'Non-JSON response body' });
  }

  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : undefined;

  if (typeof content !== 'string') {
    throw new HugoError(502, { error: 'Invalid JSON from GPT', raw: 'Missing message content' });
  }

  const parsed = safeJsonParse(content);
  if (!parsed.ok) {
    throw new HugoError(502, { error: 'Invalid JSON from GPT', raw: content });
  }

  const rawUsage = data && data.usage ? data.usage : {};
  const inputTokens = toIntToken(rawUsage.prompt_tokens);
  const outputTokens = toIntToken(rawUsage.completion_tokens);

  logger.info('GPT response parsed', { model: MODEL_AUDITOR });

  return {
    output: parsed.value,
    durationMs: Date.now() - startedMs,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

async function runHugo({ date } = {}) {
  const startedMs = Date.now();

  logger.info('Hugo run started', { date: date || 'today-utc' });

  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    throw new HugoError(500, { error: 'Missing required Hugo environment variables' });
  }

  // Step 1 — context (reuses the exact GET /reports/hugo-context builder).
  let hugoContext;
  let contextDurationMs = 0;
  try {
    const contextStart = Date.now();
    hugoContext = await buildHugoContext({ date });
    contextDurationMs = Date.now() - contextStart;
  } catch (err) {
    logger.error('Hugo context build failed', { error: err.message });
    throw new HugoError(500, { error: 'Failed to run Hugo' });
  }

  const backendAttentionLevel = hugoContext.signals.attentionLevel;

  logger.info('Context loaded', {
    date: hugoContext.date,
    totalEvents: hugoContext.today.totalEvents,
    daysAvailable: hugoContext.history.daysAvailable,
    attentionLevel: backendAttentionLevel,
  });

  // Step 2 — Claude analyst.
  const claudeResult = await callClaude(hugoContext);
  const claudeAnalysis = claudeResult.analysis;
  const claudeDurationMs = claudeResult.durationMs;

  // Step 3 — GPT auditor / formatter.
  const gptResult = await callGpt(claudeAnalysis, hugoContext);
  const gptOutput = gptResult.output;
  const gptDurationMs = gptResult.durationMs;

  const durationMs = Date.now() - startedMs;

  const usage = {
    claude: claudeResult.usage,
    gpt: gptResult.usage,
    totalTokens: claudeResult.usage.totalTokens + gptResult.usage.totalTokens,
  };

  const claudeCostUsd = round6(
    (usage.claude.inputTokens / 1e6) * PRICING.claude.inputPerMillion
      + (usage.claude.outputTokens / 1e6) * PRICING.claude.outputPerMillion,
  );
  const gptCostUsd = round6(
    (usage.gpt.inputTokens / 1e6) * PRICING.gpt.inputPerMillion
      + (usage.gpt.outputTokens / 1e6) * PRICING.gpt.outputPerMillion,
  );
  const financial = {
    claudeCostUsd,
    gptCostUsd,
    totalRunCostUsd: round6(claudeCostUsd + gptCostUsd),
    pricingNote: PRICING_NOTE,
  };

  logger.info('Hugo run completed', {
    durationMs,
    contextDurationMs,
    claudeDurationMs,
    gptDurationMs,
    claudeTokens: usage.claude.totalTokens,
    gptTokens: usage.gpt.totalTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: financial.totalRunCostUsd,
  });

  // New contract (MIE-07A): GPT returns auditedAnalysis (the full Hugo intelligence
  // object, audited). Falls back to the legacy finalAnalysis key for safety.
  const finalAnalysis = gptOutput.auditedAnalysis || gptOutput.finalAnalysis || {};
  const outputs = {
    email: gptOutput.email || {},
    dashboard: gptOutput.dashboard || {},
    voice: gptOutput.voice || {},
  };

  return {
    date: hugoContext.date,
    generatedAt: new Date().toISOString(),
    // attentionLevel is preserved from the backend context, never from the models.
    attentionLevel: backendAttentionLevel,
    analysis: finalAnalysis,
    outputs,
    audit: {
      status: gptOutput.auditStatus || 'not_generated',
      notes: gptOutput.auditNotes || [],
    },
    meta: {
      modelArchitect: MODEL_ARCHITECT,
      modelAuditor: MODEL_AUDITOR,
      daysOfHistory: hugoContext.history.daysAvailable,
      totalEvents: hugoContext.today.totalEvents,
      telemetry: {
        durationMs,
        contextDurationMs,
        claudeDurationMs,
        gptDurationMs,
      },
      usage,
      financial,
    },
  };
}

module.exports = { runHugo, HugoError };
