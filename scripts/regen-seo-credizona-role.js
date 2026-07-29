/**
 * Discard affected SEO drafts and regenerate with updated Credizona-role prompts.
 * Writes each new HTML to samples/_seo_regen_<slug>.html for review.
 */
require('dotenv').config();
if (!process.env.APIFY_TOKEN) process.env.APIFY_TOKEN = 'regen-placeholder';
if (!process.env.APIFY_ACTOR_ID) process.env.APIFY_ACTOR_ID = 'regen-placeholder';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { generateSeoLandingDraft } = require('../src/services/seo-landing-generator');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const AFFECTED = [
  {
    id: '4cd791c8-b22a-40be-bb31-39637ae4817c',
    term_id: 'eda154f4-cb5a-4c4e-8b4b-fa6067b2d992',
    term: 'préstamo pronto',
  },
  {
    id: 'ab399e07-fe2d-4785-b1c0-d2f4e6681d77',
    term_id: '4f47a2b3-800e-403b-9695-b45ab6f08127',
    term: 'préstamo hipotecario brou simulador',
  },
  {
    id: '2f681255-9f1b-4119-a079-036f1e1b54e1',
    term_id: 'd83ee05d-60e9-4bd1-97c5-99f80985ab6f',
    term: 'crédito consignado',
  },
  {
    id: '24a8cb98-e7c6-4029-8ab1-091c1532fe31',
    term_id: 'e23d5990-3bb7-470a-8fb8-2e756a280c59',
    term: 'prestamos en efectivo',
  },
];

function slugify(term) {
  return String(term)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY / OPENAI_API_KEY');
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'samples');
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];

  for (const item of AFFECTED) {
    console.log('DISCARD', item.id, item.term);
    const { error: discardErr } = await supabase
      .from('seo_landing_drafts')
      .update({ status: 'discarded' })
      .eq('id', item.id);
    if (discardErr) {
      console.error('DISCARD_FAIL', discardErr.message);
      results.push({ ...item, ok: false, error: discardErr.message });
      continue;
    }

    console.log('GENERATE', item.term_id, item.term);
    const gen = await generateSeoLandingDraft({
      termId: item.term_id,
      term: item.term,
    });
    console.log('GENERATE_RESULT', JSON.stringify(gen));

    if (gen.status !== 'draft' || !gen.draftId) {
      results.push({ ...item, ok: false, gen });
      continue;
    }

    const { data: row, error: fetchErr } = await supabase
      .from('seo_landing_drafts')
      .select('id, term_id, status, html_content')
      .eq('id', gen.draftId)
      .single();

    if (fetchErr || !row) {
      results.push({
        ...item,
        ok: false,
        error: fetchErr ? fetchErr.message : 'no row',
        gen,
      });
      continue;
    }

    const file = path.join(outDir, `_seo_regen_${slugify(item.term)}.html`);
    fs.writeFileSync(file, row.html_content || '', 'utf8');

    const html = String(row.html_content || '');
    const stillBad = {
      realizada_por_credizona: /realizada por Credizona/i.test(html),
      evaluacion_por_credizona: /evaluaci[oó]n crediticia.{0,60}Credizona/i.test(html),
      footer_old: /otorgamiento del cr[eé]dito depende del an[aá]lisis de cada perfil/i.test(html),
    };

    results.push({
      oldId: item.id,
      newId: row.id,
      term: item.term,
      term_id: item.term_id,
      status: row.status,
      file,
      htmlBytes: html.length,
      stillBad,
      ok: true,
    });
  }

  console.log('---RESULTS---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
