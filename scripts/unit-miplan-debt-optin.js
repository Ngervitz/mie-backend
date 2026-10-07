'use strict';

/**
 * Mi Deuda Stage 2 — Mi Plan opt-in export contract, coercion, debt identity, CI resolution,
 * declared creditor resolution at ingestion, current state.
 * Run: node scripts/unit-miplan-debt-optin.js
 * Pure / in-memory. No DB, no network.
 */

const assert = require('assert');

const {
  EXPORT_CONTRACT_VERSION,
  CI_RESOLUTION,
  MiplanOptinPayloadError,
  declaredDebtId,
  coerceAmount,
  validateExportEvent,
  validateExportPage,
  resolveCiFromToken,
  ciUnresolvedReason,
  resolveCiForEvent,
  buildIngestPayload,
} = require('../src/lib/miplanDebtOptinContract');
const {
  createdAtMicros,
  currentEventByJourney,
  currentStateByCi,
  activeOptinEventIds,
} = require('../src/lib/miplanDebtOptinState');
const { buildCreditorResolver, RESOLUTION } = require('../src/lib/creditorCatalog');
const { seedCatalogRows } = require('../src/lib/creditorCatalogBcuSeed');

let groups = 0;
function pass() {
  groups += 1;
}

const BROU = '2153c7f3-0193-5a03-9055-c37ed08c4ca6';
const UTE = 'aaaaaaaa-0000-4000-8000-000000000001';
const DIVINO = 'aaaaaaaa-0000-4000-8000-000000000002';
const IM = 'aaaaaaaa-0000-4000-8000-000000000003';

function testCatalog() {
  const base = seedCatalogRows();
  base.creditors.push(
    { creditor_id: UTE, slug: 'ute', display_name: 'UTE', status: 'active', merged_into_creditor_id: null },
    { creditor_id: DIVINO, slug: 'divino', display_name: 'Divino', status: 'active', merged_into_creditor_id: null },
    { creditor_id: IM, slug: 'intendencia-montevideo', display_name: 'Intendencia de Montevideo', status: 'active', merged_into_creditor_id: null },
  );
  base.aliases.push(
    { id: 'bbbbbbbb-0000-4000-8000-000000000001', source: 'miplan_declared', normalized_key: 'brou', creditor_id: BROU, status: 'approved' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', source: 'miplan_declared', normalized_key: 'ute', creditor_id: UTE, status: 'approved' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000003', source: 'miplan_declared', normalized_key: 'divino', creditor_id: DIVINO, status: 'approved' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000004', source: 'miplan_declared', normalized_key: 'intendencia de montevideo', creditor_id: IM, status: 'approved' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000005', source: 'miplan_declared', normalized_key: 'familiar', creditor_id: null, status: 'ambiguous' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000006', source: 'miplan_declared', normalized_key: 'amigo', creditor_id: null, status: 'ambiguous' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000007', source: 'miplan_declared', normalized_key: 'pass', creditor_id: null, status: 'ambiguous' },
  );
  return base;
}

const E1 = '10000000-0000-4000-8000-000000000001';
const E2 = '10000000-0000-4000-8000-000000000002';
const J1 = '20000000-0000-4000-8000-000000000001';
const J2 = '20000000-0000-4000-8000-000000000002';
const EV = '30000000-0000-4000-8000-000000000001';
const D1 = '40000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

function rawEvent(over) {
  return Object.assign(
    {
      event_id: E1,
      journey_id: J1,
      seq: 1,
      state: 'opted_in',
      scope: 'debt_management_interest',
      contract_version: 'debt_management_opt_in_v1',
      source: 'miplan_v2',
      consent_text_version: 'dm-optin-v1',
      created_at: '2026-10-06T20:01:46.123456+00:00',
      origin_evaluation_id: EV,
      origin_diagnosis_id: D1,
      snapshot_diagnosis_id: D1,
      handoff_token_hash: HASH,
      excluded_count: 0,
      debts: [],
    },
    over || {},
  );
}

function debt(position, over) {
  return Object.assign(
    { position: position, client_debt_id: 'deuda_' + position, tipo: 'prestamo', acreedor_raw: 'BROU', acreedor: 'BROU', monto: 1000, pago: 100, situacion_ui: 'pagando_normal', estado: 'al_dia' },
    over || {},
  );
}

