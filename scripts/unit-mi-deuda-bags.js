'use strict';

/**
 * Mi Deuda Stage 1C — unit tests for read-only bag model.
 * Run: node scripts/unit-mi-deuda-bags.js
 * No production I/O.
 */

const assert = require('assert');
const {
  MAP_STATUS,
  canonicalizeInstitutionName,
  isBagMember,
  selectCurrentSnapshotsByCi,
  buildMiDeudaBagModel,
  APPROVED_RAW_TO_CANONICAL,
} = require('../src/lib/miDeudaBags');

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
  const model = buildMiDeudaBagModel({
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
  // New case-only variant NOT in approved map
  const unk = canonicalizeInstitutionName('cash s.a.');
  assert.strictEqual(unk.status, MAP_STATUS.UNMAPPED);
  assert.strictEqual(unk.reason, 'REVIEW_NEEDED');
  assert.strictEqual(unk.canonical_name, null);
  pass('new case-only variant → UNMAPPED/REVIEW_NEEDED');
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
  const model = buildMiDeudaBagModel({
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
  const model = buildMiDeudaBagModel({
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
  const model = buildMiDeudaBagModel({
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

// --- reestructurado universe ---
{
  const model = buildMiDeudaBagModel({
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

console.log('unit-mi-deuda-bags: PASS (' + pass.n + ' assertions groups)');
