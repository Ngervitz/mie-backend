'use strict';

/**
 * Mi Deuda Stage 2 — READ-ONLY proposal of `miplan_declared` aliases from Mi Plan CREDITOR_DICT.
 *
 * Reads Mi Plan js/creditors.js (never modifies it), extracts CREDITOR_DICT in an isolated VM
 * context, re-keys every alias with creditor_key_v1 and classifies it:
 *   SAFE       → approved alias (existing Stage 1 creditor or a NEW creditor proposal)
 *   AMBIGUOUS  → seeded as status='ambiguous' (no creditor): category / generic word / network
 *   UNSAFE     → NOT seeded; stays UNKNOWN until a human decides with evidence
 * Any dictionary key not covered by the reviewed policy is UNSAFE (fail closed).
 * Output is a proposal for mandatory human review. No DB, no network, no writes.
 *
 * Run: node scripts/propose-miplan-declared-aliases-ro.js [--creditors=<path>] [--json]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { creditorKeyV1 } = require('../src/lib/creditorCatalog');
const { CREDITOR_SEED } = require('../src/lib/creditorCatalogBcuSeed');

const DEFAULT_CREDITORS_PATH = path.resolve(__dirname, '..', '..', '..', 'CZReset', 'CZMiplan', 'js', 'creditors.js');

/** Keys the product owner flagged as risky: never SAFE without explicit evidence. */
const FLAGGED_RISKY = Object.freeze([
  'pass', 'alfa', 'master', 'visa', 'mastercard', 'cash', 'republica',
  'persona', 'particular', 'familiar', 'amigo', 'prestamista',
]);

const EXISTING = new Set(CREDITOR_SEED.map(function (c) { return c.slug; }));

/**
 * Reviewed policy (proposal). `existing` = Stage 1 creditor slug; `new_slug` = proposed creditor.
 */
