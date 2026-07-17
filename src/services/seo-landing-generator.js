const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const {
  SEO_LANDING_CTA_URL,
  SEO_LANDING_CLAUDE_SYSTEM_PROMPT,
  SEO_LANDING_GPT_SYSTEM_PROMPT,
} = require('../config/seo-landing-prompts');

/**
 * SEO landing DRAFT generator (Claude drafts -> GPT audits), following the
 * same two-stage pattern as hugo-brain.js / own-ads-brief.js.
 *
 * Output is ALWAYS a draft: rows land in seo_landing_drafts with
 * status='draft' and the .html file goes to a Supabase Storage bucket for
 * manual download -> manual cPanel upload. There is NO auto-publish code
 * path here by design (regulatory review required before publishing).
 *
 * Error contract: this function never throws for generation failures — it
 * records status='failed' + generation_error on the row and returns the
 * failure state, so async callers/UI can surface it.
 */

const MODEL_ARCHITECT = 'claude-sonnet-4-6';
const MODEL_AUDITOR = 'gpt-4o';
const DEFAULT_BUCKET = 'seo-landings-credizona';

// Visual identity: Credizona's real site uses a deep purple/violet palette
// (NOT Mi Plan's navy/cyan — cyan tones are explicitly prohibited here).
// Hex values estimated from a screenshot, not extracted from site CSS
// (site blocks scraping) — adjust visually if needed, don't treat as
// verified brand constants. The dashboard's own CSS variables
// (mie-dashboard.css) are deliberately NOT reused: that's the MIE/Mi Plan
// aesthetic, not Credizona's.
const BRAND = Object.freeze({
  primary: '#4B0082',
  dark: '#2E0854',
  lightBg: '#F9F6FC',
  white: '#FFFFFF',
});

function getBucket() {
  return process.env.SEO_LANDINGS_BUCKET || DEFAULT_BUCKET;
}

