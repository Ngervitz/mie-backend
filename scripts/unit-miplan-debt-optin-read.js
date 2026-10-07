'use strict';

/**
 * Mi Deuda Stage 2 — read model (Rechazados list/detail, bags DECLARED + BCU) and UI helpers.
 * Fake Supabase in memory; no production I/O.
 * Run: node scripts/unit-miplan-debt-optin-read.js
 */

const assert = require('assert');

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: { port: 3000, nodeEnv: 'test', supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'test', apifyToken: 'test', apifyActorId: 'test' },
};
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const { buildCreditorResolver, RESOLUTION, creditorKeyV1 } = require('../src/lib/creditorCatalog');
const { fullSeedCatalogRows } = require('../src/lib/creditorCatalogMiplanDeclaredSeed');
const { declaredDebtId } = require('../src/lib/miplanDebtOptinContract');
const {
  attachMiDeudaOptinToListRows,
  loadMiDeudaOptinDetail,
  addDeclaredLayerToBags,
} = require('../src/lib/miplanDebtOptinRead');
const { loadMiDeudaBags, loadMiDeudaBagsWithDeclared } = require('../src/lib/miDeudaBagsRead');
const RH = require('../public/rechazados-helpers');
const MDH = require('../public/mi-deuda-helpers');

const SEED = fullSeedCatalogRows();
const RESOLVER = buildCreditorResolver(SEED);

function creditorIdBySlug(slug) {
  const c = SEED.creditors.find(function (x) { return x.slug === slug; });
  assert.ok(c, 'seed creditor ' + slug);
  return c.creditor_id;
}
const OCA = creditorIdBySlug('oca');
const UTE = creditorIdBySlug('ute');
const ANTEL = creditorIdBySlug('antel');

let groups = 0;

function u(p, n) {
  return p + '-0000-4000-8000-' + String(n).padStart(12, '0');
}

function event(n, ci, over) {
  return Object.assign({
    event_id: u('10000000', n),
    journey_id: u('20000000', n),
    seq: 1,
    state: 'opted_in',
    consent_text_version: 'dm-optin-v1',
    origin_diagnosis_id: u('40000000', n),
    snapshot_diagnosis_id: u('40000000', n),
    miplan_created_at: '2026-10-0' + (1 + (n % 5)) + 'T12:00:00.000001+00:00',
    excluded_count: 0,
    ci: ci,
    ci_resolution: ci == null ? 'unresolvable' : 'resolved',
    received_at: '2026-10-06T00:00:00+00:00',
  }, over || {});
}

function debt(ev, position, raw, over) {
  const r = require('../src/lib/creditorCatalog').resolveCreditor(RESOLVER, 'miplan_declared', raw);
  return Object.assign({
    declared_debt_id: declaredDebtId(ev.event_id, position),
    optin_event_id: ev.event_id,
    ci: ev.ci,
    snapshot_diagnosis_id: ev.snapshot_diagnosis_id,
    position: position,
    client_debt_id: 'd' + position,
    tipo: 'tarjeta',
    creditor_raw: raw,
    miplan_acreedor_display: null,
    miplan_acreedor_normalizado: null,
    creditor_normalized_key: raw == null ? null : creditorKeyV1(raw),
    ingestion_resolution: r.resolution,
    ingestion_creditor_id: r.creditor_id,
    monto: '1000',
    monto_raw: '1000',
    pago: null,
    pago_raw: null,
    pago_mensual_actual: null,
    pago_mensual_actual_raw: null,
    situacion_ui: 'atrasada',
    estado: 'atrasada',
    atraso_tiempo: null,
    atraso_tiempo_aprox: null,
    ultimo_pago_declarado: null,
    ultimo_pago_declarado_raw: null,
    debt_confidence: null,
  }, over || {});
}

