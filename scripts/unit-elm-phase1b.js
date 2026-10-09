'use strict';

/**
 * Offline checks for ELM Fase 1B (postback + ELM column). No Supabase, no network,
 * no applied migration. DB semantics are covered by scripts/db-local-elm-postback-pglite.js.
 * Run: node scripts/unit-elm-phase1b.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const express = require('express');

const TEST_SESSION_SECRET = 'unit-test-session-secret-0123456789';
const TEST_CRON_SECRET = 'unit-test-cron-secret-0123456789';

const envPath = require.resolve('../src/config/env');
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    port: 3000,
    nodeEnv: 'test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test',
    apifyToken: 'test',
    apifyActorId: 'test',
    sessionSecret: TEST_SESSION_SECRET,
    cronSecret: TEST_CRON_SECRET,
  },
};

/** Supabase stub: auth lookups only; any ELM table/RPC access through it fails the test. */
const USERS = new Map();
const supabaseCalls = [];
function authChain(table) {
  const filters = {};
  const q = {
    select() {
      return q;
    },
    eq(col, val) {
      filters[col] = val;
      return q;
    },
    async maybeSingle() {
      supabaseCalls.push(table);
      if (table === 'dashboard_users') {
        return { data: USERS.get(String(filters.id)) || null, error: null };
      }
      throw new Error('unexpected supabase table in test: ' + table);
    },
  };
  return q;
}
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from(table) {
      return authChain(table);
    },
    rpc(name) {
      supabaseCalls.push('rpc:' + name);
      throw new Error('unexpected rpc in test: ' + name);
    },
  },
};

