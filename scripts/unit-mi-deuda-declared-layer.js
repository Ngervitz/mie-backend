'use strict';

/**
 * Mi Deuda Stage 2 — declared bag layer, BCU+declared combination, unknown creditor queue.
 * Run: node scripts/unit-mi-deuda-declared-layer.js
 * Pure / in-memory. No DB, no network.
 */

const assert = require('assert');

const {
  RESOLUTION,
  CreditorCatalogIntegrityError,
  buildCreditorResolver,
} = require('../src/lib/creditorCatalog');
const { seedCatalogRows } = require('../src/lib/creditorCatalogBcuSeed');
const { buildMiDeudaBagModel } = require('../src/lib/miDeudaBags');
const {
  effectiveDeclaredCreditor,
  buildDeclaredLayer,
  combineBagLayers,
  annotateBcuBags,
  buildUnknownCreditorQueue,
} = require('../src/lib/miDeudaDeclaredLayer');

let groups = 0;
function pass() {
  groups += 1;
}

const BROU = '2153c7f3-0193-5a03-9055-c37ed08c4ca6';
const OCA = '6a126a47-8b2a-5872-9a2c-527d0891b855';
const UTE = 'aaaaaaaa-0000-4000-8000-000000000001';
const OLD = 'aaaaaaaa-0000-4000-8000-000000000005';

