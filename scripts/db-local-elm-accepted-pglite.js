'use strict';

/**
 * LOCAL database test: S2 answer `{ success: true, result: null }` read as "Aceptado ELM"
 * (ELM received the lead and assigned it to Copanel) on rows written by the real RPCs,
 * migrations 1A + 1B + 3A + 3B + C1 + 20261011 + 20261012 (production state, step B not applied).
 *
 * DB CLASSIFICATION: LOCAL. In-process, in-memory PGlite. Never reads SUPABASE_* env vars and
 * never opens a network connection. PGLITE_DIR as in db-local-provider-fallback-c1-pglite.js.
 *
 * Covers, for the seven historical cases (same CI / TrackingId = cz_solicitud_id): the stored
 * attempt stays as ELM answered (s2_status unknown, elm_response_undocumented, body untouched),
 * the list projection is enough to read it as Aceptado ELM, the CI lock keeps blocking, a later
 * non-Convertido postback keeps it Aceptado, Convertido moves it to Otorgado and the lock stops
 * blocking. Other S2 unknowns (other body, timeout) stay in review.
 *
 * Run: node scripts/db-local-elm-accepted-pglite.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PROCESS_LIST_SELECT } = require('../src/services/elm/repository');
const { classifyElmProcess, COMMERCIAL } = require('../src/services/elm/classification');
const { CORRECTION_NOTE_PREFIX } = require('../src/services/elmOps/service');

const PGLITE_DIR = process.env.PGLITE_DIR ||
  path.join(os.tmpdir(), 'stage2-pglite', 'node_modules', '@electric-sql', 'pglite');

const MIG = (name) => path.join(__dirname, '..', 'migrations', name);
const MIGRATIONS = [
  '20261007_elm_lead_processes.sql',
  '20261007_elm_postback_events.sql',
  '20261008_provider_fallback_requests.sql',
  '20261009_elm_phase3b_operations.sql',
  '20261010_provider_fallback_c1_events.sql',
  '20261011_elm_manual_pre_reception_retry.sql',
  '20261012_elm_send_origin.sql',
];

const STUBS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE public.dashboard_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE TABLE public.cz_funnel_solicitud_estados (cz_solicitud_id bigint, solicitudes_estados_id integer);
CREATE TABLE public.cz_funnel_solicitudes (cz_id bigint PRIMARY KEY, solicitudes_estados_id integer);
`;

/** CI / TrackingId (cz_solicitud_id) confirmed with ELM. */
const HISTORICAL = [
  [32392154, 1333],
  [27645104, 1346],
  [36225953, 1394],
  [37656723, 1380],
  [19118189, 1190],
  [10768808, 1195],
  [34990122, 1256],
];
const S1_OK = 'Listo para recibir datos en servicio 2';
const LIST_COLUMNS = PROCESS_LIST_SELECT.split(',').map((c) => c.trim());

let groups = 0;
function pass(label) {
  groups += 1;
  console.log('ok - ' + label);
}

