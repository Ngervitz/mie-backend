'use strict';

/**
 * CTA links on generated SEO landings.
 * node scripts/unit-seo-landing-cta.js
 */

const assert = require('assert');

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
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from: function (table) {
      return {
        insert: function (row) {
          writes.push({ op: 'insert', table: table, row: row });
          return Promise.resolve({ error: null });
        },
        update: function (row) {
          writes.push({ op: 'update', table: table, row: row });
          return {
            eq: function () {
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  },
};

const {
  renderLandingHtml,
  generateSeoLandingDraft,
  regenerateSeoLandingDraft,
} = require('../src/services/seo-landing-generator');

function hrefs(html) {
  return Array.from(html.matchAll(/href="([^"]+)"/g), function (match) {
    return match[1].replace(/&amp;/g, '&');
  });
}

const html = renderLandingHtml('Préstamo solo con la cédula', {
  ctaLabel: 'Solicitá tu préstamo',
});
const links = hrefs(html);
assert.strictEqual(links.length, 2);
assert.notStrictEqual(links[0], links[1]);

const hero = new URL(links[0]);
const footer = new URL(links[1]);
assert.strictEqual(hero.origin + hero.pathname, 'https://www.credizona.com.uy/solicitudes');
assert.strictEqual(footer.origin + footer.pathname, 'https://www.credizona.com.uy/solicitudes');
assert.strictEqual(hero.searchParams.get('seo_landing'), 'prestamo-solo-con-la-cedula');
assert.strictEqual(footer.searchParams.get('seo_landing'), 'prestamo-solo-con-la-cedula');
assert.strictEqual(hero.searchParams.get('seo_cta'), 'hero');
assert.strictEqual(footer.searchParams.get('seo_cta'), 'footer');
assert.strictEqual(hero.searchParams.get('utm_source'), null);
assert.strictEqual(footer.searchParams.get('utm_medium'), null);
assert.ok(html.indexOf('utm_') === -1);

const symbolHtml = renderLandingHtml('A & B / crédito!!', {});
assert.ok(symbolHtml.indexOf('seo_landing=a-b-credito&amp;seo_cta=hero') > 0);
assert.ok(symbolHtml.indexOf('seo_landing=a-b-credito&amp;seo_cta=footer') > 0);
assert.strictEqual(symbolHtml.indexOf('utm_'), -1);

function rejectsSlug(term) {
  assert.throws(
    function () { renderLandingHtml(term, {}); },
    /SEO landing slug is empty or invalid/,
  );
}

rejectsSlug('!!!');
rejectsSlug('');
rejectsSlug('---');
rejectsSlug('a'.repeat(201));

async function main() {
  const generated = await generateSeoLandingDraft({ termId: 7, term: '!!!' });
  assert.strictEqual(generated.status, 'failed');
  assert.strictEqual(generated.error, 'SEO landing slug is empty or invalid');
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].op, 'insert');
  assert.strictEqual(writes[0].row.status, 'failed');
  assert.strictEqual(writes[0].row.html_content, null);
  assert.strictEqual(writes[0].row.generation_error, 'SEO landing slug is empty or invalid');

  const regenerated = await regenerateSeoLandingDraft({
    draftId: 9,
    termId: 7,
    term: '***',
  });
  assert.strictEqual(regenerated.status, 'failed');
  assert.strictEqual(regenerated.error, 'SEO landing slug is empty or invalid');
  assert.strictEqual(writes[1].op, 'update');
  assert.strictEqual(writes[1].row.status, 'failed');
  assert.strictEqual(writes[1].row.html_content, undefined);

  console.log('OK unit-seo-landing-cta');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