function slugifyTerm(name) {
  // Same slug convention as monitored_entities.slug (frontend slugifyEntityName).
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function extractJsonObject(text) {
  let candidate = String(text).trim();
  candidate = candidate.replace(/```json/gi, '').replace(/```/g, '').trim();
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }
  return safeJsonParse(candidate);
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function callClaudeDraft(term) {
  logger.info('SEO landing Claude request started', { term, model: MODEL_ARCHITECT });
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_ARCHITECT,
      max_tokens: 4000,
      temperature: 0.4,
      system: SEO_LANDING_CLAUDE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Término de búsqueda objetivo (Google Uruguay): "${term}"\n\nGenerá el contenido JSON de la landing.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude request failed (HTTP ${response.status})`);
  }
  const data = await response.json();
  const text =
    data && Array.isArray(data.content) && data.content[0] && data.content[0].text
      ? data.content[0].text
      : '';
  const parsed = extractJsonObject(text);
  if (!parsed.ok) {
    throw new Error(`Claude returned invalid JSON: ${parsed.error}`);
  }
  logger.info('SEO landing Claude response parsed', { term });
  return parsed.value;
}

async function callGptAudit(term, claudeContent) {
  logger.info('SEO landing GPT request started', { term, model: MODEL_AUDITOR });
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
        { role: 'system', content: SEO_LANDING_GPT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Término objetivo: "${term}"\n\nContenido a auditar:\n${JSON.stringify(claudeContent)}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`GPT request failed (HTTP ${response.status})`);
  }
  const data = await response.json();
  const text =
    data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
  const parsed = extractJsonObject(text);
  if (!parsed.ok) {
    throw new Error(`GPT returned invalid JSON: ${parsed.error}`);
  }
  logger.info('SEO landing GPT response parsed', { term });
  return parsed.value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildFaqJsonLd(faq) {
  const entities = asArray(faq)
    .filter((f) => f && f.question && f.answer)
    .map((f) => ({
      '@type': 'Question',
      name: String(f.question),
      acceptedAnswer: { '@type': 'Answer', text: String(f.answer) },
    }));
  if (!entities.length) return '';
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entities,
  };
  return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
}

function renderLandingHtml(term, content) {
  const metaTitle = content.metaTitle || `${term} | Credizona`;
  const metaDescription = content.metaDescription || '';
  const h1 = content.h1 || term;
  const heroText = content.heroText || '';
  const ctaLabel = content.ctaLabel || 'Solicitá tu préstamo';
  const legal = content.legalDisclaimer || '';

  const sectionsHtml = asArray(content.sections)
    .map((s) => {
      const paragraphs = asArray(s && s.paragraphs)
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join('\n        ');
      return `
      <section class="content-section">
        <h2>${escapeHtml(s && s.heading)}</h2>
        ${paragraphs}
      </section>`;
    })
    .join('\n');

  const bulletsHtml = asArray(content.bullets)
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join('\n          ');

  const faqHtml = asArray(content.faq)
    .map(
      (f) => `
        <details class="faq-item">
          <summary>${escapeHtml(f && f.question)}</summary>
          <p>${escapeHtml(f && f.answer)}</p>
        </details>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="es-UY">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(metaTitle)}</title>
  <meta name="description" content="${escapeHtml(metaDescription)}" />
  <meta property="og:title" content="${escapeHtml(metaTitle)}" />
  <meta property="og:description" content="${escapeHtml(metaDescription)}" />
  <meta property="og:type" content="website" />
  ${buildFaqJsonLd(content.faq)}
  <style>
    :root {
      --cz-primary: ${BRAND.primary};
      --cz-dark: ${BRAND.dark};
      --cz-light-bg: ${BRAND.lightBg};
      --cz-white: ${BRAND.white};
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', -apple-system, Roboto, Arial, sans-serif;
      color: #241533;
      background: var(--cz-white);
      line-height: 1.6;
    }
    .hero {
      background: linear-gradient(135deg, var(--cz-primary), var(--cz-dark));
      color: var(--cz-white);
      padding: 56px 20px 64px;
      text-align: center;
    }
    .hero .brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      font-size: 20px;
      letter-spacing: 0.5px;
      margin-bottom: 28px;
    }
    .hero .brand .dot {
      width: 12px; height: 12px; border-radius: 50%;
      background: var(--cz-white); display: inline-block;
    }
    .hero h1 { font-size: clamp(28px, 5vw, 42px); font-weight: 800; max-width: 780px; margin: 0 auto 16px; }
    .hero p { font-size: 18px; max-width: 640px; margin: 0 auto 28px; opacity: 0.95; }
    .cta-btn {
      display: inline-block;
      background: var(--cz-white);
      color: var(--cz-primary);
      font-weight: 800;
      font-size: 17px;
      padding: 14px 36px;
      border-radius: 999px;
      text-decoration: none;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      box-shadow: 0 6px 18px rgba(0,0,0,0.25);
    }
    .cta-btn:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(0,0,0,0.3); }
    main { max-width: 820px; margin: 0 auto; padding: 40px 20px; }
    .content-section { margin-bottom: 32px; }
    .content-section h2 { color: var(--cz-dark); font-size: 24px; margin-bottom: 12px; }
    .content-section p { margin-bottom: 12px; }
    .benefits {
      background: var(--cz-light-bg);
      border-radius: 16px;
      padding: 24px 28px;
      margin-bottom: 32px;
    }
    .benefits h2 { color: var(--cz-dark); font-size: 22px; margin-bottom: 12px; }
    .benefits ul { padding-left: 20px; }
    .benefits li { margin-bottom: 8px; }
    .faq { margin-bottom: 40px; }
    .faq h2 { color: var(--cz-dark); font-size: 24px; margin-bottom: 16px; }
    .faq-item {
      border: 1px solid #E5DBF0;
      border-radius: 12px;
      padding: 14px 18px;
      margin-bottom: 10px;
      background: var(--cz-white);
    }
    .faq-item summary { font-weight: 700; cursor: pointer; color: var(--cz-dark); }
    .faq-item p { margin-top: 10px; }
    .cta-block {
      text-align: center;
      background: linear-gradient(135deg, var(--cz-primary), var(--cz-dark));
      border-radius: 20px;
      padding: 40px 24px;
      color: var(--cz-white);
      margin-bottom: 40px;
    }
    .cta-block h2 { font-size: 26px; margin-bottom: 16px; }
    footer {
      background: var(--cz-light-bg);
      padding: 28px 20px;
      font-size: 13px;
      color: #5C4A70;
      text-align: center;
    }
    footer .legal { max-width: 820px; margin: 0 auto; }
  </style>
</head>
<body>
  <header class="hero">
    <div class="brand"><span class="dot" aria-hidden="true"></span>Credizona</div>
    <h1>${escapeHtml(h1)}</h1>
    <p>${escapeHtml(heroText)}</p>
    <a class="cta-btn" href="${SEO_LANDING_CTA_URL}">${escapeHtml(ctaLabel)}</a>
  </header>
  <main>
