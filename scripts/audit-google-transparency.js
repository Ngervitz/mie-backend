/**
 * AUDIT-ONLY (one-off, NOT part of the deployed app): feasibility test of
 * Google Ads Transparency Center (adstransparency.google.com) as a potential
 * competitor data source.
 *
 * Zero DB dependency by design: the competitor list below was confirmed
 * against the real monitored_entities table (is_self=false) via a separate
 * one-off query on 2026-07-18 and hardcoded here.
 *
 * Access pattern (confirmed by probing, Phase 1):
 *  - POST https://adstransparency.google.com/anji/_/rpc/SearchService/SearchSuggestions
 *    Content-Type: application/x-www-form-urlencoded, body: f.req=<url-encoded JSON>
 *    Request shape: {"1":"<text>","2":<maxResults>} — plain fetch works, no browser.
 *    Response: {"1":[{"1":{"1":name,"2":advertiserId,"3":countryCode,
 *                          "4":{"2":{"1":lo,"2":hi}}  <- approx ad count range,
 *                          "5":true (verification-related flag on some rows)}}]}
 *  - POST .../SearchService/SearchCreatives — same encoding; heavily
 *    rate-limited (captcha 429 after a handful of rapid calls), so this script
 *    only calls it for names that actually resolved, with long spacing.
 *    Request shape: {"2":<limit>,"3":{"13":{"1":[advertiserId]}}}
 *
 * Region: SearchSuggestions does NOT accept a region filter (400 on every
 * region-field variant probed) — resolution is region=anywhere; the response's
 * own country code (field "3") is reported instead so relevance can be judged.
 *
 * Run: node scripts/audit-google-transparency.js
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://adstransparency.google.com/anji/_/rpc/';
const SUGGEST_DELAY_MS = 8000;
const CREATIVES_DELAY_MS = 30000;
const MAX_ATTEMPTS = 4;

// Real monitored_entities (is_self=false) as of 2026-07-18. "Credigo" is
// currently paused (active=false) in the table but included for coverage.
const COMPETITORS = [
  'ANDA',
  'Cash',
  'ChauDeudas',
  'COSSAC',
  'Credifama',
  'Credigo',
  'Credisol',
  'Creditel',
  'Crédito de Valor',
  'Crediton',
  'FUCAC',
  'Fucerep',
  'MiDeuda',
  'Ponete al Día',
  'Préstamos en la Mano',
  'Pronto+',
  'Rápido y Fácil',
  'Verde',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function rpc(service, reqObj, label) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(BASE + service + '?authuser=', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'f.req=' + encodeURIComponent(JSON.stringify(reqObj)),
    });
    if (res.status === 429) {
      const wait = 45000 * attempt;
      console.log(`  [${label}] 429 rate-limited, attempt ${attempt}/${MAX_ATTEMPTS}, waiting ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (res.status !== 200) {
      return { status: res.status, error: text.slice(0, 200) };
    }
    try {
      return { status: 200, data: JSON.parse(text) };
    } catch (e) {
      return { status: 200, error: 'non-JSON body: ' + text.slice(0, 200) };
    }
  }
  return { status: 429, error: 'still rate-limited after retries' };
}

async function resolveAdvertiser(name) {
  const out = await rpc('SearchService/SearchSuggestions', { 1: name, 2: 10 }, name);
  if (out.error) return { error: `HTTP ${out.status}: ${out.error}` };
  const entries = (out.data && out.data['1']) || [];
  const advertisers = entries
    .map((e) => e['1'])
    .filter(Boolean)
    .map((a) => ({
      name: a['1'],
      advertiserId: a['2'],
      country: a['3'],
      adCountLow: a['4'] && a['4']['2'] ? a['4']['2']['1'] : null,
      adCountHigh: a['4'] && a['4']['2'] ? a['4']['2']['2'] : null,
    }));
  const target = normalize(name);
  // Exact normalized match first; then prefix match. Never fuzzy beyond that —
  // generic names ("Cash", "Verde") match unrelated foreign advertisers.
  const exact = advertisers.filter((a) => normalize(a.name) === target);
  const prefix = advertisers.filter((a) => normalize(a.name).startsWith(target));
  return { advertisers, best: exact[0] || prefix[0] || null };
}

async function countCreatives(advertiserId, label) {
  const out = await rpc('SearchService/SearchCreatives', { 2: 20, 3: { 13: { 1: [advertiserId] } } }, label);
  if (out.error) return { error: `HTTP ${out.status}: ${out.error}` };
  const rows = (out.data && out.data['1']) || [];
  return { creativesReturned: rows.length, raw: Object.keys(out.data || {}) };
}

(async () => {
  const results = [];
  for (const name of COMPETITORS) {
    console.log(`\n--- ${name} ---`);
    const resolved = await resolveAdvertiser(name);
    if (resolved.error) {
      console.log('  suggestion error:', resolved.error);
      results.push({ name, found: false, error: resolved.error });
      await sleep(SUGGEST_DELAY_MS);
      continue;
    }
    console.log(`  candidates: ${resolved.advertisers.length}`);
    resolved.advertisers.forEach((a) =>
      console.log(`    - ${a.name} [${a.country}] ${a.advertiserId} ads~${a.adCountLow}-${a.adCountHigh}`),
    );
    if (!resolved.best) {
      results.push({ name, found: false, candidates: resolved.advertisers.length });
      await sleep(SUGGEST_DELAY_MS);
      continue;
    }
    const entry = {
      name,
      found: true,
      matchName: resolved.best.name,
      advertiserId: resolved.best.advertiserId,
      country: resolved.best.country,
      adCountLow: resolved.best.adCountLow,
      adCountHigh: resolved.best.adCountHigh,
    };
    console.log(`  RESOLVED: ${entry.matchName} [${entry.country}] ${entry.advertiserId}`);
    await sleep(CREATIVES_DELAY_MS);
    const creatives = await countCreatives(entry.advertiserId, name);
    if (creatives.error) {
      entry.creatives = `error: ${creatives.error}`;
    } else {
      entry.creatives = creatives.creativesReturned;
    }
    console.log(`  creatives check: ${JSON.stringify(entry.creatives)}`);
    results.push(entry);
    await sleep(SUGGEST_DELAY_MS);
  }

  console.log('\n\n## Resumen (Markdown)\n');
  console.log('| Competidor | ¿Encontrado en Buscador? (Sí/No) | ID de Anunciante | Cantidad de Anuncios Activos |');
  console.log('|---|---|---|---|');
  for (const r of results) {
    if (!r.found) {
      console.log(`| ${r.name} | No — No verificado / No elegible | — | — |`);
    } else {
      const count =
        typeof r.creatives === 'number'
          ? `${r.creatives} creativos devueltos (rango sugerencias: ${r.adCountLow}-${r.adCountHigh})`
          : `rango sugerencias: ${r.adCountLow}-${r.adCountHigh} (creatives: ${r.creatives})`;
      console.log(`| ${r.name} | Sí — "${r.matchName}" [${r.country}] | ${r.advertiserId} | ${count} |`);
    }
  }
})().catch((e) => {
  console.error('AUDIT ERROR:', e.message);
  process.exit(1);
});
