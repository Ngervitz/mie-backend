const fs = require('fs');
const cheerio = require('cheerio');

const file = 'samples/prestamos con cedula - Google Search.html';
const $ = cheerio.load(fs.readFileSync(file, 'utf8'));

// Focus on first few MjjYud blocks inside #rso that look like web results
const blocks = [];
$('#rso > div.MjjYud').each((i, el) => {
  const $el = $(el);
  if ($el.find('[data-text-ad="1"]').length) {
    blocks.push({ i: i + 1, type: 'contains-ad', skip: true });
    return;
  }
  const $h3 = $el.find('h3').first();
  if (!$h3.length) {
    blocks.push({ i: i + 1, type: 'no-h3', classes: $el.find('div').first().attr('class'), skip: true });
    return;
  }
  const $a = $h3.closest('a[href]');
  const href = $a.attr('href') || '';
  // structure dump shallow
  const tree = [];
  function walk(node, depth) {
    if (depth > 5 || !node || node.type !== 'tag') return;
    const $n = $(node);
    const own = $n
      .contents()
      .filter((_, c) => c.type === 'text')
      .text()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const attrs = [];
    ['class', 'role', 'data-snf', 'data-snh', 'href'].forEach((k) => {
      const v = $n.attr(k);
      if (v) attrs.push(k + '=' + String(v).slice(0, 50));
    });
    tree.push('  '.repeat(depth) + node.tagName + (attrs.length ? ' [' + attrs.join(' ') + ']' : '') + (own ? ' "' + own + '"' : ''));
    $n.children().each((_, c) => walk(c, depth + 1));
  }
  walk(el, 0);

  // cite + brand-like spans
  const cite = $el.find('cite').first().text().replace(/\s+/g, ' ').trim();
  const brands = [];
  $el.find('span').each((_, sp) => {
    if ($(sp).children().length) return;
    const t = $(sp).text().replace(/\s+/g, ' ').trim();
    if (t && t.length > 1 && t.length < 40 && !t.includes('›') && !/^https?:/i.test(t)) brands.push(t);
  });

  // Better snippet: elements with data-snf
  const snf = $el.find('[data-snf]').first().text().replace(/\s+/g, ' ').trim().slice(0, 200);

  blocks.push({
    i: i + 1,
    title: $h3.text().replace(/\s+/g, ' ').trim(),
    href: href.slice(0, 120),
    cite,
    brands: [...new Set(brands)].slice(0, 8),
    snf: snf || null,
    hasTF2Cxc: $el.find('.tF2Cxc').length > 0,
    hasN54PNb: $el.find('.N54PNb').length > 0,
    tree: tree.slice(0, 40),
  });
});

console.log('MjjYud blocks in #rso:', blocks.length);
blocks.slice(0, 5).forEach((b) => {
  console.log('\n==== block', b.i, '====');
  console.log('title:', b.title);
  console.log('href:', b.href);
  console.log('cite:', b.cite);
  console.log('brands:', b.brands);
  console.log('snf:', b.snf);
  console.log('tF2Cxc/N54PNb:', b.hasTF2Cxc, b.hasN54PNb);
  console.log(b.tree.join('\n'));
});
