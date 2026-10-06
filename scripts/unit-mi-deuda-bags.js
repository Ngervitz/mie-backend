'use strict';

/**
 * Mi Deuda Stage 1C — unit tests for read-only bag model.
 * Run: node scripts/unit-mi-deuda-bags.js
 * No production I/O.
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const {
  MAP_STATUS,
  canonicalizeInstitutionName,
  isBagMember,
  selectCurrentSnapshotsByCi,
  buildMiDeudaBagModel,
  APPROVED_RAW_TO_CANONICAL,
} = require('../src/lib/miDeudaBags');
const { RESOLUTION, buildCreditorResolver } = require('../src/lib/creditorCatalog');
const { seedCatalogRows } = require('../src/lib/creditorCatalogBcuSeed');

const SEED_RESOLVER = buildCreditorResolver(seedCatalogRows());
const CASH_ID = '163e0226-599e-5bc2-8553-151379f66537';
const SOCUR_ID = 'c541d904-9aae-5da3-b199-c2107d1dddb8';
const FIXTURES = [];

function build(input) {
  FIXTURES.push(input);
  return buildMiDeudaBagModel(Object.assign({ resolver: SEED_RESOLVER }, input));
}

/** Pre-catalog builder (exact APPROVED_RAW_TO_CANONICAL), pinned so it survives future commits. */
function loadLegacyBagModule() {
  const root = path.join(__dirname, '..');
  const code = execFileSync('git', ['show', 'd176eba:src/lib/miDeudaBags.js'], {
    cwd: root,
    encoding: 'utf8',
  });
  const filename = path.join(root, 'src', 'lib', '__legacy_miDeudaBags_d176eba.js');
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(code, filename);
  return m.exports;
}

const ADDITIVE_FIELDS = new Set(['creditor_id', 'creditor_resolution', 'normalized_key']);
function stripAdditive(value) {
  if (Array.isArray(value)) return value.map(stripAdditive);
  if (value instanceof Map) {
    const m = new Map();
    value.forEach(function (v, k) {
      m.set(k, stripAdditive(v));
    });
    return m;
  }
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(function (k) {
      if (!ADDITIVE_FIELDS.has(k)) out[k] = stripAdditive(value[k]);
    });
    return out;
  }
  return value;
}

function pass(name) {
  // counted at end
  pass.n += 1;
}
pass.n = 0;

function row(over) {
  return Object.assign(
    {
      moroso_mn: null,
      moroso_me: null,
      castigado_mn: null,
      castigado_me: null,
      creditos_reestructurados_mn: null,
      creditos_reestructurados_me: null,
      category: '5',
      institution_name: 'CASH S.A.',
    },
    over || {},
  );
}

// --- snapshot current selection ---
{
  const snaps = [
    {
      id: 'old-consult',
      ci: 1,
      consulted_on: '2026-01-01',
      created_at: '2026-09-10T00:00:00Z',
    },
    {
      id: 'current',
      ci: 1,
      consulted_on: '2026-09-01',
      created_at: '2026-09-02T00:00:00Z',
    },
    {
      id: 'same-consult-earlier-created',
      ci: 1,
      consulted_on: '2026-09-01',
      created_at: '2026-09-01T00:00:00Z',
    },
    {
      id: 'other-ci',
      ci: 2,
      consulted_on: '2026-05-01',
      created_at: '2026-05-01T00:00:00Z',
    },
  ];
  const cur = selectCurrentSnapshotsByCi(snaps);
  assert.strictEqual(cur.get(1).id, 'current');
  assert.strictEqual(cur.get(2).id, 'other-ci');
  pass('selectCurrentSnapshotsByCi consulted_on then created_at');
}

{
  const snaps = [
    {
      id: 'a',
      ci: 9,
      consulted_on: '2026-09-01',
      created_at: '2026-09-01T10:00:00Z',
    },
    {
      id: 'b',
      ci: 9,
      consulted_on: '2026-09-01',
      created_at: '2026-09-01T12:00:00Z',
    },
  ];
  const cur = selectCurrentSnapshotsByCi(snaps);
  assert.strictEqual(cur.get(9).id, 'b');
  pass('tie-break created_at DESC');
}

