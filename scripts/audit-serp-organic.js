const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const samplesDir = 'samples';
const files = fs
  .readdirSync(samplesDir)
  .filter((n) => n.endsWith('.html') && !n.startsWith('_'));

function short(s, n = 120) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

function ancestry(el, depth = 8) {
  const parts = [];
  let cur = el;
  for (let i = 0; i < depth && cur && cur.type === 'tag'; i++) {
    const id = cur.attribs?.id ? '#' + cur.attribs.id : '';
    const cls = cur.attribs?.class
      ? '.' + cur.attribs.class.split(/\s+/).slice(0, 3).join('.')
      : '';
    const data = [];
    if (cur.attribs) {
      for (const [k, v] of Object.entries(cur.attribs)) {
        if (k.startsWith('data-') || k === 'role' || k === 'jscontroller') {
          data.push(k + '=' + String(v).slice(0, 30));
        }
      }
    }
    parts.push(cur.tagName + id + cls + (data.length ? '[' + data.slice(0, 4).join(',') + ']' : ''));
    cur = cur.parent;
  }
  return parts;
}

for (const file of files) {
  const full = path.join(samplesDir, file);
  const html = fs.readFileSync(full, 'utf8');
  const $ = cheerio.load(html);
  console.log('\n======== FILE', file, 'bytes=', html.length, '========');

  const probes = [
    'div.g',
    'div[data-sokoban-container]',
    'div[data-hveid]',
    '#rso',
    '#search',
    'div.MjjYud',
    'div.g Ww4FFb',
    'div[jscontroller][data-hveid]',
    'a > h3',
    'div[data-snf]',
    'div[data-snh]',
    'div.N54PNb',
    'div.tF2Cxc',
    'div.Gx5Zad',
    'div.kvH3gc',
    'div[data-ved] h3',
  ];
  for (const sel of probes) {
    try {
      const n = $(sel).length;
      if (n) console.log('  count', sel, '=', n);
    } catch (_) {}
  }

  // Candidate organic blocks: #rso descendants with h3 inside an external link
  const rso = $('#rso');
  console.log('  #rso exists=', rso.length > 0);

  const candidates = [];
  $('#rso a').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    if (/google\./i.test((() => { try { return new URL(href).hostname; } catch { return ''; } })())) return;
    const $h3 = $(a).find('h3');
    if (!$h3.length) return;
    // climb to a block that looks like a result card
    let block = a;
    for (let i = 0; i < 8 && block; i++) {
      block = block.parent;
      if (!block || block.type !== 'tag') break;
      const cls = block.attribs?.class || '';
      const id = block.attribs?.id || '';
      // stop at rso children-ish
      if (id === 'rso') break;
    }
  });

  // Better approach: find h3 whose parent/ancestor link is external
  const seen = new Set();
  $('#rso h3').each((_, h3) => {
    const $h3 = $(h3);
    const title = short($h3.text(), 100);
    if (!title) return;

    // Find enclosing <a>
    let $a = $h3.closest('a[href]');
    if (!$a.length) {
      // sometimes h3 is sibling structure
      $a = $h3.parents().find('a[href]').first();
      $a = $h3.parent().is('a') ? $h3.parent() : $h3.closest('a');
    }
    const href = ($a.attr('href') || '').trim();
    if (!/^https?:\/\//i.test(href)) return;
    let host = '';
    try {
      host = new URL(href).hostname;
    } catch {
      return;
    }
    if (/google\./i.test(host)) return;

    // Find a reasonable container: climb until class MjjYud or g or data-hveid block
    let container = h3;
    let chosen = null;
    for (let i = 0; i < 12 && container; i++) {
      container = container.parent;
      if (!container || container.type !== 'tag') break;
      const cls = (container.attribs?.class || '').split(/\s+/);
      const has = (c) => cls.includes(c);
      if (
        has('MjjYud') ||
        has('g') ||
        has('tF2Cxc') ||
        has('N54PNb') ||
        container.attribs?.['data-hveid'] ||
        container.attribs?.['data-sokoban-container'] !== undefined
      ) {
        chosen = container;
        // prefer outermost MjjYud if present later
        if (has('MjjYud')) break;
      }
    }
    if (!chosen) chosen = $h3.closest('div').get(0);

    const key = href + '|' + title;
    if (seen.has(key)) return;
    seen.add(key);

    const $c = $(chosen);
    // skip if inside ad
    if ($c.closest('[data-text-ad="1"]').length) return;
    if ($c.closest('#tads, #tadsb, #bottomads, #tvcap').length && !$c.closest('#rso').length) return;

    // snippet candidates
    const snips = [];
    $c.find('div, span').each((__, n) => {
      const t = short($(n).text(), 200);
      if (t.length >= 40 && t.length <= 320 && !t.includes(title.slice(0, 20))) {
        snips.push(t);
      }
    });

    // cite / displayed url
    const cite = short($c.find('cite').first().text(), 80);

    candidates.push({
      title,
      href: href.slice(0, 160),
      host,
      cite,
      containerTag: chosen.tagName,
      containerClass: (chosen.attribs?.class || '').slice(0, 80),
      containerId: chosen.attribs?.id || '',
      dataHveid: chosen.attribs?.['data-hveid'] || '',
      dataAttrs: Object.keys(chosen.attribs || {})
        .filter((k) => k.startsWith('data-'))
        .slice(0, 8),
      ancestry: ancestry(chosen, 6),
      snipSample: snips[0] || null,
    });
  });

  console.log('  organic candidate count=', candidates.length);
  candidates.slice(0, 3).forEach((c, i) => {
    console.log('\n  --- organic', i + 1, '---');
    console.log(JSON.stringify(c, null, 2));
  });

  // Also dump distinct classes of #rso > * children
  const childClasses = new Map();
  $('#rso')
    .children()
    .each((_, el) => {
      const cls = el.attribs?.class || '(no-class)';
      childClasses.set(cls, (childClasses.get(cls) || 0) + 1);
    });
  console.log('\n  #rso direct children classes:', [...childClasses.entries()].slice(0, 15));
}
