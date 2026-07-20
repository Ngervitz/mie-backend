/**
 * Deterministic checks for SERP advertiser ↔ monitored_entities domain matching.
 * No Jest/Mocha in this project — same PASS/FAIL console pattern as
 * scripts/verify-activity-v1-local.js.
 *
 * Run: node scripts/verify-serp-domain-match.js
 */

process.env.APIFY_TOKEN = process.env.APIFY_TOKEN || 'dummy';
process.env.APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || 'dummy';

const {
  normalizeDomain,
  matchAdvertiserToEntities,
} = require('../src/steps/collectGoogleSerpImports');

let failed = 0;

function assert(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) failed += 1;
}

// Mirrors the four backfilled monitored_entities rows (+ one without domain).
const entities = [
  {
    id: '131940fe-6ade-48b5-9d23-d0ca10c55a48',
    name: 'Pronto+',
    website_domain: 'pronto.com.uy',
  },
  {
    id: '4491164a-0a65-439e-afab-1c9541b6f0dc',
    name: 'Creditoamigo',
    website_domain: 'creditoamigo.com.uy',
  },
  {
    id: '0680a0ee-f7d3-4f06-b481-e2ec120e8876',
    name: 'Tu Prestamo',
    website_domain: 'tuprestamo.com.uy',
  },
  {
    id: '8f20fcba-6589-487e-a178-62bada98b8df',
    name: 'Crediton',
    website_domain: 'crediton.com.uy',
  },
  {
    id: 'd04c58e1-8c9b-4e07-a082-e39d176b2b83',
    name: 'Creditel',
    website_domain: null,
  },
];

console.log('=== normalizeDomain ===');
assert('bare hostname', normalizeDomain('pronto.com.uy') === 'pronto.com.uy');
assert('strips https://www.', normalizeDomain('https://www.pronto.com.uy/path') === 'pronto.com.uy');
assert('strips trailing dot', normalizeDomain('pronto.com.uy.') === 'pronto.com.uy');
assert('empty → empty', normalizeDomain('') === '');
assert('nullish → empty', normalizeDomain(null) === '');

console.log('\n=== matchAdvertiserToEntities (exact domain only) ===');

function matchDomain(domain) {
  return matchAdvertiserToEntities({ advertiser_domain: domain }, entities);
}

const alp = matchDomain('alprestamo.uy');
assert(
  'alprestamo.uy must NOT match Tu Prestamo',
  alp === null,
);
assert(
  'alprestamo.uy unmatched (false-positive regression)',
  !(alp && alp.name === 'Tu Prestamo'),
);

const pronto = matchDomain('pronto.com.uy');
assert(
  'pronto.com.uy matches Pronto+',
  pronto && pronto.id === '131940fe-6ade-48b5-9d23-d0ca10c55a48' && pronto.name === 'Pronto+',
);

const amigo = matchDomain('creditoamigo.com.uy');
assert(
  'creditoamigo.com.uy matches Creditoamigo',
  amigo && amigo.id === '4491164a-0a65-439e-afab-1c9541b6f0dc',
);

const tu = matchDomain('tuprestamo.com.uy');
assert(
  'tuprestamo.com.uy matches Tu Prestamo',
  tu && tu.id === '0680a0ee-f7d3-4f06-b481-e2ec120e8876' && tu.name === 'Tu Prestamo',
);

const crediton = matchDomain('crediton.com.uy');
assert(
  'crediton.com.uy matches Crediton',
  crediton && crediton.id === '8f20fcba-6589-487e-a178-62bada98b8df',
);

assert(
  'www.pronto.com.uy still matches (normalization)',
  matchDomain('www.pronto.com.uy') &&
    matchDomain('www.pronto.com.uy').id === '131940fe-6ade-48b5-9d23-d0ca10c55a48',
);

assert(
  'https://tuprestamo.com.uy/foo matches',
  matchDomain('https://tuprestamo.com.uy/foo') &&
    matchDomain('https://tuprestamo.com.uy/foo').id ===
      '0680a0ee-f7d3-4f06-b481-e2ec120e8876',
);

assert(
  'creditel.com.uy unmatched when entity has no website_domain',
  matchDomain('creditel.com.uy') === null,
);

assert(
  'name-only similarity must not match (Tu Prestamo vs alprestamo)',
  matchAdvertiserToEntities(
    { advertiser_name: 'Tu Prestamo', advertiser_domain: 'alprestamo.uy' },
    entities,
  ) === null,
);

console.log(`\n${failed === 0 ? 'ALL PASSED' : failed + ' FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
