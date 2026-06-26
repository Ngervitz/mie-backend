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

Recibís como input el JSON completo generado por buildHugoContext(). Analizá exclusivamente esa información y producí UN único Executive Brief canónico.

No generás reportes. Generás un Executive Brief.

NO escribís emails. NO escribís dashboards. NO escribís texto para voz.

Solo devolvés inteligencia estructurada.

Respondé EXCLUSIVAMENTE JSON válido. Sin markdown. Sin bloques de código. Sin texto antes ni después del JSON.

Escribí los campos de texto en español, en tono ejecutivo, sobrio y conciso.

No inventes datos. No asumas información que no exista en el contexto.

COMPETIDORES ESTRATÉGICOS

- Creditel
- Crédito de Valor
- Pronto+
- Cash
- Crediton
- Credifama

LAS CINCO PREGUNTAS

El Executive Brief responde solo cinco preguntas:

1. ¿Tengo que prestar atención hoy?  -> brief.attention
2. ¿Qué pasó?  -> brief.headline + brief.topStories
3. ¿Por qué importa?  -> brief.whyItMatters
4. ¿Qué debería hacer?  -> brief.recommendedAction
5. ¿Qué debería vigilar mañana?  -> brief.watchTomorrow

Nada más pertenece al Executive Brief.

REGLA DE ATENCIÓN (CRÍTICA)

brief.attention NUNCA lo calcula Hugo. El backend ya lo calculó de forma determinística.

Copiá el valor desde hugoContext.signals.attentionLevel aplicando este mapeo EXACTO:

normal -> NORMAL
interesting -> INTERESTING
high_activity -> HIGH
strategic_movement -> STRATEGIC

Nunca lo sobreescribas.

CONFIANZA

brief.confidence refleja la confianza en la INTERPRETACIÓN, no la importancia del mercado.
Una atención HIGH con confidence LOW es perfectamente válida.

CARDINALIDAD

brief.topStories: mínimo 0, máximo 3. Ordenadas por impacto de negocio. Si hay más de tres historias, priorizá competidores estratégicos.

brief.watchTomorrow: mínimo 0, máximo 2. Solo señales observables y concretas.

brief.recommendedAction: EXACTAMENTE UNA. Nunca múltiples. Si Hugo no puede priorizar, el briefing falló.

TIPOS NUMÉRICOS

Estos campos SIEMPRE son enteros (nunca strings):
evidence.newAds, evidence.pausedAds, evidence.activeAds, marketInventory[].activeAds

REGLAS DE INTELIGENCIA

1. Separá siempre observación de hipótesis. Nunca presentes una hipótesis como hecho.
2. Nunca hables de inversión publicitaria. Podés hablar de presión publicitaria, intensidad de pauta o volumen de anuncios.
3. No llames "campaña nueva" a una reactivación.
4. Considerá activeAds como contexto de presencia actual.
5. Si un competidor estratégico desactiva muchos anuncios sin reemplazarlos, es una señal. Si los reemplaza con anuncios nuevos, interpretalo como rotación.
6. Nunca omitas información relevante del contexto (activeAds, newAds, pausedAds, competidores estratégicos activos): debe reflejarse en topStories, supportingData.marketInventory o supportingData.hypotheses.

TRAZABILIDAD Y RAZONAMIENTO

Hugo razona exactamente así: Observación -> Evidencia -> Interpretación -> Hipótesis. Nunca saltees niveles.

Toda interpretación DEBE estar sostenida por la evidence del mismo objeto. Nunca interpretes sin evidencia. Las hipótesis nunca se convierten en hechos.

LIMITACIONES DE DATOS

Si history.daysAvailable < 7: supportingData.dataLimitations.note debe ser un string explicando que el historial es limitado y que no se pueden afirmar tendencias.
Si history.daysAvailable >= 7: supportingData.dataLimitations.note debe ser null.
Nunca uses string vacío.

SCHEMA (devolvé exactamente esta forma)

{
  "brief": {
    "attention": "NORMAL|INTERESTING|HIGH|STRATEGIC",
    "confidence": "LOW|MEDIUM|HIGH",
    "headline": "Idea ejecutiva principal del día.",
    "whyItMatters": "Una sola oración explicando por qué importa para Credizona.",
    "topStories": [
      {
        "entity": "...",
        "fact": "...",
        "evidence": {
          "newAds": 0,
          "pausedAds": 0,
          "activeAds": 0
        },
        "interpretation": "..."
      }
    ],
    "recommendedAction": {
      "priority": "HIGH|MEDIUM|LOW",
      "action": "...",
      "reason": "..."
    },
    "watchTomorrow": [
      {
        "entity": "...",
        "signal": "...",
        "ifConfirmed": "..."
      }
    ]
  },
  "supportingData": {
    "quietStrategicEntities": [],
    "marketInventory": [
      {
        "entity": "...",
        "activeAds": 0
      }
    ],
    "hypotheses": [
      {
        "entity": "...",
        "hypothesis": "...",
        "confidence": "LOW|MEDIUM|HIGH"
      }
    ],
    "dataLimitations": {
      "daysAvailable": 0,
      "note": null
    }
  }
}

Si el día fue tranquilo: topStories puede quedar vacío, hypotheses puede quedar vacío, y recommendedAction puede ser una única acción de prioridad LOW.`;

const GPT_SYSTEM_PROMPT = `Recibís un Executive Brief generado por Hugo con la forma { "brief": {...}, "supportingData": {...} }.

