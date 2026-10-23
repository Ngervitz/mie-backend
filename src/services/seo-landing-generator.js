const supabase = require('../clients/supabase');
const logger = require('../lib/logger');
const { normalizeSeoLanding } = require('../lib/sanitizeCzTrackingData');
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

function buildClaudeUserContent(term, customInstructions, suggestedTitle) {
  let userContent = `Término de búsqueda objetivo (Google Uruguay): "${term}"\n\nGenerá el contenido JSON de la landing.`;
  const title = String(suggestedTitle || '').trim();
  if (title) {
    userContent +=
      `\n\nTÍTULO SUGERIDO POR EL OPERADOR (preferencia de H1 y metaTitle; no es un dato regulatorio ni una promesa comercial):\n${title}`;
  }
  const extra = String(customInstructions || '').trim();
  if (extra) {
    userContent +=
      `\n\nINSTRUCCIONES ADICIONALES PARA ESTA GENERACIÓN (no permanentes):\n${extra}`;
  }
  return userContent;
}

function buildGptUserContent(term, claudeContent, customInstructions, suggestedTitle) {
  let userContent = `Término objetivo: "${term}"\n\nContenido a auditar:\n${JSON.stringify(claudeContent)}`;
  const title = String(suggestedTitle || '').trim();
  if (title) {
    userContent +=
      `\n\nTÍTULO SUGERIDO POR EL OPERADOR (preferencia de H1 y metaTitle; no es un dato regulatorio ni una promesa comercial):\n${title}`;
  }
  const extra = String(customInstructions || '').trim();
  if (extra) {
    userContent +=
      `\n\nINSTRUCCIONES ADICIONALES PARA ESTA GENERACIÓN (no permanentes):\n${extra}\n` +
      'Respetá estas instrucciones al auditar, sin contradecir las restricciones factuales permanentes.';
  }
  return userContent;
}

async function callClaudeDraft(term, customInstructions, suggestedTitle) {
  logger.info('SEO landing Claude request started', { term, model: MODEL_ARCHITECT });
  const userContent = buildClaudeUserContent(term, customInstructions, suggestedTitle);
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
          content: userContent,
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

async function callGptAudit(term, claudeContent, customInstructions, suggestedTitle) {
  logger.info('SEO landing GPT request started', { term, model: MODEL_AUDITOR });
  const userContent = buildGptUserContent(
    term,
    claudeContent,
    customInstructions,
    suggestedTitle,
  );
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
          content: userContent,
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
  return `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`;
}

function plainLandingText(value, max, strict) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    if (strict) {
      throw new Error('editable field must be a string');
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value).slice(0, max);
    }
    return '';
  }
  return value.trim().slice(0, max);
}

function normalizeLandingContent(input, options) {
  const strict = Boolean(options && options.strict);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('content must be an object');
  }
  const sections = asArray(input.sections)
    .slice(0, 8)
    .map((section) => ({
      heading: plainLandingText(section && section.heading, 160, strict),
      paragraphs: asArray(section && section.paragraphs)
        .slice(0, 4)
        .map((paragraph) => plainLandingText(paragraph, 1200, strict))
        .filter(Boolean),
    }))
    .filter((section) => section.heading || section.paragraphs.length);
  const faq = asArray(input.faq)
    .slice(0, 8)
    .map((item) => ({
      question: plainLandingText(item && item.question, 200, strict),
      answer: plainLandingText(item && item.answer, 800, strict),
    }))
    .filter((item) => item.question || item.answer);
  return {
    metaTitle: plainLandingText(input.metaTitle, 70, strict),
    metaDescription: plainLandingText(input.metaDescription, 180, strict),
    h1: plainLandingText(input.h1, 160, strict),
    heroText: plainLandingText(input.heroText, 800, strict),
    sections,
    bullets: asArray(input.bullets)
      .slice(0, 8)
      .map((bullet) => plainLandingText(bullet, 300, strict))
      .filter(Boolean),
    faq,
    ctaLabel: plainLandingText(input.ctaLabel, 80, strict),
    legalDisclaimer: plainLandingText(input.legalDisclaimer, 2000, strict),
  };
}

/**
 * Optional hero background photo (licensed asset uploaded by Nico to the
 * public `landing-assets` Storage bucket). Read from env so the image can be
 * swapped without a code change. When set, the photo sits BEHIND a dark
 * semi-transparent purple overlay (brand dark tone) so the white headline,
 * body text and CTA keep full contrast — the raw photo never touches the
 * text directly. When unset, the hero falls back to the existing solid
 * purple gradient (previous behavior, unchanged).
 */