${sectionsHtml}
    <div class="benefits">
      <h2>Lo que tenés que saber</h2>
      <ul>
          ${bulletsHtml}
      </ul>
    </div>
    <section class="faq">
      <h2>Preguntas frecuentes</h2>
${faqHtml}
    </section>
    <div class="cta-block">
      <h2>¿Listo para dar el paso?</h2>
      <a class="cta-btn" href="${SEO_LANDING_CTA_URL}">${escapeHtml(ctaLabel)}</a>
    </div>
  </main>
  <footer>
    <div class="legal">${escapeHtml(legal)}</div>
  </footer>
</body>
</html>`;
}

async function uploadDraftToStorage(term, html) {
  const bucket = getBucket();
  const date = new Date().toISOString().split('T')[0];
  const fileName = `${slugifyTerm(term)}-${date}.html`;
  const { error } = await supabase.storage
    .from(bucket)
    .upload(fileName, Buffer.from(html, 'utf-8'), {
      contentType: 'text/html; charset=utf-8',
      upsert: true,
    });
  if (error) {
    return { path: null, error: error.message };
  }
  return { path: `${bucket}/${fileName}`, error: null };
}

async function hasActiveDraft(termId) {
  const { data, error } = await supabase
    .from('seo_landing_drafts')
    .select('id, status')
    .eq('term_id', termId)
    .in('status', ['draft', 'reviewed', 'published'])
    .limit(1);
  if (error) {
    throw new Error(`Failed to check existing drafts: ${error.message}`);
  }
  return Boolean(data && data.length);
}

/**
 * Generates a landing draft for a confirmed term. Never throws for
 * generation failures; records them on the row instead.
 * Returns { status: 'draft'|'failed'|'skipped_existing', ... }.
 */
async function generateSeoLandingDraft({ termId, term }) {
  logger.info('SEO landing generation started', { termId, term });

  // Defensive re-check (the /decide route also checks): a draft/reviewed/
  // published row for this term means we never auto-regenerate.
  if (await hasActiveDraft(termId)) {
    logger.info('SEO landing generation skipped — active draft exists', { termId, term });
    return { status: 'skipped_existing', termId, term };
  }

  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    const message = 'Missing ANTHROPIC_API_KEY / OPENAI_API_KEY';
    await recordFailure(termId, message);
    return { status: 'failed', termId, term, error: message };
  }

  try {
    const draft = await callClaudeDraft(term);
    const audited = await callGptAudit(term, draft);
    const html = renderLandingHtml(term, audited);

    // Storage upload is best-effort: the DB row (html_content) is the
    // primary asset; a missing storage_path is visible and recoverable.
    const upload = await uploadDraftToStorage(term, html);
    if (upload.error) {
      logger.warn('SEO landing storage upload failed — draft kept in DB only', {
        term,
        error: upload.error,
      });
    }

    const { data, error } = await supabase
      .from('seo_landing_drafts')
      .insert({
        term_id: termId,
        html_content: html,
        storage_path: upload.path,
        status: 'draft',
        generated_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to insert seo_landing_drafts row: ${error.message}`);
    }

    logger.info('SEO landing generation completed', {
      termId,
      term,
      draftId: data.id,
      storagePath: upload.path,
      htmlBytes: html.length,
    });
    return { status: 'draft', termId, term, draftId: data.id, storagePath: upload.path };
  } catch (err) {
    const message = err && err.message ? err.message : 'unknown';
    logger.error('SEO landing generation failed', { termId, term, error: message });
    await recordFailure(termId, message);
    return { status: 'failed', termId, term, error: message };
  }
}

async function recordFailure(termId, message) {
  try {
    const { error } = await supabase.from('seo_landing_drafts').insert({
      term_id: termId,
      html_content: null,
      storage_path: null,
      status: 'failed',
      generation_error: message,
      generated_at: new Date().toISOString(),
    });
    if (error) {
      logger.error('Failed to record SEO landing failure row', { termId, error: error.message });
    }
  } catch (err) {
    logger.error('Failed to record SEO landing failure row', { termId, error: err.message });
  }
}

module.exports = { generateSeoLandingDraft, hasActiveDraft, renderLandingHtml, slugifyTerm };