const POLICY = Object.freeze({
  SAFE_EXISTING: {
    brou: 'brou',
    'banco republica': 'brou',
    'banco de la republica': 'brou',
    'banco de la republica oriental del uruguay': 'brou',
    itau: 'banco-itau-uruguay',
    'banco itau': 'banco-itau-uruguay',
    'itau banco': 'banco-itau-uruguay',
    santander: 'banco-santander',
    'banco santander': 'banco-santander',
    scotiabank: 'scotiabank-uruguay',
    scotia: 'scotiabank-uruguay',
    bbva: 'bbva-uruguay',
    oca: 'oca',
    'tarjeta oca': 'oca',
    'oca tarjeta': 'oca',
    anda: 'anda',
    'anda prestamo': 'anda',
    fucerep: 'fucerep',
    'pass card': 'pass-card',
    passcard: 'pass-card',
  },
  SAFE_NEW: {
    ute: { slug: 'ute', display_name: 'UTE' },
    ose: { slug: 'ose', display_name: 'OSE' },
    antel: { slug: 'antel', display_name: 'ANTEL' },
    movistar: { slug: 'movistar', display_name: 'Movistar' },
    claro: { slug: 'claro', display_name: 'Claro' },
    bse: { slug: 'bse', display_name: 'BSE' },
    'caja notarial': { slug: 'caja-notarial', display_name: 'Caja Notarial' },
    bhu: { slug: 'bhu', display_name: 'BHU' },
    'banco hipotecario': { slug: 'bhu', display_name: 'BHU' },
    creditel: { slug: 'creditel', display_name: 'Creditel' },
    pronto: { slug: 'pronto', display_name: 'Pronto' },
    divino: { slug: 'divino', display_name: 'Divino' },
    motociclo: { slug: 'motociclo', display_name: 'Motociclo' },
    'multi ahorro': { slug: 'multi-ahorro', display_name: 'Multi Ahorro' },
    multiahorro: { slug: 'multi-ahorro', display_name: 'Multi Ahorro' },
  },
  AMBIGUOUS: {
    republica: 'palabra genérica; no identifica banco',
    visa: 'red de tarjetas, no emisor',
    'visa uruguay': 'red de tarjetas, no emisor',
    mastercard: 'red de tarjetas, no emisor',
    master: 'red de tarjetas / palabra genérica',
    cash: 'palabra genérica ("efectivo"); no implica CASH S.A.',
    pass: 'palabra genérica; no implica PASS CARD S.A.',
    alfa: 'palabra genérica; no implica AlfaBROU',
    uruguaya: 'adjetivo genérico',
    notarial: 'palabra genérica',
    abitab: 'red de pagos/cobranza, no acreedor',
    redpagos: 'red de pagos/cobranza, no acreedor',
    'red pagos': 'red de pagos/cobranza, no acreedor',
    familiar: 'categoría informal (persona), no identidad',
    familia: 'categoría informal (persona), no identidad',
    madre: 'categoría informal (persona), no identidad',
    padre: 'categoría informal (persona), no identidad',
    hermano: 'categoría informal (persona), no identidad',
    hermana: 'categoría informal (persona), no identidad',
    tio: 'categoría informal (persona), no identidad',
    tia: 'categoría informal (persona), no identidad',
    abuelo: 'categoría informal (persona), no identidad',
    abuela: 'categoría informal (persona), no identidad',
    primo: 'categoría informal (persona), no identidad',
    prima: 'categoría informal (persona), no identidad',
    amigo: 'categoría informal (persona), no identidad',
    amiga: 'categoría informal (persona), no identidad',
    prestamista: 'categoría informal, no identidad',
    particular: 'categoría informal, no identidad',
    persona: 'categoría informal, no identidad',
    privado: 'categoría informal, no identidad',
  },
  UNSAFE: {
    fucac: 'Stage 1 tiene "FUCAC VERDE"; FUCAC ≟ FUCAC VERDE requiere evidencia',
    alfabrou: '¿marca de BROU o entidad propia? no fusionar sin evidencia',
    'alfa brou': '¿marca de BROU o entidad propia? no fusionar sin evidencia',
    midinero: 'relación con otra entidad/emisor desconocida',
    'mi dinero': 'relación con otra entidad/emisor desconocida',
    hsbc: 'posible sucesión/cesión de cartera; decidir entidad vigente',
    cofac: 'entidad liquidada; acreedor actual puede ser otro',
    disse: 'cobertura BPS; dudoso como contraparte de deuda',
    prex: 'fintech/prepago; confirmar que es contraparte de crédito',
    acac: 'sigla sin identidad confirmada',
    coopace: 'sigla sin identidad confirmada',
    'la uruguaya': 'nombre compartido por varios negocios',
  },
});

function argValue(name) {
  const hit = process.argv.find(function (a) { return a.startsWith('--' + name + '='); });
  return hit ? hit.slice(name.length + 3) : null;
}

function extractCreditorDict(file) {
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = vm.createContext({ window: {} });
  const dict = vm.runInContext(code + '\n;CREDITOR_DICT', sandbox, { timeout: 1000, filename: 'creditors.js' });
  if (!dict || typeof dict !== 'object') throw new Error('CREDITOR_DICT not found');
  return JSON.parse(JSON.stringify(dict));
}

