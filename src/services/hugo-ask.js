const { loadDailyKnowledge } = require('./daily-knowledge');
const logger = require('../lib/logger');

// Single-model conversational layer over the already-generated Daily Knowledge.
// This service NEVER regenerates intelligence: no Claude, no buildHugoContext,
// no runHugo. It only answers questions about an existing knowledge object.

const MODEL = 'gpt-4o';
const MAX_HISTORY_ITEMS = 3;
const MAX_QUESTION_CHARS = 2000;
const MAX_HISTORY_FIELD_CHARS = 1000;
const VALID_CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'];

// Structured error so the route can map a safe status + body directly.
class AskError extends Error {
  constructor(status, body) {
    super((body && body.error) || 'Hugo ask error');
    this.status = status;
    this.body = body;
  }
}

const SYSTEM_PROMPT = `Sos Hugo, Director de Inteligencia Competitiva de Credizona Uruguay.

Estás respondiendo preguntas sobre la inteligencia diaria (Daily Knowledge) que ya fue generada para un día específico. Esa inteligencia es tu única fuente de verdad.

REGLAS
- Respondé ÚNICAMENTE con información presente en el Daily Knowledge provisto.
- Nunca inventes hechos, cifras, competidores ni eventos que no estén en el Daily Knowledge.
- Distinguí siempre la evidencia (lo observado) de la interpretación (tu lectura).
- Comunicá la incertidumbre cuando corresponda. No afirmes tendencias sin sustento.
- Si la pregunta no puede responderse con el Daily Knowledge, decilo con claridad y sobriedad.
- Mantené tono ejecutivo, calmo, preciso y analítico, como Alfred.
- Respuesta típica: 2 a 5 párrafos cortos.

PROHIBIDO
- Nunca menciones que sos una IA ni hables de modelos, prompts, arquitectura o implementación.
- Nunca expongas tu razonamiento paso a paso.
- Nunca uses frases como: "Excelente pregunta", "Claro que sí", "Con gusto", "Como asistente", "Puedo ayudarte".

SALIDA
Devolvé EXCLUSIVAMENTE JSON válido, sin markdown y sin texto antes ni después, con esta forma exacta:

{
  "answer": "...",
  "nextQuestions": ["...", "...", "..."],
  "confidence": "LOW|MEDIUM|HIGH"
}

- answer: tu respuesta ejecutiva (2 a 5 párrafos cortos).
- nextQuestions: exactamente tres preguntas de seguimiento en español que profundicen el análisis, específicas y no redundantes con la respuesta.
- confidence: tu confianza en la interpretación (LOW, MEDIUM o HIGH).`;

function truncate(text, max) {
  const str = String(text);
  return str.length > max ? str.slice(0, max) : str;
}

// Keep only the last 3 well-formed { question, answer } items, with both
// fields trimmed and defensively truncated. Malformed items are dropped.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  const clean = [];
  for (const item of history) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const q = typeof item.question === 'string' ? item.question.trim() : '';
    const a = typeof item.answer === 'string' ? item.answer.trim() : '';
    if (!q || !a) {
      continue;
    }
    clean.push({
      question: truncate(q, MAX_HISTORY_FIELD_CHARS),
      answer: truncate(a, MAX_HISTORY_FIELD_CHARS),
    });
  }

  return clean.slice(-MAX_HISTORY_ITEMS);
}

// A valid Daily Knowledge object must carry Hugo's intelligence structure.
function isValidKnowledge(knowledge) {
  return Boolean(
    knowledge
      && typeof knowledge === 'object'
      && knowledge.analysis
      && typeof knowledge.analysis === 'object'
      && knowledge.analysis.brief
      && typeof knowledge.analysis.brief === 'object',
  );
}

// Project only the sections needed to answer questions. This keeps token usage
// bounded and makes future Daily Knowledge growth cheap to optimize without
// changing the endpoint contract.
function buildKnowledgeForModel(knowledge) {
  return {
    date: knowledge.date,
    generatedAt: knowledge.generatedAt,
    attentionLevel: knowledge.attentionLevel,
    analysis: knowledge.analysis,
  };
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false };
  }
}

async function callGpt(payload) {
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    });
  } catch (err) {
    logger.error('Hugo ask GPT request failed', { error: err && err.message });
    throw new AskError(502, { error: 'Failed to generate Hugo answer.' });
  }

  if (!response.ok) {
    logger.error('Hugo ask GPT non-ok response', { status: response.status });
    throw new AskError(502, { error: 'Failed to generate Hugo answer.' });
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new AskError(502, { error: 'Failed to generate Hugo answer.' });
  }

  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : undefined;

  const parsed = typeof content === 'string' ? safeJsonParse(content) : { ok: false };
  if (!parsed.ok) {
    throw new AskError(502, { error: 'Failed to generate Hugo answer.' });
  }

  return parsed.value;
}

async function askHugo({ date, question, history }) {
  const startedMs = Date.now();

  if (!process.env.OPENAI_API_KEY) {
    throw new AskError(500, { error: 'Failed to ask Hugo.' });
  }

  const safeQuestion = truncate(String(question), MAX_QUESTION_CHARS);
  const sanitizedHistory = sanitizeHistory(history);

  logger.info('Hugo ask started', {
    date,
    historyItems: sanitizedHistory.length,
    questionPreview: truncate(safeQuestion, 120),
  });

  // Load existing Daily Knowledge. Never regenerate it.
  const knowledge = await loadDailyKnowledge(date);
  if (!isValidKnowledge(knowledge)) {
    throw new AskError(404, { error: 'Daily Knowledge not found for requested date.' });
  }

  logger.info('Daily Knowledge loaded', { date });

  const payload = {
    knowledge: buildKnowledgeForModel(knowledge),
    question: safeQuestion,
    history: sanitizedHistory,
  };

  const gptJson = await callGpt(payload);
  logger.info('GPT completed', { date });

  const answer = typeof gptJson.answer === 'string' ? gptJson.answer.trim() : '';
  if (!answer) {
    throw new AskError(502, { error: 'Failed to generate Hugo answer.' });
  }

  const nextQuestions = Array.isArray(gptJson.nextQuestions)
    ? gptJson.nextQuestions.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim())
    : [];

  const confidence = VALID_CONFIDENCE.includes(gptJson.confidence)
    ? gptJson.confidence
    : 'MEDIUM';

  logger.info('Hugo ask completed', { date, durationMs: Date.now() - startedMs });

  return {
    answer,
    nextQuestions,
    confidence,
    actions: [],
    usedContext: {
      date,
      historyItems: sanitizedHistory.length,
    },
  };
}

module.exports = { askHugo, AskError };