function catalog(extra) {
  const base = seedCatalogRows();
  base.creditors.push({ creditor_id: UTE, slug: 'ute', display_name: 'UTE', status: 'active', merged_into_creditor_id: null });
  base.aliases.push(
    { id: 'bbbbbbbb-0000-4000-8000-000000000001', source: 'miplan_declared', normalized_key: 'brou', creditor_id: BROU, status: 'approved' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', source: 'miplan_declared', normalized_key: 'ute', creditor_id: UTE, status: 'approved' },
  );
  if (extra) extra(base);
  return base;
}

const resolver = buildCreditorResolver(catalog());

let eid = 0;
function ev(ci, state, at, journey, seq) {
  eid += 1;
  return {
    event_id: '10000000-0000-4000-8000-' + String(eid).padStart(12, '0'),
    journey_id: journey || '20000000-0000-4000-8000-' + String(ci).padStart(12, '0'),
    seq: seq || 1,
    state: state,
    ci: ci,
    miplan_created_at: at || '2026-10-01T10:00:00Z',
    snapshot_diagnosis_id: '40000000-0000-4000-8000-000000000001',
  };
}

let did = 0;
function dd(event, position, resolution, creditorId, over) {
  did += 1;
  return Object.assign(
    {
      declared_debt_id: '50000000-0000-4000-8000-' + String(did).padStart(12, '0'),
      optin_event_id: event.event_id,
      ci: event.ci,
      snapshot_diagnosis_id: event.snapshot_diagnosis_id,
      position: position,
      creditor_raw: 'raw' + position,
      creditor_normalized_key: 'raw' + position,
      ingestion_resolution: resolution,
      ingestion_creditor_id: creditorId,
      monto: '1000',
    },
    over || {},
  );
}

// BCU fixture: CI 1 in BROU (member), CI 3 in OCA (member)
function bcuModel() {
  return buildMiDeudaBagModel({
    resolver: resolver,
    snapshots: [
      { id: 's1', ci: 1, consulted_on: '2026-09-01', period_label: '2026-08', created_at: '2026-09-01T00:00:00Z' },
      { id: 's3', ci: 3, consulted_on: '2026-09-01', period_label: '2026-08', created_at: '2026-09-01T00:00:00Z' },
    ],
    institutions: [
      { snapshot_id: 's1', institution_name: 'Banco de la República Oriental del Uruguay', category: '3', moroso_mn: 100 },
      { snapshot_id: 's3', institution_name: 'OCA S.A.', category: '4', castigado_mn: 50 },
    ],
  });
}

// 11-12. Effective creditor: snapshot id + explicit one-hop merge; invalid merges fail closed
{
  const r = buildCreditorResolver(catalog(function (c) {
    c.creditors.push({ creditor_id: OLD, slug: 'old', display_name: 'Old brand', status: 'merged', merged_into_creditor_id: BROU });
  }));
  const e = ev(1, 'opted_in');
  assert.deepStrictEqual(effectiveDeclaredCreditor(dd(e, 0, RESOLUTION.RESOLVED, OLD), r), {
    creditor_id: BROU,
    display_name: 'Banco de la República Oriental del Uruguay',
  });
  assert.strictEqual(effectiveDeclaredCreditor(dd(e, 0, RESOLUTION.UNKNOWN, null), r), null);
  assert.strictEqual(effectiveDeclaredCreditor(dd(e, 0, RESOLUTION.UNKNOWN_REVIEWED, null), r), null);
  assert.strictEqual(effectiveDeclaredCreditor(dd(e, 0, RESOLUTION.EMPTY, null), r), null);
  assert.throws(function () {
    effectiveDeclaredCreditor(dd(e, 0, RESOLUTION.RESOLVED, 'ffffffff-0000-4000-8000-000000000000'), r);
  }, CreditorCatalogIntegrityError);
  assert.throws(function () {
    effectiveDeclaredCreditor(dd(e, 0, RESOLUTION.RESOLVED, null), r);
  }, CreditorCatalogIntegrityError);
  [
    function (c) { // chained merge
      c.creditors.push(
        { creditor_id: OLD, slug: 'old', display_name: 'Old', status: 'merged', merged_into_creditor_id: 'aaaaaaaa-0000-4000-8000-000000000006' },
        { creditor_id: 'aaaaaaaa-0000-4000-8000-000000000006', slug: 'mid', display_name: 'Mid', status: 'merged', merged_into_creditor_id: BROU },
      );
    },
    function (c) { // cycle
      c.creditors.push(
        { creditor_id: OLD, slug: 'old', display_name: 'Old', status: 'merged', merged_into_creditor_id: 'aaaaaaaa-0000-4000-8000-000000000006' },
        { creditor_id: 'aaaaaaaa-0000-4000-8000-000000000006', slug: 'mid', display_name: 'Mid', status: 'merged', merged_into_creditor_id: OLD },
      );
    },
    function (c) { // self
      c.creditors.push({ creditor_id: OLD, slug: 'old', display_name: 'Old', status: 'merged', merged_into_creditor_id: OLD });
    },
  ].forEach(function (mutate, i) {
    assert.throws(function () {
      buildCreditorResolver(catalog(mutate));
    }, CreditorCatalogIntegrityError, 'merge case ' + i);
  });
  pass();
}

// 10/41. Ingested UNKNOWN never enters a bag even if the catalog resolves its key today
{
  const e = ev(9, 'opted_in');
  const unknownBrou = dd(e, 0, RESOLUTION.UNKNOWN, null, { creditor_raw: 'BROU', creditor_normalized_key: 'brou' });
  const layer = buildDeclaredLayer({ events: [e], debts: [unknownBrou], resolver: resolver });
  assert.strictEqual(layer.by_creditor.size, 0);
  assert.strictEqual(layer.unbagged_active_debts.length, 1);
  assert.strictEqual(layer.unbagged_active_debts[0].ci, 9);
  const q = buildUnknownCreditorQueue({ events: [e], debts: [unknownBrou], resolver: resolver });
  assert.strictEqual(q[0].current_catalog_hint.resolution, RESOLUTION.RESOLVED); // hint only
  assert.strictEqual(q[0].current_catalog_hint.creditor_id, BROU);
  pass();
}

// 36-43. Two layers
{
  const e1 = ev(1, 'opted_in'); // CI 1: declared BROU (x2 same amount) + UTE; also BCU BROU
  const e2 = ev(2, 'opted_in'); // CI 2: declared UTE only, no BCU at all
  const e4 = ev(4, 'opted_in'); // CI 4: only unknown debt
  const debts = [
    dd(e1, 0, RESOLUTION.RESOLVED, BROU, { monto: '5000' }),
    dd(e1, 1, RESOLUTION.RESOLVED, BROU, { monto: '5000' }),
    dd(e1, 2, RESOLUTION.RESOLVED, UTE),
    dd(e2, 0, RESOLUTION.RESOLVED, UTE),
    dd(e4, 0, RESOLUTION.UNKNOWN, null, { creditor_raw: 'Tía Marta', creditor_normalized_key: 'tia marta' }),
  ];
  const bcu = bcuModel();
  const bcuBefore = JSON.stringify(bcu.bags);
  const layer = buildDeclaredLayer({ events: [e1, e2, e4], debts: debts, resolver: resolver });
  const combined = combineBagLayers({ bcuBags: bcu.bags, declaredLayer: layer });
  const byId = new Map(combined.map(function (b) {
    return [b.creditor_id, b];
  }));

  // 39/42: CI 1 once in BROU bag with both layers; its two debts stay separate (40: no matching)
  const brou = byId.get(BROU);
  assert.strictEqual(brou.people_union, 1);
  assert.strictEqual(brou.people_both, 1);
  assert.strictEqual(brou.declared_debts_count, 2);
  assert.strictEqual(brou.members[0].declared_debts.length, 2);
  assert.strictEqual(brou.members[0].bcu_rows.length, 1);
  assert.ok(!('matched_bcu_row' in brou.members[0].declared_debts[0]));

  // 36/37: declared-only non-financial creditor makes a bag without BCU
  const ute = byId.get(UTE);
  assert.strictEqual(ute.people_declared, 2);
  assert.strictEqual(ute.people_bcu, 0);
  assert.strictEqual(ute.display_name, 'UTE');

  // 43: CI 1 in several bags
  assert.ok(brou.members.some(function (m) { return m.ci === 1; }));
  assert.ok(ute.members.some(function (m) { return m.ci === 1; }));

  // 38: BCU-only bag unchanged; BCU model object itself untouched
  const oca = byId.get(OCA);
  assert.strictEqual(oca.people_bcu, 1);
  assert.strictEqual(oca.people_declared, 0);
  assert.strictEqual(JSON.stringify(bcu.bags), bcuBefore);

  // 41: unknown visible (unbagged list), never bagged
  assert.strictEqual(layer.unbagged_active_debts.length, 1);
  assert.strictEqual(layer.unbagged_active_debts[0].creditor_raw, 'Tía Marta');
  assert.ok(combined.every(function (b) {
    return b.members.every(function (m) { return m.ci !== 4; });
  }));
  assert.strictEqual(layer.counts.people_active, 3);
  assert.strictEqual(layer.counts.active_debts, 5);
  assert.strictEqual(layer.counts.active_debts_bagged, 4);

  // Additive annotations keep people_count = BCU semantics
  const annotated = annotateBcuBags(bcu.bags, combined);
  const aBrou = annotated.find(function (b) { return b.creditor_id === BROU; });
  assert.strictEqual(aBrou.people_count, 1);
  assert.strictEqual(aBrou.people_bcu, 1);
  assert.strictEqual(aBrou.people_declared, 1);
  assert.strictEqual(aBrou.people_union, 1);
  assert.strictEqual(annotated.length, bcu.bags.length); // declared-only bags are not injected into BCU list
  pass();
}

// Withdrawn / re-accept: only the current event's snapshot feeds bags; history kept
{
  const j = '20000000-0000-4000-8000-0000000000aa';
  const a1 = ev(5, 'opted_in', '2026-10-01T10:00:00Z', j, 1);
  const w2 = ev(5, 'withdrawn', '2026-10-02T10:00:00Z', j, 2);
  const debtsA1 = [dd(a1, 0, RESOLUTION.RESOLVED, BROU)];
  let layer = buildDeclaredLayer({ events: [a1, w2], debts: debtsA1, resolver: resolver });
  assert.strictEqual(layer.by_creditor.size, 0);
  assert.strictEqual(layer.state_by_ci.get(5).state, 'withdrawn');
  const a3 = ev(5, 'opted_in', '2026-10-03T10:00:00Z', j, 3);
  const debtsA3 = [dd(a3, 0, RESOLUTION.RESOLVED, UTE)];
  layer = buildDeclaredLayer({ events: [a1, w2, a3], debts: debtsA1.concat(debtsA3), resolver: resolver });
  assert.deepStrictEqual(Array.from(layer.by_creditor.keys()), [UTE]); // old A1 snapshot not reused
  // Unresolved CI: debts persisted but never bagged
  const u = ev(null, 'opted_in');
  layer = buildDeclaredLayer({ events: [u], debts: [dd(u, 0, RESOLUTION.RESOLVED, BROU)], resolver: resolver });
  assert.strictEqual(layer.by_creditor.size, 0);
  pass();
}

// Unknown queue grouping by (source, normalized_key)
{
  const e1 = ev(11, 'opted_in');
  const e2 = ev(12, 'opted_in');
  const debts = [
    dd(e1, 0, RESOLUTION.UNKNOWN, null, { creditor_raw: 'Creditel', creditor_normalized_key: 'creditel', miplan_acreedor_display: 'Creditel' }),
    dd(e1, 1, RESOLUTION.UNKNOWN, null, { creditor_raw: 'CREDITEL', creditor_normalized_key: 'creditel' }),
    dd(e2, 0, RESOLUTION.UNKNOWN, null, { creditor_raw: 'creditel', creditor_normalized_key: 'creditel' }),
    dd(e2, 1, RESOLUTION.UNKNOWN_REVIEWED, null, { creditor_raw: 'Familiar', creditor_normalized_key: 'familiar' }),
    dd(e2, 2, RESOLUTION.EMPTY, null, { creditor_raw: null, creditor_normalized_key: null }),
    dd(e2, 3, RESOLUTION.RESOLVED, UTE),
  ];
  const q = buildUnknownCreditorQueue({ events: [e1, e2], debts: debts, resolver: resolver });
  assert.strictEqual(q.length, 3);
  assert.strictEqual(q[0].normalized_key, 'creditel');
  assert.strictEqual(q[0].source, 'miplan_declared');
  assert.strictEqual(q[0].occurrences, 3);
  assert.strictEqual(q[0].distinct_ci, 2);
  assert.deepStrictEqual(q[0].raw_examples, ['Creditel', 'CREDITEL', 'creditel']);
  assert.deepStrictEqual(q[0].display_hints, ['Creditel']);
  assert.strictEqual(q[0].current_catalog_hint.resolution, RESOLUTION.UNKNOWN);
  const empty = q.find(function (g) { return g.normalized_key === null; });
  assert.strictEqual(empty.current_catalog_hint.resolution, RESOLUTION.EMPTY);
  pass();
}

console.log('unit-mi-deuda-declared-layer: ' + groups + ' groups OK');