/** Fake supporting from().select().in()/neq()/range() and catalog tables. */
function fakeSupabase(tables, opts) {
  const o = opts || {};
  const calls = [];
  const all = Object.assign({ creditors: SEED.creditors, creditor_aliases: SEED.aliases }, tables);
  return {
    calls: calls,
    from: function (table) {
      calls.push(table);
      const filters = [];
      const q = {
        select: function () { return q; },
        in: function (col, vals) {
          filters.push(function (r) { return vals.map(String).indexOf(String(r[col])) >= 0; });
          return q;
        },
        neq: function (col, val) {
          filters.push(function (r) { return r[col] !== val; });
          return q;
        },
        range: async function (from, to) {
          if (o.missing && o.missing.indexOf(table) >= 0) {
            return { data: null, error: { code: '42P01', message: 'relation "public.' + table + '" does not exist' } };
          }
          if (o.failing && o.failing.indexOf(table) >= 0) {
            return { data: null, error: { code: '57014', message: 'canceling statement' } };
          }
          const rows = (all[table] || []).filter(function (r) { return filters.every(function (f) { return f(r); }); });
          return { data: rows.slice(from, to + 1), error: null };
        },
      };
      return q;
    },
  };
}

async function main() {
  // Scenario: CI 1 active (OCA x2 + UNKNOWN + UTE), CI 2 withdrawn after accepting, CI 3 active
  // (OCA, ANTEL), CI 4 unresolvable (no CI) event, CI 5 accept→withdraw→accept.
  const e1 = event(1, 1);
  const e2a = event(2, 2, { journey_id: u('20000000', 2), seq: 1 });
  const e2b = event(12, 2, { journey_id: u('20000000', 2), seq: 2, state: 'withdrawn', excluded_count: null, miplan_created_at: '2026-10-05T12:00:00.000001+00:00' });
  const e3 = event(3, 3);
  const e4 = event(4, null);
  const e5a = event(5, 5, { journey_id: u('20000000', 5), seq: 1, miplan_created_at: '2026-10-01T10:00:00.000001+00:00' });
  const e5b = event(15, 5, { journey_id: u('20000000', 5), seq: 2, state: 'withdrawn', excluded_count: null, miplan_created_at: '2026-10-01T11:00:00.000001+00:00' });
  const e5c = event(25, 5, { journey_id: u('20000000', 5), seq: 3, miplan_created_at: '2026-10-01T12:00:00.000001+00:00' });
  const events = [e1, e2a, e2b, e3, e4, e5a, e5b, e5c];
  const debts = [
    debt(e1, 0, 'OCA'),
    debt(e1, 1, 'oca', { monto: '1000', monto_raw: '1000' }),
    debt(e1, 2, 'Tía Marta'),
    debt(e1, 3, 'UTE', { tipo: 'servicio' }),
    debt(e2a, 0, 'OCA'),
    debt(e3, 0, 'OCA'),
    debt(e3, 1, 'Antel'),
    debt(e4, 0, 'OCA'),
    debt(e5a, 0, 'Antel'),
    debt(e5c, 0, 'UTE', { monto: null, monto_raw: '15.000' }),
  ];
  assert.strictEqual(debts[0].ingestion_creditor_id, OCA);
  assert.strictEqual(debts[2].ingestion_resolution, RESOLUTION.UNKNOWN);
  const tables = { miplan_debt_optin_events: events, miplan_declared_debts: debts };

  // 1. Rechazados list: derived state, legacy mi_deuda_status untouched, no event ≠ rejected.
  {
    const rows = [
      { ci: 1, mi_deuda_status: 'not_invited' },
      { ci: 2, mi_deuda_status: 'invite_sent' },
      { ci: 5, mi_deuda_status: 'not_invited' },
      { ci: 9, mi_deuda_status: 'not_invited' },
    ];
    const out = await attachMiDeudaOptinToListRows(fakeSupabase(tables), rows);
    assert.strictEqual(out.available, true);
    const by = new Map(out.rows.map(function (r) { return [r.ci, r]; }));
    assert.strictEqual(by.get(1).mi_deuda_optin.state, 'opted_in');
    assert.strictEqual(by.get(1).mi_deuda_optin.label, 'aceptó');
    assert.strictEqual(by.get(1).mi_deuda_optin.active, true);
    assert.strictEqual(by.get(1).mi_deuda_optin.third_party_sharing_authorized, false);
    assert.strictEqual(by.get(2).mi_deuda_optin.state, 'withdrawn');
    assert.strictEqual(by.get(2).mi_deuda_optin.label, 'retiró');
    assert.strictEqual(by.get(2).mi_deuda_optin.at, e2b.miplan_created_at);
    assert.strictEqual(by.get(5).mi_deuda_optin.state, 'opted_in', 'accept → withdraw → accept');
    assert.strictEqual(by.get(5).mi_deuda_optin.event_id, e5c.event_id);
    assert.strictEqual(by.get(9).mi_deuda_optin, null, 'no event is not "rejected"');
    assert.strictEqual(by.get(2).mi_deuda_status, 'invite_sent', 'legacy field untouched');

    const missing = await attachMiDeudaOptinToListRows(fakeSupabase(tables, { missing: ['miplan_debt_optin_events'] }), [{ ci: 1, mi_deuda_status: 'x' }]);
    assert.strictEqual(missing.available, false);
    assert.strictEqual(missing.error_code, 'MI_DEUDA_OPTIN_NOT_MIGRATED');
    assert.strictEqual(missing.rows[0].mi_deuda_optin, null);
    assert.strictEqual(missing.rows[0].mi_deuda_status, 'x');
    const failing = await attachMiDeudaOptinToListRows(fakeSupabase(tables, { failing: ['miplan_debt_optin_events'] }), [{ ci: 1 }]);
    assert.strictEqual(failing.available, false);
    assert.strictEqual(failing.error_code, 'MI_DEUDA_OPTIN_READ_FAILED');
    groups += 1;
  }

  // 2. Detail: latest snapshot, effective creditor, UNKNOWN visible, history, feeds_bags.
  {
    const loadCatalog = async function () { return RESOLVER; };
    const d1 = await loadMiDeudaOptinDetail(fakeSupabase(tables), 1, { loadCatalog: loadCatalog });
    assert.strictEqual(d1.available, true);
    assert.strictEqual(d1.third_party_sharing_authorized, false);
    assert.strictEqual(d1.current.state, 'opted_in');
    assert.strictEqual(d1.snapshot.event_id, e1.event_id);
    assert.strictEqual(d1.snapshot.feeds_bags, true);
    assert.strictEqual(d1.snapshot.catalog_available, true);
    assert.strictEqual(d1.snapshot.debts.length, 4, 'several debts same creditor stay separate');
    assert.strictEqual(d1.snapshot.debts[0].effective_creditor_id, OCA);
    assert.strictEqual(d1.snapshot.debts[1].effective_creditor_id, OCA);
    assert.strictEqual(d1.snapshot.debts[2].unknown, true);
    assert.strictEqual(d1.snapshot.debts[2].effective_creditor_id, null);
    assert.strictEqual(d1.snapshot.debts[2].creditor_raw, 'Tía Marta');
    assert.strictEqual(d1.snapshot.debts[3].effective_creditor_id, UTE, 'non-financial creditor');
    assert.strictEqual(d1.history.length, 1);

    const d2 = await loadMiDeudaOptinDetail(fakeSupabase(tables), 2, { loadCatalog: loadCatalog });
    assert.strictEqual(d2.current.state, 'withdrawn');
    assert.strictEqual(d2.snapshot.event_id, e2a.event_id, 'withdrawn keeps historic snapshot visible');
    assert.strictEqual(d2.snapshot.feeds_bags, false);
    assert.deepStrictEqual(d2.history.map(function (h) { return h.state; }), ['withdrawn', 'opted_in']);

    const d5 = await loadMiDeudaOptinDetail(fakeSupabase(tables), 5, { loadCatalog: loadCatalog });
    assert.strictEqual(d5.snapshot.event_id, e5c.event_id);
    assert.strictEqual(d5.snapshot.debts[0].monto, null, 'invalid numeric keeps null');
    assert.strictEqual(d5.snapshot.debts[0].monto_raw, '15.000', 'raw preserved');

    const none = await loadMiDeudaOptinDetail(fakeSupabase(tables), 9, { loadCatalog: loadCatalog });
    assert.strictEqual(none.available, true);
    assert.strictEqual(none.current, null);
    assert.strictEqual(none.snapshot, null);

    const noCat = await loadMiDeudaOptinDetail(fakeSupabase(tables), 1, { loadCatalog: async function () { throw new Error('x'); } });
    assert.strictEqual(noCat.snapshot.catalog_available, false);
    assert.strictEqual(noCat.snapshot.debts[0].effective_creditor_id, null);
    assert.strictEqual(noCat.snapshot.debts[0].creditor_raw, 'OCA');

    const missing = await loadMiDeudaOptinDetail(fakeSupabase(tables, { missing: ['miplan_debt_optin_events'] }), 1, { loadCatalog: loadCatalog });
    assert.deepStrictEqual(missing, { available: false, error_code: 'MI_DEUDA_OPTIN_NOT_MIGRATED', third_party_sharing_authorized: false });

    // merged creditor one hop at read time (ingested OCA → merged into UTE purely for the test)
    const merged = fullSeedCatalogRows();
    merged.creditors = merged.creditors.map(function (c) {
      return c.creditor_id === OCA ? Object.assign({}, c, { status: 'merged', merged_into_creditor_id: UTE }) : c;
    });
    const dm = await loadMiDeudaOptinDetail(fakeSupabase(tables), 1, { loadCatalog: async function () { return buildCreditorResolver(merged); } });
    assert.strictEqual(dm.snapshot.debts[0].ingestion_resolution, RESOLUTION.RESOLVED);
    assert.strictEqual(dm.snapshot.debts[0].effective_creditor_id, UTE, 'merged one hop');
    groups += 1;
  }

  // 3. Bags: BCU unchanged + DECLARED layer (declared-only creditor, both layers, UNKNOWN out).
  {
    const bcuTables = Object.assign({}, tables, {
      rejected_bcu_snapshots: [
        { id: 's1', ci: 1, consulted_on: '2026-09-01', created_at: '2026-09-01T00:00:00Z', source: 'html_import' },
        { id: 's7', ci: 7, consulted_on: '2026-09-01', created_at: '2026-09-01T00:00:00Z', source: 'html_import' },
      ],
      rejected_bcu_institutions: [
        { id: 'i1', snapshot_id: 's1', institution_name: 'OCA S.A.', category: '5', moroso_mn: 100, moroso_me: null, castigado_mn: null, castigado_me: null },
        { id: 'i7', snapshot_id: 's7', institution_name: 'OCA S.A.', category: '5', moroso_mn: 50, moroso_me: null, castigado_mn: null, castigado_me: null },
      ],
    });
    const before = await loadMiDeudaBags(fakeSupabase(bcuTables));
    const after = await loadMiDeudaBagsWithDeclared(fakeSupabase(bcuTables));
    const ocaBefore = before.bags.find(function (b) { return b.creditor_id === OCA; });
    const ocaAfter = after.bags.find(function (b) { return b.creditor_id === OCA; });
    Object.keys(ocaBefore).forEach(function (k) {
      assert.deepStrictEqual(ocaAfter[k], ocaBefore[k], 'BCU field preserved: ' + k);
    });
    assert.strictEqual(after.bags.length, before.bags.length, 'no declared-only bag injected into BCU list');
    assert.strictEqual(ocaAfter.people_count, 2, 'people_count keeps BCU meaning');
    assert.strictEqual(ocaAfter.people_bcu, 2);
    assert.strictEqual(ocaAfter.people_declared, 2, 'CI 1 and CI 3 (CI 2 withdrawn, CI 4 unresolved)');
    assert.strictEqual(ocaAfter.people_both, 1, 'same CI + same creditor_id (CI 1)');
    assert.strictEqual(ocaAfter.people_union, 3);
    ['counts', 'reestructurado_universe', 'unmapped_rows', 'ambiguous_cases', 'current_snapshot_ids', 'creditor_catalog'].forEach(function (k) {
      assert.deepStrictEqual(after[k], before[k], 'top-level BCU field preserved: ' + k);
    });

    const dl = after.declared_layer;
    assert.strictEqual(dl.available, true);
    assert.strictEqual(dl.third_party_sharing_authorized, false);
    const dOca = dl.bags.find(function (b) { return b.creditor_id === OCA; });
    const dUte = dl.bags.find(function (b) { return b.creditor_id === UTE; });
    const dAntel = dl.bags.find(function (b) { return b.creditor_id === ANTEL; });
    assert.ok(dUte && dUte.people_bcu === 0 && dUte.people_declared === 2, 'declared-only non-financial bag (CI 1, CI 5)');
    assert.ok(dAntel && dAntel.people_declared === 1, 'CI 3 only: CI 5 antel debt belongs to a superseded snapshot');
    const ci1 = dOca.members.find(function (m) { return m.ci === 1; });
    assert.strictEqual(dOca.members.filter(function (m) { return m.ci === 1; }).length, 1, 'one CI once per bag');
    assert.strictEqual(ci1.declared_debts.length, 2, 'two OCA debts kept separate (same amount, no collision)');
    assert.notStrictEqual(ci1.declared_debts[0].declared_debt_id, ci1.declared_debts[1].declared_debt_id);
    assert.strictEqual(ci1.also_in_bcu, true);
    assert.ok(!('bcu_rows' in ci1), 'declared view never merges BCU rows into declared debts');
    assert.ok(dl.bags.every(function (b) { return b.members.every(function (m) { return m.ci !== 2 && m.ci !== 4; }); }), 'withdrawn / unresolved CI never bagged');
    const inBags = new Set();
    dl.bags.forEach(function (b) { b.members.forEach(function (m) { if (m.ci === 1) inBags.add(b.creditor_id); }); });
    assert.deepStrictEqual(Array.from(inBags).sort(), [OCA, UTE].sort(), 'one CI in several bags');
    assert.strictEqual(dl.unbagged_active_debts_count, 1, 'Tía Marta (UNKNOWN) visible but not bagged');

    // declared layer unavailable → BCU payload byte-identical apart from declared_layer
    const noTables = await loadMiDeudaBagsWithDeclared(fakeSupabase(bcuTables, { missing: ['miplan_debt_optin_events'] }));
    const stripped = Object.assign({}, noTables);
    delete stripped.declared_layer;
    assert.deepStrictEqual(stripped, before);
    assert.strictEqual(noTables.declared_layer.available, false);
    assert.strictEqual(noTables.declared_layer.error_code, 'MI_DEUDA_OPTIN_NOT_MIGRATED');

    // BCU-only (no events at all) → annotations are zero, BCU unchanged
    const bcuOnly = await loadMiDeudaBagsWithDeclared(fakeSupabase(Object.assign({}, bcuTables, { miplan_debt_optin_events: [], miplan_declared_debts: [] })));
    const o = bcuOnly.bags.find(function (b) { return b.creditor_id === OCA; });
    assert.strictEqual(o.people_count, 2);
    assert.strictEqual(o.people_declared, 0);
    assert.strictEqual(o.people_union, 2);
    assert.strictEqual(bcuOnly.declared_layer.bags.length, 0);

    // integrity failure in the declared layer does not break BCU bags
    const badDebts = debts.concat([debt(e3, 9, 'OCA', { ingestion_creditor_id: '99999999-0000-4000-8000-000000000000' })]);
    const broken = await addDeclaredLayerToBags(
      fakeSupabase(Object.assign({}, tables, { miplan_declared_debts: badDebts })),
      before,
      RESOLVER,
    );
    assert.strictEqual(broken.declared_layer.available, false);
    assert.deepStrictEqual(broken.bags, before.bags);
    groups += 1;
  }

  // 5. [K][J][L][F] CI reconciliation at read time + out-of-order journey.
  {
    const e6 = event(6, null);
    const e7 = event(7, null);
    const e8 = event(8, null);
    // F: same journey, seq2 withdrawn (processed first) + late seq1 opted_in with debts.
    const f2 = event(32, 11, { journey_id: u('20000000', 31), seq: 2, state: 'withdrawn', excluded_count: null, miplan_created_at: '2026-10-02T12:00:00.000001+00:00', received_at: '2026-10-01T00:00:00+00:00' });
    const f1 = event(31, 11, { journey_id: u('20000000', 31), seq: 1, miplan_created_at: '2026-10-01T12:00:00.000001+00:00', received_at: '2026-10-09T00:00:00+00:00' });
    const recTables = {
      miplan_debt_optin_events: [e6, e7, e8, f2, f1],
      miplan_declared_debts: [debt(e6, 0, 'OCA'), debt(e7, 0, 'OCA'), debt(e8, 0, 'Antel'), debt(f1, 0, 'UTE')],
      miplan_optin_ci_reconciliation: [
        { event_id: e6.event_id, status: 'RESOLVED', resolved_ci: 6 },
        { event_id: e7.event_id, status: 'PENDING', resolved_ci: null },
        { event_id: e8.event_id, status: 'TERMINAL_UNRESOLVABLE', resolved_ci: null },
      ],
    };
    assert.strictEqual(recTables.miplan_declared_debts[0].ci, null, 'debt row keeps ci NULL (immutable)');

    const list = await attachMiDeudaOptinToListRows(fakeSupabase(recTables), [{ ci: 6 }, { ci: 11 }, { ci: 7 }]);
    const by = new Map(list.rows.map(function (r) { return [r.ci, r]; }));
    assert.strictEqual(by.get(6).mi_deuda_optin.state, 'opted_in', 'K: reconciled CI shows the opt-in');
    assert.strictEqual(by.get(6).mi_deuda_optin.event_id, e6.event_id);
    assert.strictEqual(by.get(11).mi_deuda_optin.state, 'withdrawn', 'F: late seq1 never reactivates');
    assert.strictEqual(by.get(7).mi_deuda_optin, null, 'pending event has no CI → no state');

    const d6 = await loadMiDeudaOptinDetail(fakeSupabase(recTables), 6, { loadCatalog: async function () { return RESOLVER; } });
    assert.strictEqual(d6.current.state, 'opted_in');
    assert.strictEqual(d6.snapshot.feeds_bags, true);
    assert.strictEqual(d6.history[0].ci_reconciled, true);
    const d11 = await loadMiDeudaOptinDetail(fakeSupabase(recTables), 11, { loadCatalog: async function () { return RESOLVER; } });
    assert.strictEqual(d11.current.state, 'withdrawn');
    assert.strictEqual(d11.snapshot.event_id, f1.event_id, 'F: late seq1 kept historically');
    assert.strictEqual(d11.snapshot.feeds_bags, false, 'F: late seq1 snapshot does not feed bags');
    assert.deepStrictEqual(d11.history.map(function (h) { return h.seq; }), [2, 1]);

    const bags = await addDeclaredLayerToBags(fakeSupabase(recTables), { bags: [] }, RESOLVER);
    const dl = bags.declared_layer;
    assert.strictEqual(dl.available, true);
    const dOca = dl.bags.find(function (b) { return b.creditor_id === OCA; });
    assert.ok(dOca && dOca.members.length === 1 && dOca.members[0].ci === 6, 'K: resolved CI enters the bag');
    assert.ok(!dl.bags.some(function (b) { return b.creditor_id === ANTEL; }), 'L: terminal event never bagged');
    assert.ok(!dl.bags.some(function (b) { return b.creditor_id === UTE; }), 'F: late seq1 debts never bagged');
    assert.ok(dl.bags.every(function (b) { return b.members.every(function (m) { return m.ci === 6; }); }), 'J: pending event never bagged');
    assert.deepStrictEqual(dl.ci_reconciliation, { pending: 1, resolved: 1, terminal_unresolvable: 1 }, 'pending / terminal stay visible');
    const notice = MDH.declaredLayerNotice(dl);
    assert.ok(/reconciliación \(no entran en bolsas\): 1/.test(notice) && /irresolubles \(no entran en bolsas\): 1/.test(notice), notice);

    const noRecon = await addDeclaredLayerToBags(fakeSupabase(recTables, { missing: ['miplan_optin_ci_reconciliation'] }), { bags: [] }, RESOLVER);
    assert.strictEqual(noRecon.declared_layer.available, false, 'fail-soft when the reconciliation table is missing');
    groups += 1;
  }

  // 4. UI helpers.
  {
    const accepted = RH.miDeudaOptinCell({ state: 'opted_in', at: '2026-10-06T12:00:00Z' }, 'not_invited', false);
    assert.strictEqual(accepted.label, 'Aceptó');
    assert.ok(/Mi Plan/.test(accepted.title));
    assert.strictEqual(RH.miDeudaOptinCell({ state: 'withdrawn', at: null }, 'opt_in_accepted', false).label, 'Retiró');
    assert.deepStrictEqual(RH.miDeudaOptinCell(null, 'invite_sent', false), RH.miDeudaCell('invite_sent', false), 'legacy fallback');
    assert.deepStrictEqual(RH.miDeudaOptinCell(undefined, 'not_invited', false), RH.miDeudaCell('not_invited', false));
    assert.strictEqual(RH.miDeudaOptinLabel(null, 'opt_in_rejected', false), 'Rechazó', 'legacy rejected only from legacy field');

    assert.deepStrictEqual(MDH.buildDeclaredBagTableRows(null), []);
    assert.deepStrictEqual(MDH.buildDeclaredBagTableRows({ available: false }), []);
    const rows = MDH.buildDeclaredBagTableRows({
      available: true,
      bags: [
        { creditor_id: 'b', display_name: 'UTE', people_declared: 1, people_both: 0, declared_debts_count: 1 },
        { creditor_id: 'a', display_name: 'OCA', people_declared: 3, people_both: 2, declared_debts_count: 4 },
      ],
    });
    assert.deepStrictEqual(rows.map(function (r) { return r.display_name; }), ['OCA', 'UTE']);
    assert.strictEqual(MDH.declaredLayerNotice({ available: false }), 'Deudas declaradas en Mi Plan: no disponible.');
    assert.ok(/1/.test(MDH.declaredLayerNotice({ available: true, unbagged_active_debts_count: 1 })));
    assert.strictEqual(MDH.declaredLayerNotice({ available: true, unbagged_active_debts_count: 0 }), '');
    const det = MDH.declaredDebtDetailRows({
      debts: [
        { position: 0, unknown: false, effective_creditor_name: 'OCA', tipo: 'tarjeta', monto: 1000, situacion_ui: 'atrasada' },
        { position: 1, unknown: true, creditor_raw: 'Tía Marta', monto: null, monto_raw: '15.000' },
      ],
    });
    assert.strictEqual(det[0].creditor_label, 'OCA');
    assert.strictEqual(det[1].creditor_label, 'Sin resolver: Tía Marta');
    assert.strictEqual(det[1].monto_raw, '15.000');
    groups += 1;
  }

  console.log('unit-miplan-debt-optin-read: ' + groups + ' groups OK');
}

main().catch(function (err) {
  console.error('unit-miplan-debt-optin-read: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