// --- no mixing snapshots ---
{
  const model = build({
    snapshots: [
      {
        id: 'snap-old',
        ci: 100,
        consulted_on: '2026-01-01',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'snap-new',
        ci: 100,
        consulted_on: '2026-09-01',
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    institutions: [
      {
        snapshot_id: 'snap-old',
        institution_name: 'CASH S.A.',
        category: '5',
        moroso_mn: 999,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
      },
      {
        snapshot_id: 'snap-new',
        institution_name: 'SOCUR S.A.',
        category: '5',
        moroso_mn: 50,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
      },
    ],
  });
  assert.strictEqual(model.persona_institution_rows.length, 1);
  assert.strictEqual(model.persona_institution_rows[0].raw_name, 'SOCUR S.A.');
  assert.strictEqual(model.persona_institution_rows[0].snapshot_id, 'snap-new');
  assert.ok(
    !model.persona_institution_rows.some(function (r) {
      return r.raw_name === 'CASH S.A.';
    }),
  );
  pass('never mix institutions across snapshots');
}

// --- canonicalization ---
{
  const brou = canonicalizeInstitutionName(
    'BANCO DE LA REPÚBLICA ORIENTAL DEL URUGUAY',
  );
  assert.strictEqual(brou.status, MAP_STATUS.MAPPED);
  assert.strictEqual(
    brou.canonical_name,
    'Banco de la República Oriental del Uruguay',
  );
  const brou2 = canonicalizeInstitutionName(
    'Banco de la República Oriental del Uruguay',
  );
  assert.strictEqual(brou2.canonical_name, brou.canonical_name);
  pass('canonical BROU case variants');
}

{
  const a = canonicalizeInstitutionName(
    'ADMINISTRADORA DE SOLUCIONES INTEGRALES S.A.',
  );
  const b = canonicalizeInstitutionName(
    'Administradora de Soluciones Integrales S.A.',
  );
  assert.strictEqual(a.status, MAP_STATUS.MAPPED);
  assert.strictEqual(a.canonical_name, b.canonical_name);
  pass('canonical Administradora case variants');
}

{
  const itau = canonicalizeInstitutionName('Banco Itaú Uruguay SA');
  assert.strictEqual(itau.status, MAP_STATUS.MAPPED);
  assert.strictEqual(itau.canonical_name, 'Banco Itaú Uruguay S.A.');
  pass('canonical Itaú SA → S.A. (explicit map only)');
}

{
  const fucac = canonicalizeInstitutionName(
    'FUCAC VERDE COOPERATIVA DE AHORRO Y CRÉDITO',
  );
  const fucerep = canonicalizeInstitutionName(
    'Cooperativa de Ahorro y Crédito FUCEREP',
  );
  assert.notStrictEqual(fucac.canonical_name, fucerep.canonical_name);
  pass('FUCAC ≠ FUCEREP');
}

{
  // Legacy oracle stays exact; runtime semantics changed deliberately (see catalog block).
  const unk = canonicalizeInstitutionName('cash s.a.');
  assert.strictEqual(unk.status, MAP_STATUS.UNMAPPED);
  assert.strictEqual(unk.reason, 'REVIEW_NEEDED');
  assert.strictEqual(unk.canonical_name, null);
  pass('legacy oracle: case-only variant → UNMAPPED/REVIEW_NEEDED');
}

{
  const unk = canonicalizeInstitutionName('Banco Fantasma S.A.');
  assert.strictEqual(unk.status, MAP_STATUS.UNMAPPED);
  assert.strictEqual(unk.canonical_name, null);
  pass('unknown raw → UNMAPPED');
}

{
  // Do not invent general SA→S.A. for unlisted names
  assert.ok(!Object.prototype.hasOwnProperty.call(APPROVED_RAW_TO_CANONICAL, 'Foo SA'));
  const foo = canonicalizeInstitutionName('Foo SA');
  assert.strictEqual(foo.status, MAP_STATUS.UNMAPPED);
  pass('no general SA→S.A. rule');
}

// --- membership sides ---
assert.strictEqual(isBagMember(row({ moroso_mn: 10 })), true);
pass('membership moroso_mn > 0');
assert.strictEqual(isBagMember(row({ moroso_me: 10 })), true);
pass('membership moroso_me > 0');
assert.strictEqual(isBagMember(row({ castigado_mn: 10 })), true);
pass('membership castigado_mn > 0');
assert.strictEqual(isBagMember(row({ castigado_me: 10 })), true);
pass('membership castigado_me > 0');

// NULL moroso
assert.strictEqual(
  isBagMember(row({ moroso_mn: null, moroso_me: 50 })),
  true,
);
pass('moroso_mn=NULL moroso_me=50 → enter');
assert.strictEqual(
  isBagMember(row({ moroso_mn: 50, moroso_me: null })),
  true,
);
pass('moroso_mn=50 moroso_me=NULL → enter');
assert.strictEqual(
  isBagMember(row({ moroso_mn: null, moroso_me: null })),
  false,
);
pass('moroso both NULL → no enter');
assert.strictEqual(
  isBagMember(row({ moroso_mn: 0, moroso_me: 0 })),
  false,
);
pass('moroso both 0 → no enter');

// NULL castigado
assert.strictEqual(
  isBagMember(row({ castigado_mn: null, castigado_me: 50 })),
  true,
);
pass('castigado_mn=NULL castigado_me=50 → enter');
assert.strictEqual(
  isBagMember(row({ castigado_mn: 50, castigado_me: null })),
  true,
);
pass('castigado_mn=50 castigado_me=NULL → enter');
assert.strictEqual(
  isBagMember(row({ castigado_mn: null, castigado_me: null })),
  false,
);
pass('castigado both NULL → no enter');
assert.strictEqual(
  isBagMember(row({ castigado_mn: 0, castigado_me: 0 })),
  false,
);
pass('castigado both 0 → no enter');

{
  assert.strictEqual(
    isBagMember(
      row({
        category: '5',
        moroso_mn: null,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
      }),
    ),
    false,
  );
  pass('bad category alone → no membership');
}

{
  assert.strictEqual(
    isBagMember(
      row({
        creditos_reestructurados_mn: 75598.99,
        creditos_reestructurados_me: 0,
      }),
    ),
    false,
  );
  pass('reestructurado-only → no membership');
}

{
  assert.strictEqual(
    isBagMember(
      row({
        colocacion_vencida_mn: 60420.61,
        colocacion_vencida_me: null,
      }),
    ),
    true,
  );
  pass('colocacion_vencida_mn-only → member (V2)');
}

{
  assert.strictEqual(
    isBagMember(
      row({
        colocacion_vencida_mn: null,
        colocacion_vencida_me: 916.21,
      }),
    ),
    true,
  );
  pass('colocacion_vencida_me-only → member (V2)');
}

{
  assert.strictEqual(
    isBagMember(
      row({
        colocacion_vencida_mn: 0,
        colocacion_vencida_me: 0,
      }),
    ),
    false,
  );
  pass('colocacion_vencida 0/0 → no membership');
}

{
  assert.strictEqual(
    isBagMember(
      row({
        colocacion_vencida_mn: null,
        colocacion_vencida_me: null,
      }),
    ),
    false,
  );
  pass('colocacion_vencida null/null → no membership');
}

{
  assert.strictEqual(
    isBagMember(row({ moroso_mn: 10, castigado_mn: 20 })),
    true,
  );
  pass('moroso + castigado → enter');
}

// --- MN/ME separation (membership does not sum) ---
{
  // me alone is enough; verifying we don't require both
  assert.strictEqual(
    isBagMember(row({ moroso_mn: 0, moroso_me: 1 })),
    true,
  );
  assert.strictEqual(
    isBagMember(row({ moroso_mn: 0, moroso_me: 0, castigado_mn: 0, castigado_me: 1 })),
    true,
  );
  pass('MN/ME evaluated independently (no sum required)');
}

// --- AMBIGUOUS_CONSOLIDATION ---
{
  const model = build({
    snapshots: [
      {
        id: 's1',
        ci: 50212550,
        consulted_on: '2026-09-01',
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    institutions: [
      {
        snapshot_id: 's1',
        institution_name: 'Banco de la República Oriental del Uruguay',
        category: '5',
        moroso_mn: 100,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
      },
      {
        snapshot_id: 's1',
        institution_name: 'BANCO DE LA REPÚBLICA ORIENTAL DEL URUGUAY',
        category: '5',
        moroso_mn: null,
        moroso_me: null,
        castigado_mn: 50,
        castigado_me: null,
      },
    ],
  });
  assert.strictEqual(model.counts.ambiguous_consolidation, 1);
  assert.strictEqual(model.ambiguous_cases[0].flag, 'AMBIGUOUS_CONSOLIDATION');
  assert.strictEqual(model.bags.length, 0);
  assert.strictEqual(model.counts.bag_members_after_exclusions, 0);
  assert.strictEqual(model.counts.membership_true, 2);
  pass('AMBIGUOUS_CONSOLIDATION detected and excluded from bags');
}

// --- unmapped excluded from bags even if member ---
{
  const model = build({
    snapshots: [
      {
        id: 's1',
        ci: 1,
        consulted_on: '2026-09-01',
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    institutions: [
      {
        snapshot_id: 's1',
        institution_name: 'Unknown Bank S.A.',
        category: '5',
        moroso_mn: 100,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
      },
    ],
  });
  assert.strictEqual(model.counts.membership_true, 1);
  assert.strictEqual(model.counts.unmapped, 1);
  assert.strictEqual(model.bags.length, 0);
  pass('unmapped member excluded from canonical bags');
}

// --- bag amounts keep MN/ME separate ---
{
  const model = build({
    snapshots: [
      {
        id: 's1',
        ci: 1,
        consulted_on: '2026-09-01',
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    institutions: [
      {
        snapshot_id: 's1',
        institution_name: 'OCA S.A.',
        category: '5',
        moroso_mn: null,
        moroso_me: null,
        castigado_mn: 100,
        castigado_me: 50,
      },
    ],
  });
  assert.strictEqual(model.bags.length, 1);
  assert.strictEqual(model.bags[0].castigado_mn, 100);
  assert.strictEqual(model.bags[0].castigado_me, 50);
  assert.ok(!('castigado_total' in model.bags[0]));
  pass('bag aggregate keeps MN/ME separate');
}

// --- colocacion_vencida aggregates + people_count ---
{
  const model = build({
    snapshots: [
      {
        id: 's1',
        ci: 17994244,
        consulted_on: '2026-09-01',
        created_at: '2026-09-01T00:00:00Z',
      },
      {
        id: 's2',
        ci: 34027654,
        consulted_on: '2026-09-01',
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    institutions: [
      {
        snapshot_id: 's1',
        institution_name: 'SOCUR S.A.',
        category: '3',
        moroso_mn: null,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
        colocacion_vencida_mn: 60420.61,
        colocacion_vencida_me: 916.21,
      },
      {
        snapshot_id: 's2',
        institution_name: 'SOCUR S.A.',
        category: '5',
        moroso_mn: 100,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
        colocacion_vencida_mn: null,
        colocacion_vencida_me: null,
      },
      {
        snapshot_id: 's2',
        institution_name: 'Administradora de Soluciones Integrales S.A.',
        category: '3',
        moroso_mn: null,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
        colocacion_vencida_mn: 53545.43,
        colocacion_vencida_me: 0,
      },
    ],
  });
  assert.strictEqual(model.counts.membership_true, 3);
  const socur = model.bags.find(function (b) {
    return b.institution_canonical === 'SOCUR S.A.';
  });
  assert.ok(socur);
  assert.strictEqual(socur.people_count, 2);
  assert.strictEqual(socur.colocacion_vencida_mn, 60420.61);
  assert.strictEqual(socur.colocacion_vencida_me, 916.21);
  assert.strictEqual(socur.moroso_mn, 100);
  const adm = model.bags.find(function (b) {
    return (
      b.institution_canonical ===
      'Administradora de Soluciones Integrales S.A.'
    );
  });
  assert.ok(adm);
  assert.strictEqual(adm.people_count, 1);
  assert.strictEqual(adm.colocacion_vencida_mn, 53545.43);
  assert.strictEqual(adm.colocacion_vencida_me, 0);
  pass('colocacion_vencida aggregates + independent persona×inst memberships');
}

// --- reestructurado universe ---
{
  const model = build({
    snapshots: [
      {
        id: 's1',
        ci: 1,
        consulted_on: '2026-09-01',
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    institutions: [
      {
        snapshot_id: 's1',
        institution_name: 'Banco de la República Oriental del Uruguay',
        category: '5',
        moroso_mn: null,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
        creditos_reestructurados_mn: 10,
        creditos_reestructurados_me: 0,
      },
      {
        snapshot_id: 's1',
        institution_name: 'CASH S.A.',
        category: '5',
        moroso_mn: 5,
        moroso_me: null,
        castigado_mn: null,
        castigado_me: null,
        creditos_reestructurados_mn: 3,
        creditos_reestructurados_me: null,
      },
    ],
  });
  assert.strictEqual(model.reestructurado_universe.length, 2);
  const outside = model.reestructurado_universe.filter(function (r) {
    return !r.also_bag_member;
  });
  const inside = model.reestructurado_universe.filter(function (r) {
    return r.also_bag_member;
  });
  assert.strictEqual(outside.length, 1);
  assert.strictEqual(inside.length, 1);
  pass('reestructurado universe inside/outside bag');
}

// --- creditor catalog runtime ---
function oneSnap(ci, id) {
  return { id: id || 's-' + ci, ci: ci, consulted_on: '2026-09-01', created_at: '2026-09-01T00:00:00Z' };
}

{
  // 12. before/after: every fixture above gives the same model as the pre-catalog builder.
  const legacy = loadLegacyBagModule();
  assert.ok(FIXTURES.length >= 6);
  FIXTURES.forEach(function (input, i) {
    const oldModel = legacy.buildMiDeudaBagModel(input);
    const newModel = buildMiDeudaBagModel(Object.assign({ resolver: SEED_RESOLVER }, input));
    assert.deepStrictEqual(stripAdditive(newModel), stripAdditive(oldModel), 'fixture ' + i);
  });
  pass('bag model parity vs legacy builder (d176eba) on all fixtures');
}

{
  const model = build({
    snapshots: [oneSnap(1), oneSnap(2)],
    institutions: [
      { snapshot_id: 's-1', institution_name: 'SOCUR S.A.', category: '5', moroso_mn: 10 },
      { snapshot_id: 's-2', institution_name: 'SOCUR S.A.', category: '5', moroso_mn: 5 },
    ],
  });
  assert.strictEqual(model.bags.length, 1);
  assert.strictEqual(model.bags[0].creditor_id, SOCUR_ID);
  assert.strictEqual(model.bags[0].institution_canonical, 'SOCUR S.A.');
  assert.strictEqual(model.bags[0].people_count, 2);
  assert.strictEqual(model.persona_institution_rows[0].creditor_resolution, RESOLUTION.RESOLVED);
  assert.strictEqual(model.persona_institution_rows[0].normalized_key, 'socur sa');
  pass('bags grouped by creditor_id (additive output)');
}

{
  // 14. "cash s.a." now joins the CASH bag; raw is preserved on the member.
  const model = build({
    snapshots: [oneSnap(1), oneSnap(2)],
    institutions: [
      { snapshot_id: 's-1', institution_name: 'CASH S.A.', category: '5', moroso_mn: 10 },
      { snapshot_id: 's-2', institution_name: 'cash s.a.', category: '5', castigado_me: 3 },
    ],
  });
  assert.strictEqual(model.counts.unmapped, 0);
  assert.strictEqual(model.bags.length, 1);
  assert.strictEqual(model.bags[0].creditor_id, CASH_ID);
  assert.strictEqual(model.bags[0].people_count, 2);
  assert.deepStrictEqual(
    model.bags[0].members.map(function (m) {
      return m.raw_name;
    }),
    ['CASH S.A.', 'cash s.a.'],
  );
  pass('"cash s.a." resolves into CASH bag (intentional creditor_key_v1 semantics)');
}

{
  // 13. ambiguity guard now keys on creditor_id: two raws, same CI, same creditor.
  const model = build({
    snapshots: [oneSnap(7)],
    institutions: [
      { snapshot_id: 's-7', institution_name: 'CASH S.A.', category: '5', moroso_mn: 10 },
      { snapshot_id: 's-7', institution_name: 'Cash S.A', category: '5', castigado_mn: 4 },
    ],
  });
  assert.strictEqual(model.counts.ambiguous_consolidation, 1);
  assert.strictEqual(model.ambiguous_cases[0].creditor_id, CASH_ID);
  assert.strictEqual(model.bags.length, 0);
  pass('ambiguity guard on creditor_id (same CI, two raws, one creditor)');
}

{
  // Merged creditor: aliases of both creditors land in one bag; same CI via both → guard.
  const OLD = '44444444-4444-4444-8444-444444444444';
  const NEW = '55555555-5555-4555-8555-555555555555';
  const resolver = buildCreditorResolver({
    creditors: [
      { creditor_id: OLD, slug: 'old', display_name: 'Old Fin', status: 'merged', merged_into_creditor_id: NEW },
      { creditor_id: NEW, slug: 'new', display_name: 'New Fin', status: 'active', merged_into_creditor_id: null },
    ],
    aliases: [
      { id: 'a', source: 'bcu', normalized_key: 'old fin', creditor_id: OLD, status: 'approved' },
      { id: 'b', source: 'bcu', normalized_key: 'new fin', creditor_id: NEW, status: 'approved' },
    ],
  });
  const model = buildMiDeudaBagModel({
    resolver: resolver,
    snapshots: [oneSnap(1), oneSnap(2), oneSnap(3)],
    institutions: [
      { snapshot_id: 's-1', institution_name: 'OLD FIN', category: '5', moroso_mn: 1 },
      { snapshot_id: 's-2', institution_name: 'New Fin', category: '5', moroso_mn: 2 },
      { snapshot_id: 's-3', institution_name: 'Old Fin', category: '5', moroso_mn: 3 },
      { snapshot_id: 's-3', institution_name: 'New Fin', category: '5', moroso_mn: 4 },
    ],
  });
  assert.strictEqual(model.bags.length, 1);
  assert.strictEqual(model.bags[0].creditor_id, NEW);
  assert.strictEqual(model.bags[0].institution_canonical, 'New Fin');
  assert.strictEqual(model.bags[0].people_count, 2);
  assert.strictEqual(model.counts.ambiguous_consolidation, 1);
  pass('merged creditor → one bag; cross-alias same CI hits ambiguity guard');
}

{
  // 24. display rename: same creditor_id grouping, new label.
  const rows = seedCatalogRows();
  rows.creditors = rows.creditors.map(function (c) {
    return c.creditor_id === SOCUR_ID ? Object.assign({}, c, { display_name: 'Socur (renamed)' }) : c;
  });
  const model = buildMiDeudaBagModel({
    resolver: buildCreditorResolver(rows),
    snapshots: [oneSnap(1)],
    institutions: [{ snapshot_id: 's-1', institution_name: 'SOCUR S.A.', category: '5', moroso_mn: 10 }],
  });
  assert.strictEqual(model.bags[0].creditor_id, SOCUR_ID);
  assert.strictEqual(model.bags[0].institution_canonical, 'Socur (renamed)');
  pass('display_name rename keeps creditor_id grouping');
}

{
  // UNKNOWN / UNKNOWN_REVIEWED / EMPTY: excluded fail-closed, raw kept, rest of model continues.
  const rows = seedCatalogRows();
  rows.aliases = rows.aliases.concat([
    { id: 'amb', source: 'bcu', normalized_key: 'credito amigo', creditor_id: null, status: 'ambiguous' },
  ]);
  const model = buildMiDeudaBagModel({
    resolver: buildCreditorResolver(rows),
    snapshots: [oneSnap(1)],
    institutions: [
      { snapshot_id: 's-1', institution_name: 'Banco Fantasma S.A.', category: '5', moroso_mn: 1 },
      { snapshot_id: 's-1', institution_name: 'Crédito Amigo', category: '5', moroso_mn: 1 },
      { snapshot_id: 's-1', institution_name: '...', category: '5', moroso_mn: 1 },
      { snapshot_id: 's-1', institution_name: 'OCA S.A.', category: '5', moroso_mn: 9 },
    ],
  });
  assert.strictEqual(model.counts.unmapped, 3);
  assert.deepStrictEqual(
    model.unmapped_rows.map(function (r) {
      return [r.raw_name, r.map_status, r.map_reason, r.creditor_resolution];
    }),
    [
      ['Banco Fantasma S.A.', 'UNMAPPED', 'REVIEW_NEEDED', 'UNKNOWN'],
      ['Crédito Amigo', 'UNMAPPED', 'REVIEWED_AMBIGUOUS', 'UNKNOWN_REVIEWED'],
      ['...', 'UNMAPPED', 'EMPTY_RAW', 'EMPTY'],
    ],
  );
  assert.strictEqual(model.bags.length, 1);
  assert.strictEqual(model.bags[0].institution_canonical, 'OCA S.A.');
  pass('UNKNOWN / UNKNOWN_REVIEWED / EMPTY excluded fail-closed, raw kept');
}

{
  // 16 (model level). Empty-but-loaded catalog is a valid state: everything UNMAPPED, no throw.
  const model = buildMiDeudaBagModel({
    resolver: buildCreditorResolver({ creditors: [], aliases: [] }),
    snapshots: [oneSnap(1)],
    institutions: [{ snapshot_id: 's-1', institution_name: 'OCA S.A.', category: '5', moroso_mn: 9 }],
  });
  assert.strictEqual(model.bags.length, 0);
  assert.strictEqual(model.counts.unmapped, 1);
  pass('empty catalog → all UNMAPPED (visible), not an error');
}

{
  // 17. No silent fallback to APPROVED_RAW_TO_CANONICAL: no resolver → throws.
  [undefined, null, {}].forEach(function (resolver) {
    assert.throws(
      function () {
        buildMiDeudaBagModel({
          resolver: resolver,
          snapshots: [oneSnap(1)],
          institutions: [{ snapshot_id: 's-1', institution_name: 'OCA S.A.', category: '5', moroso_mn: 9 }],
        });
      },
      function (err) {
        return err && err.code === 'CREDITOR_CATALOG_INTEGRITY';
      },
    );
  });
  assert.throws(function () {
    buildMiDeudaBagModel({ snapshots: [], institutions: [] });
  });
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lib', 'miDeudaBags.js'), 'utf8');
  const body = src.slice(src.indexOf('function makeBcuRowResolver'), src.indexOf('module.exports'));
  assert.ok(!/canonicalizeInstitutionName|APPROVED_RAW_TO_CANONICAL/.test(body), 'builder must not read legacy map');
  pass('no silent legacy fallback (resolver required; builder never reads legacy map)');
}

console.log('unit-mi-deuda-bags: PASS (' + pass.n + ' assertions groups)');