function expectPayloadError(fn, label) {
  assert.throws(fn, function (err) {
    return err instanceof MiplanOptinPayloadError && err.code === 'MIPLAN_OPTIN_PAYLOAD_INVALID';
  }, label);
}

const resolver = buildCreditorResolver(testCatalog());

function ingest(ev, token) {
  return buildIngestPayload(validateExportEvent(ev), resolveCiFromToken(token), resolver);
}

const TOKEN_OK = { id: 'cccccccc-0000-4000-8000-000000000001', status: 'consumed', ci: '12345678' };

// 1-5. Declared creditor resolution: financial, non-financial, comercio, ente público, unknown
{
  const p = ingest(rawEvent({
    debts: [
      debt(0, { acreedor_raw: 'Brou' }),
      debt(1, { acreedor_raw: 'U.T.E.' }),
      debt(2, { acreedor_raw: 'DIVINO' }),
      debt(3, { acreedor_raw: 'Intendencia de Montevideo' }),
      debt(4, { acreedor_raw: 'Creditel' }),
    ],
  }), TOKEN_OK);
  const r = p.debts.map(function (d) {
    return [d.ingestion_resolution, d.ingestion_creditor_id, d.creditor_normalized_key];
  });
  assert.deepStrictEqual(r[0], [RESOLUTION.RESOLVED, BROU, 'brou']);
  assert.deepStrictEqual(r[1], [RESOLUTION.RESOLVED, UTE, 'ute']);
  assert.deepStrictEqual(r[2], [RESOLUTION.RESOLVED, DIVINO, 'divino']);
  assert.deepStrictEqual(r[3], [RESOLUTION.RESOLVED, IM, 'intendencia de montevideo']);
  assert.deepStrictEqual(r[4], [RESOLUTION.UNKNOWN, null, 'creditel']);
  p.debts.forEach(function (d) {
    assert.strictEqual(d.creditor_key_version, 'creditor_key_v1');
  });
  assert.strictEqual(p.debts[0].ingestion_alias_id, 'bbbbbbbb-0000-4000-8000-000000000001');
  assert.strictEqual(p.debts[4].ingestion_alias_id, null);
  pass();
}

// 6-7. Ambiguous aliases and informal counterparties never merge into a creditor
{
  const p = ingest(rawEvent({
    debts: [
      debt(0, { acreedor_raw: 'Familiar' }),
      debt(1, { acreedor_raw: 'amigo' }),
      debt(2, { acreedor_raw: 'Pass' }),
      debt(3, { acreedor_raw: 'mi hermano' }),
      debt(4, { acreedor_raw: 'Persona' }),
    ],
  }), TOKEN_OK);
  assert.deepStrictEqual(p.debts.map(function (d) {
    return d.ingestion_resolution;
  }), [RESOLUTION.UNKNOWN_REVIEWED, RESOLUTION.UNKNOWN_REVIEWED, RESOLUTION.UNKNOWN_REVIEWED, RESOLUTION.UNKNOWN, RESOLUTION.UNKNOWN]);
  p.debts.forEach(function (d) {
    assert.strictEqual(d.ingestion_creditor_id, null);
  });
  pass();
}

// 8-9. BCU aliases never resolve miplan_declared; no fuzzy / no Mi Plan hints used
{
  const p = ingest(rawEvent({
    debts: [
      debt(0, { acreedor_raw: 'Banco Santander S.A.' }), // bcu alias exists for this key
      debt(1, { acreedor_raw: 'BROU.' }), // exact key "brou" (dots deleted) → resolves
      debt(2, { acreedor_raw: 'Brou Uruguay' }), // near-miss → UNKNOWN (no fuzzy)
      debt(3, { acreedor_raw: 'Brouu' }),
      debt(4, { acreedor_raw: 'XYZ', acreedor_normalizado: 'BROU', acreedor_display: 'BROU', acreedor_key: 'brou' }),
    ],
  }), TOKEN_OK);
  assert.deepStrictEqual(p.debts.map(function (d) {
    return d.ingestion_resolution;
  }), [RESOLUTION.UNKNOWN, RESOLUTION.RESOLVED, RESOLUTION.UNKNOWN, RESOLUTION.UNKNOWN, RESOLUTION.UNKNOWN]);
  assert.strictEqual(p.debts[4].miplan_acreedor_normalizado, 'BROU'); // kept as hint only
  pass();
}

