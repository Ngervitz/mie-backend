'use strict';

/**
 * Mi Deuda — canonical creditor catalog: normalizer, resolver, BCU seed, historical parity.
 * Run: node scripts/unit-creditor-catalog.js
 * Pure / in-memory. No DB, no network.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  RESOLUTION,
  CreditorCatalogIntegrityError,
  creditorKeyV1,
  buildCreditorResolver,
  resolveCreditor,
} = require('../src/lib/creditorCatalog');
const {
  SEED_UUID_NAMESPACE,
  CREDITOR_SEED,
  BCU_ALIAS_SEED,
  seedCatalogRows,
} = require('../src/lib/creditorCatalogBcuSeed');
const {
  MAP_STATUS,
  APPROVED_RAW_TO_CANONICAL,
  canonicalizeInstitutionName,
} = require('../src/lib/miDeudaBags');

let groups = 0;
function pass() {
  groups += 1;
}

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';

function creditor(id, display, over) {
  return Object.assign(
    { creditor_id: id, slug: 'c-' + id.slice(0, 4), display_name: display, status: 'active', merged_into_creditor_id: null },
    over || {},
  );
}

function alias(id, source, key, creditorId, status) {
  return { id: id, source: source, normalized_key: key, creditor_id: creditorId, status: status };
}

function expectIntegrityError(fn, label) {
  assert.throws(fn, function (err) {
    return err instanceof CreditorCatalogIntegrityError && err.code === 'CREDITOR_CATALOG_INTEGRITY';
  }, label);
}

// 1. creditor_key_v1
{
  assert.strictEqual(creditorKeyV1('  Oca S.A. '), 'oca sa');
  assert.strictEqual(creditorKeyV1('PRONTO'), 'pronto');
  assert.strictEqual(creditorKeyV1('Pronto!'), 'pronto');
  assert.strictEqual(creditorKeyV1('Pronto financiera'), 'pronto financiera');
  assert.strictEqual(creditorKeyV1('CASH S.A.'), 'cash sa');
  assert.strictEqual(creditorKeyV1('cash s.a.'), 'cash sa');
  assert.strictEqual(creditorKeyV1('Banco Itaú Uruguay SA'), 'banco itau uruguay sa');
  assert.strictEqual(creditorKeyV1('Banco Itaú Uruguay S.A.'), 'banco itau uruguay sa');
  assert.strictEqual(creditorKeyV1('BANCO DE LA REPÚBLICA'), 'banco de la republica');
  assert.strictEqual(creditorKeyV1('Peña\tCrédito\n  Ñandú'), 'pena credito nandu');
  assert.strictEqual(creditorKeyV1('Ｏｃａ　S.A.'), 'oca sa'); // NFKC fullwidth
  assert.strictEqual(creditorKeyV1('A-B/C_D'), 'a b c d');
  assert.strictEqual(creditorKeyV1('S.A.'), 'sa');
  assert.strictEqual(creditorKeyV1(''), null);
  assert.strictEqual(creditorKeyV1('   '), null);
  assert.strictEqual(creditorKeyV1('...'), null);
  assert.strictEqual(creditorKeyV1(null), null);
  assert.strictEqual(creditorKeyV1(undefined), null);
  assert.strictEqual(creditorKeyV1('Creditel'), 'creditel');
  assert.notStrictEqual(creditorKeyV1('Pronto'), creditorKeyV1('Pronto financiera'));
  pass('creditor_key_v1');
}

const base = {
  creditors: [creditor(C1, 'Cash S.A.'), creditor(C2, 'OCA S.A.')],
  aliases: [
    alias('a1', 'bcu', 'cash sa', C1, 'approved'),
    alias('a2', 'bcu', 'oca sa', C2, 'approved'),
    alias('a3', 'bcu', 'cash', null, 'ambiguous'),
  ],
};

// 2. exact alias resolution (no fuzzy)
{
  const r = buildCreditorResolver(base);
  const res = resolveCreditor(r, 'bcu', 'CASH S.A.');
  assert.strictEqual(res.resolution, RESOLUTION.RESOLVED);
  assert.strictEqual(res.creditor_id, C1);
  assert.strictEqual(res.display_name, 'Cash S.A.');
  assert.strictEqual(res.raw, 'CASH S.A.');
  assert.strictEqual(res.normalized_key, 'cash sa');
  assert.strictEqual(resolveCreditor(r, 'bcu', 'Cash SA Uruguay').resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(resolveCreditor(r, 'bcu', 'Cashh S.A.').resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(resolveCreditor(r, 'bcu', 'OCA').resolution, RESOLUTION.UNKNOWN);
  pass('exact alias resolution, no fuzzy');
}

// 3 + 23. source scoping
{
  const r = buildCreditorResolver(base);
  assert.strictEqual(resolveCreditor(r, 'bcu', 'cash s.a.').resolution, RESOLUTION.RESOLVED);
  const declared = resolveCreditor(r, 'miplan_declared', 'cash s.a.');
  assert.strictEqual(declared.resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(declared.creditor_id, null);
  assert.strictEqual(declared.normalized_key, 'cash sa');

  const scoped = buildCreditorResolver({
    creditors: [creditor(C1, 'Cash S.A.'), creditor(C2, 'Other')],
    aliases: [
      alias('b1', 'bcu', 'cash', C1, 'approved'),
      alias('m1', 'miplan_declared', 'cash', C2, 'approved'),
    ],
  });
  assert.strictEqual(resolveCreditor(scoped, 'bcu', 'Cash').creditor_id, C1);
  assert.strictEqual(resolveCreditor(scoped, 'miplan_declared', 'Cash').creditor_id, C2);
  expectIntegrityError(function () {
    resolveCreditor(scoped, 'manual', 'Cash');
  }, 'unknown source rejected');
  pass('source scoping (bcu resolves, miplan_declared same key UNKNOWN)');
}

// 4/5/6. UNKNOWN / UNKNOWN_REVIEWED / EMPTY
{
  const r = buildCreditorResolver(base);
  const u = resolveCreditor(r, 'bcu', 'Banco Fantasma S.A.');
  assert.strictEqual(u.resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(u.raw, 'Banco Fantasma S.A.');
  assert.strictEqual(u.normalized_key, 'banco fantasma sa');
  assert.strictEqual(u.creditor_id, null);
  pass('UNKNOWN keeps raw + key');

  const rv = resolveCreditor(r, 'bcu', 'CASH');
  assert.strictEqual(rv.resolution, RESOLUTION.UNKNOWN_REVIEWED);
  assert.strictEqual(rv.creditor_id, null);
  assert.strictEqual(rv.alias_id, 'a3');
  pass('UNKNOWN_REVIEWED from ambiguous alias');

  ['', '   ', '.', null, undefined].forEach(function (raw) {
    const e = resolveCreditor(r, 'bcu', raw);
    assert.strictEqual(e.resolution, RESOLUTION.EMPTY);
    assert.strictEqual(e.creditor_id, null);
    assert.strictEqual(e.normalized_key, null);
  });
  pass('EMPTY');
}

// 7 + 25. disabled alias never resolves, not even via another path
{
  const r = buildCreditorResolver({
    creditors: [creditor(C1, 'Cash S.A.'), creditor(C2, 'OCA S.A.')],
    aliases: [alias('d1', 'bcu', 'cash sa', C1, 'disabled')],
  });
  assert.strictEqual(resolveCreditor(r, 'bcu', 'CASH S.A.').resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(resolveCreditor(r, 'miplan_declared', 'CASH S.A.').resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(r.active_alias_count, 0);
  pass('disabled alias does not resolve');

  const moved = buildCreditorResolver({
    creditors: [creditor(C1, 'Cash S.A.'), creditor(C2, 'OCA S.A.')],
    aliases: [
      alias('d1', 'bcu', 'cash sa', C1, 'disabled'),
      alias('n1', 'bcu', 'cash sa', C2, 'approved'),
    ],
  });
  const res = resolveCreditor(moved, 'bcu', 'CASH S.A.');
  assert.strictEqual(res.creditor_id, C2);
  assert.strictEqual(res.alias_id, 'n1');

  const disabledThenAmbiguous = buildCreditorResolver({
    creditors: [creditor(C1, 'Cash S.A.')],
    aliases: [
      alias('d1', 'bcu', 'cash sa', C1, 'disabled'),
      alias('q1', 'bcu', 'cash sa', null, 'ambiguous'),
    ],
  });
  assert.strictEqual(
    resolveCreditor(disabledThenAmbiguous, 'bcu', 'CASH S.A.').resolution,
    RESOLUTION.UNKNOWN_REVIEWED,
  );
  pass('disabled alias not reactivated by a coexisting row (move = disable + new)');
}

// 8. merged creditor → single hop to target
{
  const r = buildCreditorResolver({
    creditors: [
      creditor(C1, 'Old Cash', { status: 'merged', merged_into_creditor_id: C2 }),
      creditor(C2, 'Cash S.A.'),
    ],
    aliases: [alias('a1', 'bcu', 'old cash', C1, 'approved'), alias('a2', 'bcu', 'cash sa', C2, 'approved')],
  });
  const res = resolveCreditor(r, 'bcu', 'Old Cash');
  assert.strictEqual(res.resolution, RESOLUTION.RESOLVED);
  assert.strictEqual(res.creditor_id, C2);
  assert.strictEqual(res.display_name, 'Cash S.A.');
  assert.strictEqual(res.alias_id, 'a1');

  const retired = buildCreditorResolver({
    creditors: [creditor(C1, 'Gone S.A.', { status: 'retired' })],
    aliases: [alias('a1', 'bcu', 'gone sa', C1, 'approved')],
  });
  assert.strictEqual(resolveCreditor(retired, 'bcu', 'GONE S.A.').creditor_id, C1);
  pass('merged creditor resolves to target (one hop); retired keeps identity');
}

// 9. cycle / inconsistency fail-closed
{
  expectIntegrityError(function () {
    buildCreditorResolver({
      creditors: [
        creditor(C1, 'A', { status: 'merged', merged_into_creditor_id: C2 }),
        creditor(C2, 'B', { status: 'merged', merged_into_creditor_id: C1 }),
      ],
      aliases: [],
    });
  }, 'cycle');
  expectIntegrityError(function () {
    buildCreditorResolver({
      creditors: [
        creditor(C1, 'A', { status: 'merged', merged_into_creditor_id: C2 }),
        creditor(C2, 'B', { status: 'merged', merged_into_creditor_id: C3 }),
        creditor(C3, 'C'),
      ],
      aliases: [],
    });
  }, 'chain of 2 hops');
  expectIntegrityError(function () {
    buildCreditorResolver({
      creditors: [creditor(C1, 'A', { status: 'merged', merged_into_creditor_id: C1 })],
      aliases: [],
    });
  }, 'self merge');
  expectIntegrityError(function () {
    buildCreditorResolver({
      creditors: [creditor(C1, 'A', { status: 'merged', merged_into_creditor_id: C3 })],
      aliases: [],
    });
  }, 'missing target');
  expectIntegrityError(function () {
    buildCreditorResolver({
      creditors: [creditor(C1, 'A', { status: 'merged', merged_into_creditor_id: null })],
      aliases: [],
    });
  }, 'merged without target');
  expectIntegrityError(function () {
    buildCreditorResolver({
      creditors: [creditor(C1, 'A', { status: 'active', merged_into_creditor_id: C2 }), creditor(C2, 'B')],
      aliases: [],
    });
  }, 'active with target');
  expectIntegrityError(function () {
    buildCreditorResolver({ creditors: [creditor(C1, 'A', { status: 'paused' })], aliases: [] });
  }, 'invalid status');
  expectIntegrityError(function () {
    buildCreditorResolver({ creditors: [creditor(C1, 'A')], aliases: [alias('x', 'bcu', 'a', C3, 'approved')] });
  }, 'alias to missing creditor');
  expectIntegrityError(function () {
    buildCreditorResolver({ creditors: [creditor(C1, 'A')], aliases: [alias('x', 'bcu', 'a', null, 'approved')] });
  }, 'approved without creditor');
  expectIntegrityError(function () {
    buildCreditorResolver({ creditors: [creditor(C1, 'A')], aliases: [alias('x', 'bcu', 'a', C1, 'ambiguous')] });
  }, 'ambiguous with creditor');
  expectIntegrityError(function () {
    buildCreditorResolver({
      creditors: [creditor(C1, 'A'), creditor(C2, 'B')],
      aliases: [alias('x', 'bcu', 'a', C1, 'approved'), alias('y', 'bcu', 'a', C2, 'approved')],
    });
  }, 'duplicate active alias');
  expectIntegrityError(function () {
    buildCreditorResolver({ creditors: [creditor(C1, 'A')], aliases: [alias('x', 'manual', 'a', C1, 'approved')] });
  }, 'source manual rejected');
  expectIntegrityError(function () {
    buildCreditorResolver({ creditors: [creditor(C1, 'A')], aliases: [alias('x', 'bcu', 'Cash S.A.', C1, 'approved')] });
  }, 'unnormalized key rejected');
  expectIntegrityError(function () {
    buildCreditorResolver({ creditors: [creditor(C1, 'A'), creditor(C1, 'B')], aliases: [] });
  }, 'duplicate creditor_id');
  expectIntegrityError(function () {
    buildCreditorResolver(null);
  }, 'null catalog');
  expectIntegrityError(function () {
    resolveCreditor(null, 'bcu', 'x');
  }, 'resolver required');
  pass('cycle / chain / inconsistency → fail-closed');
}

// 24. display_name change does not alter creditor_id
{
  const before = buildCreditorResolver(base);
  const renamed = buildCreditorResolver({
    creditors: [creditor(C1, 'Cash Financiera'), creditor(C2, 'OCA S.A.')],
    aliases: base.aliases,
  });
  const a = resolveCreditor(before, 'bcu', 'CASH S.A.');
  const b = resolveCreditor(renamed, 'bcu', 'CASH S.A.');
  assert.strictEqual(a.creditor_id, b.creditor_id);
  assert.notStrictEqual(a.display_name, b.display_name);
  pass('display_name rename keeps creditor_id');
}

// 10. BCU seed: completeness, determinism, collapse report
function uuidV5(name) {
  const ns = Buffer.from(SEED_UUID_NAMESPACE.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return [x.slice(0, 8), x.slice(8, 12), x.slice(12, 16), x.slice(16, 20), x.slice(20)].join('-');
}

const legacyRaws = Object.keys(APPROVED_RAW_TO_CANONICAL);
const legacyCanonicals = Array.from(new Set(Object.values(APPROVED_RAW_TO_CANONICAL)));
const seedRows = seedCatalogRows();
const seedResolver = buildCreditorResolver(seedRows);

{
  assert.strictEqual(legacyRaws.length, 18);
  assert.strictEqual(legacyCanonicals.length, 16);
  assert.strictEqual(CREDITOR_SEED.length, 16);
  assert.strictEqual(BCU_ALIAS_SEED.length, 16);

  const displays = CREDITOR_SEED.map(function (c) {
    return c.display_name;
  }).sort();
  assert.deepStrictEqual(displays, legacyCanonicals.slice().sort());

  CREDITOR_SEED.forEach(function (c) {
    assert.strictEqual(c.creditor_id, uuidV5('creditor:' + c.slug), 'creditor uuid ' + c.slug);
  });
  BCU_ALIAS_SEED.forEach(function (a) {
    assert.strictEqual(a.id, uuidV5('creditor_alias:bcu:' + a.normalized_key), 'alias uuid ' + a.normalized_key);
    a.raws.forEach(function (raw) {
      assert.strictEqual(creditorKeyV1(raw), a.normalized_key, 'alias key ' + raw);
    });
  });

  const seededRaws = [];
  BCU_ALIAS_SEED.forEach(function (a) {
    seededRaws.push.apply(seededRaws, a.raws);
  });
  assert.deepStrictEqual(seededRaws.slice().sort(), legacyRaws.slice().sort());

  // Collapse report: raws sharing a key must share the legacy canonical.
  const byKey = new Map();
  legacyRaws.forEach(function (raw) {
    const k = creditorKeyV1(raw);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(raw);
  });
  const collapses = [];
  byKey.forEach(function (raws, k) {
    const canon = new Set(
      raws.map(function (r) {
        return APPROVED_RAW_TO_CANONICAL[r];
      }),
    );
    assert.strictEqual(canon.size, 1, 'BLOCKER cross-canonical collapse on key ' + k);
    if (raws.length > 1) collapses.push(k);
  });
  assert.deepStrictEqual(collapses.sort(), [
    'administradora de soluciones integrales sa',
    'banco de la republica oriental del uruguay',
  ]);
  pass('BCU seed complete, deterministic, collapses same-canonical only');
}

// Seed module ↔ migration SQL row for row.
{
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '20261006_mi_deuda_creditor_catalog.sql'),
    'utf8',
  );
  const sqlCreditors = [];
  const reC = /\('([0-9a-f-]{36})', '([a-z0-9-]+)', '([^']*)', 'active'\)/g;
  let m;
  while ((m = reC.exec(sql))) sqlCreditors.push({ creditor_id: m[1], slug: m[2], display_name: m[3] });
  assert.deepStrictEqual(
    sqlCreditors,
    CREDITOR_SEED.map(function (c) {
      return { creditor_id: c.creditor_id, slug: c.slug, display_name: c.display_name };
    }),
  );

  const sqlAliases = [];
  const reA = /\('([0-9a-f-]{36})', 'bcu', '([a-z0-9 ]+)', '([0-9a-f-]{36})', 'approved', '([^']*)'/g;
  while ((m = reA.exec(sql))) {
    sqlAliases.push({ id: m[1], normalized_key: m[2], creditor_id: m[3], example_raw: m[4] });
  }
  assert.deepStrictEqual(
    sqlAliases,
    seedRows.aliases.map(function (a) {
      return { id: a.id, normalized_key: a.normalized_key, creditor_id: a.creditor_id, example_raw: a.example_raw };
    }),
  );
  assert.ok(/ENABLE ROW LEVEL SECURITY/.test(sql) && /REVOKE ALL ON TABLE public\.creditors FROM PUBLIC, anon, authenticated/.test(sql));
  assert.ok(/REVOKE ALL ON TABLE public\.creditor_aliases FROM PUBLIC, anon, authenticated/.test(sql));
  assert.ok(!/CREATE POLICY/i.test(sql), 'no policies');
  assert.ok(/ON CONFLICT \(creditor_id\) DO NOTHING/.test(sql) && /ON CONFLICT \(id\) DO NOTHING/.test(sql));
  assert.ok(!/miplan_declared', '/.test(sql), 'no miplan_declared seed');
  pass('seed module mirrors migration SQL; RLS on, no policies, idempotent');
}

// 11. historical mapping parity (old display === new display_name, all RESOLVED)
{
  const canonicalToCreditor = new Map();
  legacyRaws.forEach(function (raw) {
    const oldRes = canonicalizeInstitutionName(raw);
    assert.strictEqual(oldRes.status, MAP_STATUS.MAPPED);
    const newRes = resolveCreditor(seedResolver, 'bcu', raw);
    assert.strictEqual(newRes.resolution, RESOLUTION.RESOLVED, 'historical raw UNKNOWN: ' + raw);
    assert.strictEqual(newRes.display_name, oldRes.canonical_name, 'display parity: ' + raw);
    const prev = canonicalToCreditor.get(oldRes.canonical_name);
    if (prev) assert.strictEqual(prev, newRes.creditor_id, 'institution split: ' + raw);
    canonicalToCreditor.set(oldRes.canonical_name, newRes.creditor_id);
  });
  assert.strictEqual(new Set(canonicalToCreditor.values()).size, 16);
  pass('historical mapping parity 18/18');
}

// 14. "cash s.a." — intentional new semantics
{
  assert.strictEqual(canonicalizeInstitutionName('cash s.a.').status, MAP_STATUS.UNMAPPED);
  const res = resolveCreditor(seedResolver, 'bcu', 'cash s.a.');
  assert.strictEqual(res.resolution, RESOLUTION.RESOLVED);
  assert.strictEqual(res.display_name, 'CASH S.A.');
  assert.strictEqual(res.creditor_id, '163e0226-599e-5bc2-8553-151379f66537');
  assert.strictEqual(resolveCreditor(seedResolver, 'bcu', 'CASH').resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(resolveCreditor(seedResolver, 'bcu', 'Foo SA').resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(resolveCreditor(seedResolver, 'miplan_declared', 'cash s.a.').resolution, RESOLUTION.UNKNOWN);
  pass('"cash s.a." resolves under creditor_key_v1 (bcu only)');
}

console.log('unit-creditor-catalog: PASS (' + groups + ' groups)');
