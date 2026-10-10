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
const { createElmOpsRouter } = require('../src/routes/elmOps');
const { requireElmAction } = require('../src/middleware/requireElmAction');
const { parseElmPostback } = require('../src/services/elm/postback');
const { CODES } = require('../src/services/elm/constants');
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
    async getProcessesByIds() {
      return new Map();
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
  const opsSrc = readSrc('src/services/elmOps/repository.js') + readSrc('src/services/elmOps/service.js');
  assert.ok(!/\.from\([^)]*\)\s*\.(insert|update|delete|upsert)\(/.test(opsSrc), 'no direct writes');
  assert.ok(!/evaluateElm|referElm|retryElmStep|service1|service2/.test(opsSrc), 'ops never sends to ELM');
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
  assert.ok(!page.includes('elm-ops.js') && !page.includes('id="elm-ops-root"'), 'ELM Ops panels retired from Preaprobados');
  assert.ok(!readSrc('public/mie-dashboard.js').includes('ElmOps'), 'dashboard no longer mounts ELM Ops');
  const pane = page.slice(page.indexOf('id="preaprobados-panel"'), page.indexOf('id="preaprobados-modal-root"'));
  for (const id of ['preaprobados-reload-btn', 'preaprobados-filters', 'preaprobados-kpis', 'preaprobados-status', 'preaprobados-results']) {
    assert.ok(pane.includes('id="' + id + '"'), 'Preaprobados keeps #' + id);
  }
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