async function main() {
  let PGlite;
  try {
    PGlite = require(PGLITE_DIR).PGlite;
  } catch (e) {
    console.error('PGlite not available at ' + PGLITE_DIR + ' (set PGLITE_DIR). SKIPPED.');
    process.exit(2);
  }
  const db = new PGlite();
  await db.exec(STUBS);
  for (const m of MIGRATIONS) await db.exec(fs.readFileSync(MIG(m), 'utf8'));

  async function asRole(role, fn) {
    await db.exec('SET ROLE ' + role);
    try {
      return await fn();
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const svc = (sql, params) => asRole('service_role', () => db.query(sql, params || []));
  const su = async (sql, params) => (await db.query(sql, params || [])).rows;
  const actor = (await db.query('INSERT INTO public.dashboard_users DEFAULT VALUES RETURNING id')).rows[0].id;

  const claim = async (czId, ci) =>
    (await svc('SELECT public.elm_claim_process($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11) AS r', [
      czId, ci, 'copanel', 'janus_manual', actor, 3, 'LRW-' + czId,
      JSON.stringify({ docNumber: String(ci), TrackingId: String(czId) }), 300, null, 'rechazados_manual',
    ])).rows[0].r;
  const finishS1Eligible = (id) =>
    svc('SELECT * FROM public.elm_finish_s1($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, 'eligible', JSON.stringify({ result: S1_OK }), 200, S1_OK, 5, null, null,
    ]);
  const beginS2 = (czId, ci) =>
    svc('SELECT * FROM public.elm_begin_s2($1, $2::jsonb, $3)', [
      czId, JSON.stringify({ docNumber: String(ci), TrackingId: String(czId) }), 300,
    ]);
  /** What the orchestrator stores for a 2xx body without a documented `result` text. */
  const finishS2 = (id, body, http, errorCode) =>
    svc('SELECT * FROM public.elm_finish_s2($1, $2, $3::jsonb, $4, $5, $6, $7, $8)', [
      id, 'unknown', body == null ? null : JSON.stringify(body), http, null, 5, errorCode, null,
    ]);
  const settle = (czId) => svc('SELECT public.elm_ci_lock_settle($1) AS r', [czId]);
  const listRow = async (czId) =>
    (await svc('SELECT ' + PROCESS_LIST_SELECT + ' FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId])).rows[0];
  const lockOf = async (czId) =>
    (await su('SELECT state, blocks_future, block_reason FROM public.elm_ci_send_locks WHERE cz_solicitud_id = $1', [czId]))[0];
  const record = async (raw, norm, ci, czId) =>
    (await svc('SELECT * FROM public.elm_postback_record_event($1, $2, $3, $4, $5, $6, $7::jsonb)', [
      raw, norm, ci, null, czId, null, JSON.stringify({ status: raw }),
    ])).rows[0];
  const resolve = async (eventId, processId) =>
    (await svc('SELECT * FROM public.elm_postback_resolve_event($1, $2, $3, $4, $5)', [
      eventId, processId, 'cz_solicitud_id', null, null,
    ])).rows[0];
  const read = (p, extra) => classifyElmProcess(p, Object.assign({ nowMs: Date.now() }, extra || {}));

  // ------------------------------------------------------------------ the seven historical sends
  const ids = new Map();
  for (const [ci, czId] of HISTORICAL) {
    const c = await claim(czId, ci);
    assert.strictEqual(c.claimed, true, 'claim ' + czId);
    ids.set(czId, c.process.id);
    await finishS1Eligible(c.process.id);
    await beginS2(czId, ci);
    await finishS2(c.process.id, { result: null, success: true, docNumber: String(ci) }, 200, 'elm_response_undocumented');
    await settle(czId);
  }
  for (const [ci, czId] of HISTORICAL) {
    const full = (await su('SELECT * FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czId]))[0];
    assert.deepStrictEqual(
      [full.s1_status, full.s2_status, full.s2_http_status, full.s2_error_code, full.s2_result_message, full.referred_at, full.disbursed_at, full.send_origin],
      ['eligible', 'unknown', 200, 'elm_response_undocumented', null, null, null, 'rechazados_manual'],
      'stored as answered: ' + czId,
    );
    assert.deepStrictEqual(full.s2_response, { result: null, success: true, docNumber: String(ci) });
    assert.strictEqual(full.s2_request.TrackingId, String(czId));
  }
  pass('7 historical sends stored exactly as ELM answered (s2 unknown / 200 / elm_response_undocumented, body untouched)');

  for (const [ci, czId] of HISTORICAL) {
    const p = await listRow(czId);
    assert.deepStrictEqual(Object.keys(p).sort(), LIST_COLUMNS.slice().sort());
    const c = read(p);
    assert.deepStrictEqual(
      [c.state, c.detail, c.label, c.detail_label],
      [COMMERCIAL.REFERRED, 's2_accepted', 'Aceptado ELM', 'Aceptado ELM (asignado a Copanel)'],
      'reading ' + czId + ' / ' + ci,
    );
  }
  const unchanged = await su('SELECT count(*)::int AS n FROM public.elm_lead_processes WHERE s2_status = $1', ['unknown']);
  assert.strictEqual(unchanged[0].n, 7, 'the reading writes nothing');
  pass('list projection → Aceptado ELM (referred / s2_accepted) for the 7 cases; technical state untouched');

  for (const [ci, czId] of HISTORICAL) {
    assert.deepStrictEqual(await lockOf(czId), { state: 'consumed', blocks_future: true, block_reason: 'uncertain_referral' });
    const other = await claim(czId + 100000, ci);
    assert.strictEqual(other.claimed, false, 'CI ' + ci + ' still blocked');
  }
  pass('CI lock unchanged: consumed + blocks_future; a new solicitud of the same CI is refused');

  // ------------------------------------------------------------------ postbacks
  const [ciA, czA] = HISTORICAL[0];
  const latente = await record('Latente', 'latente', ciA, czA);
  assert.strictEqual((await resolve(latente.id, ids.get(czA))).processing_status, 'applied');
  const afterLatente = await listRow(czA);
  assert.strictEqual(afterLatente.provider_status, 'Latente');
  assert.strictEqual(read(afterLatente).detail, 's2_accepted', 'a non-Convertido status keeps Aceptado');
  assert.strictEqual(read(afterLatente, { postReferralRejectionStatuses: ['latente'] }).state, COMMERCIAL.REJECTED, 'configured post-referral rejection applies as for any acceptance');

  const conv = await record('Convertido', 'convertido', ciA, czA);
  assert.strictEqual((await resolve(conv.id, ids.get(czA))).processing_status, 'applied');
  const granted = await listRow(czA);
  assert.ok(granted.disbursed_at);
  assert.strictEqual(granted.s2_status, 'unknown', 'S2 attempt untouched');
  assert.deepStrictEqual(granted.s2_response, { result: null, success: true, docNumber: String(ciA) });
  const g = read(granted);
  assert.deepStrictEqual([g.state, g.label], [COMMERCIAL.GRANTED, 'Otorgado ELM']);
  await settle(czA);
  assert.deepStrictEqual(await lockOf(czA), { state: 'consumed', blocks_future: false, block_reason: null }, 'a grant stops blocking, as for any referral');
  for (const [ci, czId] of HISTORICAL.slice(1)) {
    const p = await listRow(czId);
    assert.strictEqual(p.disbursed_at, null, 'no grant leaks to ' + czId + ' / ' + ci);
    assert.strictEqual(read(p).state, COMMERCIAL.REFERRED);
  }
  pass('postbacks: Latente keeps Aceptado; Convertido → Otorgado ELM (S2 attempt kept) and the lock stops blocking; the other 6 stay Aceptado');

  // ------------------------------------------------------------------ audited correction (ELM Ops)
  const [ciB, czB] = HISTORICAL[1];
  const rowB = (await su('SELECT updated_at FROM public.elm_lead_processes WHERE cz_solicitud_id = $1', [czB]))[0];
  const correctionNote = CORRECTION_NOTE_PREFIX + 'ELM confirmó por correo que el lead nunca ingresó a su CRM.';
  const resolved = (await svc('SELECT public.elm_resolve_process($1, $2, $3, $4, $5, $6) AS r', [
    ids.get(czB), rowB.updated_at, 'provider_confirmed_not_received', correctionNote, actor, 'none',
  ])).rows[0].r;
  assert.deepStrictEqual([resolved.status, resolved.kind], ['resolved', 's2_unknown']);
  const audit = await su("SELECT actor_user_id, action, detail FROM public.elm_ops_audit_events WHERE entity_type = 'elm_process' AND entity_id = $1", [ids.get(czB)]);
  assert.strictEqual(audit.length, 1);
  assert.deepStrictEqual(
    [audit[0].actor_user_id, audit[0].action, audit[0].detail.resolution_code, audit[0].detail.note, audit[0].detail.s2_status],
    [actor, 'resolved', 'provider_confirmed_not_received', correctionNote, 'unknown'],
  );
  const afterCorrection = await listRow(czB);
  assert.deepStrictEqual(afterCorrection.s2_response, { result: null, success: true, docNumber: String(ciB) }, 'ELM answer kept');
  assert.deepStrictEqual([read(afterCorrection).state, read(afterCorrection).detail], [COMMERCIAL.CLOSED, 'ops_provider_confirmed_not_received']);
  pass('audited correction of an Aceptado through elm_resolve_process: marked note + actor in elm_ops_audit_events, ELM answer kept');

  // ------------------------------------------------------------------ other S2 unknowns stay in review
  const others = [
    [9000001, 81000001, { result: 'Respuesta nueva', success: true }, 200, 'elm_response_undocumented'],
    [9000002, 81000002, { result: null, success: false }, 200, 'elm_response_undocumented'],
    [9000003, 81000003, { result: null, success: true, docNumber: '99999999' }, 200, 'elm_response_undocumented'],
    [9000004, 81000004, null, null, 'elm_http_timeout'],
    [9000005, 81000005, { result: null, success: true }, 500, 'elm_http_error'],
  ];
  for (const [czId, ci, body, http, code] of others) {
    const c = await claim(czId, ci);
    await finishS1Eligible(c.process.id);
    await beginS2(czId, ci);
    await finishS2(c.process.id, body, http, code);
    const r = read(await listRow(czId));
    assert.deepStrictEqual([r.state, r.detail], [COMMERCIAL.REVIEW, 's2_unknown'], 'cz ' + czId);
  }
  pass('other S2 unknowns (other result, success false, foreign docNumber, timeout, HTTP 500) stay Pendiente de revisión');

  console.log('\ndb-local-elm-accepted-pglite: ' + groups + ' groups passed (LOCAL PGlite, no network)');
  await db.close();
}

main().catch((err) => {
  console.error('FAIL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
