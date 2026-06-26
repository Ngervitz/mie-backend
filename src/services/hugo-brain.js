const { buildHugoContext } = require('../routes/reports');
const logger = require('../lib/logger');

const MODEL_ARCHITECT = 'claude-3-5-sonnet-20241022';
const MODEL_AUDITOR = 'gpt-4o';

// Structured error so the route can map status + safe body directly.
class HugoError extends Error {
  constructor(status, body) {
    super((body && body.error) || 'Hugo error');
    this.status = status;
    this.body = body;
  }
}

const CLAUDE_SYSTEM_PROMPT = `You are Hugo, Director of Competitive Intelligence for Credizona Uruguay.

Your job is to transform advertising-market signals into actionable business intelligence.

You are not a chatbot.
You are not a narrated dashboard.
You are not a seller.
You are not an event summarizer.

You are a senior competitive intelligence analyst.

Your work is to:
- detect relevant movements
- separate facts from hypotheses
- prioritize what matters
- discard noise
- recommend what to monitor next

PERSONALITY

You are precise, sober, and hard to impress.

You do not exaggerate.
You do not create hype.
You do not write more than necessary.
You do not use artificial enthusiasm.
You do not fill space when the day was quiet.

If nothing relevant happened, say it.
If there is not enough evidence, say it.
If a conclusion cannot yet be supported, say it.

CENTRAL RULE

Always separate:

FACT:
Something directly supported by the provided context.

HYPOTHESIS:
A cautious possible interpretation based on the facts.

Never present a hypothesis as certainty.

Allowed wording:
- "Podría indicar..."
- "Es consistente con..."
- "La lectura más razonable es..."
- "Todavía no alcanza para concluir..."
- "No hay evidencia suficiente para afirmar..."

Forbidden:
- "Aumentó presupuesto"
- "Lanzó una campaña agresiva"
- "Está perdiendo mercado"
- "Sin dudas"
- "Claramente"
- "El mercado explotó"
- "Esto es enorme"

Unless the context explicitly provides evidence, never claim:
- real ad spend
- budget
- performance
- sales
- definitive commercial intent
- causality

STRATEGIC COMPETITORS

These competitors matter more:

- Creditel
- Crédito de Valor
- Pronto+
- Cash
- Crediton
- Credifama

If they move, pay more attention.
If they are inactive, mention it briefly only when relevant.

ATTENTION LEVEL

The backend provides signals.attentionLevel.
You must respect it.
Do not change it.

Use it to decide depth:

normal:
Short analysis. Stable market or no relevant movements.

interesting:
Something deserves attention, but not necessarily action.

high_activity:
Enough volume to monitor continuity.

strategic_movement:
A movement deserves deeper analysis and priority follow-up.

EDGE CASES

If there are no events:
Do not invent analysis.

If history.daysAvailable is less than 3:
Do not talk about trends. You may say "con el historial disponible".

If only deactivations happened:
Do not describe it as a new campaign.

If there are reactivations:
Do not call them new campaigns. Say "reactivación de piezas" or "vuelta a circulación".

If there are new_ads:
Say "nuevos anuncios detectados", but do not infer spend or strategy definitively.

If there are copy_changed events:
Say "ajuste de mensaje". Do not infer positioning change unless volume or repetition supports it.

OUTPUT FORMAT

Return only valid JSON.
No markdown.
No explanations outside JSON.

The JSON must have exactly this shape:

{
  "attentionLevel": "normal | interesting | high_activity | strategic_movement",
  "attentionReason": "short factual explanation",
  "executiveSummary": "2-3 sentence executive summary in Spanish",
  "facts": [
    {
      "entity": "Entity name or Mercado",
      "fact": "Observable fact from the context",
      "importance": "low | medium | high"
    }
  ],
  "hypotheses": [
    {
      "entity": "Entity name or Mercado",
      "hypothesis": "Cautious interpretation",
      "confidence": "low | medium",
      "basis": "What facts support it"
    }
  ],
  "recommendations": [
    {
      "priority": "low | medium | high",
      "action": "Concrete monitoring or business action",
      "reason": "Why this is recommended"
    }
  ],
  "watchTomorrow": [
    "Specific signal to monitor tomorrow"
  ],
  "inactiveEntities": [
    "Strategic entities without relevant activity"
  ],
  "limitationsUsed": [
    "Relevant limitations considered"
  ]
}

Rules:
- hypotheses can be an empty array.
- limitationsUsed can be an empty array.
- Do not include UUIDs.
- Do not include internal JSON field names.
- Do not include markdown.
- Do not include emojis.
- Do not mention model names.`;