// creditor_raw: acreedor_raw first, acreedor fallback, EMPTY when both blank
{
  const p = ingest(rawEvent({
    debts: [
      debt(0, { acreedor_raw: '  ', acreedor: 'UTE' }),
      debt(1, { acreedor_raw: null, acreedor: 'Divino' }),
      debt(2, { acreedor_raw: '', acreedor: '' }),
    ],
  }), TOKEN_OK);
  assert.strictEqual(p.debts[0].creditor_raw, 'UTE');
  assert.strictEqual(p.debts[0].ingestion_creditor_id, UTE);
  assert.strictEqual(p.debts[1].ingestion_creditor_id, DIVINO);
  assert.strictEqual(p.debts[2].ingestion_resolution, RESOLUTION.EMPTY);
  assert.strictEqual(p.debts[2].creditor_normalized_key, null);
  pass();
}

// 10. Creditor snapshot: the payload carries the resolution of the catalog AT INGESTION
{
  const before = ingest(rawEvent({ debts: [debt(0, { acreedor_raw: 'Creditel' })] }), TOKEN_OK);
  const cat = testCatalog();
  cat.creditors.push({ creditor_id: 'aaaaaaaa-0000-4000-8000-000000000009', slug: 'creditel', display_name: 'Creditel', status: 'active', merged_into_creditor_id: null });
  cat.aliases.push({ id: 'bbbbbbbb-0000-4000-8000-000000000009', source: 'miplan_declared', normalized_key: 'creditel', creditor_id: 'aaaaaaaa-0000-4000-8000-000000000009', status: 'approved' });
  const after = buildIngestPayload(
    validateExportEvent(rawEvent({ debts: [debt(0, { acreedor_raw: 'Creditel' })] })),
    resolveCiFromToken(TOKEN_OK),
    buildCreditorResolver(cat),
  );
  assert.strictEqual(before.debts[0].ingestion_resolution, RESOLUTION.UNKNOWN);
  assert.strictEqual(after.debts[0].ingestion_resolution, RESOLUTION.RESOLVED);
  // Same identity → the DB keeps the first ingestion (ON CONFLICT DO NOTHING; see migration).
  assert.strictEqual(before.debts[0].declared_debt_id, after.debts[0].declared_debt_id);
  pass();
}

// 13-16. Deterministic debt identity
{
  const a = declaredDebtId(E1, 0);
  assert.strictEqual(a, declaredDebtId(E1, 0));
  assert.strictEqual(a, declaredDebtId(E1.toUpperCase(), 0));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notStrictEqual(a, declaredDebtId(E1, 1));
  assert.notStrictEqual(a, declaredDebtId(E2, 0)); // same position, different event
  const p = ingest(rawEvent({
    debts: [debt(0, { acreedor_raw: 'BROU', monto: 5000 }), debt(1, { acreedor_raw: 'BROU', monto: 5000 }), debt(2, { acreedor_raw: 'brou', monto: 5000 })],
  }), TOKEN_OK);
  const ids = new Set(p.debts.map(function (d) {
    return d.declared_debt_id;
  }));
  assert.strictEqual(ids.size, 3); // same creditor + same amount + same person do not collide
  p.debts.forEach(function (d) {
    assert.strictEqual(d.ingestion_creditor_id, BROU);
  });
  expectPayloadError(function () {
    declaredDebtId('nope', 0);
  }, 'bad event id');
  expectPayloadError(function () {
    declaredDebtId(E1, -1);
  }, 'bad position');
  pass();
}

