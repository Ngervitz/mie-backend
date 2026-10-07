'use strict';

/**
 * Mi Deuda Stage 2 — miplan_declared seed: JS ↔ migration SQL parity, deterministic ids,
 * reviewed policy, no risky/excluded keys approved, BCU behavior untouched.
 * Run: node scripts/unit-creditor-catalog-miplan-seed.js
 * Pure / in-memory. No DB, no network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  RESOLUTION,
  creditorKeyV1,
  buildCreditorResolver,
  resolveCreditor,
} = require('../src/lib/creditorCatalog');
const { CREDITOR_SEED, BCU_ALIAS_SEED, seedCatalogRows } = require('../src/lib/creditorCatalogBcuSeed');
const {
  SEED_UUID_NAMESPACE,
  MIPLAN_CREDITOR_SEED,
  MIPLAN_DECLARED_ALIAS_SEED,
  MIPLAN_DECLARED_EXCLUDED_KEYS,
  fullSeedCatalogRows,
} = require('../src/lib/creditorCatalogMiplanDeclaredSeed');
const { uuidV5 } = require('../src/lib/miplanDebtOptinContract');
const { POLICY, FLAGGED_RISKY } = require('./propose-miplan-declared-aliases-ro');

let groups = 0;
function pass() {
  groups += 1;
}

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20261006_mi_deuda_miplan_declared_debts.sql'),
  'utf8',
);

// Deterministic ids + counts
{
  assert.strictEqual(MIPLAN_CREDITOR_SEED.length, 13);
  assert.strictEqual(MIPLAN_DECLARED_ALIAS_SEED.filter(function (a) { return a.status === 'approved'; }).length, 35);
  assert.strictEqual(MIPLAN_DECLARED_ALIAS_SEED.filter(function (a) { return a.status === 'ambiguous'; }).length, 31);
  MIPLAN_CREDITOR_SEED.forEach(function (c) {
    assert.strictEqual(c.creditor_id, uuidV5(SEED_UUID_NAMESPACE, 'creditor:' + c.slug), c.slug);
    assert.match(c.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(!/\b(s\.?a\.?|srl|ltda)\b/i.test(c.display_name), 'no unsupported legal suffix: ' + c.display_name);
  });
  MIPLAN_DECLARED_ALIAS_SEED.forEach(function (a) {
    assert.strictEqual(a.id, uuidV5(SEED_UUID_NAMESPACE, 'creditor_alias:miplan_declared:' + a.normalized_key), a.normalized_key);
    assert.strictEqual(creditorKeyV1(a.normalized_key), a.normalized_key);
  });
  pass();
}

// Seed == reviewed policy (no drift from the approved proposal)
{
  const approved = new Map();
  Object.keys(POLICY.SAFE_EXISTING).forEach(function (k) { approved.set(k, POLICY.SAFE_EXISTING[k]); });
  Object.keys(POLICY.SAFE_NEW).forEach(function (k) { approved.set(k, POLICY.SAFE_NEW[k].slug); });
  const ambiguous = new Set(Object.keys(POLICY.AMBIGUOUS));
  MIPLAN_DECLARED_ALIAS_SEED.forEach(function (a) {
    if (a.status === 'approved') {
      assert.strictEqual(approved.get(a.normalized_key), a.creditor_slug, a.normalized_key);
      approved.delete(a.normalized_key);
    } else {
      assert.ok(ambiguous.delete(a.normalized_key), 'unexpected ambiguous ' + a.normalized_key);
      assert.strictEqual(a.creditor_slug, null);
    }
  });
  assert.strictEqual(approved.size, 0);
  assert.strictEqual(ambiguous.size, 0);
  assert.deepStrictEqual(MIPLAN_DECLARED_EXCLUDED_KEYS.slice().sort(), Object.keys(POLICY.UNSAFE).sort());
  const seededKeys = new Set(MIPLAN_DECLARED_ALIAS_SEED.map(function (a) { return a.normalized_key; }));
  MIPLAN_DECLARED_EXCLUDED_KEYS.forEach(function (k) {
    assert.ok(!seededKeys.has(k), 'excluded key seeded: ' + k);
    assert.ok(SQL.indexOf("'" + k + "'") === -1, 'excluded key in SQL: ' + k);
  });
  FLAGGED_RISKY.forEach(function (k) {
    const a = MIPLAN_DECLARED_ALIAS_SEED.find(function (x) { return x.normalized_key === k; });
    assert.ok(!a || a.status === 'ambiguous', 'risky key approved: ' + k);
  });
  MIPLAN_CREDITOR_SEED.forEach(function (c) {
    assert.ok(!CREDITOR_SEED.some(function (s) { return s.slug === c.slug; }), 'slug collides with Stage 1: ' + c.slug);
  });
  pass();
}

// JS seed ↔ migration SQL, row for row
{
  const creditorRe = /\('([0-9a-f-]{36})', '([a-z0-9-]+)', '([^']+)', 'active'\)/g;
  const sqlCreditors = [];
  let m;
  while ((m = creditorRe.exec(SQL))) sqlCreditors.push({ creditor_id: m[1], slug: m[2], display_name: m[3] });
  assert.deepStrictEqual(sqlCreditors, MIPLAN_CREDITOR_SEED.map(function (c) {
    return { creditor_id: c.creditor_id, slug: c.slug, display_name: c.display_name };
  }));

  const idBySlug = new Map(CREDITOR_SEED.concat(MIPLAN_CREDITOR_SEED).map(function (c) { return [c.slug, c.creditor_id]; }));
  const aliasRe = /\('([0-9a-f-]{36})', 'miplan_declared', '([a-z0-9 ]+)', (NULL|'[0-9a-f-]{36}'), '(approved|ambiguous)', '([a-z0-9 ]+)'/g;
  const sqlAliases = [];
  while ((m = aliasRe.exec(SQL))) {
    sqlAliases.push({ id: m[1], normalized_key: m[2], creditor_id: m[3] === 'NULL' ? null : m[3].slice(1, -1), status: m[4], example_raw: m[5] });
  }
  assert.deepStrictEqual(sqlAliases, MIPLAN_DECLARED_ALIAS_SEED.map(function (a) {
    return {
      id: a.id,
      normalized_key: a.normalized_key,
      creditor_id: a.status === 'approved' ? idBySlug.get(a.creditor_slug) : null,
      status: a.status,
      example_raw: a.normalized_key,
    };
  }));
  assert.ok(SQL.indexOf("'bcu'") === -1, 'Stage 2 migration must not seed bcu aliases');
  pass();
}

// Combined catalog: resolver builds; miplan_declared resolves; BCU resolution unchanged
{
  const full = buildCreditorResolver(fullSeedCatalogRows());
  const bcuOnly = buildCreditorResolver(seedCatalogRows());
  assert.strictEqual(full.creditor_count, 29);
  assert.strictEqual(full.active_alias_count, 16 + 66);
  BCU_ALIAS_SEED.forEach(function (a) {
    a.raws.forEach(function (raw) {
      assert.deepStrictEqual(resolveCreditor(full, 'bcu', raw), resolveCreditor(bcuOnly, 'bcu', raw));
    });
  });
  // Declared keys never resolve through bcu, and bcu keys never through miplan_declared
  assert.strictEqual(resolveCreditor(full, 'bcu', 'UTE').resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(resolveCreditor(full, 'miplan_declared', 'Banco Santander S.A.').resolution, RESOLUTION.UNKNOWN);
  const cases = [
    ['Brou', RESOLUTION.RESOLVED, 'brou'],
    ['Santander', RESOLUTION.RESOLVED, 'banco-santander'],
    ['U.T.E.', RESOLUTION.RESOLVED, 'ute'],
    ['ANTEL', RESOLUTION.RESOLVED, 'antel'],
    ['Divino', RESOLUTION.RESOLVED, 'divino'],
    ['Creditel', RESOLUTION.RESOLVED, 'creditel'],
    ['Pass Card', RESOLUTION.RESOLVED, 'pass-card'],
    ['Pass', RESOLUTION.UNKNOWN_REVIEWED, null],
    ['Visa', RESOLUTION.UNKNOWN_REVIEWED, null],
    ['Cash', RESOLUTION.UNKNOWN_REVIEWED, null],
    ['Mamá', RESOLUTION.UNKNOWN, null],
    ['Madre', RESOLUTION.UNKNOWN_REVIEWED, null],
    ['Prestamista', RESOLUTION.UNKNOWN_REVIEWED, null],
    ['HSBC', RESOLUTION.UNKNOWN, null],
    ['Fucac', RESOLUTION.UNKNOWN, null],
    ['La Uruguaya', RESOLUTION.UNKNOWN, null],
    ['Intendencia de Montevideo', RESOLUTION.UNKNOWN, null],
    ['', RESOLUTION.EMPTY, null],
  ];
  const slugById = new Map(fullSeedCatalogRows().creditors.map(function (c) { return [c.creditor_id, c.slug]; }));
  cases.forEach(function (c) {
    const r = resolveCreditor(full, 'miplan_declared', c[0]);
    assert.strictEqual(r.resolution, c[1], c[0]);
    assert.strictEqual(r.creditor_id == null ? null : slugById.get(r.creditor_id), c[2], c[0]);
  });
  // Creditel stays independent from Santander and ASI
  const creditel = resolveCreditor(full, 'miplan_declared', 'creditel').creditor_id;
  ['santander', 'banco santander'].forEach(function (k) {
    assert.notStrictEqual(resolveCreditor(full, 'miplan_declared', k).creditor_id, creditel);
  });
  pass();
}

console.log('unit-creditor-catalog-miplan-seed: ' + groups + ' groups OK');