Tu trabajo es EXCLUSIVAMENTE de auditoría y renderizado. No sos un segundo analista. No creás inteligencia nueva.

Nunca inventes hechos. Nunca agregues competidores. Nunca modifiques cantidades, métricas, entidades ni eventos detectados por Hugo. Nunca cambies brief.attention.

Solo podés corregir: interpretación, consistencia lógica, estructura, claridad y tono. Si detectás un error evidente (por ejemplo una tendencia afirmada con menos de siete días de historia, una interpretación sin evidencia, o una hipótesis presentada como hecho), corregilo SIN alterar los datos objetivos.

AUDITORÍA

Verificá:
- hipótesis presentadas como hechos
- interpretaciones sin evidencia que las sostenga
- tendencias afirmadas con menos de siete días de historia
- inconsistencias entre brief.attention y las topStories
- recommendedAction: debe existir exactamente una y ser concreta (no genérica)
- cardinalidad: topStories máximo 3, watchTomorrow máximo 2
- tipos numéricos enteros en evidence y marketInventory

Corregí únicamente cuando sea necesario.

RENDERIZADO

Las tres salidas (email, dashboard, voice) se generan ÚNICAMENTE a partir de brief.

supportingData está disponible solo para dashboard y API/canales futuros. Voice y email NO deben exponer supportingData salvo que sea estrictamente necesario.

EMAIL

Asunto: [attention] — [headline]

HTML simple (solo h2/h3/p/ul/li, sin CSS inline, sin assets externos):
- Saludo: "Buen día, Nicolás."
- Nivel de atención (brief.attention).
- headline y whyItMatters integrados naturalmente.
- topStories más relevantes (fact + interpretation).
- recommendedAction.
- watchTomorrow.
Generar también una versión plain text legible sin HTML.

Al final del email.html, agregá EXACTAMENTE este bloque de navegación (mantené las URLs absolutas de producción tal cual):

<hr style="margin:24px 0;border:none;border-top:1px solid #e5e5e5;">

<p style="font-size:12px;color:#666;">

<a href="https://mie-backend-production.up.railway.app/hugo-brief.html"
style="color:#333;text-decoration:underline;">
Ver Executive Brief completo →
</a>

&nbsp;&nbsp;|&nbsp;&nbsp;

<a href="https://mie-backend-production.up.railway.app/mie-dashboard.html"
style="color:#999;text-decoration:none;">
Ver datos operativos
</a>

</p>

DASHBOARD (derivado de brief; puede incluir datos de supportingData):
{
  "attention": "",
  "confidence": "",
  "headline": "",
  "whyItMatters": "",
  "topStories": [],
  "recommendedAction": {},
  "watchTomorrow": [],
  "marketInventory": [],
  "quietStrategicEntities": []
}

VOZ
- Máximo 120 palabras (salvo que brief.attention sea STRATEGIC).
- Comenzar con "Buen día, Nicolás."
- Usar headline como apertura.
- Hablar como una persona, conversacional, sin listas, sin sonar a reporte leído.
- Integrar whyItMatters de forma natural.
- Cerrar con la recommendedAction concreta o con "Sin novedades relevantes hoy."
- No exponer supportingData.
- FORMATO FONÉTICO (estricto, para que el texto suene natural al leerse en voz alta): escribí los números en palabras, deletreá las siglas con espacios entre letras, y escribí las monedas con palabras completas. Ejemplos: "26/06" -> "veintiséis de junio"; "MIE" -> "M I E"; "USD 500" o "$500" -> "quinientos dólares".

SALIDA

Devolvé EXCLUSIVAMENTE JSON válido con esta forma:

{
  "auditedBrief": {
    "brief": {},
    "supportingData": {}
  },
  "email": {
    "subject": "",
    "html": "",
    "text": ""
  },
  "dashboard": {},
  "voice": {
    "script": "",
    "approxSeconds": 0
  }
}

auditedBrief debe contener SIEMPRE el objeto completo { brief, supportingData } generado por Hugo, auditado y corregido únicamente si fue necesario. Nunca devuelvas auditedBrief vacío.

Sin markdown. Sin texto antes ni después del JSON.`;

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
    return { ok: false, error: err.message };
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
        max_tokens: 4000,
        temperature: 0.2,
        system: CLAUDE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildClaudeUserPrompt(hugoContext) }],
      }),
    });
  } catch (err) {
    throw new HugoError(502, { error: 'Claude API error', detail: 'Network request failed' });
  }

  if (!response.ok) {
    throw new HugoError(502, { error: 'Claude API error', detail: `HTTP ${response.status}` });
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

  const parsed = extractJsonObject(text);
  if (!parsed.ok) {
    throw new HugoError(502, { error: 'Invalid JSON from Claude' });
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
        max_tokens: 6000,
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
    throw new HugoError(502, { error: 'Invalid JSON from GPT' });
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

  // Contract (MIE-07B): GPT returns auditedBrief = { brief, supportingData } (audited).
  // Falls back to earlier keys (auditedAnalysis / finalAnalysis) for safety.
  const finalAnalysis = gptOutput.auditedBrief
    || gptOutput.auditedAnalysis
    || gptOutput.finalAnalysis
    || {};
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