// 34-35. Amount coercion
{
  assert.deepStrictEqual(coerceAmount(1500), { value: 1500, raw: '1500' });
  assert.deepStrictEqual(coerceAmount('15000'), { value: 15000, raw: '15000' });
  assert.deepStrictEqual(coerceAmount(' 1500.5 '), { value: 1500.5, raw: ' 1500.5 ' });
  assert.deepStrictEqual(coerceAmount('1500,50'), { value: 1500.5, raw: '1500,50' });
  assert.deepStrictEqual(coerceAmount('15.000'), { value: null, raw: '15.000' }); // ambiguous
  assert.deepStrictEqual(coerceAmount('quince mil'), { value: null, raw: 'quince mil' });
  assert.deepStrictEqual(coerceAmount(-5), { value: null, raw: '-5' });
  assert.deepStrictEqual(coerceAmount(NaN), { value: null, raw: 'NaN' });
  assert.deepStrictEqual(coerceAmount(null), { value: null, raw: null });
  assert.deepStrictEqual(coerceAmount({ a: 1 }), { value: null, raw: null });
  const p = ingest(rawEvent({ debts: [debt(0, { monto: 'mucho', pago: '200', pago_mensual_actual: {}, ultimo_pago_declarado: '300' })] }), TOKEN_OK);
  assert.strictEqual(p.debts.length, 1); // malformed optional fields never drop the debt
  assert.strictEqual(p.debts[0].monto, null);
  assert.strictEqual(p.debts[0].monto_raw, 'mucho');
  assert.strictEqual(p.debts[0].pago, 200);
  assert.strictEqual(p.debts[0].pago_mensual_actual, null);
  assert.strictEqual(p.debts[0].ultimo_pago_declarado, 300);
  pass();
}

// 29-33. Authorized snapshot boundary: export must never contain excluded debts; disputes OK
{
  ['pagada'].forEach(function (s) {
    expectPayloadError(function () {
      validateExportEvent(rawEvent({ debts: [debt(0, { situacion_ui: s })] }));
    }, 'pagada');
  });
  expectPayloadError(function () {
    validateExportEvent(rawEvent({ debts: [debt(0, { cancelada: true })] }));
  }, 'cancelada');
  expectPayloadError(function () {
    validateExportEvent(rawEvent({ debts: [debt(0, { _is_draft_add: true })] }));
  }, 'draft');
  const ok = validateExportEvent(rawEvent({ excluded_count: 2, debts: [debt(1, { situacion_ui: 'reclamo_disputa' }), debt(3)] }));
  assert.strictEqual(ok.debts.length, 2);
  assert.strictEqual(ok.debts[0].situacion_ui, 'reclamo_disputa');
  assert.deepStrictEqual(ok.debts.map(function (d) {
    return d.position;
  }), [1, 3]); // positions keep D's ordinality gaps
  assert.strictEqual(ok.excluded_count, 2);
  // Snapshot is pinned to D: snapshot_diagnosis_id must match origin_diagnosis_id when present.
  expectPayloadError(function () {
    validateExportEvent(rawEvent({ snapshot_diagnosis_id: '40000000-0000-4000-8000-000000000099' }));
  }, 'later diagnosis cannot replace D');
  const fallback = validateExportEvent(rawEvent({ origin_diagnosis_id: null }));
  assert.strictEqual(fallback.snapshot_diagnosis_id, D1);
  pass();
}

// 24. Contract violations (FAIL RUN)
{
  const bad = [
    { event_id: 'x' },
    { seq: 0 },
    { state: 'rejected' },
    { scope: 'other' },
    { contract_version: 'v2' },
    { source: 'web' },
    { consent_text_version: 'Bad Version' },
    { created_at: 'yesterday' },
    { origin_evaluation_id: null },
    { snapshot_diagnosis_id: null },
    { handoff_token_hash: 'abc' },
    { excluded_count: -1 },
    { debts: null },
    { debts: [debt(0), debt(0)] },
    { debts: [debt(-1)] },
    { debts: ['x'] },
    { state: 'withdrawn', excluded_count: null, debts: [debt(0)] },
    { state: 'withdrawn', excluded_count: 0, debts: null },
  ];
  bad.forEach(function (over, i) {
    expectPayloadError(function () {
      validateExportEvent(rawEvent(over));
    }, 'bad event #' + i);
  });
  const w = validateExportEvent(rawEvent({ state: 'withdrawn', excluded_count: null, debts: undefined }));
  assert.deepStrictEqual(w.debts, []);
  assert.strictEqual(w.excluded_count, null);
  pass();
}

// Page validation
{
  const page = validateExportPage({ contract_version: EXPORT_CONTRACT_VERSION, events: [rawEvent()], has_more: true });
  assert.strictEqual(page.events.length, 1);
  assert.deepStrictEqual(Object.keys(page).sort(), ['events', 'has_more'], 'pending/ACK page carries no cursor');
  expectPayloadError(function () {
    validateExportPage({ contract_version: 'other', events: [], has_more: false });
  }, 'version');
  expectPayloadError(function () {
    validateExportPage({ contract_version: EXPORT_CONTRACT_VERSION, events: [], has_more: true });
  }, 'has_more without events');
  expectPayloadError(function () {
    validateExportPage({ contract_version: EXPORT_CONTRACT_VERSION, events: [rawEvent(), rawEvent()], has_more: false });
  }, 'dup event');
  expectPayloadError(function () {
    validateExportPage(null);
  }, 'null body');
  pass();
}

