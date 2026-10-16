'use strict';

/**
 * Offline checks for Fase 3B ELM operations: queues service, routes/permissions, UI helpers and
 * postback identity keys. No Supabase, no network, no applied migration.
 * DB-level semantics (RPC row locks, version checks, audit) are covered by
 * scripts/db-local-elm-phase3b-pglite.js.
 *
 * Run: node scripts/unit-elm-ops.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

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
    sessionSecret: 'unit-test-session-secret-0123456789',
    cronSecret: 'unit-test-cron-secret-0123456789',
  },
};
const supabasePath = require.resolve('../src/clients/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    from(table) {
      throw new Error('unexpected supabase access in test: ' + table);
    },
    rpc(name) {
      throw new Error('unexpected supabase rpc in test: ' + name);
    },
  },
};

const {
  createElmOpsService,
  openProcessView,
  reviewCaseView,
  processKind,
  PROCESS_RESOLUTIONS,
  ACTION_HTTP,
} = require('../src/services/elmOps/service');
const {
  classifyOpportunity,
  filterOpportunities,
  SITUATIONS,
  S1_SUBCLASS,
} = require('../src/services/elmOps/opportunityClassify');
const { createGestionActions } = require('../src/services/elmOps/gestionActions');
const { createElmOpsRouter } = require('../src/routes/elmOps');
const { CODES } = require('../src/services/elm/constants');
const { requireElmAction } = require('../src/middleware/requireElmAction');
const { parseElmPostback } = require('../src/services/elm/postback');
const ElmOpsUi = require('../public/elm-ops.js');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = Date.parse('2026-10-08T12:00:00Z');
const PID = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const NOTE = 'ELM confirmó por mail el cierre del caso';

function referredProcess(extra) {
  return Object.assign(
    {
      id: PID,
      cz_solicitud_id: 500,
      ci: 12345678,
      trigger_origin: 'cz_automatic',
      commercial_origin: null,
      created_at: '2026-10-05T12:00:00Z',
      updated_at: '2026-10-06T12:00:00.123456+00:00',
      s1_status: 'eligible',
      s1_started_at: '2026-10-05T12:00:00Z',
      s1_lease_expires_at: null,
      s2_status: 'referred',
      s2_started_at: '2026-10-05T12:00:01Z',
      s2_lease_expires_at: null,
      referred_at: '2026-10-05T12:00:00Z',
      provider_status: 'Latente',
      provider_status_at: '2026-10-06T12:00:00Z',
      disbursed_at: null,
      last_postback_event_id: 'ev-1',
      last_postback_at: '2026-10-06T12:00:00Z',
      ops_resolved_at: null,
    },
    extra || {},
  );
}

function fakeOpsRepo(state) {
  const calls = [];
  return {
    calls,
    async listOpenProcesses() {
      return state.processes;
    },
    async getProcessById(id) {
      return state.processes.find((p) => p.id === id) || null;
    },
    async getProcessByCzId(czId) {
      return state.processes.find((p) => Number(p.cz_solicitud_id) === Number(czId)) || null;
    },
    async getOpenReviewCaseByCzId(czId) {
      return (state.cases || []).find((c) => Number(c.cz_solicitud_id) === Number(czId) && c.status !== 'resolved') || null;
    },
    async getProcessesByIds(ids) {
      const m = new Map();
      const wanted = new Set((ids || []).filter(Boolean));
      if (!wanted.size) return m;
      (state.processes || []).forEach((p) => {
        if (wanted.has(p.id)) m.set(p.id, p);
      });
      return m;
    },
    async getPostbackEventsByIds(ids) {
      calls.push(['events', ids.length]);
      return new Map([['ev-1', { id: 'ev-1', received_at: '2026-10-06T12:00:00Z', raw_status: 'Latente', processing_status: 'applied' }]]);
    },
    async listBlockedByRelated(ids) {
      calls.push(['blocked', ids.length]);
      return new Map([[500, [501, 502]]]);
    },
    async listReviewCases() {
      return state.cases || [];
    },
    async getUsersByIds() {
      return new Map([[ADMIN, { id: ADMIN, email: 'ops@example.test' }]]);
    },
    async listAssignableUsers() {
      return [{ id: ADMIN, email: 'ops@example.test' }];
    },
    async countOpenProcesses() {
      return state.processes.length;
    },
    async listAuditEvents() {
      return [];
    },
    async resolveProcess(args) {
      calls.push(['resolve', args]);
      return { status: 'resolved' };
    },
    async assignReviewCase(args) {
      calls.push(['assign', args]);
      return { status: args.assigneeUserId ? 'assigned' : 'unassigned', version: args.expectedVersion + 1 };
    },
    async triageReviewCase(args) {
      calls.push(['triage', args]);
      return { status: 'triaged', version: args.expectedVersion + 1 };
    },
    async resolveReviewCase(args) {
      calls.push(['resolveCase', args]);
      return { status: 'resolved', version: args.expectedVersion + 1 };
    },
    async listC1ActiveReferrals(staleHours, limit) {
      calls.push(['c1Referrals', staleHours, limit]);
      return state.c1Referrals || [];
    },
    async listOpenFallbackRequests() {
      return state.queued || [];
    },
    async listPhoneInvalidFinalized() {
      return state.phoneInvalid || [];
    },
    async czIdsWithEstado3(ids) {
      return new Set((state.estado3 || ids || []).map(Number));
    },
    async listCzConflicts(status, limit) {
      calls.push(['c1Conflicts', status, limit]);
      return (state.conflicts || []).filter((c) => c.status === status);
    },
    async resolveCzConflict(args) {
      calls.push(['c1ConflictResolve', args]);
      return { status: 'resolved' };
    },
  };
}

function setup(state) {
  const repo = fakeOpsRepo(state);
  const expired = [];
  const elmRepository = {
    async expireStaleInFlight(czId) {
      expired.push(czId);
      const p = state.processes.find((x) => x.cz_solicitud_id === czId);
      Object.assign(p, { s1_status: p.s1_status === 'in_flight' ? 'unknown' : p.s1_status, s1_lease_expires_at: null, updated_at: 'v2' });
      return Object.assign({}, p);
    },
    async listAllProcesses() {
      return state.allProcesses || [];
    },
    async getProjectedEstadosByCzIds() {
      return new Map(state.projected || []);
    },
  };
  const fallbackRepository = {
    async countReviewAlerts() {
      return { open: 2, unassigned: 1, overdue: 1 };
    },
  };
  const silent = { info() {}, warn() {}, error() {} };
  const service = createElmOpsService({
    repository: repo,
    elmRepository,
    fallbackRepository,
    now: () => T0,
    logger: silent,
    c1StaleHours: 48,
  });
  return { repo, service, expired };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('queue view: derivation date, age, solicitud, ELM state, last event, blocked solicitudes', async () => {
  const { service, repo } = setup({ processes: [referredProcess()] });
  const items = await service.listOpenProcesses(50);
  assert.strictEqual(items.length, 1);
  const v = items[0];
  assert.strictEqual(v.kind, 'referral');
  assert.strictEqual(v.cz_solicitud_id, 500);
  assert.strictEqual(v.since, '2026-10-05T12:00:00Z');
  assert.strictEqual(v.age_hours, 72);
  assert.strictEqual(v.elm.provider_status, 'Latente');
  assert.strictEqual(v.elm.granted_elm, false);
  assert.deepStrictEqual(v.last_event, { received_at: '2026-10-06T12:00:00Z', status: 'Latente', processing_status: 'applied' });
  assert.deepStrictEqual(v.blocked_cz_solicitud_ids, [501, 502]);
  assert.strictEqual(v.version, '2026-10-06T12:00:00.123456+00:00');
  assert.deepStrictEqual(v.allowed_resolutions, PROCESS_RESOLUTIONS.referral.slice());
  assert.deepStrictEqual(repo.calls.map((c) => c[0]).sort(), ['blocked', 'events'], 'batched: constant queries');
  assert.ok(!('s1_request' in v) && !('s2_request' in v), 'no PII request bodies');

  assert.strictEqual(processKind({ s1_status: 'unknown', s2_status: 'not_started' }, T0), 's1_unknown');
  assert.strictEqual(processKind({ s1_status: 'eligible', s2_status: 'in_flight', s2_lease_expires_at: '2026-10-01T00:00:00Z' }, T0), 's2_unknown');
  assert.strictEqual(processKind({ s1_status: 'rejected', s2_status: 'not_started' }, T0), null);
});

test('manual resolution: mandatory note, code valid for the state, version passed to the RPC', async () => {
  const { service, repo } = setup({ processes: [referredProcess()] });
  const base = { expected_updated_at: '2026-10-06T12:00:00.123456+00:00', resolution_code: 'provider_closed_no_loan' };
  assert.strictEqual((await service.resolveProcess(PID, Object.assign({}, base, { note: 'corta' }), ADMIN)).status, 'note_required');
  assert.strictEqual((await service.resolveProcess(PID, Object.assign({}, base), ADMIN)).status, 'note_required');
  assert.strictEqual(
    (await service.resolveProcess(PID, Object.assign({}, base, { note: NOTE, resolution_code: 'provider_confirmed_no_referral' }), ADMIN)).status,
    'invalid_resolution',
    'S1-only code not valid for a referral',
  );
  assert.strictEqual((await service.resolveProcess('not-a-uuid', Object.assign({}, base, { note: NOTE }), ADMIN)).status, 'invalid_request');
  assert.strictEqual(repo.calls.filter((c) => c[0] === 'resolve').length, 0);
  const ok = await service.resolveProcess(PID, Object.assign({}, base, { note: NOTE }), ADMIN);
  assert.strictEqual(ok.status, 'resolved');
  const call = repo.calls.find((c) => c[0] === 'resolve')[1];
  assert.strictEqual(call.expectedUpdatedAt, base.expected_updated_at);
  assert.strictEqual(call.actorUserId, ADMIN);
  assert.strictEqual(call.note, NOTE);
  assert.strictEqual(call.czOutcome, 'none', 'no CZ change unless chosen');

  // Referral still 13 in CZ: the operator chooses the CZ result (13→3 / 13→16) with the evidence.
  assert.strictEqual(
    (await service.resolveProcess(PID, Object.assign({}, base, { note: NOTE, cz_outcome: 'approved' }), ADMIN)).status,
    'invalid_cz_outcome',
  );
  const rej = await service.resolveProcess(PID, Object.assign({}, base, { note: NOTE, cz_outcome: 'rejected' }), ADMIN);
  assert.strictEqual(rej.status, 'resolved');
  assert.strictEqual(repo.calls.filter((c) => c[0] === 'resolve').pop()[1].czOutcome, 'rejected');
  assert.strictEqual(ACTION_HTTP.cz_outcome_mismatch, 409);
  assert.strictEqual(ACTION_HTTP.invalid_cz_outcome, 400);
});

test('manual resolution: not resolvable states; expired in_flight persisted as unknown first', async () => {
  const rejected = setup({ processes: [referredProcess({ s2_status: 'rejected', referred_at: null })] });
  assert.strictEqual(
    (await rejected.service.resolveProcess(PID, { expected_updated_at: 'x', resolution_code: 'other', note: NOTE }, ADMIN)).status,
    'not_resolvable',
  );
  const resolved = setup({ processes: [referredProcess({ ops_resolved_at: '2026-10-07T00:00:00Z' })] });
  assert.strictEqual(
    (await resolved.service.resolveProcess(PID, { expected_updated_at: 'x', resolution_code: 'other', note: NOTE }, ADMIN)).status,
    'already_resolved',
  );
  const stuck = setup({
    processes: [referredProcess({ s1_status: 'in_flight', s1_lease_expires_at: '2026-10-08T11:00:00Z', s2_status: 'not_started', referred_at: null, updated_at: 'v1' })],
  });
  const staleView = await stuck.service.resolveProcess(PID, { expected_updated_at: 'v0', resolution_code: 'other', note: NOTE }, ADMIN);
  assert.strictEqual(staleView.status, 'stale');
  assert.deepStrictEqual(stuck.expired, []);
  const out = await stuck.service.resolveProcess(PID, { expected_updated_at: 'v1', resolution_code: 'provider_confirmed_not_received', note: NOTE }, ADMIN);
  assert.strictEqual(out.status, 'resolved');
  assert.deepStrictEqual(stuck.expired, [500]);
  assert.strictEqual(stuck.repo.calls.find((c) => c[0] === 'resolve')[1].expectedUpdatedAt, 'v2');
});

test('review cases: view (owner, overdue, unassigned, ELM state) and validated actions', async () => {
  const c = {
    id: CID,
    fallback_request_id: 'req-1',
    cz_solicitud_id: 600,
    ci: 22222222,
    elm_process_id: null,
    related_cz_solicitud_id: 599,
    reason_code: 'ci_prior_unknown',
    priority: 'normal',
    due_at: '2026-10-08T10:00:00Z',
    status: 'open',
    assigned_to: null,
    created_at: '2026-10-07T12:00:00Z',
    version: 3,
  };
  const v = reviewCaseView(c, { nowMs: T0 });
  assert.strictEqual(v.overdue, true);
  assert.strictEqual(v.unassigned, true);
  assert.strictEqual(v.age_hours, 24);
  assert.strictEqual(v.related_cz_solicitud_id, 599);
  const assigned = reviewCaseView(Object.assign({}, c, { assigned_to: ADMIN }), {
    nowMs: T0,
    users: new Map([[ADMIN, { id: ADMIN, email: 'ops@example.test' }]]),
  });
  assert.deepStrictEqual(assigned.assigned_to, { id: ADMIN, email: 'ops@example.test' });

  const { service, repo } = setup({ processes: [], cases: [c] });
  assert.strictEqual((await service.assignReviewCase(CID, { expected_version: 3, assignee_user_id: '44444444-4444-4444-8444-444444444444' }, ADMIN)).status, 'invalid_assignee');
  assert.strictEqual((await service.assignReviewCase(CID, { assignee_user_id: ADMIN }, ADMIN)).status, 'invalid_request');
  assert.strictEqual((await service.assignReviewCase(CID, { expected_version: 3, assignee_user_id: ADMIN }, ADMIN)).status, 'assigned');
  assert.strictEqual((await service.triageReviewCase(CID, { expected_version: 4, priority: 'urgent', due_at: '2026-10-01T00:00:00Z' }, ADMIN)).status, 'invalid_triage', 'due in the past');
  assert.strictEqual((await service.triageReviewCase(CID, { expected_version: 4, priority: 'nope', due_at: '2026-10-09T00:00:00Z' }, ADMIN)).status, 'invalid_triage');
  assert.strictEqual((await service.triageReviewCase(CID, { expected_version: 4, priority: 'urgent', due_at: '2026-10-09T00:00:00Z' }, ADMIN)).status, 'triaged');
  assert.strictEqual((await service.resolveReviewCase(CID, { expected_version: 5, resolution_code: 'other', cz_outcome: 'none', note: 'x' }, ADMIN)).status, 'note_required');
  assert.strictEqual((await service.resolveReviewCase(CID, { expected_version: 5, resolution_code: 'approve_loan', cz_outcome: 'none', note: NOTE }, ADMIN)).status, 'invalid_resolution');
  assert.strictEqual((await service.resolveReviewCase(CID, { expected_version: 5, resolution_code: 'other', note: NOTE }, ADMIN)).status, 'invalid_cz_outcome', 'cz_outcome mandatory');
  assert.strictEqual((await service.resolveReviewCase(CID, { expected_version: 5, resolution_code: 'other', cz_outcome: 'approved', note: NOTE }, ADMIN)).status, 'invalid_cz_outcome');
  assert.strictEqual((await service.resolveReviewCase(CID, { expected_version: 5, resolution_code: 'resolved_with_provider', cz_outcome: 'rejected', note: NOTE }, ADMIN)).status, 'resolved');
  assert.deepStrictEqual(repo.calls.map((x) => x[0]), ['assign', 'triage', 'resolveCase']);
  assert.strictEqual(repo.calls[2][1].czOutcome, 'rejected', 'cz_outcome passed to the RPC');
  assert.strictEqual(ACTION_HTTP.cz_outcome_required, 409);
  assert.strictEqual(ACTION_HTTP.cz_outcome_not_applicable, 409);
  assert.strictEqual(ACTION_HTTP.invalid_cz_outcome, 400);

  const s = await service.summary();
  assert.deepStrictEqual(s, { open_elm_processes: 0, review_open: 2, review_unassigned: 1, review_overdue: 1 });
});

const CONFLICT_ID = '55555555-5555-4555-8555-555555555555';

function c1Row(extra) {
  return Object.assign(
    {
      cz_solicitud_id: '700',
      ci: '12345678',
      projected_estado: 13,
      fallback_outcome: 'referred',
      reason_code: 'elm_referred',
      elm_process_id: PID,
      started_at: '2026-10-05T12:00:00Z',
      referred_at: '2026-10-05T12:00:00Z',
      age_hours: '72.0',
      provider_status: 'Latente',
      provider_status_at: '2026-10-06T12:00:00Z',
      last_postback_at: '2026-10-06T12:00:00Z',
      hours_since_last_signal: '48.0',
      last_event_seq: 1,
      last_event_type: 'outcome',
      last_event_delivery: 'acked',
      unacked_events: 0,
      open_conflicts: 1,
      lock_state: 'consumed',
      lock_month: '2026-10-01',
      lock_block_reason: 'active_referral',
      granted_elm: false,
      stale: true,
    },
    extra || {},
  );
}

test('C1 ops: active referrals (start date, age, last ELM status, stale) and conflicts', async () => {
  const { service, repo } = setup({
    processes: [],
    c1Referrals: [c1Row(), c1Row({ cz_solicitud_id: 701, projected_estado: 14, last_event_type: null, lock_state: null, stale: false })],
    conflicts: [{ id: CONFLICT_ID, status: 'open' }, { id: 'x', status: 'resolved' }],
  });
  const items = await service.listC1ActiveReferrals(10);
  assert.deepStrictEqual(repo.calls[0], ['c1Referrals', 48, 10], 'stale threshold from config');
  assert.strictEqual(items[0].cz_solicitud_id, 700);
  assert.strictEqual(items[0].projected_estado, 13);
  assert.strictEqual(items[0].started_at, '2026-10-05T12:00:00Z');
  assert.strictEqual(items[0].age_hours, 72);
  assert.strictEqual(items[0].provider_status, 'Latente');
  assert.strictEqual(items[0].hours_since_last_signal, 48);
  assert.deepStrictEqual(items[0].last_event, { seq: 1, type: 'outcome', delivery_status: 'acked' });
  assert.deepStrictEqual(items[0].lock, { state: 'consumed', month: '2026-10-01', block_reason: 'active_referral' });
  assert.strictEqual(items[0].stale, true);
  assert.strictEqual(items[0].open_conflicts, 1);
  assert.strictEqual(items[1].last_event, null);
  assert.strictEqual(items[1].lock, null);
  assert.strictEqual(items[1].stale, false);

  assert.deepStrictEqual((await service.listCzConflicts(undefined, 5)).map((c) => c.id), [CONFLICT_ID], 'default open');
  assert.deepStrictEqual((await service.listCzConflicts('resolved', 5)).map((c) => c.id), ['x']);
  assert.strictEqual((await service.resolveCzConflict('nope', { note: NOTE }, ADMIN)).status, 'invalid_request');
  assert.strictEqual((await service.resolveCzConflict(CONFLICT_ID, { note: 'corta' }, ADMIN)).status, 'note_required');
  assert.strictEqual((await service.resolveCzConflict(CONFLICT_ID, { note: NOTE }, ADMIN)).status, 'resolved');
  assert.deepStrictEqual(repo.calls.filter((c) => c[0] === 'c1ConflictResolve').map((c) => c[1]), [
    { conflictId: CONFLICT_ID, note: NOTE, actorUserId: ADMIN },
  ]);
  assert.strictEqual(await service.listAuditEvents('cz_conflict', CONFLICT_ID).then((r) => Array.isArray(r)), true);
  assert.strictEqual(await service.listAuditEvents('cz_event', CONFLICT_ID), null);
});

function startApp(router, preMiddleware) {
  const app = express();
  app.use(express.json());
  if (preMiddleware) app.use(preMiddleware);
  app.use('/preaprobados/elm-ops', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function call(server, method, p, body) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method,
        path: p,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('routes: reads open to the section; actions need requireElmAction (cron forbidden)', async () => {
  const { service, repo } = setup({ processes: [referredProcess()] });
  const cronServer = await startApp(createElmOpsRouter({ service, requireAction: requireElmAction }), (req, _res, next) => {
    req.dashboardAuthViaCron = true;
    next();
  });
  try {
    assert.strictEqual((await call(cronServer, 'GET', '/preaprobados/elm-ops/summary')).status, 200);
    const r = await call(cronServer, 'POST', '/preaprobados/elm-ops/processes/' + PID + '/resolve', {
      expected_updated_at: 'x', resolution_code: 'other', note: NOTE,
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'elm_cron_forbidden');
    for (const action of ['assign', 'triage', 'resolve']) {
      const a = await call(cronServer, 'POST', '/preaprobados/elm-ops/review-cases/' + CID + '/' + action, {});
      assert.strictEqual(a.status, 403);
    }
    assert.strictEqual((await call(cronServer, 'GET', '/preaprobados/elm-ops/assignees')).status, 403);
    assert.strictEqual((await call(cronServer, 'GET', '/preaprobados/elm-ops/c1/active-referrals')).status, 200);
    assert.strictEqual((await call(cronServer, 'GET', '/preaprobados/elm-ops/c1/conflicts')).status, 200);
    assert.strictEqual((await call(cronServer, 'GET', '/preaprobados/elm-ops/opportunities')).status, 200);
    assert.strictEqual((await call(cronServer, 'GET', '/preaprobados/elm-ops/gestion')).status, 200);
    const closeCron = await call(cronServer, 'POST', '/preaprobados/elm-ops/gestion/1939/close-reject', {
      confirm: true, note: NOTE, expected_version: 1,
    });
    assert.strictEqual(closeCron.status, 403);
    assert.strictEqual(closeCron.body.code, 'elm_cron_forbidden');
    const retryCron = await call(cronServer, 'POST', '/preaprobados/elm-ops/gestion/1939/retry-s1', {
      confirm: true, expected_attempts: 1,
    });
    assert.strictEqual(retryCron.status, 403);
    const cr = await call(cronServer, 'POST', '/preaprobados/elm-ops/c1/conflicts/' + CONFLICT_ID + '/resolve', { note: NOTE });
    assert.strictEqual(cr.status, 403, 'conflict resolution needs the action gate');
    assert.strictEqual(repo.calls.filter((c) => c[0] === 'c1ConflictResolve').length, 0);
    assert.strictEqual(repo.calls.filter((c) => c[0] === 'resolve').length, 0);
  } finally {
    cronServer.close();
  }

  const gate = [];
  const adminServer = await startApp(
    createElmOpsRouter({
      service,
      requireAction: (req, _res, next) => {
        gate.push(req.path);
        req.elmActorUserId = ADMIN;
        next();
      },
    }),
  );
  try {
    const ok = await call(adminServer, 'POST', '/preaprobados/elm-ops/processes/' + PID + '/resolve', {
      expected_updated_at: '2026-10-06T12:00:00.123456+00:00', resolution_code: 'customer_withdrew', note: NOTE,
    });
    assert.strictEqual(ok.status, 200);
    const bad = await call(adminServer, 'POST', '/preaprobados/elm-ops/processes/' + PID + '/resolve', {
      expected_updated_at: 'x', resolution_code: 'customer_withdrew',
    });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.status, 'note_required');
    assert.strictEqual(gate.length, 2);
    const list = await call(adminServer, 'GET', '/preaprobados/elm-ops/processes');
    assert.strictEqual(list.body.items.length, 1);
    assert.strictEqual(gate.length, 2, 'reads do not need the action gate');
    const cok = await call(adminServer, 'POST', '/preaprobados/elm-ops/c1/conflicts/' + CONFLICT_ID + '/resolve', { note: NOTE });
    assert.strictEqual(cok.status, 200);
    const cbad = await call(adminServer, 'POST', '/preaprobados/elm-ops/c1/conflicts/' + CONFLICT_ID + '/resolve', {});
    assert.strictEqual(cbad.status, 400);
    assert.strictEqual(cbad.body.status, 'note_required');
    assert.strictEqual(gate.length, 4);
  } finally {
    adminServer.close();
  }

  const pre = readSrc('src/routes/preaprobados.js');
  assert.ok(pre.indexOf("router.use('/elm-ops', createElmOpsRouter())") < pre.indexOf("router.get('/:czId'"));
  const { resolveSectionForPath } = require('../src/middleware/dashboardSections');
  assert.strictEqual(resolveSectionForPath('/preaprobados/elm-ops/processes'), 'preaprobados');
  assert.strictEqual(resolveSectionForPath('/preaprobados/elm-ops/opportunities'), 'preaprobados');
  assert.strictEqual(resolveSectionForPath('/preaprobados/elm-ops/gestion'), 'preaprobados');
  assert.strictEqual(resolveSectionForPath('/rechazados/elm-recoverable'), 'rechazados');
  const opsSrc = readSrc('src/services/elmOps/repository.js') + readSrc('src/services/elmOps/service.js');
  assert.ok(!/\.from\([^)]*\)\s*\.(insert|update|delete|upsert)\(/.test(opsSrc), 'no direct writes');
  assert.ok(!/evaluateElm|referElm|retryElmStep|service1|service2/.test(opsSrc), 'ops never sends to ELM');
});

test('UI helpers: cellphone-correction review reason is labeled for the operator', async () => {
  assert.ok(ElmOpsUi.reasonLabel('elm_mobilephone_needs_correction').includes('Celular'));
  assert.ok(ElmOpsUi.reasonLabel('elm_mobilephone_needs_correction').includes('no es un rechazo comercial'));
  const html = ElmOpsUi.caseRowHtml(
    {
      id: CID,
      cz_solicitud_id: 1631,
      ci: '52764619',
      reason_code: 'elm_mobilephone_needs_correction',
      created_at: '2026-10-16T12:00:00Z',
      age_hours: 1,
      due_at: '2026-10-17T12:00:00Z',
      unassigned: true,
      overdue: false,
      assigned_to: null,
    },
    function () { return '—'; },
    true,
  );
  assert.ok(html.includes('Celular con formato inválido'));
  assert.ok(!html.includes('elm_mobilephone_needs_correction'), 'operator sees the label, not the raw code');
});

test('UI helpers: alert banner, escaping, no action buttons without permission', async () => {
  assert.strictEqual(ElmOpsUi.alertText({ review_unassigned: 0, review_overdue: 0 }), '');
  assert.strictEqual(
    ElmOpsUi.alertText({ review_unassigned: 2, review_overdue: 1 }),
    '2 caso(s) de revisión sin asignar · 1 caso(s) de revisión vencido(s)',
  );
  const view = openProcessView(referredProcess({ provider_status: '<script>x</script>' }), { nowMs: T0 });
  const fmt = (iso) => iso || '—';
  const html = ElmOpsUi.processRowHtml(view, fmt, false);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('Resolver'));
  assert.ok(ElmOpsUi.processRowHtml(view, fmt, true).includes('data-elm-ops-action="resolve-process"'));
  const form = ElmOpsUi.resolveProcessFormHtml(view);
  assert.ok(form.includes('required') && form.includes('minlength="10"'));
  assert.ok(form.includes('No envía nada a ELM'));
  assert.ok(form.includes('name="cz_outcome"'));
  for (const o of ['none', 'rejected', 'granted']) assert.ok(form.includes('value="' + o + '"'), 'process cz_outcome ' + o);
  assert.deepStrictEqual(Object.keys(ElmOpsUi.PROCESS_CZ_OUTCOME_LABELS).sort(), ['granted', 'none', 'rejected']);
  assert.ok(ElmOpsUi.actionErrorText('cz_outcome_mismatch').includes('13'));
  assert.strictEqual(ElmOpsUi.actionErrorText('stale').includes('cambió'), true);
  const caseForm = ElmOpsUi.resolveCaseFormHtml();
  for (const o of ['referred', 'rejected', 'granted', 'none']) {
    assert.ok(caseForm.includes('value="' + o + '"'), 'cz_outcome option ' + o);
  }
  assert.ok(caseForm.includes('name="cz_outcome"'));
  assert.ok(ElmOpsUi.actionErrorText('cz_outcome_required').includes('14'));
  const page = readSrc('public/mie-dashboard.html');
  assert.ok(page.indexOf('elm-ops.js') > page.indexOf('elm-ui-helpers.js'));
  assert.ok(page.indexOf('elm-ops.js') < page.indexOf('mie-dashboard.js'));
  assert.ok(page.includes('data-dashboard-tab="elm-gestion"'));
  assert.ok(page.includes('id="elm-gestion-panel"'));
  assert.ok(page.includes('id="elm-gestion-root"'));
  assert.ok(page.includes('Gestión ELM'));
  assert.ok(!page.includes('id="elm-ops-root"'));
  assert.ok(!page.includes('id="elm-recoverable-root"'));
  assert.ok(!page.includes('aria-label="Oportunidades ELM"'));
  assert.ok(!page.includes('aria-label="Recuperables ELM"'));
  assert.ok(page.includes("sectionKey === 'elm-gestion'"));
  assert.ok(page.includes('allowedSet.preaprobados'));
  assert.ok(!page.includes("data-dashboard-tab=\"elm-gestion\"") || page.includes('SECTION_ORDER'));
  assert.ok(/SECTION_ORDER = \[[\s\S]*?'preaprobados',\s*'elm-gestion'/m.test(page));
  const dash = readSrc('public/mie-dashboard.js');
  assert.ok(dash.includes('ElmOps.mount'));
  assert.ok(dash.includes('initGestionElm'));
  assert.ok(!/initGestionElm[\s\S]{0,250}canAct:\s*false/.test(dash), 'Gestión probes admin via /assignees');
  assert.ok(dash.includes('__openGestionElm'));
  assert.ok(!dash.includes('ensureElmOpsTray'));
  assert.ok(!dash.includes('ensureElmRecoverableTray'));
  assert.ok(!dash.includes('ElmOps.mountRecoverable'));
  const sections = readSrc('src/middleware/dashboardSections.js');
  assert.ok(!sections.includes('elm-gestion'), 'no new section_key');
});

test('classifier: commercial situations in Spanish without raw ELM codes as primary text', () => {
  const send = classifyOpportunity({
    cz_solicitud_id: 1912,
    ci: '18165244',
    s1_status: 'eligible',
    s2_status: 'technical_error',
    reason_code: 'elm_s2_technical_error_retry_unsafe',
    s1_result_message: 'TypeError: Cannot read properties of undefined (reading \'trackingId\')',
    age_hours: 72.9,
  });
  assert.strictEqual(send.situation, SITUATIONS.COMPLETE_SEND);
  assert.strictEqual(send.situation_label, 'Completar envío a ELM');
  assert.strictEqual(send.next_step_key, 'retry_s2');
  assert.strictEqual(send.age_hours, 72, 'age floors decimal hours');
  assert.ok(send.last_elm.includes('trackingId'));

  const close = classifyOpportunity({
    cz_solicitud_id: 1939,
    ci: '22222222',
    s1_status: 'unknown',
    s2_status: 'not_started',
    reason_code: 'elm_s1_unknown',
    s1_result_message: 'Repetido. Rechazado',
  });
  assert.strictEqual(close.situation, SITUATIONS.CLOSE_REJECT);
  assert.strictEqual(close.s1_subclass, S1_SUBCLASS.DEFINITIVE_REJECT);
  assert.ok(close.situation_label.indexOf('Cerrar rechazo') === 0);
  assert.strictEqual(close.allowed_actions.length, 0, 'close needs an open review case in estado 14');

  const uncertain = classifyOpportunity({
    cz_solicitud_id: 1940,
    ci: '22222223',
    s1_status: 'unknown',
    s2_status: 'not_started',
    reason_code: 'elm_s1_unknown',
    s1_result_message: null,
    s1_error_code: 'elm_http_timeout',
  });
  assert.strictEqual(uncertain.situation, SITUATIONS.RECONCILE);
  assert.strictEqual(uncertain.s1_subclass, S1_SUBCLASS.UNCERTAIN);
  assert.deepStrictEqual(uncertain.allowed_actions, []);
  assert.strictEqual(uncertain.next_step_key, 'reconcile');

  const preRec = classifyOpportunity({
    cz_solicitud_id: 1941,
    ci: '22222224',
    s1_status: 'technical_error',
    s2_status: 'not_started',
    s1_error_code: CODES.HTTP_AUTH_REJECTED,
    s1_http_status: 403,
    s1_attempts: 1,
    trigger_origin: 'janus_manual',
  });
  assert.strictEqual(preRec.situation, SITUATIONS.TECH_NOT_PROCESSED);
  assert.strictEqual(preRec.s1_subclass, S1_SUBCLASS.TECH_NOT_PROCESSED);
  assert.strictEqual(preRec.allowed_actions.length, 1);
  assert.strictEqual(preRec.allowed_actions[0].id, 'retry_s1');

  const autoPre = classifyOpportunity({
    cz_solicitud_id: 1942,
    ci: '22222225',
    s1_status: 'technical_error',
    s2_status: 'not_started',
    s1_error_code: CODES.HTTP_AUTH_REJECTED,
    s1_http_status: 401,
    s1_attempts: 1,
    trigger_origin: 'cz_automatic',
  });
  assert.strictEqual(autoPre.s1_subclass, S1_SUBCLASS.TECH_NOT_PROCESSED);
  assert.deepStrictEqual(autoPre.allowed_actions, [], 'cz_automatic cannot use elm_manual_retry_s1');

  const closable = classifyOpportunity({
    cz_solicitud_id: 1939,
    ci: '22222222',
    s1_status: 'unknown',
    s2_status: 'not_started',
    s1_result_message: 'Repetido. Rechazado',
    review_id: CID,
    review_version: 3,
    projected_estado: 14,
    process_id: PID,
    process_updated_at: 'v1',
  });
  assert.strictEqual(closable.allowed_actions.length, 1);
  assert.strictEqual(closable.allowed_actions[0].id, 'close_reject');
  assert.ok(closable.allowed_actions[0].explanation.indexOf('Repetido. Rechazado') !== -1);

  const data = classifyOpportunity({
    cz_solicitud_id: 10,
    ci: '1',
    reason_code: 'elm_config_incomplete',
  });
  assert.strictEqual(data.situation, SITUATIONS.NEEDS_DATA);

  const wait = classifyOpportunity({
    cz_solicitud_id: 11,
    ci: '1',
    reason_code: 'ci_prior_unknown',
    related_cz_solicitud_id: 1912,
  });
  assert.strictEqual(wait.situation, SITUATIONS.WAITING_OTHER);
  assert.strictEqual(wait.related_cz_solicitud_id, 1912);

  const follow = classifyOpportunity({
    cz_solicitud_id: 1475,
    ci: '33333333',
    projected_estado: 13,
    s2_status: 'referred',
    provider_status: 'Latente',
  });
  assert.strictEqual(follow.situation, SITUATIONS.FOLLOWUP);

  const granted = classifyOpportunity({
    cz_solicitud_id: 1475,
    ci: '33333333',
    projected_estado: 13,
    granted_elm: true,
    provider_status: 'Convertido',
  });
  assert.strictEqual(granted.situation, SITUATIONS.GRANTED);

  const rec = classifyOpportunity({
    cz_solicitud_id: 1630,
    ci: '52764618',
    recoverable: true,
    reason_code: 'elm_mobilephone_invalid',
    s1_status: 'eligible',
    s2_status: 'not_started',
    followup_label: 'Paso 1 aceptado por ELM · paso 2 no enviado',
  });
  assert.strictEqual(rec.situation, SITUATIONS.RECOVERABLE);
  assert.ok(rec.reason_label.toLowerCase().includes('celular'));
  assert.strictEqual(rec.dashboard, 'preaprobados');

  const recDash = classifyOpportunity({
    cz_solicitud_id: 1630,
    ci: '52764618',
    recoverable: true,
    reason_code: 'elm_mobilephone_invalid',
    dashboard: 'rechazados',
  });
  assert.strictEqual(recDash.dashboard, 'rechazados');
  assert.strictEqual(send.vintage, 'historical');
  assert.strictEqual(send.lane, 'attention');
  assert.strictEqual(send.attention, true);
  assert.strictEqual(follow.lane, 'followup');
  assert.strictEqual(follow.attention, false);
  assert.strictEqual(granted.lane, 'followup');
  assert.strictEqual(rec.lane, 'attention');
  const post = classifyOpportunity({
    cz_solicitud_id: 2000,
    ci: '1',
    s1_status: 'eligible',
    s2_status: 'technical_error',
    reason_code: 'elm_s2_technical_error_retry_unsafe',
    since: '2026-10-16T19:00:00.000Z',
  });
  assert.strictEqual(post.vintage, 'post_correction');
  assert.strictEqual(post.vintage_label, 'Posterior a correcciones');
  assert.strictEqual(
    filterOpportunities([send, post], { vintage: 'historical' }).map((i) => i.cz_solicitud_id).join(','),
    '1912',
  );
  assert.strictEqual(
    filterOpportunities([send, follow], { lane: 'followup' }).map((i) => i.cz_solicitud_id).join(','),
    '1475',
  );

  const filtered = filterOpportunities(
    [send, close, rec],
    { ci: '18165244', situation: 'complete_send' },
  );
  assert.deepStrictEqual(filtered.map((i) => i.cz_solicitud_id), [1912]);
});

const PID1630 = '44444444-4444-4444-8444-444444444444';

test('opportunities: one row per solicitud, CI search, 1912 complete_send, no 1630', async () => {
  const p1912 = referredProcess({
    cz_solicitud_id: 1912,
    ci: 18165244,
    trigger_origin: 'cz_automatic',
    s1_status: 'eligible',
    s2_status: 'technical_error',
    referred_at: null,
    provider_status: null,
  });
  const p1630 = referredProcess({
    id: PID1630,
    cz_solicitud_id: 1630,
    ci: 52764618,
    trigger_origin: 'cz_automatic',
    s1_status: 'eligible',
    s2_status: 'not_started',
    referred_at: null,
    provider_status: null,
  });
  const { service } = setup({
    processes: [p1912, p1630],
    allProcesses: [p1912, p1630],
    projected: [[1912, 14], [1630, 3]],
    estado3: [1630],
    cases: [
      {
        id: CID,
        fallback_request_id: 'req-1912',
        cz_solicitud_id: 1912,
        ci: 18165244,
        elm_process_id: PID,
        related_cz_solicitud_id: null,
        reason_code: 'elm_s2_technical_error_retry_unsafe',
        priority: 'normal',
        due_at: '2026-10-09T12:00:00Z',
        status: 'open',
        assigned_to: null,
        created_at: '2026-10-07T12:00:00Z',
        version: 1,
      },
    ],
    c1Referrals: [
      c1Row({
        cz_solicitud_id: 1475,
        ci: '33333333',
        projected_estado: 13,
        granted_elm: true,
        provider_status: 'Convertido',
      }),
      c1Row({
        cz_solicitud_id: 1912,
        ci: '18165244',
        projected_estado: 14,
        fallback_outcome: 'manual_review',
        granted_elm: false,
        stale: false,
        last_event_type: null,
        lock_state: null,
      }),
    ],
    queued: [{ cz_solicitud_id: 1490, ci: '11111111', created_at: '2026-10-08T08:00:00Z' }],
  });
  const out = await service.opportunities({ limit: 50 });
  const ids = out.items.map((i) => i.cz_solicitud_id);
  assert.strictEqual(ids.length, new Set(ids).size, 'no duplicate C1 rows');
  const byId = new Map(out.items.map((i) => [i.cz_solicitud_id, i]));
  assert.ok(byId.has(1912));
  assert.strictEqual(byId.get(1912).situation, SITUATIONS.COMPLETE_SEND);
  assert.strictEqual(byId.get(1912).ci, '18165244');
  assert.ok(byId.has(1475));
  assert.strictEqual(byId.get(1475).situation, SITUATIONS.GRANTED);
  assert.ok(byId.has(1490));
  assert.strictEqual(byId.get(1490).situation, SITUATIONS.IN_EVALUATION);
  assert.ok(!byId.has(1630), 'estado 3 recoverable stays out of Preaprobados');

  const byCi = await service.opportunities({ ci: '18165244' });
  assert.deepStrictEqual(byCi.items.map((i) => i.cz_solicitud_id), [1912]);
  const bySit = await service.opportunities({ situation: 'granted' });
  assert.ok(bySit.items.every((i) => i.situation === 'granted'));
});

test('recoverable: CZ 1630 localizable; S2 already started is excluded', async () => {
  const p1630 = referredProcess({
    id: PID1630,
    cz_solicitud_id: 1630,
    ci: 52764618,
    s1_status: 'eligible',
    s2_status: 'not_started',
    referred_at: null,
  });
  const pSkip = referredProcess({
    id: '55555555-5555-4555-8555-555555555555',
    cz_solicitud_id: 1631,
    ci: 52764619,
    s1_status: 'eligible',
    s2_status: 'unknown',
    referred_at: null,
  });
  const { service } = setup({
    processes: [p1630, pSkip],
    estado3: [1630, 1631],
    phoneInvalid: [
      {
        cz_solicitud_id: 1630,
        ci: '52764618',
        reason_code: 'elm_mobilephone_invalid',
        elm_process_id: PID1630,
        finalized_at: '2026-09-01T12:00:00Z',
        created_at: '2026-09-01T12:00:00Z',
      },
      {
        cz_solicitud_id: 1631,
        ci: '52764619',
        reason_code: 'elm_mobilephone_needs_correction',
        elm_process_id: pSkip.id,
        finalized_at: '2026-09-02T12:00:00Z',
        created_at: '2026-09-02T12:00:00Z',
      },
    ],
  });
  const out = await service.recoverable({ limit: 50 });
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.items[0].cz_solicitud_id, 1630);
  assert.strictEqual(out.items[0].ci, '52764618');
  assert.strictEqual(out.items[0].situation, SITUATIONS.RECOVERABLE);
  assert.strictEqual(out.items[0].dashboard, 'rechazados');
  assert.ok(out.items[0].reason_label.toLowerCase().includes('celular'));
  assert.ok(out.items[0].last_elm.includes('paso 2 no enviado'));
  const byCi = await service.recoverable({ ci: '52764618' });
  assert.strictEqual(byCi.items.length, 1);
  const miss = await service.recoverable({ ci: '18165244' });
  assert.strictEqual(miss.items.length, 0);
});

test('gestion: 1912 + 1630 + estado 13; historical vs post_correction; tab stays disableable', async () => {
  const p1912 = referredProcess({
    cz_solicitud_id: 1912,
    ci: 18165244,
    trigger_origin: 'cz_automatic',
    s1_status: 'eligible',
    s2_status: 'technical_error',
    referred_at: null,
    provider_status: null,
  });
  const p1630 = referredProcess({
    id: PID1630,
    cz_solicitud_id: 1630,
    ci: 52764618,
    trigger_origin: 'cz_automatic',
    s1_status: 'eligible',
    s2_status: 'not_started',
    referred_at: null,
    provider_status: null,
  });
  const { service } = setup({
    processes: [p1912, p1630],
    allProcesses: [p1912, p1630],
    projected: [[1912, 14], [1630, 3]],
    estado3: [1630],
    cases: [
      {
        id: CID,
        fallback_request_id: 'req-1912',
        cz_solicitud_id: 1912,
        ci: 18165244,
        elm_process_id: PID,
        related_cz_solicitud_id: null,
        reason_code: 'elm_s2_technical_error_retry_unsafe',
        priority: 'normal',
        due_at: '2026-10-09T12:00:00Z',
        status: 'open',
        assigned_to: null,
        created_at: '2026-10-07T12:00:00Z',
        version: 1,
      },
    ],
    c1Referrals: [
      c1Row({
        cz_solicitud_id: 1475,
        ci: '33333333',
        projected_estado: 13,
        granted_elm: true,
        provider_status: 'Convertido',
      }),
      c1Row({
        cz_solicitud_id: 1912,
        ci: '18165244',
        projected_estado: 14,
        fallback_outcome: 'manual_review',
        granted_elm: false,
        stale: false,
        last_event_type: null,
        lock_state: null,
      }),
    ],
    queued: [{ cz_solicitud_id: 1490, ci: '11111111', created_at: '2026-10-08T08:00:00Z' }],
    phoneInvalid: [
      {
        cz_solicitud_id: 1630,
        ci: '52764618',
        reason_code: 'elm_mobilephone_invalid',
        elm_process_id: PID1630,
        finalized_at: '2026-09-01T12:00:00Z',
        created_at: '2026-09-01T12:00:00Z',
      },
    ],
  });
  const out = await service.gestion({ limit: 50 });
  const ids = out.items.map((i) => i.cz_solicitud_id);
  assert.strictEqual(ids.length, new Set(ids).size, 'no duplicate C1 rows');
  const byId = new Map(out.items.map((i) => [i.cz_solicitud_id, i]));
  assert.ok(byId.has(1912));
  assert.strictEqual(byId.get(1912).situation, SITUATIONS.COMPLETE_SEND);
  assert.strictEqual(byId.get(1912).vintage, 'historical');
  assert.ok(byId.has(1630), 'estado 3 recoverable enters Gestión ELM');
  assert.strictEqual(byId.get(1630).situation, SITUATIONS.RECOVERABLE);
  assert.ok(byId.has(1475));
  assert.strictEqual(byId.get(1475).lane, 'followup');
  assert.strictEqual(byId.get(1475).attention, false);
  assert.ok(out.tab_enabled === true);
  assert.ok(out.cutover_at);
  assert.ok(out.vintages.some((v) => v.id === 'historical'));
  assert.ok(out.lanes.some((v) => v.id === 'followup'));
  const hist = await service.gestion({ vintage: 'historical' });
  assert.ok(hist.items.every((i) => i.vintage === 'historical'));
  const followLane = await service.gestion({ lane: 'followup' });
  assert.ok(followLane.items.every((i) => i.lane === 'followup'));
  const byCi = await service.gestion({ ci: '52764618' });
  assert.deepStrictEqual(byCi.items.map((i) => i.cz_solicitud_id), [1630]);
});

test('GET Preaprobados and Rechazados list handlers stay the CDV/rejected assemblers', () => {
  const pre = readSrc('src/routes/preaprobados.js');
  assert.ok(pre.includes("router.get('/', async function getPreaprobadosList"));
  assert.ok(pre.includes('assembleGroupedPreaprobadosList'));
  assert.ok(pre.includes("router.use('/elm-ops', createElmOpsRouter())"));
  const rec = readSrc('src/routes/rechazados.js');
  assert.ok(rec.includes("router.get('/', async function getRechazadosList"));
  assert.ok(rec.includes('assembleRejectedList'));
  assert.ok(rec.indexOf("router.get('/elm-recoverable'") > rec.indexOf("router.get('/', async function getRechazadosList"));
  assert.ok(rec.indexOf("router.get('/elm-recoverable'") < rec.indexOf("router.get('/:ci'"));
  assert.ok(!/router\.post\('\/elm-recoverable'/.test(rec), 'recoverable is GET only');
  const elmOps = readSrc('src/routes/elmOps.js');
  assert.ok(elmOps.includes("router.get('/opportunities'"));
  assert.ok(elmOps.includes("router.get('/gestion'"));
  assert.ok(elmOps.includes("router.post('/gestion/:czId/close-reject'"));
  assert.ok(elmOps.includes("router.post('/gestion/:czId/retry-s1'"));
  assert.ok(!/router\.post\('\/opportunities'/.test(elmOps));
  const ui = readSrc('public/elm-ops.js');
  assert.ok(ui.includes("request('GET', '/gestion')"));
  assert.ok(!ui.slice(ui.indexOf('function mount('), ui.indexOf('function mountRecoverable')).includes("request('/opportunities')"));
  assert.ok(ui.includes('/rechazados/elm-recoverable'));
  assert.ok(ui.includes('/close-reject'));
  assert.ok(ui.includes('/retry-s1'));
});

test('UI Gestión ELM: mount GET /gestion only; CI search; vintage/lane; no send actions', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    calls.push({ method: method, url: String(url), body: opts && opts.body });
    return {
      status: 200,
      json: async () => ({
        ok: true,
        items: [
          classifyOpportunity({
            cz_solicitud_id: 1912,
            ci: '18165244',
            s1_status: 'eligible',
            s2_status: 'technical_error',
            reason_code: 'elm_s2_technical_error_retry_unsafe',
            since: '2026-10-05T12:00:00Z',
            age_hours: 72,
          }),
          classifyOpportunity({
            cz_solicitud_id: 1630,
            ci: '52764618',
            recoverable: true,
            reason_code: 'elm_mobilephone_invalid',
            s1_status: 'eligible',
            s2_status: 'not_started',
            dashboard: 'rechazados',
            since: '2026-09-01T12:00:00Z',
            age_hours: 1000,
          }),
          classifyOpportunity({
            cz_solicitud_id: 1475,
            ci: '33333333',
            projected_estado: 13,
            granted_elm: true,
            provider_status: 'Convertido',
            since: '2026-10-04T12:00:00Z',
            age_hours: 96,
            dashboard: 'preaprobados',
          }),
        ],
        situations: [
          { id: 'complete_send', label: 'Completar envío a ELM' },
          { id: 'recoverable', label: 'Recuperable' },
          { id: 'granted', label: 'Préstamo otorgado' },
        ],
        vintages: [
          { id: 'historical', label: 'Pendiente histórico' },
          { id: 'post_correction', label: 'Posterior a correcciones' },
        ],
        lanes: [
          { id: 'attention', label: 'Requiere gestión' },
          { id: 'followup', label: 'Seguimiento (no es un error)' },
        ],
      }),
    };
  };
  const listeners = [];
  const root = {
    innerHTML: '',
    addEventListener(type, fn) {
      listeners.push({ type: type, fn: fn });
    },
  };
  const tray = ElmOpsUi.mount({ root: root, api: '', fetch: fetchFn, canAct: true });
  await tray.load();
  assert.strictEqual(calls.length, 1, 'canAct:true skips /assignees and only reads /gestion');
  assert.strictEqual(calls[0].method, 'GET');
  assert.ok(calls[0].url.includes('/preaprobados/elm-ops/gestion'));
  assert.ok(!calls[0].url.includes('/opportunities'));
  assert.ok(!calls[0].url.includes('/followup'));
  assert.ok(root.innerHTML.includes('Gestión ELM'));
  assert.ok(root.innerHTML.includes('Pendiente histórico'));
  assert.ok(root.innerHTML.includes('class="elm-ops-flag">Pendiente histórico'));
  assert.ok(!root.innerHTML.includes('elm-ops-flag-danger">Pendiente histórico'));
  assert.ok(root.innerHTML.includes('elm-ops-flag-danger">Requiere gestión'));
  assert.ok(root.innerHTML.includes('value="attention" selected'));
  assert.ok(root.innerHTML.includes('1912'));
  assert.ok(root.innerHTML.includes('1630'));
  assert.ok(!root.innerHTML.includes('1475'), 'follow-up/granted stay out of the default attention lane');
  assert.ok(root.innerHTML.includes('Seguimiento (no es un error)'), 'follow-up remains in the lane filter');
  assert.ok(root.innerHTML.includes('data-elm-ops-search'));
  assert.ok(root.innerHTML.includes('data-elm-ops-filter="vintage"'));
  assert.ok(root.innerHTML.includes('data-elm-ops-filter="lane"'));
  assert.ok(root.innerHTML.includes('data-elm-ops-open-detail'));
  assert.ok(root.innerHTML.includes('data-elm-ops-actions'));
  assert.ok(root.innerHTML.includes('data-elm-ops-admin-slot') === false, 'admin slot appears after opening detail');
  assert.ok(root.innerHTML.includes('data-elm-next="retry_s2"'));
  assert.ok(!root.innerHTML.includes('id="elm-ops-estado-12"'));
  assert.ok(!root.innerHTML.includes('id="elm-ops-estado-14"'));
  assert.ok(!root.innerHTML.includes('id="elm-ops-estado-13"'));
  assert.ok(root.innerHTML.includes('Reenviar paso 2'), 'next step is copy, not a send control');
  assert.ok(!root.innerHTML.includes('data-elm-ops-form'));
  assert.ok(!/<form[\s>]/.test(root.innerHTML));
  assert.strictEqual(ElmOpsUi.GESTION_TAB_ENABLED, true);
  assert.strictEqual(ElmOpsUi.fmtAge(72.9), '3 d');
  const change = listeners.find((l) => l.type === 'change');
  assert.ok(change);
  change.fn({
    target: {
      getAttribute(name) {
        return name === 'data-elm-ops-filter' ? 'lane' : null;
      },
      value: '',
    },
  });
  assert.ok(root.innerHTML.includes('1475'), 'follow-up/granted remain consultable via the lane filter');
  const click = listeners.find((l) => l.type === 'click');
  assert.ok(click);
  click.fn({
    target: {
      closest() {
        return {
          getAttribute(name) {
            return name === 'data-elm-ops-open-detail' ? '1912' : null;
          },
        };
      },
    },
  });
  assert.ok(root.innerHTML.includes('data-elm-ops-admin-slot'));
  assert.ok(
    root.innerHTML.includes('No hay acciones administrativas') ||
      root.innerHTML.includes('Solo un administrador'),
  );
  const input = listeners.find((l) => l.type === 'input');
  assert.ok(input);
  input.fn({
    target: {
      getAttribute(name) {
        return name === 'data-elm-ops-search' ? '' : null;
      },
      value: '18165244',
    },
  });
  assert.ok(root.innerHTML.includes('1912'));
  assert.ok(!root.innerHTML.includes('>1475<') && !root.innerHTML.includes('>33333333<'), 'CI filter hides 1475');
  assert.ok(!root.innerHTML.includes('>1630<'), 'CI filter hides 1630');
});

test('UI stage A: Recuperables ELM GET /rechazados/elm-recoverable shows 1630', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ method: (opts && opts.method) || 'GET', url: String(url) });
    return {
      status: 200,
      json: async () => ({
        ok: true,
        items: [
          classifyOpportunity({
            cz_solicitud_id: 1630,
            ci: '52764618',
            recoverable: true,
            reason_code: 'elm_mobilephone_invalid',
            s1_status: 'eligible',
            s2_status: 'not_started',
            dashboard: 'rechazados',
            followup_label: 'Paso 1 aceptado por ELM · paso 2 no enviado',
            since: '2026-09-01T12:00:00Z',
            age_hours: 1000,
          }),
        ],
      }),
    };
  };
  const root = { innerHTML: '', addEventListener() {} };
  const tray = ElmOpsUi.mountRecoverable({ root: root, api: '', fetch: fetchFn });
  await tray.load();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'GET');
  assert.ok(calls[0].url.includes('/rechazados/elm-recoverable'));
  assert.ok(root.innerHTML.includes('Recuperables ELM'));
  assert.ok(root.innerHTML.includes('1630'));
  assert.ok(root.innerHTML.includes('52764618'));
  assert.ok(root.innerHTML.toLowerCase().includes('celular') || root.innerHTML.includes('paso 2 no enviado'));
  assert.ok(root.innerHTML.includes('Enviar paso 2'), 'next step explains the later resume');
  assert.ok(!root.innerHTML.includes('data-elm-ops-action='), 'no action buttons yet');
  assert.ok(!/<form[\s>]/.test(root.innerHTML));
});

test('stage B actions: close only with definitive S1 + review 14; retry only pre-reception; no ELM on close', async () => {
  const pUnknown = referredProcess({
    cz_solicitud_id: 1939,
    ci: 22222222,
    s1_status: 'unknown',
    s2_status: 'not_started',
    s1_result_message: 'Repetido. Rechazado',
    referred_at: null,
    updated_at: 'v1',
  });
  const review = {
    id: CID,
    cz_solicitud_id: 1939,
    ci: 22222222,
    reason_code: 'elm_s1_unknown',
    status: 'open',
    version: 3,
  };
  const state = {
    processes: [pUnknown],
    cases: [review],
    projected: [[1939, 14]],
  };
  const repo = fakeOpsRepo(state);
  const retryCalls = [];
  const actions = createGestionActions({
    repository: repo,
    elmRepository: {
      async getProcessByCzId(czId) {
        return state.processes.find((p) => Number(p.cz_solicitud_id) === Number(czId)) || null;
      },
      async getProjectedEstadosByCzIds() {
        return new Map(state.projected);
      },
    },
    retryDeps: {
      orchestrator: {
        getSendReadiness() { return { ready: true, reasons: [] }; },
        async retrySendElm() {
          retryCalls.push('retry');
          return { ok: true, stage: 's1' };
        },
      },
      listView: { async cellsForCzIds() { return new Map(); } },
      loadCiResendHold: async () => null,
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.strictEqual(
    (await actions.closeS1AsRejected(1939, { confirm: true, note: NOTE, expected_version: 3 }, ADMIN)).status,
    'resolved',
  );
  assert.strictEqual(repo.calls.filter((c) => c[0] === 'resolveCase').length, 1);
  assert.strictEqual(repo.calls.filter((c) => c[0] === 'resolveCase')[0][1].czOutcome, 'rejected');
  assert.strictEqual(repo.calls.filter((c) => c[0] === 'resolve').length, 1);
  assert.strictEqual(repo.calls.filter((c) => c[0] === 'resolve')[0][1].czOutcome, 'none');
  assert.strictEqual(
    repo.calls.filter((c) => c[0] === 'resolve')[0][1].resolutionCode,
    'other',
    'other keeps monthly quota; provider_confirmed_not_received would release the month',
  );
  assert.deepStrictEqual(retryCalls, [], 'close never retries S1');

  assert.strictEqual(
    (await actions.closeS1AsRejected(1939, { note: NOTE, expected_version: 3 }, ADMIN)).status,
    'confirm_required',
  );
  review.status = 'resolved';
  review.version = 4;
  assert.strictEqual(
    (await actions.closeS1AsRejected(1939, { confirm: true, note: NOTE, expected_version: 3 }, ADMIN)).status,
    'no_review_case',
    'second admin cannot close an already resolved review',
  );

  const pStale = referredProcess({
    id: '99999999-9999-4999-8999-999999999999',
    cz_solicitud_id: 1938,
    ci: 22222221,
    s1_status: 'unknown',
    s2_status: 'not_started',
    s1_result_message: 'SCORE BAJO',
    referred_at: null,
    updated_at: 'v1',
  });
  state.processes.push(pStale);
  state.cases.push({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cz_solicitud_id: 1938,
    ci: 22222221,
    reason_code: 'elm_s1_unknown',
    status: 'open',
    version: 5,
  });
  state.projected.push([1938, 14]);
  assert.strictEqual(
    (await actions.closeS1AsRejected(1938, { confirm: true, note: NOTE, expected_version: 4 }, ADMIN)).status,
    'stale',
    'concurrent operator with an old version is refused',
  );
  const src = readSrc('src/services/elmOps/gestionActions.js');
  assert.ok(src.includes("PROCESS_UNBLOCK_RESOLUTION = 'other'"));
  assert.ok(!/closeS1AsRejected[\s\S]*provider_confirmed_not_received/.test(src));

  const timeoutProc = referredProcess({
    id: '66666666-6666-4666-8666-666666666666',
    cz_solicitud_id: 1940,
    ci: 22222223,
    s1_status: 'unknown',
    s2_status: 'not_started',
    s1_result_message: null,
    s1_error_code: 'elm_http_timeout',
    referred_at: null,
  });
  state.processes.push(timeoutProc);
  state.cases.push({ id: '77777777-7777-4777-8777-777777777777', cz_solicitud_id: 1940, status: 'open', version: 1 });
  state.projected.push([1940, 14]);
  assert.strictEqual(
    (await actions.closeS1AsRejected(1940, { confirm: true, note: NOTE, expected_version: 1 }, ADMIN)).status,
    'not_definitive',
  );

  const pre = referredProcess({
    id: '88888888-8888-4888-8888-888888888888',
    cz_solicitud_id: 1941,
    ci: 22222224,
    s1_status: 'technical_error',
    s2_status: 'not_started',
    s1_error_code: CODES.HTTP_AUTH_REJECTED,
    s1_http_status: 403,
    s1_attempts: 1,
    trigger_origin: 'janus_manual',
    referred_at: null,
  });
  state.processes.push(pre);
  const retryOk = await actions.retryS1(1941, { confirm: true, expected_attempts: 1 }, ADMIN);
  assert.strictEqual(retryOk.status, 'retried');
  assert.deepStrictEqual(retryCalls, ['retry']);

  assert.strictEqual(
    (await actions.retryS1(1940, { confirm: true, expected_attempts: 1 }, ADMIN)).status,
    'retry_not_allowed',
    'timeout unknown is not pre-reception',
  );
  assert.strictEqual(
    (await actions.retryS1(1939, { confirm: true, expected_attempts: 1 }, ADMIN)).status,
    'retry_not_allowed',
    'definitive rejection is not retried',
  );
});

test('UI stage B: only valid actions; uncertain shows conciliation; confirmation required', async () => {
  const closeItem = classifyOpportunity({
    cz_solicitud_id: 1939,
    ci: '22222222',
    s1_status: 'unknown',
    s2_status: 'not_started',
    s1_result_message: 'Repetido. Rechazado',
    review_id: CID,
    review_version: 3,
    projected_estado: 14,
    process_id: PID,
    process_updated_at: 'v1',
    since: '2026-10-01T12:00:00Z',
    age_hours: 200,
  });
  const uncItem = classifyOpportunity({
    cz_solicitud_id: 1940,
    ci: '22222223',
    s1_status: 'unknown',
    s2_status: 'not_started',
    reason_code: 'elm_s1_unknown',
    since: '2026-10-02T12:00:00Z',
    age_hours: 100,
  });
  const slotClose = ElmOpsUi.gestionAdminSlotHtml(closeItem, { canAct: true });
  assert.ok(slotClose.includes('data-elm-ops-action="close_reject"'));
  assert.ok(!slotClose.includes('data-elm-ops-action="retry_s1"'));
  assert.ok(slotClose.includes('Cerrar como rechazado'));
  const slotUnc = ElmOpsUi.gestionAdminSlotHtml(uncItem, { canAct: true });
  assert.ok(slotUnc.includes('Requiere conciliación con ELM'));
  assert.ok(!slotUnc.includes('data-elm-ops-action="close_reject"'));
  assert.ok(!slotUnc.includes('data-elm-ops-action="retry_s1"'));
  const form = ElmOpsUi.gestionActionFormHtml(closeItem.allowed_actions[0]);
  assert.ok(form.includes('name="confirm"'));
  assert.ok(form.includes('No llama a ELM') || form.includes('no envía nada a ELM'));
  assert.ok(form.includes('name="note"'));
  assert.ok(ElmOpsUi.actionErrorText('not_definitive').includes('definitivo'));
});

test('postback: internal_id / cedula accepted; disagreeing aliases are invalid, never resolved by precedence', async () => {
  const now = T0;
  const a = parseElmPostback({ estado: 'Convertido', internal_id: '700', cedula: '1.234.567-8' }, now);
  assert.strictEqual(a.invalidCode, null);
  assert.strictEqual(a.fields.czSolicitudId, 700);
  assert.strictEqual(a.fields.grantedElm, true);
  assert.ok(a.fields.ci != null);
  const same = parseElmPostback({ estado: 'Convertido', internal_id: 700, cz_solicitud_id: '700' }, now);
  assert.strictEqual(same.invalidCode, null);
  assert.strictEqual(same.fields.czSolicitudId, 700);
  const conflict = parseElmPostback({ estado: 'Convertido', internal_id: '700', cz_solicitud_id: '701' }, now);
  assert.strictEqual(conflict.invalidCode, CODES.POSTBACK_CZ_ID_INVALID);
  const ciConflict = parseElmPostback({ estado: 'Convertido', internal_id: '700', cedula: '11111111', docNumber: '22222222' }, now);
  assert.strictEqual(ciConflict.invalidCode, CODES.POSTBACK_CI_INVALID);
  const pb = readSrc('src/services/elm/postback.js');
  assert.ok(!/cz_funnel_solicitudes/.test(pb), 'postback association never depends on the mirror');
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log('ok - ' + t.name);
    } catch (err) {
      console.error('FAIL - ' + t.name);
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    }
  }
  console.log('unit-elm-ops: ' + passed + '/' + tests.length + ' checks passed');
})();
