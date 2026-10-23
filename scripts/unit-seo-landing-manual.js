'use strict';

/**
 * Manual SEO landings, structured edit, and prompt instructions.
 * node scripts/unit-seo-landing-manual.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
    apifyToken: 'test',
    apifyActorId: 'test',
  },
};

const writes = [];
let slugOwners = [];

const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from: function () {
      const state = { filters: [] };
      const builder = {
        insert: function (row) {
          writes.push({ op: 'insert', row: row });
          state.inserted = Object.assign({ id: 'draft-manual-1' }, row);
          return builder;
        },
        update: function (row) {
          writes.push({ op: 'update', row: row });
          return builder;
        },
        select: function () {
          return builder;
        },
        eq: function (column, value) {
          state.filters.push([column, value]);
          return builder;
        },
        in: function () {
          return builder;
        },
        order: function () {
          return builder;
        },
        limit: function () {
          const bySlug = state.filters.some(function (filter) {
            return filter[0] === 'slug';
          });
          return Promise.resolve({
            data: bySlug ? slugOwners : [],
            error: null,
          });
        },
        single: function () {
          return Promise.resolve({ data: state.inserted, error: null });
        },
        then: function (resolve, reject) {
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    storage: {
      from: function () {
        return {
          upload: function () {
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  },
};

const {
  renderLandingHtml,
  createManualLandingDraft,
  regenerateSeoLandingDraft,
  saveStructuredLandingContent,
  normalizeLandingContent,
  buildClaudeUserContent,
  buildGptUserContent,
  seoLandingSlug,
} = require('../src/services/seo-landing-generator');
const { resolveSectionForPath } = require('../src/middleware/dashboardSections');

function hrefs(html) {
  return Array.from(html.matchAll(/href="([^"]+)"/g), function (match) {
    return match[1].replace(/&amp;/g, '&');
  });
}

const instruction = 'Usar tono breve y mencionar solo la cédula, sin prometer aprobación.';
const suggestedTitle = 'Guía para pedir con cédula';

const claudePrompt = buildClaudeUserContent('préstamo con cédula', instruction, suggestedTitle);
const gptPrompt = buildGptUserContent('préstamo con cédula', { h1: 'x' }, instruction, suggestedTitle);
assert.ok(claudePrompt.includes(instruction));
assert.ok(claudePrompt.includes(suggestedTitle));
assert.ok(claudePrompt.includes('INSTRUCCIONES ADICIONALES PARA ESTA GENERACIÓN'));
assert.ok(gptPrompt.includes(instruction));
assert.ok(gptPrompt.includes(suggestedTitle));
assert.strictEqual(seoLandingSlug('Préstamo con cédula'), 'prestamo-con-cedula');
assert.throws(function () {
  seoLandingSlug('!!!');
}, /SEO landing slug is empty or invalid/);

assert.throws(function () {
  normalizeLandingContent({ h1: 12 }, { strict: true });
}, /editable field must be a string/);

const injected = renderLandingHtml('Préstamo con cédula', {
  h1: '<script>alert(1)</script>',
  heroText: '<img src=x onerror=alert(1)>',
  ctaLabel: '<b>Pedir</b>',
  legalDisclaimer: '<script>alert(3)</script>',
  faq: [{ question: '¿Qué necesito?', answer: '</script><script>alert(2)</script>' }],
});
assert.ok(injected.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert.ok(injected.includes('&lt;img src=x onerror=alert(1)&gt;'));
assert.ok(injected.includes('&lt;b&gt;Pedir&lt;/b&gt;'));
assert.strictEqual(injected.includes('<script>alert'), false);
assert.strictEqual(injected.includes('</script><script>'), false);
assert.ok(injected.includes('\\u003c/script'));
const injectedLinks = hrefs(injected);
assert.strictEqual(injectedLinks.length, 2);
assert.strictEqual(new URL(injectedLinks[0]).searchParams.get('seo_cta'), 'hero');
assert.strictEqual(new URL(injectedLinks[1]).searchParams.get('seo_cta'), 'footer');
assert.strictEqual(new URL(injectedLinks[0]).searchParams.get('seo_landing'), 'prestamo-con-cedula');

const legacy = renderLandingHtml('A & B / crédito!!', {
  metaTitle: 'Titulo viejo',
  sections: [{ heading: 'Como funciona', paragraphs: ['Un parrafo'] }],
  faq: [{ question: 'Quien', answer: 'Credizona' }],
});
assert.ok(legacy.includes('seo_landing=a-b-credito&amp;seo_cta=hero'));
assert.ok(legacy.includes('seo_landing=a-b-credito&amp;seo_cta=footer'));
assert.strictEqual(legacy.indexOf('utm_'), -1);

assert.strictEqual(
  resolveSectionForPath('/reports/seo-landing-drafts/manual'),
  'discoveries',
);
assert.strictEqual(
  resolveSectionForPath('/reports/seo-landing-drafts/abc/content'),
  'discoveries',
);
assert.notStrictEqual(resolveSectionForPath('/reports/seo-landing-drafts/manual'), null);

const root = path.join(__dirname, '..');
const dashboardJs = fs.readFileSync(path.join(root, 'public', 'mie-dashboard.js'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(root, 'public', 'mie-dashboard.html'), 'utf8');
assert.ok(dashboardHtml.includes('Creador de landings'));
assert.ok(dashboardHtml.includes('Gestión de landings'));
assert.ok(dashboardHtml.includes('Términos descubiertos'));
assert.ok(dashboardHtml.includes('no está online'));
assert.ok(dashboardJs.includes('No está online'));
assert.ok(dashboardJs.includes('readStructuredEditor'));
assert.strictEqual(dashboardJs.includes('name="html"'), false);
assert.strictEqual(dashboardHtml.includes('/guias/'), false);
assert.ok(dashboardJs.includes('solo marca el estado como Publicado'));
assert.ok(dashboardJs.includes('CZ_FUNNEL_CHANNELS'));

async function main() {
  const created = await createManualLandingDraft({
    topic: 'Préstamo con cédula',
    suggestedTitle: suggestedTitle,
    customInstructions: instruction,
  });
  assert.strictEqual(created.status, 'started');
  assert.strictEqual(created.slug, 'prestamo-con-cedula');
  assert.strictEqual(writes[0].row.term_id, null);
  assert.strictEqual(writes[0].row.origin, 'manual');
  assert.strictEqual(writes[0].row.topic, 'Préstamo con cédula');
  assert.strictEqual(writes[0].row.custom_instructions, instruction);
  assert.strictEqual(writes[0].row.suggested_title, suggestedTitle);
  assert.strictEqual(writes[0].row.html_content, null);

  slugOwners = [{ id: 'draft-other' }];
  const taken = await createManualLandingDraft({ topic: 'Préstamo con cédula' });
  assert.strictEqual(taken.status, 'slug_taken');
  assert.strictEqual(writes.length, 1);
  slugOwners = [];

  await assert.rejects(
    function () { return createManualLandingDraft({ topic: '!!!' }); },
    /SEO landing slug is empty or invalid/,
  );

  const requests = [];
  global.fetch = async function (url, options) {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).includes('anthropic')) {
      return {
        ok: true,
        json: async function () {
          return { content: [{ text: '{"h1":"Borrador"}' }] };
        },
      };
    }
    return {
      ok: true,
      json: async function () {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                metaTitle: 'Titulo',
                h1: '<script>alert(1)</script>',
                ctaLabel: 'Pedir',
                faq: [{ question: 'Q', answer: '</script><script>alert(2)</script>' }],
              }),
            },
          }],
        };
      },
    };
  };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = 'test-key';

  const regenerated = await regenerateSeoLandingDraft({
    draftId: 'draft-manual-1',
    termId: null,
    term: 'Préstamo con cédula',
    customInstructions: instruction,
    suggestedTitle: suggestedTitle,
  });
  assert.strictEqual(regenerated.status, 'draft');
  assert.strictEqual(requests.length, 2);
  assert.ok(requests[0].body.messages[0].content.includes(instruction));
  assert.ok(requests[0].body.messages[0].content.includes(suggestedTitle));
  assert.ok(requests[1].body.messages[1].content.includes(instruction));
  assert.ok(requests[1].body.messages[1].content.includes(suggestedTitle));
  const savedHtml = writes[writes.length - 1].row.html_content;
  assert.ok(savedHtml.includes('seo_cta=hero'));
  assert.ok(savedHtml.includes('seo_cta=footer'));
  assert.strictEqual(savedHtml.includes('<script>alert'), false);
  assert.ok(savedHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

  const edited = await saveStructuredLandingContent({
    draftId: 'draft-manual-1',
    term: 'Préstamo con cédula',
    content: {
      metaTitle: 'Titulo editado',
      h1: 'Encabezado <em>seguro</em>',
      heroText: 'Texto',
      ctaLabel: 'Quiero pedir',
      legalDisclaimer: 'Aviso',
      sections: [{ heading: 'Pasos', paragraphs: ['Primero'] }],
      bullets: ['Cédula'],
      faq: [{ question: '¿Cuándo?', answer: 'Depende' }],
    },
  });
  assert.strictEqual(edited.slug, 'prestamo-con-cedula');
  assert.ok(edited.html.includes('Encabezado &lt;em&gt;seguro&lt;/em&gt;'));
  assert.ok(edited.html.includes('seo_landing=prestamo-con-cedula'));
  assert.ok(edited.html.includes('seo_cta=hero'));
  assert.ok(edited.html.includes('seo_cta=footer'));
  assert.strictEqual(writes[writes.length - 1].row.status, 'draft');
  assert.strictEqual(writes[writes.length - 1].row.content_json.h1, 'Encabezado <em>seguro</em>');

  console.log('OK unit-seo-landing-manual');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