// 23. CI resolution
{
  assert.deepStrictEqual(resolveCiFromToken(null), { handoff_token_id: null, ci: null, ci_resolution: CI_RESOLUTION.UNRESOLVABLE });
  assert.deepStrictEqual(resolveCiFromToken(TOKEN_OK), { handoff_token_id: TOKEN_OK.id, ci: 12345678, ci_resolution: CI_RESOLUTION.RESOLVED });
  ['issued', 'revoked', 'expired'].forEach(function (status) {
    const r = resolveCiFromToken({ id: TOKEN_OK.id, status: status, ci: 12345678 });
    assert.strictEqual(r.ci, null);
    assert.strictEqual(r.ci_resolution, CI_RESOLUTION.UNRESOLVABLE);
  });
  [null, 0, '12a', -4, '1.5'].forEach(function (ci) {
    assert.strictEqual(resolveCiFromToken({ id: TOKEN_OK.id, status: 'consumed', ci: ci }).ci_resolution, CI_RESOLUTION.UNRESOLVABLE);
  });
  const p = ingest(rawEvent({ handoff_token_hash: null, debts: [debt(0)] }), null);
  assert.strictEqual(p.event.ci, null);
  assert.strictEqual(p.event.ci_resolution, 'unresolvable');
  assert.strictEqual(p.debts.length, 1); // event + debts still persisted
  pass();
}

// Ingest payload never carries forbidden fields; CI only from the token row
{
  const p = ingest(rawEvent({ ci: 99999999, anonymous_id: 'anon', debts: [debt(0, { nombre: 'x', email: 'y', interes_mensual_estimado: 3 })] }), TOKEN_OK);
  assert.strictEqual(p.event.ci, 12345678);
  const text = JSON.stringify(p);
  ['anonymous_id', 'nombre', 'email', 'interes_mensual_estimado', 'handoff_token_hash', HASH, '99999999'].forEach(function (f) {
    assert.ok(text.indexOf(f) === -1, 'payload leaks ' + f);
  });
  assert.strictEqual(p.event.miplan_created_at, '2026-10-06T20:01:46.123456+00:00'); // microseconds kept
  pass();
}

// 17-22. Current state
function row(id, journey, seq, state, ci, at) {
  return { event_id: id, journey_id: journey, seq: seq, state: state, ci: ci, miplan_created_at: at, snapshot_diagnosis_id: D1 };
}
{
  const ID = function (n) {
    return '10000000-0000-4000-8000-00000000000' + n;
  };
  // accept
  let s = currentStateByCi([row(ID(1), J1, 1, 'opted_in', 7, '2026-10-01T10:00:00Z')]);
  assert.strictEqual(s.get(7).active, true);
  // withdraw
  s = currentStateByCi([row(ID(1), J1, 1, 'opted_in', 7, '2026-10-01T10:00:00Z'), row(ID(2), J1, 2, 'withdrawn', 7, '2026-10-02T10:00:00Z')]);
  assert.strictEqual(s.get(7).active, false);
  assert.strictEqual(s.get(7).state, 'withdrawn');
  // accept → withdraw → accept; old seq arriving out of order does not win
  const chain = [
    row(ID(3), J1, 3, 'opted_in', 7, '2026-10-03T10:00:00Z'),
    row(ID(1), J1, 1, 'opted_in', 7, '2026-10-01T10:00:00Z'),
    row(ID(2), J1, 2, 'withdrawn', 7, '2026-10-02T10:00:00Z'),
  ];
  s = currentStateByCi(chain);
  assert.strictEqual(s.get(7).event_id, ID(3));
  assert.strictEqual(s.get(7).active, true);
  assert.strictEqual(currentEventByJourney(chain).get(J1).seq, 3);
  // latest across journeys of the same CI
  s = currentStateByCi([
    row(ID(1), J1, 1, 'opted_in', 7, '2026-10-01T10:00:00Z'),
    row(ID(4), J2, 1, 'withdrawn', 7, '2026-10-05T10:00:00Z'),
  ]);
  assert.strictEqual(s.get(7).event_id, ID(4));
  assert.strictEqual(s.get(7).active, false);
  assert.strictEqual(s.get(7).journeys, 2);
  // unresolved CI never produces state
  s = currentStateByCi([row(ID(5), J1, 1, 'opted_in', null, '2026-10-01T10:00:00Z')]);
  assert.strictEqual(s.size, 0);
  // microsecond tie-break on created_at string, then event_id
  s = currentStateByCi([
    row(ID(1), J1, 1, 'opted_in', 7, '2026-10-01T10:00:00.000001+00:00'),
    row(ID(2), J2, 1, 'withdrawn', 7, '2026-10-01T10:00:00.000002+00:00'),
  ]);
  assert.strictEqual(s.get(7).event_id, ID(2));
  assert.deepStrictEqual(Array.from(activeOptinEventIds([row(ID(1), J1, 1, 'opted_in', 7, '2026-10-01T10:00:00Z')])), [ID(1)]);
  pass();
}