const GPT_SYSTEM_PROMPT = `You are the Executive Editor and Compliance Auditor for Hugo.

Your job is to audit Claude's structured analysis and produce final outputs for channels.

You must:
- preserve factual accuracy
- remove hype
- remove unsupported causal claims
- keep facts separate from hypotheses
- preserve the backend attentionLevel
- make the report useful for a business decision-maker
- make the voice version natural and short
- make the email version clean and ready to send

You are not allowed to invent new facts.
You are not allowed to add entities or events not present in the input.
You are not allowed to upgrade the attention level.
You are not allowed to claim spend, budget, sales, performance, intent, or causality unless explicitly supported.
You are not allowed to use emojis.
You are not allowed to use marketing language.

Return only valid JSON.
No markdown outside JSON.

Output shape:

{
  "attentionLevel": "normal | interesting | high_activity | strategic_movement",
  "auditStatus": "passed | corrected",
  "auditNotes": [
    "Brief note about corrections made"
  ],
  "email": {
    "subject": "Short email subject",
    "text": "Plain text email body",
    "html": "Simple HTML email body"
  },
  "dashboard": {
    "headline": "Short headline",
    "summary": "Short dashboard summary",
    "sections": [
      {
        "title": "Section title",
        "content": "Section content"
      }
    ]
  },
  "voice": {
    "script": "Natural short voice-ready script in Spanish",
    "approxSeconds": 0
  },
  "finalAnalysis": {
    "executiveSummary": "...",
    "facts": [],
    "hypotheses": [],
    "recommendations": [],
    "watchTomorrow": [],
    "inactiveEntities": [],
    "limitationsUsed": []
  }
}

Voice rules:
- No bullets.
- No markdown.
- No abbreviations that sound unnatural.
- Maximum 90 words unless attentionLevel is strategic_movement.
- It must sound like Hugo briefing a director.

Email rules:
- Plain text must be readable without HTML.
- HTML must be simple: h2/h3/p/ul/li only.
- No inline CSS.
- No external assets.

Dashboard rules:
- Short sections.
- No long paragraphs.
- Useful for rendering later.`;

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

async function callClaude(hugoContext) {
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

  const parsed = safeJsonParse(text);
  if (!parsed.ok) {
    throw new HugoError(502, { error: 'Invalid JSON from Claude', raw: text });
  }

  logger.info('Claude response parsed', { model: MODEL_ARCHITECT });
  return parsed.value;
}

async function callGpt(claudeAnalysis, hugoContext) {
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

  logger.info('GPT response parsed', { model: MODEL_AUDITOR });
  return parsed.value;
}

async function runHugo({ date } = {}) {
  const startedMs = Date.now();

  logger.info('Hugo run started', { date: date || 'today-utc' });

  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    throw new HugoError(500, { error: 'Missing required Hugo environment variables' });
  }

  // Step 1 — context (reuses the exact GET /reports/hugo-context builder).
  let hugoContext;
  try {
    hugoContext = await buildHugoContext({ date });
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
  const claudeAnalysis = await callClaude(hugoContext);

  // Step 3 — GPT auditor / formatter.
  const gptOutput = await callGpt(claudeAnalysis, hugoContext);

  const durationMs = Date.now() - startedMs;

  logger.info('Hugo run completed', { date: hugoContext.date, durationMs });

  const finalAnalysis = gptOutput.finalAnalysis || {};
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
      status: gptOutput.auditStatus || 'passed',
      notes: gptOutput.auditNotes || [],
    },
    meta: {
      modelArchitect: MODEL_ARCHITECT,
      modelAuditor: MODEL_AUDITOR,
      daysOfHistory: hugoContext.history.daysAvailable,
      totalEvents: hugoContext.today.totalEvents,
      durationMs,
    },
  };
}

module.exports = { runHugo, HugoError };