function buildHeroBackgroundCss() {
  const imageUrl = String(process.env.SEO_LANDING_HERO_IMAGE_URL || '').trim();
  if (!imageUrl) {
    return 'background: linear-gradient(135deg, var(--cz-primary), var(--cz-dark));';
  }
  // CSS url() literal: escape quotes/backslashes defensively.
  const safeUrl = imageUrl.replace(/\\/g, '\\\\').replace(/"/g, '%22');
  return [
    // Purple-tinted overlay over the photo: reads as brand, not as a clash.
    `background: linear-gradient(rgba(75, 0, 130, 0.62), rgba(46, 8, 84, 0.78)), url("${safeUrl}");`,
    'background-size: cover;',
    'background-position: center;',
  ].join('\n      ');
}

function seoLandingSlug(term) {
  const slug = normalizeSeoLanding(slugifyTerm(term));
  if (!slug) {
    throw new Error('SEO landing slug is empty or invalid');
  }
  return slug;
}

function seoFormCtaUrl(term, cta) {
  const url = new URL(SEO_LANDING_CTA_URL);
  url.searchParams.set('seo_landing', seoLandingSlug(term));
  url.searchParams.set('seo_cta', cta);
  return url.toString();
}

function renderLandingHtml(term, content) {
  const safe = normalizeLandingContent(content || {}, { strict: false });
  const metaTitle = safe.metaTitle || `${term} | Credizona`;
  const metaDescription = safe.metaDescription || '';
  const h1 = safe.h1 || term;
  const heroText = safe.heroText || '';
  const ctaLabel = safe.ctaLabel || 'Solicitá tu préstamo';
  const legal = safe.legalDisclaimer || '';

  const sectionsHtml = asArray(safe.sections)
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

  const bulletsHtml = asArray(safe.bullets)
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join('\n          ');

  const faqHtml = asArray(safe.faq)
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
  ${buildFaqJsonLd(safe.faq)}
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
      ${buildHeroBackgroundCss()}
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
    <a class="cta-btn" href="${escapeHtml(seoFormCtaUrl(term, 'hero'))}">${escapeHtml(ctaLabel)}</a>
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
      <a class="cta-btn" href="${escapeHtml(seoFormCtaUrl(term, 'footer'))}">${escapeHtml(ctaLabel)}</a>
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
async function findSlugOwner(slug) {
  const { data, error } = await supabase
    .from('seo_landing_drafts')
    .select('id')
    .eq('slug', slug)
    .limit(1);
  if (error) {
    throw new Error(`Failed to check landing slug: ${error.message}`);
  }
  return data && data[0] ? data[0].id : null;
}

async function generateSeoLandingDraft({ termId, term }) {
  logger.info('SEO landing generation started', { termId, term });

  let slug;
  try {
    slug = seoLandingSlug(term);
  } catch (err) {
    const message = err && err.message ? err.message : 'SEO landing slug is empty or invalid';
    await recordFailure(termId, message);
    return { status: 'failed', termId, term, error: message };
  }

  // Defensive re-check (the /decide route also checks): a draft/reviewed/
  // published row for this term means we never auto-regenerate.
  if (await hasActiveDraft(termId)) {
    logger.info('SEO landing generation skipped — active draft exists', { termId, term });
    return { status: 'skipped_existing', termId, term };
  }

  const slugOwner = await findSlugOwner(slug);
  if (slugOwner) {
    const message = `SEO landing slug already exists: ${slug}`;
    await recordFailure(termId, message);
    return { status: 'failed', termId, term, error: message };
  }

  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    const message = 'Missing ANTHROPIC_API_KEY / OPENAI_API_KEY';
    await recordFailure(termId, message);
    return { status: 'failed', termId, term, error: message };
  }

  try {
    const draft = await callClaudeDraft(term);
    const audited = await callGptAudit(term, draft);
    const content = normalizeLandingContent(audited, { strict: false });
    const html = renderLandingHtml(term, content);

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
        origin: 'discovered',
        topic: String(term).trim(),
        slug,
        content_json: content,
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

/**
 * Regenerates an EXISTING draft row in place (intentional manual action from
 * the drafts review UI). Unlike generateSeoLandingDraft, this deliberately
 * bypasses the hasActiveDraft guard — regenerating is the whole point — and
 * UPDATEs the existing row instead of inserting a new one, so a term never
 * accumulates duplicate rows. Status always resets to 'draft' (a previously
 * 'reviewed' draft must go through review again after regeneration).
 * Never throws for generation failures; records status='failed' on the row.
 */
async function regenerateSeoLandingDraft({
  draftId,
  termId,
  term,
  customInstructions,
  suggestedTitle,
}) {
  logger.info('SEO landing regeneration started', {
    draftId,
    termId,
    term,
    hasCustomInstructions: Boolean(customInstructions && String(customInstructions).trim()),
  });

  const recordRegenFailure = async (message) => {
    try {
      const { error } = await supabase
        .from('seo_landing_drafts')
        .update({
          status: 'failed',
          generation_error: message,
          generated_at: new Date().toISOString(),
        })
        .eq('id', draftId);
      if (error) {
        logger.error('Failed to record SEO landing regen failure', {
          draftId,
          error: error.message,
        });
      }
    } catch (err) {
      logger.error('Failed to record SEO landing regen failure', { draftId, error: err.message });
    }
  };

  try {
    seoLandingSlug(term);
  } catch (err) {
    const message = err && err.message ? err.message : 'SEO landing slug is empty or invalid';
    await recordRegenFailure(message);
    return { status: 'failed', draftId, termId, term, error: message };
  }

  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    const message = 'Missing ANTHROPIC_API_KEY / OPENAI_API_KEY';
    await recordRegenFailure(message);
    return { status: 'failed', draftId, termId, term, error: message };
  }

  try {
    const instructions = customInstructions && String(customInstructions).trim()
      ? String(customInstructions).trim()
      : null;
    const draft = await callClaudeDraft(term, instructions, suggestedTitle);
    const audited = await callGptAudit(term, draft, instructions, suggestedTitle);
    const content = normalizeLandingContent(audited, { strict: false });
    const html = renderLandingHtml(term, content);
    const slug = seoLandingSlug(term);
    const slugOwner = await findSlugOwner(slug);
    if (slugOwner && slugOwner !== draftId) {
      throw new Error(`SEO landing slug already exists: ${slug}`);
    }

    // Same slug+date naming convention: same-day regeneration overwrites the
    // file (upsert: true); a later-day regeneration gets a fresh date suffix
    // and the row's storage_path points at the new file.
    const upload = await uploadDraftToStorage(term, html);
    if (upload.error) {
      logger.warn('SEO landing regen storage upload failed — draft kept in DB only', {
        term,
        error: upload.error,
      });
    }

    const patch = {
      html_content: html,
      content_json: content,
      topic: String(term).trim(),
      slug,
      custom_instructions: instructions,
      storage_path: upload.path,
      status: 'draft',
      generation_error: null,
      generated_at: new Date().toISOString(),
      reviewed_at: null,
      published_at: null,
    };
    if (suggestedTitle !== undefined) {
      patch.suggested_title = suggestedTitle
        ? String(suggestedTitle).trim().slice(0, 180)
        : null;
    }
    const { error } = await supabase
      .from('seo_landing_drafts')
      .update(patch)
      .eq('id', draftId);

    if (error) {
      throw new Error(`Failed to update seo_landing_drafts row: ${error.message}`);
    }

    logger.info('SEO landing regeneration completed', {
      draftId,
      termId,
      term,
      storagePath: upload.path,
      htmlBytes: html.length,
    });
    return { status: 'draft', draftId, termId, term, storagePath: upload.path };
  } catch (err) {
    const message = err && err.message ? err.message : 'unknown';
    logger.error('SEO landing regeneration failed', { draftId, termId, term, error: message });
    await recordRegenFailure(message);
    return { status: 'failed', draftId, termId, term, error: message };
  }
}

async function createManualLandingDraft({ topic, suggestedTitle, customInstructions }) {
  const topicText = String(topic || '').trim();
  const slug = seoLandingSlug(topicText);
  const owner = await findSlugOwner(slug);
  if (owner) {
    return { status: 'slug_taken', slug, error: `SEO landing slug already exists: ${slug}` };
  }
  const title = suggestedTitle ? String(suggestedTitle).trim().slice(0, 180) : null;
  const instructions = customInstructions
    ? String(customInstructions).trim().slice(0, 4000)
    : null;
  const { data, error } = await supabase
    .from('seo_landing_drafts')
    .insert({
      term_id: null,
      origin: 'manual',
      topic: topicText,
      slug,
      suggested_title: title,
      custom_instructions: instructions,
      content_json: null,
      html_content: null,
      storage_path: null,
      status: 'draft',
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') {
      return { status: 'slug_taken', slug, error: `SEO landing slug already exists: ${slug}` };
    }
    throw new Error(`Failed to insert manual SEO landing draft: ${error.message}`);
  }
  return {
    status: 'started',
    draftId: data.id,
    slug,
    topic: topicText,
    suggestedTitle: title,
    customInstructions: instructions,
  };
}

async function saveStructuredLandingContent({ draftId, term, content }) {
  const slug = seoLandingSlug(term);
  const owner = await findSlugOwner(slug);
  if (owner && owner !== draftId) {
    const err = new Error(`SEO landing slug already exists: ${slug}`);
    err.code = 'slug_taken';
    throw err;
  }
  const structured = normalizeLandingContent(content, { strict: true });
  const html = renderLandingHtml(term, structured);
  const upload = await uploadDraftToStorage(slug, html);
  const { error } = await supabase
    .from('seo_landing_drafts')
    .update({
      html_content: html,
      content_json: structured,
      storage_path: upload.path,
      status: 'draft',
      reviewed_at: null,
      published_at: null,
    })
    .eq('id', draftId);
  if (error) {
    throw new Error(`Failed to save structured landing content: ${error.message}`);
  }
  return { draftId, slug, html, content: structured, storagePath: upload.path };
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

module.exports = {
  generateSeoLandingDraft,
  regenerateSeoLandingDraft,
  createManualLandingDraft,
  saveStructuredLandingContent,
  hasActiveDraft,
  renderLandingHtml,
  slugifyTerm,
  seoLandingSlug,
  normalizeLandingContent,
  buildClaudeUserContent,
  buildGptUserContent,
};