// F / G / H / I. Out-of-order arrival: authority = original seq / Mi Plan created_at, never arrival.
{
  const ID = function (n) {
    return '20000000-0000-4000-8000-00000000000' + n;
  };
  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    arr.forEach(function (x, i) {
      permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach(function (p) {
        out.push([x].concat(p));
      });
    });
    return out;
  }
  function withArrival(rows, order) {
    return order.map(function (idx, k) {
      return Object.assign({}, rows[idx], { received_at: '2026-10-0' + (9 - k) + 'T00:00:00Z' });
    });
  }

  // F. seq1 opted_in, seq2 withdrawn; seq2 processed first, seq1 late → withdrawn; seq1 kept, inactive.
  const f1 = row(ID(1), J1, 1, 'opted_in', 7, '2026-10-01T10:00:00.000001+00:00');
  const f2 = row(ID(2), J1, 2, 'withdrawn', 7, '2026-10-01T10:05:00.000001+00:00');
  let s = currentStateByCi([f2]);
  assert.strictEqual(s.get(7).state, 'withdrawn');
  s = currentStateByCi([f2, f1]);
  assert.strictEqual(s.get(7).state, 'withdrawn', 'F: late seq1 never reactivates');
  assert.strictEqual(s.get(7).active, false);
  assert.strictEqual(activeOptinEventIds([f2, f1]).size, 0, 'F: late seq1 snapshot never feeds bags');
  // Even if the late seq1 carried a LATER Mi Plan timestamp (clock anomaly), seq decides inside a journey.
  const f1Skewed = Object.assign({}, f1, { miplan_created_at: '2026-10-02T00:00:00Z' });
  assert.strictEqual(currentStateByCi([f2, f1Skewed]).get(7).state, 'withdrawn', 'F: seq beats timestamps within a journey');

  // G. seq1 withdrawn, seq2 opted_in; seq2 first, seq1 late → opted_in (seq2 snapshot active).
  const g1 = row(ID(3), J1, 1, 'withdrawn', 8, '2026-10-01T10:00:00Z');
  const g2 = row(ID(4), J1, 2, 'opted_in', 8, '2026-10-01T10:05:00Z');
  s = currentStateByCi([g2, g1]);
  assert.strictEqual(s.get(8).state, 'opted_in', 'G: final opted_in');
  assert.deepStrictEqual(Array.from(activeOptinEventIds([g2, g1])), [ID(4)]);

  // H. Multi-journey, same CI: every arrival order gives the same result (latest journey head by
  //    Mi Plan created_at, microsecond precision; exact tie → greater event_id).
  const hA1 = row(ID(5), J1, 1, 'opted_in', 9, '2026-10-01T10:00:00.000001+00:00');
  const hA2 = row(ID(6), J1, 2, 'withdrawn', 9, '2026-10-03T10:00:00.000001+00:00');
  const hB1 = row(ID(7), J2, 1, 'opted_in', 9, '2026-10-03T10:00:00.000002+00:00');
  const hRows = [hA1, hA2, hB1];
  permutations([0, 1, 2]).forEach(function (order) {
    const st = currentStateByCi(withArrival(hRows, order)).get(9);
    assert.strictEqual(st.event_id, ID(7), 'H: order ' + order.join(''));
    assert.strictEqual(st.state, 'opted_in');
    assert.strictEqual(st.journeys, 2);
  });
  // 1 µs earlier for journey B → journey A's withdrawal (later) wins, in every order.
  const hB1Earlier = Object.assign({}, hB1, { miplan_created_at: '2026-10-03T10:00:00.000000+00:00' });
  permutations([0, 1, 2]).forEach(function (order) {
    assert.strictEqual(currentStateByCi(withArrival([hA1, hA2, hB1Earlier], order)).get(9).state, 'withdrawn', 'H µs: ' + order.join(''));
  });
  // Exact same created_at across journeys → greater event_id wins (stable tie-break only).
  const tA = row(ID(8), J1, 1, 'withdrawn', 10, '2026-10-04T10:00:00.5+00:00');
  const tB = row(ID(9), J2, 1, 'opted_in', 10, '2026-10-04T10:00:00.500000+00:00');
  [[tA, tB], [tB, tA]].forEach(function (rows) {
    assert.strictEqual(currentStateByCi(rows).get(10).event_id, ID(9), 'H tie: equal instants in different renderings');
  });
  // Different offsets, same instant handled numerically (not as strings).
  assert.strictEqual(createdAtMicros('2026-10-04T07:00:00.25-03:00'), createdAtMicros('2026-10-04T10:00:00.250000+00:00'));
  assert.strictEqual(createdAtMicros('2026-10-04 10:00:00+00'), createdAtMicros('2026-10-04T10:00:00Z'));
  assert.ok(createdAtMicros('2026-10-04T10:00:00.000001Z') > createdAtMicros('2026-10-04T10:00:00Z'));
  assert.strictEqual(createdAtMicros('yesterday'), null);

  // I. Inverted JANUS received_at never changes authority.
  const iRows = [Object.assign({}, f1, { received_at: '2026-10-09T00:00:00Z' }), Object.assign({}, f2, { received_at: '2026-10-01T00:00:00Z' })];
  assert.strictEqual(currentStateByCi(iRows).get(7).state, 'withdrawn', 'I: received_at ignored (same journey)');
  const iMulti = [Object.assign({}, hB1, { received_at: '2026-01-01T00:00:00Z' }), Object.assign({}, hA2, { received_at: '2027-01-01T00:00:00Z' }), hA1];
  assert.strictEqual(currentStateByCi(iMulti).get(9).event_id, ID(7), 'I: received_at ignored (multi journey)');
  pass();
}