// Network guard: any non-loopback connection or fetch is counted and refused.
const externalNet = [];
function isLoopback(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}
function hostOf(args) {
  const a = args[0];
  if (typeof a === 'string' || a instanceof URL) {
    try {
      return new URL(String(a)).hostname;
    } catch {
      return String(a);
    }
  }
  if (a && typeof a === 'object') return a.hostname || a.host || null;
  if (typeof a === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
  return null;
}
function guard(mod, name) {
  const orig = mod[name];
  mod[name] = function guarded() {
    const host = hostOf(arguments);
    if (!isLoopback(host)) {
      externalNet.push(name + ':' + host);
      throw new Error('external network blocked in test: ' + name);
    }
    return orig.apply(this, arguments);
  };
}
guard(http, 'request');
guard(http, 'get');
guard(https, 'request');
guard(https, 'get');
guard(net, 'connect');
guard(net, 'createConnection');
guard(tls, 'connect');
globalThis.fetch = async function blockedFetch(url) {
  externalNet.push('fetch:' + String(url));
  throw new Error('fetch blocked in test');
};

const captured = [];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
process.stdout.write = function (chunk) {
  captured.push(String(chunk));
  return true;
};
process.stderr.write = function (chunk) {
  captured.push(String(chunk));
  return true;
};

const { CODES, POSTBACK_PROCESSING, MATCH_METHODS } = require('../src/services/elm/constants');
const {
  ELM_PROVIDER_STATUSES,
  GRANTED_NORMALIZED_STATUS,
  normalizeProviderStatus,
  classifyProviderStatus,
  isGrantedElmStatus,
} = require('../src/services/elm/providerStatus');
const {
  parseElmPostback,
  sanitizePostbackPayload,
  normalizeElmCi,
  isPostbackCompatible,
  createElmPostbackProcessor,
} = require('../src/services/elm/postback');
const {
  computeElmCell,
  createElmListView,
  attachElmCells,
  SEND_PENDING_HINT,
} = require('../src/services/elm/listView');
const { createElmRepository } = require('../src/services/elm/repository');
const { readElmConfig } = require('../src/services/elm/config');
const { createElmOrchestrator } = require('../src/services/elm/orchestrator');
const { createElmPostbackRouter } = require('../src/routes/elmPostback');
const { requireAuth, createSessionToken, COOKIE_NAME } = require('../src/middleware/auth');
const ElmUi = require('../public/elm-ui-helpers');

const ROOT = path.join(__dirname, '..');
function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const silentLogger = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Fake repository mirroring elm_postback_record_event / elm_postback_resolve_event.
// ---------------------------------------------------------------------------
function createPostbackRepo(processList, clock) {
  const processes = processList.map(function (p) {
    return Object.assign(
      {
        provider_status: null,
        provider_status_at: null,
        disbursed_at: null,
        disbursed_amount: null,
        granted_event_id: null,
        last_postback_event_id: null,
        last_postback_at: null,
      },
      p,
    );
  });
  const events = [];
  const calls = [];
  let seq = 0;
  const copy = (o) => (o ? JSON.parse(JSON.stringify(o)) : null);
  return {
    processes,
    events,
    calls,
    failRecord: false,
    async getProcessByCzId(czId) {
      calls.push('getProcessByCzId');
      return copy(processes.find((p) => p.cz_solicitud_id === czId) || null);
    },
    async recordPostbackEvent(ev) {
      calls.push('recordPostbackEvent');
      if (this.failRecord) throw new Error('db down');
      seq += 1;
      const row = {
        id: 'ev-' + seq,
        received_at: new Date(clock()).toISOString(),
        provider: 'elm',
        raw_status: ev.rawStatus,
        normalized_status: ev.normalizedStatus,
        ci: ev.ci,
        provider_external_id: ev.providerExternalId,
        received_cz_solicitud_id: ev.receivedCzSolicitudId,
        provider_event_at: ev.providerEventAt,
        payload: ev.payload,
        matched_elm_process_id: null,
        matched_cz_solicitud_id: null,
        match_method: null,
        processing_status: 'received',
        processed_at: null,
        error_code: null,
      };
      events.push(row);
      return copy(row);
    },
    async resolvePostbackEvent(a) {
      calls.push('resolvePostbackEvent');
      const ev = events.find((e) => e.id === a.eventId);
      if (!ev) throw new Error('elm_postback_event_not_found');
      if (ev.processing_status !== 'received') return copy(ev);
      const nowIso = new Date(clock()).toISOString();
      if (!a.processId) {
        Object.assign(ev, {
          processing_status: a.unresolvedStatus,
          processed_at: nowIso,
          match_method: a.matchMethod,
          error_code: a.errorCode,
        });
        return copy(ev);
      }
      const p = processes.find((x) => x.id === a.processId);
      let err = null;
      if (!p) err = 'elm_postback_process_not_found';
      else if (ev.received_cz_solicitud_id == null) err = 'elm_postback_cz_id_missing';
      else if (p.cz_solicitud_id !== ev.received_cz_solicitud_id) err = 'elm_postback_cz_id_mismatch';
      else if (ev.ci != null && p.ci !== ev.ci) err = 'elm_postback_ci_mismatch';
      else if (!p.s2_started_at || !['referred', 'unknown'].includes(p.s2_status)) err = 'elm_postback_process_not_compatible';
      if (err) {
        Object.assign(ev, { processing_status: 'unmatched', processed_at: nowIso, match_method: a.matchMethod, error_code: err });
        return copy(ev);
      }
      const at = ev.provider_event_at || ev.received_at;
      let outcome;
      if (p.disbursed_at) outcome = 'ignored_granted';
      else if (ev.normalized_status === 'convertido') {
        Object.assign(p, { disbursed_at: at, provider_status: ev.raw_status.trim(), provider_status_at: at, granted_event_id: ev.id });
        outcome = 'applied';
      } else if (!p.provider_status_at || Date.parse(at) >= Date.parse(p.provider_status_at)) {
        Object.assign(p, { provider_status: ev.raw_status.trim(), provider_status_at: at });
        outcome = 'applied';
      } else outcome = 'stale';
      if (!p.last_postback_at || Date.parse(p.last_postback_at) <= Date.parse(ev.received_at)) {
        p.last_postback_event_id = ev.id;
        p.last_postback_at = ev.received_at;
      }
      Object.assign(ev, {
        processing_status: outcome,
        processed_at: nowIso,
        matched_elm_process_id: p.id,
        matched_cz_solicitud_id: p.cz_solicitud_id,
        match_method: a.matchMethod,
        error_code: null,
      });
      return copy(ev);
    },
  };
}

function proc(over) {
  return Object.assign(
    {
      id: 'p-' + over.cz_solicitud_id,
      ci: 12345678,
      created_at: '2026-10-01T10:00:00.000Z',
      s1_status: 'eligible',
      s2_status: 'referred',
      s2_started_at: '2026-10-01T10:00:05.000Z',
      referred_at: '2026-10-01T10:00:06.000Z',
    },
    over,
  );
}

function setup(processList) {
  let t = Date.parse('2026-10-07T12:00:00.000Z');
  const clock = () => t;
  const advance = (ms) => {
    t += ms || 1000;
  };
  const repo = createPostbackRepo(processList, clock);
  const processor = createElmPostbackProcessor({ repository: repo, logger: silentLogger, now: clock });
  async function post(body) {
    advance();
    return processor.processElmPostback(body);
  }
  return { repo, post, advance };
}

const results = [];
async function test(name, fn) {
  await fn();
  results.push(name);
}

async function main() {
  await test('normalization: 24 statuses, unique, only spaces/case/accents', async () => {
    assert.strictEqual(ELM_PROVIDER_STATUSES.length, 24);
    const norm = new Set(ELM_PROVIDER_STATUSES.map(normalizeProviderStatus));
    assert.strictEqual(norm.size, 24);
    assert.strictEqual(normalizeProviderStatus('  pendiente   DE  evaluacion '), 'pendiente de evaluacion');
    assert.strictEqual(normalizeProviderStatus('Pendiente de Evaluación'), 'pendiente de evaluacion');
    assert.strictEqual(normalizeProviderStatus('Repetido-Rechazado'), 'repetido - rechazado');
    assert.strictEqual(normalizeProviderStatus('REVISION'), 'revision');
    assert.strictEqual(classifyProviderStatus(' en VALIDACION ').canonical, 'En validación');
    assert.strictEqual(classifyProviderStatus('Prestamo otorgado').known, false);
    assert.strictEqual(GRANTED_NORMALIZED_STATUS, 'convertido');
    const sql = readSrc('migrations/20261007_elm_postback_events.sql');
    assert.ok(sql.includes("normalized_status = '" + GRANTED_NORMALIZED_STATUS + "'"));
  });

  await test('#1 #2 Convertido → GRANTED ELM, disbursed_at set, amount NULL, provider=elm', async () => {
    const { repo, post } = setup([proc({ cz_solicitud_id: 501 })]);
    const out = await post({ estado: 'Convertido', internal_id: 501, cedula: '12345678' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.event.processing_status, POSTBACK_PROCESSING.APPLIED);
    assert.strictEqual(out.event.match_method, MATCH_METHODS.CZ_SOLICITUD_ID);
    const p = repo.processes[0];
    assert.ok(p.disbursed_at);
    assert.strictEqual(p.disbursed_amount, null);
    assert.strictEqual(p.provider_status, 'Convertido');
    assert.strictEqual(p.granted_event_id, repo.events[0].id);
    assert.strictEqual(repo.events[0].provider, 'elm');
    assert.ok(isGrantedElmStatus(' convertido '));
  });

  await test('#3 the other 23 statuses never mean GRANTED', async () => {
    const others = ELM_PROVIDER_STATUSES.filter((s) => s !== 'Convertido');
    assert.strictEqual(others.length, 23);
    for (const s of others) {
      assert.strictEqual(isGrantedElmStatus(s), false, s);
      const { repo, post } = setup([proc({ cz_solicitud_id: 502 })]);
      const out = await post({ estado: s, internal_id: 502, cedula: 12345678 });
      assert.strictEqual(out.event.processing_status, 'applied', s);
      assert.strictEqual(repo.processes[0].disbursed_at, null, s);
      assert.strictEqual(repo.processes[0].provider_status, s);
      const cell = computeElmCell({ process: repo.processes[0], nowMs: Date.now() });
      assert.strictEqual(cell.granted_elm, false);
      assert.notStrictEqual(cell.label, 'Otorgado');
    }
  });

  await test('normalizeElmCi: explicit format-only normalization (both sides)', async () => {
    assert.strictEqual(normalizeElmCi('1.234.567-8'), 12345678);
    assert.strictEqual(normalizeElmCi(' 12345678 '), 12345678);
    assert.strictEqual(normalizeElmCi('1 234 567 8'), 12345678);
    assert.strictEqual(normalizeElmCi(12345678), 12345678);
    assert.strictEqual(normalizeElmCi('12345678'), normalizeElmCi(12345678), 'bigint text from DB = number');
    assert.strictEqual(normalizeElmCi(BigInt(12345678)), 12345678);
    for (const bad of ['', 'abc', '1234x678', '-', '0', 0, -5, 1.5, null, undefined, {}, '99999999999999999999']) {
      assert.strictEqual(normalizeElmCi(bad), null, String(bad));
    }
  });

  await test('#4 #5 CI never selects a process: CI-only postback → unmatched, nothing mutated', async () => {
    const { repo, post } = setup([
      proc({ cz_solicitud_id: 900, s2_started_at: '2026-09-01T10:00:00.000Z' }),
      proc({ cz_solicitud_id: 700, s2_started_at: '2026-10-02T10:00:00.000Z' }),
    ]);
    const before = JSON.stringify(repo.processes);
    const out = await post({ estado: 'Convertido', cedula: '1.234.567-8' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.event.processing_status, 'unmatched');
    assert.strictEqual(out.event.error_code, CODES.POSTBACK_CZ_ID_MISSING);
    assert.strictEqual(out.event.match_method, null);
    assert.strictEqual(JSON.stringify(repo.processes), before);
    assert.ok(!repo.calls.includes('getProcessByCzId'), 'no process lookup without exact id');
    assert.strictEqual(repo.events[0].ci, 12345678, 'CI kept normalized for audit');
    const srcPb = readSrc('src/services/elm/postback.js');
    const srcRepo = readSrc('src/services/elm/repository.js');
    assert.ok(!/listProcessesByCi|latest_elm_process_by_ci/.test(srcPb + srcRepo));
    assert.ok(!/\.eq\('ci'/.test(srcRepo), 'no process query by CI');
    assert.ok(!/latest_elm_process_by_ci/.test(readSrc('migrations/20261007_elm_postback_events.sql')));

    const older = await post({ estado: 'Aprobado', internal_id: 900, cedula: '12345678' });
    assert.strictEqual(older.event.processing_status, 'applied');
    assert.strictEqual(repo.processes.find((p) => p.cz_solicitud_id === 900).provider_status, 'Aprobado');
    assert.strictEqual(repo.processes.find((p) => p.cz_solicitud_id === 700).provider_status, null);
  });

  await test('#6 #7 compatibility: never-S2 rejected; S2 unknown with start evidence accepted', async () => {
    assert.strictEqual(isPostbackCompatible(proc({ cz_solicitud_id: 1, s2_status: 'not_started', s2_started_at: null })), false);
    assert.strictEqual(isPostbackCompatible(proc({ cz_solicitud_id: 1, s2_status: 'rejected' })), false);
    assert.strictEqual(isPostbackCompatible(proc({ cz_solicitud_id: 1, s2_status: 'technical_error' })), false);
    assert.strictEqual(isPostbackCompatible(proc({ cz_solicitud_id: 1, s2_status: 'in_flight' })), false);
    assert.strictEqual(isPostbackCompatible(proc({ cz_solicitud_id: 1, s2_status: 'unknown', s2_started_at: null })), false);
    assert.strictEqual(isPostbackCompatible(proc({ cz_solicitud_id: 1, s2_status: 'unknown' })), true);
    assert.strictEqual(isPostbackCompatible(proc({ cz_solicitud_id: 1, s2_status: 'referred' })), true);

    const never = setup([proc({ cz_solicitud_id: 601, s1_status: 'eligible', s2_status: 'not_started', s2_started_at: null })]);
    const o1 = await never.post({ estado: 'Convertido', internal_id: 601, cedula: '12345678' });
    assert.strictEqual(o1.event.processing_status, 'unmatched');
    assert.strictEqual(o1.event.error_code, CODES.POSTBACK_PROCESS_NOT_COMPATIBLE);
    assert.strictEqual(never.repo.processes[0].disbursed_at, null);
    for (const s2 of ['rejected', 'technical_error', 'in_flight']) {
      const x = setup([proc({ cz_solicitud_id: 603, s2_status: s2 })]);
      const o = await x.post({ estado: 'Convertido', internal_id: 603 });
      assert.strictEqual(o.event.error_code, CODES.POSTBACK_PROCESS_NOT_COMPATIBLE, s2);
      assert.strictEqual(x.repo.processes[0].disbursed_at, null, s2);
    }

    const unk = setup([proc({ cz_solicitud_id: 602, s2_status: 'unknown', referred_at: null })]);
    const o2 = await unk.post({ estado: 'Convertido', internal_id: 602 });
    assert.strictEqual(o2.event.processing_status, 'applied');
    assert.ok(unk.repo.processes[0].disbursed_at);
  });

  await test('#8 #9 no process for the id / no id → unmatched, event kept, no process modified', async () => {
    const { repo, post } = setup([proc({ cz_solicitud_id: 801, ci: 11111111 })]);
    const before = JSON.stringify(repo.processes);
    const out = await post({ estado: 'Convertido', internal_id: 802, cedula: '11111111' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.event.processing_status, 'unmatched');
    assert.strictEqual(out.event.error_code, CODES.POSTBACK_CZ_ID_NOT_FOUND);
    const noId = await post({ estado: 'Convertido', cedula: '11111111' });
    assert.strictEqual(noId.event.error_code, CODES.POSTBACK_CZ_ID_MISSING);
    assert.strictEqual(JSON.stringify(repo.processes), before);
    assert.strictEqual(repo.events.length, 2);
    for (const ev of repo.events) {
      assert.strictEqual(ev.matched_elm_process_id, null);
      assert.strictEqual(ev.matched_cz_solicitud_id, null);
    }
  });

  await test('#10 #11 #12 repeated / later / out-of-order events never revert GRANTED or move disbursed_at', async () => {
    const { repo, post } = setup([proc({ cz_solicitud_id: 1001 })]);
    await post({ estado: 'Pendiente de Doc', internal_id: 1001, event_at: '2026-10-05T10:00:00Z' });
    const conv = await post({ estado: 'Convertido', internal_id: 1001, event_at: '2026-10-06T10:00:00Z' });
    assert.strictEqual(conv.event.processing_status, 'applied');
    const p = repo.processes[0];
    const snapshot = { d: p.disbursed_at, s: p.provider_status, a: p.provider_status_at, g: p.granted_event_id };
    assert.strictEqual(snapshot.d, '2026-10-06T10:00:00.000Z');

    const dup = await post({ estado: 'Convertido', internal_id: 1001, event_at: '2026-10-06T10:00:00Z' });
    assert.strictEqual(dup.event.processing_status, 'ignored_granted');
    const earlierConv = await post({ estado: 'Convertido', internal_id: 1001, event_at: '2026-10-01T10:00:00Z' });
    assert.strictEqual(earlierConv.event.processing_status, 'ignored_granted');
    const later = await post({ estado: 'Desiste', internal_id: 1001, event_at: '2026-10-07T10:00:00Z' });
    assert.strictEqual(later.event.processing_status, 'ignored_granted');
    const noTs = await post({ estado: 'Rechazado', internal_id: 1001 });
    assert.strictEqual(noTs.event.processing_status, 'ignored_granted');

    assert.deepStrictEqual(
      { d: p.disbursed_at, s: p.provider_status, a: p.provider_status_at, g: p.granted_event_id },
      snapshot,
    );
    assert.strictEqual(repo.events.length, 6, 'every POST stored (no dedupe)');
  });

  await test('Convertido out of order (before older statuses arrive) stays sticky; stale ordering otherwise', async () => {
    const a = setup([proc({ cz_solicitud_id: 1101 })]);
    await a.post({ estado: 'Latente', internal_id: 1101, event_at: '2026-10-05T10:00:00Z' });
    const stale = await a.post({ estado: 'Inicial', internal_id: 1101, event_at: '2026-10-04T10:00:00Z' });
    assert.strictEqual(stale.event.processing_status, 'stale');
    assert.strictEqual(a.repo.processes[0].provider_status, 'Latente');
    assert.strictEqual(a.repo.events.length, 2, 'older event preserved');
    const conv = await a.post({ estado: 'Convertido', internal_id: 1101, event_at: '2026-10-03T10:00:00Z' });
    assert.strictEqual(conv.event.processing_status, 'applied');
    assert.strictEqual(a.repo.processes[0].provider_status, 'Convertido');
  });

  await test('#13 raw event kept (raw text, sanitized payload, invalid ones too)', async () => {
    const { repo, post } = setup([proc({ cz_solicitud_id: 1201 })]);
    await post({ estado: '  Pendiente de   Evaluación ', internal_id: '1201', cedula: '12345678', extra: { a: 1 } });
    const ev = repo.events[0];
    assert.strictEqual(ev.raw_status, 'Pendiente de   Evaluación');
    assert.strictEqual(ev.normalized_status, 'pendiente de evaluacion');
    assert.deepStrictEqual(ev.payload.extra, { a: 1 });
    assert.strictEqual(repo.processes[0].provider_status, 'Pendiente de   Evaluación');

    const bad = await post({ estado: 'Estado Nuevo Inventado', internal_id: 1201 });
    assert.strictEqual(bad.event.processing_status, 'invalid');
    assert.strictEqual(bad.event.error_code, CODES.POSTBACK_STATUS_UNKNOWN);
    assert.strictEqual(repo.events[1].raw_status, 'Estado Nuevo Inventado');
    const noId = await post({ estado: 'Aprobado' });
    assert.strictEqual(noId.event.processing_status, 'unmatched');
    assert.strictEqual(noId.event.error_code, CODES.POSTBACK_CZ_ID_MISSING);
    const fut = await post({ estado: 'Aprobado', internal_id: 1201, event_at: '2099-01-01T00:00:00Z' });
    assert.strictEqual(fut.event.error_code, CODES.POSTBACK_EVENT_AT_INVALID);
    const notObj = await post('Convertido');
    assert.strictEqual(notObj.event.error_code, CODES.POSTBACK_BODY_INVALID);
    assert.strictEqual(repo.processes[0].provider_status, 'Pendiente de   Evaluación');
    assert.strictEqual(repo.events.length, 5);
  });

  await test('#14 #15 exact cz_solicitud_id only; missing id never falls back to CI; CI is audit control', async () => {
    const { repo, post } = setup([
      proc({ cz_solicitud_id: 1301, s2_started_at: '2026-09-01T10:00:00.000Z' }),
      proc({ cz_solicitud_id: 1302, s2_started_at: '2026-10-01T10:00:00.000Z' }),
    ]);
    const exact = await post({ estado: 'Aprobado', cedula: '1.234.567-8', internal_id: '1301' });
    assert.strictEqual(exact.event.processing_status, 'applied', 'CI equal after normalization');
    assert.strictEqual(exact.event.match_method, MATCH_METHODS.CZ_SOLICITUD_ID);
    assert.strictEqual(repo.events[0].matched_cz_solicitud_id, 1301);
    assert.strictEqual(repo.processes[1].provider_status, null);

    const before = JSON.stringify(repo.processes);
    const missing = await post({ estado: 'Convertido', cedula: '12345678', internal_id: 9999 });
    assert.strictEqual(missing.event.processing_status, 'unmatched');
    assert.strictEqual(missing.event.error_code, CODES.POSTBACK_CZ_ID_NOT_FOUND);
    assert.strictEqual(JSON.stringify(repo.processes), before);

    const mismatch = await post({ estado: 'Convertido', cedula: '9.999.999-9', internal_id: 1301 });
    assert.strictEqual(mismatch.event.processing_status, 'unmatched');
    assert.strictEqual(mismatch.event.error_code, CODES.POSTBACK_CI_MISMATCH);
    assert.strictEqual(JSON.stringify(repo.processes), before, 'CI mismatch → zero mutation');
    assert.strictEqual(repo.events[repo.events.length - 1].raw_status, 'Convertido', 'event kept');

    const badCi = await post({ estado: 'Convertido', cedula: 'abc', internal_id: 1301 });
    assert.strictEqual(badCi.event.processing_status, 'invalid');
    assert.strictEqual(badCi.event.error_code, CODES.POSTBACK_CI_INVALID);
    const badId = await post({ estado: 'Aprobado', cedula: '12345678', internal_id: 'abc' });
    assert.strictEqual(badId.event.processing_status, 'invalid');
    assert.strictEqual(badId.event.error_code, CODES.POSTBACK_CZ_ID_INVALID);
    assert.strictEqual(JSON.stringify(repo.processes), before);
  });

  await test('secrets never persisted: body credentials redacted, headers never stored', async () => {
    const { repo, post } = setup([proc({ cz_solicitud_id: 1401 })]);
    await post({
      status: 'Aprobado',
      cz_solicitud_id: 1401,
      Authorization: 'Bearer abc.def.ghi',
      token: 'tkn-123456',
      note: 'oauth_signature="zzz"',
    });
    const stored = JSON.stringify(repo.events[0]);
    assert.ok(!stored.includes('abc.def.ghi'));
    assert.ok(!stored.includes('tkn-123456'));
    assert.ok(!stored.includes('zzz'));
    const huge = sanitizePostbackPayload({ estado: 'Aprobado', blob: 'x'.repeat(20000) });
    assert.strictEqual(huge._truncated, true);
    const src = readSrc('src/services/elm/postback.js') + readSrc('src/routes/elmPostback.js');
    assert.ok(!/req\.headers|req\.get\(|rawHeaders/.test(src), 'headers never read into storage');
  });

  await test('persist failure → ok:false (route answers 500); resolve failure keeps event as received', async () => {
    const { repo, post } = setup([proc({ cz_solicitud_id: 1501 })]);
    repo.failRecord = true;
    const out = await post({ estado: 'Aprobado', internal_id: 1501 });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, CODES.POSTBACK_PERSIST_FAILED);
    assert.strictEqual(repo.processes[0].provider_status, null);
    repo.failRecord = false;
    repo.resolvePostbackEvent = async () => {
      throw new Error('db down');
    };
    const out2 = await post({ estado: 'Aprobado', internal_id: 1501 });
    assert.strictEqual(out2.ok, false);
    assert.strictEqual(repo.events[repo.events.length - 1].processing_status, 'received');
    assert.strictEqual(repo.processes[0].provider_status, null);
  });

  await test('#16 fail-closed + order auth → persist: unauthenticated never stored/matched/applied', async () => {
    USERS.set('admin-1', { id: 'admin-1', is_admin: true, active: true });
    const processed = [];
    const spy = { async processElmPostback(b) { processed.push(b); return { ok: true, event: {} }; } };
    // Same order as app.js: postback router (default token auth, no token configured) before
    // the global JSON parser and requireAuth.
    const app = express();
    app.use('/elm/postback', createElmPostbackRouter({ processor: spy, logger: silentLogger }));
    app.use(express.json());
    app.use(requireAuth);
    const okApp = express();
    okApp.use(express.json());
    okApp.use('/elm/postback', createElmPostbackRouter({
      authenticateElmPostback: async () => ({ ok: true }),
      processor: createElmPostbackProcessor({
        repository: createPostbackRepo([], () => Date.now()),
        logger: silentLogger,
      }),
    }));
    const failApp = express();
    failApp.use(express.json());
    failApp.use('/elm/postback', createElmPostbackRouter({
      authenticateElmPostback: async () => ({ ok: true }),
      processor: { async processElmPostback() { return { ok: false, code: CODES.POSTBACK_PERSIST_FAILED }; } },
    }));
    // A matchable body + real processor: a request that does not authenticate must store nothing.
    const guardedRepo = createPostbackRepo([proc({ cz_solicitud_id: 1601 })], () => Date.now());
    const guardedProcessor = createElmPostbackProcessor({ repository: guardedRepo, logger: silentLogger });
    const rejectApp = express();
    rejectApp.use(express.json());
    rejectApp.use('/elm/postback', createElmPostbackRouter({
      authenticateElmPostback: async () => ({ ok: false, status: 401, code: 'elm_postback_unauthorized' }),
      processor: guardedProcessor,
    }));
    const throwApp = express();
    throwApp.use(express.json());
    throwApp.use('/elm/postback', createElmPostbackRouter({
      authenticateElmPostback: async () => {
        throw new Error('auth backend down');
      },
      processor: guardedProcessor,
    }));
    const defaultApp = express();
    defaultApp.use(express.json());
    defaultApp.use('/elm/postback', createElmPostbackRouter({ processor: guardedProcessor }));
    const servers = [];
    async function listen(a) {
      const srv = http.createServer(a);
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      servers.push(srv);
      return srv.address().port;
    }
    function call(port, headers, body) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify(body || {});
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/elm/postback',
            headers: Object.assign(
              { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
              headers || {},
            ),
          },
          (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => {
              let json = null;
              try {
                json = JSON.parse(buf);
              } catch {
                json = null;
              }
              resolve({ status: res.statusCode, body: json });
            });
          },
        );
        req.on('error', reject);
        req.write(data);
        req.end();
      });
    }
    try {
      const port = await listen(app);
      const body = { estado: 'Convertido', cedula: '12345678' };
      const cookie = COOKIE_NAME + '=' + encodeURIComponent(createSessionToken('admin-1'));
      for (const h of [{}, { Authorization: 'Bearer guessed' }, { 'X-Cron-Key': TEST_CRON_SECRET }, { Cookie: cookie }]) {
        const r = await call(port, h, body);
        assert.strictEqual(r.status, 503, 'no token configured → 503 whatever else is presented');
        assert.strictEqual(r.body.error, CODES.POSTBACK_AUTH_NOT_CONFIGURED);
      }
      assert.strictEqual(processed.length, 0, 'processor never reached');

      const okPort = await listen(okApp);
      const unmatched = await call(okPort, {}, body);
      assert.strictEqual(unmatched.status, 200, 'stored outcomes answer 200 (no retry storms)');
      assert.strictEqual(unmatched.body.data.processing_status, 'unmatched');
      const failPort = await listen(failApp);
      const failed = await call(failPort, {}, body);
      assert.strictEqual(failed.status, 500);

      const before = JSON.stringify(guardedRepo.processes);
      const matchable = { estado: 'Convertido', internal_id: 1601 };
      const rejected = await call(await listen(rejectApp), {}, matchable);
      assert.strictEqual(rejected.status, 401);
      assert.strictEqual(rejected.body.error, 'elm_postback_unauthorized');
      const thrown = await call(await listen(throwApp), {}, matchable);
      assert.strictEqual(thrown.status, 503);
      const dflt = await call(await listen(defaultApp), { Authorization: 'Bearer guessed' }, matchable);
      assert.strictEqual(dflt.status, 503);
      assert.strictEqual(dflt.body.error, CODES.POSTBACK_AUTH_NOT_CONFIGURED);
      assert.strictEqual(guardedRepo.events.length, 0, 'unauthenticated → no elm_postback_events row');
      assert.strictEqual(guardedRepo.calls.length, 0, 'unauthenticated → no parse/persist/match');
      assert.strictEqual(JSON.stringify(guardedRepo.processes), before, 'unauthenticated → no process mutation');
    } finally {
      for (const s of servers) await new Promise((r) => s.close(r));
    }
    assert.ok(supabaseCalls.every((t) => t === 'dashboard_users'), 'no ELM DB access: ' + supabaseCalls.join(','));
    const server = readSrc('src/server.js');
    assert.ok(!/elm\/postback|createElmPostbackRouter/.test(server), 'not mounted after requireAuth');
    const appSrc = readSrc('src/app.js');
    const mountAt = appSrc.indexOf("app.use('/elm/postback', createElmPostbackRouter())");
    assert.ok(mountAt > 0);
    assert.ok(mountAt < appSrc.indexOf('app.use(express.json());'), 'before the global JSON parser');
    assert.ok(mountAt < appSrc.indexOf('app.use(requireAuth);'), 'before requireAuth');
  });

  await test('#17 migration: RLS, no policies, anon/authenticated revoked, no DELETE/TRUNCATE', async () => {
    const sql = readSrc('migrations/20261007_elm_postback_events.sql');
    assert.ok(/ALTER TABLE public\.elm_postback_events ENABLE ROW LEVEL SECURITY/.test(sql));
    assert.ok(!/CREATE POLICY/i.test(sql));
    assert.ok(/REVOKE ALL ON TABLE public\.elm_postback_events FROM PUBLIC, anon, authenticated/.test(sql));
    assert.ok(/REVOKE DELETE, TRUNCATE ON TABLE public\.elm_postback_events FROM service_role/.test(sql));
    assert.ok(!/GRANT[^;]*TO[^;]*\b(anon|authenticated)\b/i.test(sql));
    assert.ok(/REVOKE ALL ON FUNCTION public\.elm_postback_record_event[^;]*FROM PUBLIC, anon, authenticated/.test(sql));
    assert.ok(/REVOKE ALL ON FUNCTION public\.elm_postback_resolve_event[^;]*FROM PUBLIC, anon, authenticated/.test(sql));
    assert.ok(!/SECURITY DEFINER/i.test(sql));
    const phase1a = readSrc('migrations/20261007_elm_lead_processes.sql');
    assert.ok(!/elm_postback/.test(phase1a), 'Fase 1A migration untouched');
    assert.ok(!/CREATE OR REPLACE FUNCTION public\.(elm_claim_process|elm_finish_s1|elm_begin_s2|elm_finish_s2|elm_expire_stale_in_flight|elm_lead_processes_guard)\b/.test(sql));
    const repoSrc = readSrc('src/services/elm/repository.js');
    assert.ok(!/\.(insert|upsert|update|delete)\(/.test(repoSrc));
  });

  // -------------------------------------------------------------------------
  // List column
  // -------------------------------------------------------------------------
  const EMPTY_CONFIG = readElmConfig({});
  function sol(id, over) {
    return Object.assign(
      {
        cz_id: id,
        ci: 30000000 + id,
        nombre: 'N',
        apellido: 'A',
        email: 'n@example.test',
        celular: '099123456',
        salario: 30000,
        fecha_nacimiento: '1990-01-01',
        relacion_laboral: 'EPR',
        lrw_id: null,
        solicitudes_estados_id: 8,
      },
      over || {},
    );
  }

  await test('#18 list cells: constant queries per page, no per-row access (fake + real repository)', async () => {
    const calls = [];
    const fakeRepo = {
      async getProcessesByCzIds(ids) {
        calls.push(['proc', ids.length]);
        return new Map([[2, proc({ cz_solicitud_id: 2, provider_status: 'Latente' })]]);
      },
      async loadSolicitudContexts(ids) {
        calls.push(['ctx', ids.length]);
        return new Map(ids.map((id) => [id, { solicitud: sol(id), grantedRow: null }]));
      },
      async resolveBaseLabels(ids) {
        calls.push(['base', ids.length]);
        return new Map(ids.map((id) => [String(id), 'BASE_X']));
      },
    };
    const view = createElmListView({ repository: fakeRepo, config: EMPTY_CONFIG, now: () => Date.now() });
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const cells = await view.cellsForCzIds(ids);
    assert.strictEqual(cells.size, 50);
    // Fase 3B: source is the constant copanel, so the cell no longer resolves provenance bases.
    assert.deepStrictEqual(calls, [['proc', 50], ['ctx', 49]]);

    // Real repository against a counting stub: queries grow with chunks (200), not rows.
    const queries = [];
    function countingClient() {
      return {
        from(table) {
          const q = {
            _in: null,
            select() { return q; },
            in(col, vals) { q._in = vals; return q; },
            eq() { queries.push('EQ:' + table); return q; },
            then(resolve) {
              queries.push(table);
              let data = [];
              if (table === 'cz_funnel_solicitudes') data = q._in.map((id) => sol(id));
              resolve({ data, error: null });
            },
          };
          return q;
        },
        rpc() { throw new Error('no rpc in list'); },
      };
    }
    const realView = createElmListView({
      repository: createElmRepository(countingClient()),
      config: EMPTY_CONFIG,
    });
    queries.length = 0;
    await realView.cellsForCzIds(ids);
    const small = queries.length;
    queries.length = 0;
    await realView.cellsForCzIds(Array.from({ length: 450 }, (_, i) => i + 1));
    const big = queries.length;
    assert.ok(!queries.some((q) => q.startsWith('EQ:')), 'no per-row eq lookups');
    assert.strictEqual(small, 3);
    assert.strictEqual(big, 9, 'ceil(450/200)=3 chunks × 3 lookups');

    const rows = [{ cz_id: 1, resultado: 'granted' }, { cz_id: 2, resultado: 'sin_resultado' }];
    await attachElmCells(rows, view, silentLogger);
    assert.strictEqual(rows[0].resultado, 'granted');
    assert.strictEqual(rows[1].elm.label, 'Preaprobado ELM');
    assert.strictEqual(rows[1].elm.provider_status, 'Latente');
    const broken = [{ cz_id: 3, resultado: 'granted' }];
    await attachElmCells(broken, { async cellsForCzIds() { throw new Error('relation missing'); } }, silentLogger);
    assert.strictEqual(broken[0].elm.kind, 'unavailable');
    assert.strictEqual(broken[0].resultado, 'granted');
    const route = readSrc('src/routes/preaprobados.js');
    assert.ok(/await attachElmCells\(assembled\.rows, getElmListView\(\), logger\)/.test(route));
  });

  await test('#19 "Enviar a ELM" only where allowed, enabled only when ready + eligible; not sendable → no button', async () => {
    const notReady = { ready: false, reasons: [CODES.ACTIVITY_TYPE_MAPPING_MISSING] };
    const ready = { ready: true, reasons: [] };

    const preaprobadosCell = computeElmCell({ process: null, eligibility: { eligible: true, blockers: [] }, nowMs: 0 });
    assert.strictEqual(preaprobadosCell.kind, 'not_sent');
    assert.strictEqual(preaprobadosCell.action.show, false, 'no send outside Rechazados');
    assert.ok(!ElmUi.elmCellHtml(preaprobadosCell).includes('<button'));

    const pending = computeElmCell({
      process: null,
      eligibility: { eligible: false, blockers: [{ code: CODES.ACTIVITY_TYPE_MAPPING_MISSING }] },
      nowMs: Date.now(),
      allowSend: true,
      sendReadiness: notReady,
    });
    assert.strictEqual(pending.kind, 'not_sent');
    assert.strictEqual(pending.action.show, true);
    assert.strictEqual(pending.action.enabled, false);
    assert.strictEqual(pending.action.reason, CODES.ACTIVITY_TYPE_MAPPING_MISSING);
    assert.strictEqual(pending.action.hint, SEND_PENDING_HINT);
    const html = ElmUi.elmCellHtml(pending);
    assert.ok(html.includes('Enviar a ELM'));
    assert.ok(/ disabled /.test(html));
    assert.ok(html.includes('title="Configuración ELM pendiente: mapeo de actividad."'));
    assert.ok(!/data-action/.test(html), 'disabled button has no click wiring');

    const allOkNotReady = computeElmCell({
      process: null, eligibility: { eligible: true, blockers: [] }, nowMs: 0, allowSend: true, sendReadiness: notReady,
    });
    assert.strictEqual(allOkNotReady.action.show, true);
    assert.strictEqual(allOkNotReady.action.enabled, false);

    const enabled = computeElmCell({
      process: null, czId: 77, eligibility: { eligible: true, blockers: [] }, nowMs: 0, allowSend: true, sendReadiness: ready,
    });
    assert.strictEqual(enabled.action.enabled, true);
    assert.strictEqual(enabled.action.hint, null);
    assert.strictEqual(enabled.cz_solicitud_id, 77);
    const enabledHtml = ElmUi.elmCellHtml(enabled);
    assert.ok(enabledHtml.includes('data-action="elm-send"'));
    assert.ok(enabledHtml.includes('data-cz-id="77"'));
    assert.ok(!/ disabled /.test(enabledHtml));

    for (const blocker of [CODES.CDV_GRANTED, CODES.MISSING_REQUIRED_FIELDS, CODES.SOLICITUD_NOT_FOUND]) {
      const c = computeElmCell({ process: null, eligibility: { eligible: false, blockers: [{ code: blocker }] }, nowMs: 0 });
      assert.strictEqual(c.kind, 'not_sendable');
      assert.strictEqual(c.action.show, false);
      assert.ok(!ElmUi.elmCellHtml(c).includes('<button'));
    }
    // Fase 3B: organic leads are no longer blocked by provenance (source is always copanel).
    assert.strictEqual(CODES.SOURCE_BRAND_INDETERMINATE, undefined);

    const dash = readSrc('public/mie-dashboard.js');
    assert.strictEqual((dash.match(/action === 'elm-send'/g) || []).length, 1, 'single send handler');
    assert.strictEqual((dash.match(/\/elm\/send/g) || []).length, 1);
    assert.ok(dash.includes("API + '/rechazados/' + encodeURIComponent(ci) + '/elm/send'"));
    assert.ok(!/\/elm\/evaluate|\/elm\/refer/.test(dash), 'dashboard never calls S1/S2 routes directly');
    assert.ok(!/CONSULTAR ELM|Consultar ELM/.test(dash), 'no "Consultar ELM" button');
    assert.ok(dash.includes('window.confirm('), 'send asks for confirmation');
    assert.ok(dash.includes('<th>ELM</th>'));
    const htmlPage = readSrc('public/mie-dashboard.html');
    assert.ok(htmlPage.indexOf('elm-ui-helpers.js') !== -1);
    assert.ok(htmlPage.indexOf('elm-ui-helpers.js') < htmlPage.indexOf('mie-dashboard.js'));
  });

  await test('#20 #21 #22 referred = "Preaprobado ELM" (raw status kept); only disbursed = "Otorgado ELM"', async () => {
    const nowMs = Date.now();
    const st = computeElmCell({ process: proc({ cz_solicitud_id: 1, provider_status: 'Pendiente de Doc' }), nowMs });
    assert.strictEqual(st.kind, 'referred');
    assert.strictEqual(st.label, 'Preaprobado ELM');
    assert.strictEqual(st.provider_status, 'Pendiente de Doc');
    const sth = ElmUi.elmCellHtml(st);
    assert.ok(sth.includes('Preaprobado ELM'));
    assert.ok(sth.includes('Estado ELM: Pendiente de Doc'));

    const g = computeElmCell({
      process: proc({ cz_solicitud_id: 1, provider_status: 'Convertido', disbursed_at: '2026-10-06T10:00:00Z' }),
      nowMs,
    });
    assert.strictEqual(g.kind, 'granted');
    assert.strictEqual(g.label, 'Otorgado ELM');
    assert.strictEqual(g.granted_elm, true);
    assert.strictEqual(g.provider_status, 'Convertido');
    const gh = ElmUi.elmCellHtml(g);
    assert.ok(gh.includes('>Otorgado ELM<'));
    assert.ok(gh.includes('Estado ELM: Convertido'));

    const r = computeElmCell({ process: proc({ cz_solicitud_id: 1 }), nowMs });
    assert.strictEqual(r.kind, 'referred');
    assert.strictEqual(r.label, 'Preaprobado ELM');
    assert.strictEqual(r.granted_elm, false);
    assert.ok(!ElmUi.elmCellHtml(r).includes('Otorgado'));
    const unk = computeElmCell({ process: proc({ cz_solicitud_id: 1, s2_status: 'unknown' }), nowMs });
    assert.strictEqual(unk.kind, 'review');
    assert.strictEqual(unk.granted_elm, false);
    const xss = ElmUi.elmCellHtml(computeElmCell({ process: proc({ cz_solicitud_id: 1, provider_status: '<img src=x>' }), nowMs }));
    assert.ok(!xss.includes('<img'));
  });

  await test('#23 GRANTED CDV and GRANTED ELM stay separate sources', async () => {
    const dash = readSrc('public/mie-dashboard.js');
    assert.ok(dash.includes("kpiCard('GRANTED CDV'"));
    assert.ok(dash.includes('is-granted">GRANTED CDV</span>'));
    assert.ok(dash.includes("{ id: 'granted', label: 'GRANTED CDV' }"));
    assert.ok(dash.includes("'GRANTED ELM'"));
    assert.strictEqual(ElmUi.CDV_GRANTED_LABEL, 'GRANTED CDV');
    const row = { cz_id: 5, resultado: 'granted', monto_otorgado: 1000 };
    const view = {
      async cellsForCzIds() {
        return new Map([[5, computeElmCell({ process: proc({ cz_solicitud_id: 5, disbursed_at: '2026-10-06T00:00:00Z', provider_status: 'Convertido' }), nowMs: 0 })]]);
      },
    };
    await attachElmCells([row], view, silentLogger);
    assert.strictEqual(row.resultado, 'granted');
    assert.strictEqual(row.monto_otorgado, 1000);
    assert.strictEqual(row.elm.granted_elm, true);
    assert.strictEqual(row.elm.disbursed_at, '2026-10-06T00:00:00Z');
    const readLib = readSrc('src/lib/preaprobadosRead.js');
    assert.ok(!/elm/i.test(readLib), 'CDV read rules untouched');
  });

  await test('getElmStatus exposes cell, GRANTED ELM, last postback + match method (read-only)', async () => {
    const p = proc({
      cz_solicitud_id: 1001,
      source_brand: 'X',
      trigger_origin: 'janus_manual',
      s1_lease_expires_at: null,
      s2_lease_expires_at: null,
      provider_status: 'Convertido',
      provider_status_at: '2026-10-06T10:00:00Z',
      disbursed_at: '2026-10-06T10:00:00Z',
      disbursed_amount: null,
      last_postback_at: '2026-10-06T10:00:01Z',
      last_postback_event_id: 'ev-9',
    });
    const writes = [];
    const repo = {
      async getProcessByCzId() { return p; },
      async loadSolicitudContext() { return { solicitud: sol(1001), grantedRow: null }; },
      async resolveBaseLabel() { return ''; },
      async getPostbackEvent(id) { return { id, match_method: 'cz_solicitud_id' }; },
      async expireStaleInFlight() { writes.push('expire'); },
      async claimProcess() { writes.push('claim'); },
    };
    const orch = createElmOrchestrator({ repository: repo, config: EMPTY_CONFIG, logger: silentLogger });
    const out = await orch.getElmStatus('1001');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.data.cell.label, 'Otorgado ELM');
    assert.strictEqual(out.data.process.granted_elm, true);
    assert.strictEqual(out.data.process.disbursed_amount, null);
    assert.strictEqual(out.data.process.last_postback_at, '2026-10-06T10:00:01Z');
    assert.strictEqual(out.data.last_postback_match_method, 'cz_solicitud_id');
    assert.strictEqual(out.data.send_enabled, false);
    assert.strictEqual(writes.length, 0);
    assert.ok(!JSON.stringify(out.data.process).includes(String(p.ci)));
  });

  await test('#24 zero external ELM requests; no secrets in output', async () => {
    assert.strictEqual(externalNet.length, 0, 'external network attempts: ' + externalNet.join(','));
    const out = captured.join('');
    assert.ok(!/Bearer abc|tkn-123456/.test(out));
  });
}

main()
  .then(() => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    for (const r of results) origOut('ok - ' + r + '\n');
    origOut('unit-elm-phase1b: ' + results.length + ' checks passed; external network attempts: ' + externalNet.length + '\n');
  })
  .catch((err) => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    origErr('FAIL: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
