/**
 * Local QA: organic + ad parsing, 0-ads success, first 3 organic blocks audit.
 * No DB required for parse checks.
 */
const fs = require('fs');
const path = require('path');
const {
  parseGoogleSerpHtml,
  parseOrganicResults,
} = require('../src/steps/collectGoogleSerpImports');
const cheerio = require('cheerio');

const samplesDir = path.join(__dirname, '..', 'samples');
const files = fs
  .readdirSync(samplesDir)
  .filter((n) => n.endsWith('.html') && !n.startsWith('_'));

function auditFirstOrganicBlocks(file, limit = 3) {
  const html = fs.readFileSync(path.join(samplesDir, file), 'utf8');
  const $ = cheerio.load(html);
  const blocks = [];
  $('#rso > div.MjjYud').each((_, el) => {
    if (blocks.length >= limit) return;
    const $el = $(el);
    if ($el.find('[data-text-ad="1"]').length) return;
    if (!$el.find('.tF2Cxc, .N54PNb').length) return;
    const $h3 = $el.find('h3').first();
    if (!$h3.length) return;
    const href = String($h3.closest('a[href]').attr('href') || '');
    if (!/^https?:\/\//i.test(href)) return;
    blocks.push({
      container: 'div.MjjYud',
      classes: el.attribs?.class || '',
      title: $h3.text().replace(/\s+/g, ' ').trim().slice(0, 80),
      href: href.slice(0, 120),
      snippet: ($el.find('div.VwiC3b').first().text() || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    });
  });
  return blocks;
}

console.log('=== Organic selector audit (first 3 blocks per sample) ===\n');
for (const file of files) {
  const blocks = auditFirstOrganicBlocks(file);
  console.log('FILE:', file);
  console.log('  container: #rso > div.MjjYud (with .tF2Cxc / .N54PNb, external h3 link)');
  console.log('  blocks found:', blocks.length >= 3 ? '3+' : blocks.length);
  blocks.forEach((b, i) => {
    console.log(`  [${i + 1}]`, JSON.stringify(b));
  });
  console.log('');
}

console.log('=== parseGoogleSerpHtml summary ===\n');
for (const file of files) {
  const html = fs.readFileSync(path.join(samplesDir, file), 'utf8');
  const parsed = parseGoogleSerpHtml(html);
  const adPositions = parsed.ads.map((a) => a.position);
  const orgPositions = parsed.organic.map((o) => o.position);
  console.log('FILE:', file);
  console.log('  ads:', parsed.ads.length, 'positions:', adPositions.join(','));
  console.log('  organic:', parsed.organic.length, 'positions:', orgPositions.join(','));
  console.log('  parserFoundNoResults:', parsed.parserFoundNoResults);
  console.log('  searchTerm:', parsed.searchTermFromHtml || '(none)');
  if (parsed.organic[0]) {
    console.log('  organic[0]:', {
      domain: parsed.organic[0].advertiser_domain,
      name: parsed.organic[0].advertiser_name,
      placement: parsed.organic[0].placement,
      result_type: parsed.organic[0].result_type,
    });
  }
  console.log('');
}

const pronto = path.join(samplesDir, 'préstamo pronto - Google Search.html');
if (fs.existsSync(pronto)) {
  const p = parseGoogleSerpHtml(fs.readFileSync(pronto, 'utf8'));
  const ok = p.ads.length === 0 && p.organic.length > 0 && !p.parserFoundNoResults;
  console.log('=== 0 ads + N organic success check (préstamo pronto) ===');
  console.log(ok ? 'PASS' : 'FAIL', { ads: p.ads.length, organic: p.organic.length });
}