// CI unresolved reasons (reconciliation inputs) + payload shape
{
  const H = 'd'.repeat(64);
  assert.strictEqual(ciUnresolvedReason(null, TOKEN_OK), 'NO_TOKEN_HASH');
  assert.strictEqual(ciUnresolvedReason(H, null), 'TOKEN_NOT_FOUND');
  assert.strictEqual(ciUnresolvedReason(H, { id: 'x', status: 'issued', ci: 1 }), 'TOKEN_NOT_CONSUMED');
  assert.strictEqual(ciUnresolvedReason(H, { id: 'x', status: 'consumed', ci: null }), 'TOKEN_WITHOUT_CI');
  assert.strictEqual(ciUnresolvedReason(H, TOKEN_OK), null);
  const evNoHash = validateExportEvent(rawEvent({ handoff_token_hash: null }));
  assert.strictEqual(resolveCiForEvent(evNoHash, TOKEN_OK).ci_resolution, 'unresolvable', 'no hash → token row ignored');
  assert.strictEqual(resolveCiForEvent(evNoHash, TOKEN_OK).ci_unresolved_reason, 'NO_TOKEN_HASH');
  const evOk = validateExportEvent(rawEvent());
  assert.deepStrictEqual(resolveCiForEvent(evOk, TOKEN_OK), resolveCiFromToken(TOKEN_OK));
  const pu = buildIngestPayload(evOk, resolveCiForEvent(evOk, { id: TOKEN_OK.id, status: 'consumed', ci: null }), resolver);
  assert.strictEqual(pu.event.ci_unresolved_reason, 'TOKEN_WITHOUT_CI');
  assert.strictEqual(pu.event.handoff_token_hash, evOk.handoff_token_hash);
  expectPayloadError(function () {
    buildIngestPayload(evOk, resolveCiFromToken({ id: TOKEN_OK.id, status: 'issued', ci: 1 }), resolver);
  }, 'ambiguous unresolved reason must be explicit');
  pass();
}

console.log('unit-miplan-debt-optin: ' + groups + ' groups OK');