function classify(dict) {
  const out = { SAFE: [], AMBIGUOUS: [], UNSAFE: [] };
  const warnings = [];
  const seenKeys = new Map();
  Object.keys(dict).sort().forEach(function (dictKey) {
    const label = dict[dictKey];
    const key = creditorKeyV1(dictKey);
    if (key !== dictKey) warnings.push('creditor_key_v1 differs: "' + dictKey + '" → "' + key + '"');
    if (key == null) {
      warnings.push('empty key skipped: "' + dictKey + '"');
      return;
    }
    if (seenKeys.has(key)) {
      warnings.push('two dict keys collapse to "' + key + '"');
      return;
    }
    seenKeys.set(key, dictKey);
    const base = { normalized_key: key, miplan_label: label };
    if (Object.prototype.hasOwnProperty.call(POLICY.SAFE_EXISTING, key)) {
      const slug = POLICY.SAFE_EXISTING[key];
      if (!EXISTING.has(slug)) throw new Error('policy targets unknown Stage 1 slug ' + slug);
      out.SAFE.push(Object.assign(base, { target: 'existing', creditor_slug: slug }));
    } else if (Object.prototype.hasOwnProperty.call(POLICY.SAFE_NEW, key)) {
      const nc = POLICY.SAFE_NEW[key];
      if (EXISTING.has(nc.slug)) throw new Error('new slug collides with Stage 1: ' + nc.slug);
      out.SAFE.push(Object.assign(base, { target: 'new', creditor_slug: nc.slug, display_name: nc.display_name }));
    } else if (Object.prototype.hasOwnProperty.call(POLICY.AMBIGUOUS, key)) {
      out.AMBIGUOUS.push(Object.assign(base, { reason: POLICY.AMBIGUOUS[key] }));
    } else if (Object.prototype.hasOwnProperty.call(POLICY.UNSAFE, key)) {
      out.UNSAFE.push(Object.assign(base, { reason: POLICY.UNSAFE[key] }));
    } else {
      out.UNSAFE.push(Object.assign(base, { reason: 'UNCLASSIFIED (no reviewed policy) — fail closed' }));
    }
  });
  out.SAFE.forEach(function (a) {
    if (FLAGGED_RISKY.indexOf(a.normalized_key) !== -1) {
      throw new Error('flagged risky key classified SAFE: ' + a.normalized_key);
    }
  });
  Object.keys(POLICY).forEach(function (bucket) {
    Object.keys(POLICY[bucket]).forEach(function (k) {
      if (!seenKeys.has(k)) warnings.push('policy key not in CREDITOR_DICT: ' + bucket + ' "' + k + '"');
    });
  });
  return { buckets: out, warnings: warnings, dict_size: Object.keys(dict).length };
}

function main() {
  const file = argValue('creditors') || DEFAULT_CREDITORS_PATH;
  if (!fs.existsSync(file)) {
    console.error('Mi Plan creditors.js not found. Pass --creditors=<path>.');
    process.exit(2);
  }
  const result = classify(extractCreditorDict(file));
  const b = result.buckets;
  const newCreditors = new Map();
  b.SAFE.forEach(function (a) {
    if (a.target === 'new') newCreditors.set(a.creditor_slug, a.display_name);
  });
  const summary = {
    dict_size: result.dict_size,
    safe_existing: b.SAFE.filter(function (a) { return a.target === 'existing'; }).length,
    safe_new_aliases: b.SAFE.filter(function (a) { return a.target === 'new'; }).length,
    new_creditors: newCreditors.size,
    ambiguous: b.AMBIGUOUS.length,
    unsafe: b.UNSAFE.length,
  };
  if (process.argv.indexOf('--json') !== -1) {
    console.log(JSON.stringify({ summary: summary, buckets: b, warnings: result.warnings }, null, 2));
    return;
  }
  console.log('PROPOSAL miplan_declared aliases (READ-ONLY, requires human review)');
  console.log(JSON.stringify(summary));
  console.log('\nSAFE → existing Stage 1 creditor');
  b.SAFE.filter(function (a) { return a.target === 'existing'; }).forEach(function (a) {
    console.log('  ' + a.normalized_key.padEnd(44) + ' → ' + a.creditor_slug);
  });
  console.log('\nSAFE → NEW creditor');
  b.SAFE.filter(function (a) { return a.target === 'new'; }).forEach(function (a) {
    console.log('  ' + a.normalized_key.padEnd(44) + ' → ' + a.creditor_slug + ' (' + a.display_name + ')');
  });
  console.log('\nAMBIGUOUS (seed status=ambiguous, no creditor)');
  b.AMBIGUOUS.forEach(function (a) {
    console.log('  ' + a.normalized_key.padEnd(44) + ' ' + a.reason);
  });
  console.log('\nUNSAFE (not seeded, stays UNKNOWN until decided)');
  b.UNSAFE.forEach(function (a) {
    console.log('  ' + a.normalized_key.padEnd(44) + ' [' + a.miplan_label + '] ' + a.reason);
  });
  if (result.warnings.length) {
    console.log('\nWARNINGS');
    result.warnings.forEach(function (w) { console.log('  ' + w); });
  }
}

if (require.main === module) main();

module.exports = { POLICY, FLAGGED_RISKY, extractCreditorDict, classify };
