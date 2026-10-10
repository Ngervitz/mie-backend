'use strict';

/**
 * Offline checks for Fase 3A (persistent provider fallback job). No Supabase, no network, no
 * applied migration, no real ELM. In-memory repositories mirror the RPC semantics of
 * migrations/20261008_provider_fallback_requests.sql (verified separately against PGlite in
 * scripts/db-local-provider-fallback-pglite.js). The ELM client is a test double; the
 * production client stays disabled.
 *
 * Run: node scripts/unit-provider-fallback.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const express = require('express');

const HMAC_SECRET = 'unit-provider-fallback-secret-0123456789';
const envPath = require.resolve('../src/config/env');
const ENV = {
  port: 3000,
  nodeEnv: 'test',
  supabaseUrl: 'https://example.supabase.co',
  supabaseServiceRoleKey: 'test',
  apifyToken: 'test',
  apifyActorId: 'test',
  sessionSecret: 'unit-test-session-secret-0123456789',
  cronSecret: 'unit-test-cron-secret-0123456789',
  czTrackingHmacSecret: 'unit-tracking-secret-0123456789',
  czMiplanHandoffHmacSecret: 'unit-miplan-secret-0123456789',
  czProviderFallbackHmacSecret: HMAC_SECRET,
};
require.cache[envPath] = { id: envPath, filename: envPath, loaded: true, exports: ENV };

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

const { readElmConfig } = require('../src/services/elm/config');
const { createElmOrchestrator } = require('../src/services/elm/orchestrator');
const { createElmClient } = require('../src/services/elm/client');
const { S1, S2, CODES } = require('../src/services/elm/constants');
const { readProviderFallbackConfig } = require('../src/services/providerFallback/config');
const { parseStartBody, snapshotToSolicitud } = require('../src/services/providerFallback/snapshot');
const { createProviderFallbackWorker } = require('../src/services/providerFallback/worker');
const { OUTCOME, REASONS, CI_LOCK_BLOCK } = require('../src/services/providerFallback/constants');
const { decideCiLock } = require('../src/services/providerFallback/outcome');
const { parseRejectionStatuses } = require('../src/services/providerFallback/config');
const { createProviderFallbackRouter } = require('../src/routes/providerFallback');
const { signProviderFallbackPayload } = require('../src/lib/czProviderFallbackHmac');
const miplanHandoff = require('../src/routes/miplan-handoff');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = Date.parse('2026-10-07T12:00:00Z');
/** 2026-11-01 00:00 in America/Montevideo (UTC-3). */
const NOV_1_MVD = Date.parse('2026-11-01T03:00:00Z');
const ELM_CONFIG = readElmConfig({
  ELM_ACTIVITY_TYPE_MAP_JSON: '{"EPR":"TEST_ACTIVITY_EPR"}',
  ELM_DATE_OF_BIRTH_FORMAT: 'D/M/YYYY',
  ELM_MOBILE_PHONE_FORMAT: 'uy_local_0',
});
const LEASE_MS = ELM_CONFIG.inFlightLeaseSeconds * 1000;
const ALL_ON = {
  PROVIDER_FALLBACK_START_ENABLED: 'true',
  PROVIDER_FALLBACK_WORKER_ENABLED: 'true',
  PROVIDER_FALLBACK_CZ_AUTOMATIC_ENABLED: 'true',
};

const tick = () => new Promise((r) => setImmediate(r));
const iso = (ms) => new Date(ms).toISOString();

function createLogger() {
  const lines = [];
  const log = (level) => (msg, meta) => lines.push(JSON.stringify({ level, msg, meta: meta || null }));
  return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
}

/**
 * In-memory elm_lead_processes with the 1A RPC semantics (write-ahead in_flight + leases).
 * C1: hooks are wired by setup() to the fake CI lock (elm_claim_process takes the lock; the
 * guard trigger requires a live lock to start S2 / a retry; the settle trigger runs after every
 * status change).
 */
function createFakeElmRepo(now) {
  const rows = new Map();
  const lateResults = [];
  const stepAttempts = [];
  const calls = [];
  let seq = 0;
  const flags = { failFinishS1: false };
  const hooks = { lockTry: null, settle: null, hasLiveLock: null };
  function byId(id) {
    for (const r of rows.values()) if (r.id === id) return r;
    return null;
  }
  const settle = (czId) => (hooks.settle ? hooks.settle(czId) : null);
  const liveLock = (r) => (hooks.hasLiveLock ? hooks.hasLiveLock(r.cz_solicitud_id, Number(r.ci)) : true);
  return {
    rows,
    lateResults,
    stepAttempts,
    calls,
    flags,
    hooks,
    /** Same effect as elm_resolve_process on the row (the settle trigger runs in the same tx). */
    resolveOps(czId, code) {
      const r = rows.get(czId);
      Object.assign(r, { ops_resolved_at: iso(now()), ops_resolution_code: code });
      settle(czId);
    },
    async loadSolicitudContext() {
      calls.push('loadSolicitudContext');
      return { solicitud: null, grantedRow: null };
    },
    async resolveBaseLabel(czId, jt) {
      calls.push('resolveBaseLabel');
      return jt === 'JT-BASE' ? 'BASE_TEST' : '';
    },
    async getProcessByCzId(czId) {
      await tick();
      const r = rows.get(czId);
      return r ? Object.assign({}, r) : null;
    },
    async claimProcess(a) {
      await tick();
      const existing = rows.get(a.czSolicitudId);
      if (existing) return { claimed: false, process: Object.assign({}, existing) };
      if (hooks.lockTry) {
        const lock = hooks.lockTry({ ci: Number(a.ci), czSolicitudId: a.czSolicitudId, triggerOrigin: a.triggerOrigin });
        if (lock.status === 'blocked') return { claimed: false, process: null, blocked: lock };
      }
      seq += 1;
      const row = {
        id: 'proc-' + seq,
        cz_solicitud_id: a.czSolicitudId,
        ci: a.ci,
        source_brand: a.sourceBrand,
        commercial_origin: a.commercialOrigin || null,
        trigger_origin: a.triggerOrigin,
        triggered_by_user_id: a.triggeredByUserId,
        s1_status: S1.IN_FLIGHT,
        s1_attempts: 1,
        s1_request: a.s1Request,
        s1_error_code: null,
        s1_result_message: null,
        s1_started_at: iso(now()),
        s1_completed_at: null,
        s1_lease_expires_at: iso(now() + a.leaseSeconds * 1000),
        s2_status: S2.NOT_STARTED,
        s2_attempts: 0,
        s2_error_code: null,
        s2_result_message: null,
        s2_completed_at: null,
        s2_lease_expires_at: null,
        referred_at: null,
        provider_status: null,
        disbursed_at: null,
        ops_resolved_at: null,
        ops_resolution_code: null,
      };
      rows.set(a.czSolicitudId, row);
      return { claimed: true, process: Object.assign({}, row) };
    },
    async finishS1(id, result) {
      await tick();
      if (flags.failFinishS1) throw new Error('db down');
      const r = byId(id);
      if (!r || r.s1_status !== S1.IN_FLIGHT) return null;
      Object.assign(r, {
        s1_status: result.status,
        s1_error_code: result.errorCode || null,
        s1_result_message: result.resultMessage != null ? result.resultMessage : null,
        s1_completed_at: iso(now()),
        s1_lease_expires_at: null,
      });
      settle(r.cz_solicitud_id);
      return Object.assign({}, r);
    },
    async beginS2(czId, req, leaseSeconds) {
      await tick();
      const r = rows.get(czId);
      if (!r || r.s1_status !== S1.ELIGIBLE || r.s2_status !== S2.NOT_STARTED) return null;
      if (!liveLock(r)) throw new Error('elm_ci_lock_required');
      Object.assign(r, {
        s2_status: S2.IN_FLIGHT,
        s2_attempts: 1,
        s2_request: req,
        s2_lease_expires_at: iso(now() + leaseSeconds * 1000),
      });
      settle(czId);
      return Object.assign({}, r);
    },
    async finishS2(id, result) {
      await tick();
      const r = byId(id);
      if (!r || r.s2_status !== S2.IN_FLIGHT) return null;
      Object.assign(r, {
        s2_status: result.status,
        s2_error_code: result.errorCode || null,
        s2_result_message: result.resultMessage != null ? result.resultMessage : null,
        s2_completed_at: iso(now()),
        s2_lease_expires_at: null,
        referred_at: result.status === S2.REFERRED ? iso(now()) : null,
      });
      settle(r.cz_solicitud_id);
      return Object.assign({}, r);
    },
    /**
     * Mirrors elm_retry_step: one atomic check-and-set under the live CI lock; archives the failed
     * attempt. S1 BCU error: only attempt 1, only 24 h after the error (max / codes ignored).
     */
    async retryStep(a) {
      calls.push('retryStep');
      await tick();
      const r = rows.get(a.czSolicitudId);
      if (!r || r.ops_resolved_at || !liveLock(r)) return null;
      const st = a.step;
      if (r[st + '_status'] !== 'technical_error' || r[st + '_attempts'] !== a.expectedAttempts) return null;
      const code = r[st + '_error_code'];
      const allowed =
        st === 's1' && code === 'elm_provider_bcu_error'
          ? r.s1_attempts === 1 && r.s1_completed_at && now() >= Date.parse(r.s1_completed_at) + 24 * 3600 * 1000
          : r[st + '_attempts'] < a.maxAttempts && code && Array.from(a.retrySafeErrorCodes || []).includes(code);
      if (!allowed) return null;
      stepAttempts.push({
        cz_solicitud_id: r.cz_solicitud_id,
        step: st,
        attempt_no: r[st + '_attempts'],
        status: r[st + '_status'],
        error_code: code,
        result_message: r[st + '_result_message'],
        started_at: r[st + '_started_at'] || null,
        completed_at: r[st + '_completed_at'],
      });
      Object.assign(r, {
        [st + '_status']: 'in_flight',
        [st + '_attempts']: r[st + '_attempts'] + 1,
        [st + '_error_code']: null,
        [st + '_result_message']: null,
        [st + '_completed_at']: null,
        [st + '_started_at']: iso(now()),
        [st + '_lease_expires_at']: iso(now() + a.leaseSeconds * 1000),
      });
      settle(r.cz_solicitud_id);
      return Object.assign({}, r);
    },
    async expireStaleInFlight(czId) {
      await tick();
      const r = rows.get(czId);
      if (!r) return null;
      const t = now();
      if (r.s1_status === S1.IN_FLIGHT && Date.parse(r.s1_lease_expires_at) < t) {
        Object.assign(r, { s1_status: S1.UNKNOWN, s1_lease_expires_at: null });
      }
      if (r.s2_status === S2.IN_FLIGHT && Date.parse(r.s2_lease_expires_at) < t) {
        Object.assign(r, { s2_status: S2.UNKNOWN, s2_lease_expires_at: null });
      }
      settle(czId);
      return Object.assign({}, r);
    },
    async recordLateResult(args) {
      await tick();
      lateResults.push({ processId: args.processId, step: args.step, status: args.result.status });
      return { id: 'late-' + lateResults.length };
    },
  };
}

const MONTH_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Montevideo',
  year: 'numeric',
  month: '2-digit',
});
/** Same as elm_month_key(): calendar month in America/Montevideo. */
function monthKey(ms) {
  const parts = MONTH_FMT.formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return get('year') + '-' + get('month') + '-01';
}
const PRE_RECEPTION_CODES = ['elm_http_auth_rejected'];
const CZ_TRANSITIONS = ['12>13', '12>14', '12>3', '12>15', '13>3', '13>16', '14>13', '14>3', '14>16'];
const OUTCOME_TARGET = { referred: 13, manual_review: 14, already_referred: 15 };

/** Mirrors elm_process_reception(): none | in_progress | uncertain | received. */
function receptionOf(p, t) {
  if (!p || p.s1_status === S1.NOT_STARTED) return 'none';
  if (p.s1_status === S1.IN_FLIGHT) return Date.parse(p.s1_lease_expires_at) < t ? 'uncertain' : 'in_progress';
  if (p.s1_status === S1.UNKNOWN) {
    if (p.ops_resolution_code === 'provider_confirmed_not_received') return 'none';
    return p.ops_resolved_at ? 'received' : 'uncertain';
  }
  if (p.s1_status === 'technical_error' && PRE_RECEPTION_CODES.includes(p.s1_error_code)) return 'none';
  return 'received';
}

/** In-memory provider_fallback_requests with the 3A RPC semantics (claim is one sync block). */
function createFakeFallbackRepo(now, elmRepo) {
  const rows = new Map();
  const reviewCases = [];
  const calls = { claim: 0, reconcileLocks: 0, lateEvents: [] };
  let seq = 0;
  // C1 (migrations/20261010_provider_fallback_c1_events.sql), verified against PGlite in
  // scripts/db-local-provider-fallback-c1-pglite.js.
  const locks = [];
  const czState = new Map();
  const events = [];
  const conflicts = [];
  const flags = { failReconcile: false };
  const requestById = (id) => Array.from(rows.values()).find((x) => x.id === id) || null;
  const projected = (czId) => (czState.has(czId) ? czState.get(czId).projected_estado : null);

  function recordConflict(czId, code, type, target, dedupe) {
    if (conflicts.some((c) => c.dedupe_key === dedupe)) return;
    conflicts.push({ cz_solicitud_id: czId, conflict_code: code, attempted_type: type, attempted_target: target, dedupe_key: dedupe, status: 'open' });
  }

  function settle(czId) {
    const lock = locks.find((l) => l.cz_solicitud_id === czId && (l.state === 'reserved' || l.state === 'consumed'));
    if (!lock) return 'no_lock';
    if (lock.fallback_request_id != null) {
      const req = requestById(lock.fallback_request_id);
      if (req && req.outcome === 'pending') return 'request_open';
    }
    const est = projected(czId);
    const p = elmRepo.rows.get(czId) || null;
    const rec = receptionOf(p, now());
    if (
      lock.fallback_request_id == null &&
      lock.state === 'reserved' &&
      !(p && p.ops_resolved_at) &&
      (rec === 'in_progress' || (p && p.s1_status === S1.ELIGIBLE && [S2.NOT_STARTED, S2.IN_FLIGHT].includes(p.s2_status)))
    ) {
      return 'kept_reserved';
    }
    let target;
    let block = null;
    if ((p && p.disbursed_at) || est === 16) {
      // GRANTED closes only this solicitud: quota consumed, no block on later solicitudes.
      target = 'consumed';
    } else if (rec === 'in_progress' || rec === 'uncertain') {
      return 'kept_reserved';
    } else if (rec === 'none') {
      target = 'released';
    } else {
      target = 'consumed';
      if ((p && p.ops_resolved_at) || est === 3) block = null;
      else if (est === 13 || (p && p.s2_status === S2.REFERRED)) block = 'active_referral';
      else if (p && (p.s2_status === S2.UNKNOWN || p.s2_status === S2.IN_FLIGHT)) block = 'uncertain_referral';
    }
    if (lock.state === 'consumed' && target === 'released') {
      target = 'consumed';
      block = null;
    }
    if (lock.state === target && lock.block_reason === block) return 'unchanged';
    if (block && locks.some((l) => l !== lock && l.ci === lock.ci && l.block_reason)) {
      Object.assign(lock, { state: 'consumed', block_reason: null });
      recordConflict(czId, 'ci_lock_overlap', null, null, 'ci_lock_overlap:' + czId + ':' + block);
      return 'conflict';
    }
    Object.assign(lock, { state: target, block_reason: block });
    return target;
  }

  function emit(czId, type, target, sourceId, dedupe, extra) {
    const st = czState.get(czId);
    if (!st) return { status: 'no_state' };
    const dup = events.find((e) => e.dedupe_key === dedupe);
    if (dup) return { status: 'duplicate', event_id: dup.id, seq: dup.seq };
    if (conflicts.some((c) => c.dedupe_key === dedupe)) return { status: 'duplicate' };
    if (st.projected_estado === target) return { status: 'noop' };
    if (!CZ_TRANSITIONS.includes(st.projected_estado + '>' + target)) {
      recordConflict(czId, 'transition_not_allowed', type, target, dedupe);
      return { status: 'conflict' };
    }
    const e = Object.assign(
      {
        id: crypto.randomUUID(),
        cz_solicitud_id: czId,
        seq: st.last_seq + 1,
        event_type: type,
        from_estado: st.projected_estado,
        target_estado: target,
        outcome: null,
        reason_code: null,
        related_cz_solicitud_id: null,
        provider_status: null,
        provider_status_at: null,
        source_id: sourceId,
        dedupe_key: dedupe,
        delivery_status: 'pending',
        delivery_attempts: 0,
        cz_ack_result: null,
        created_at: iso(now()),
      },
      extra || {},
    );
    events.push(e);
    Object.assign(st, { projected_estado: target, last_seq: e.seq });
    settle(czId);
    return { status: 'emitted', event_id: e.id, seq: e.seq };
  }

  /** Same step as provider_fallback_finalize: CZ state at 12, outcome event, lock settle. */
  function afterFinalize(r) {
    if (!czState.has(r.cz_solicitud_id)) {
      czState.set(r.cz_solicitud_id, { projected_estado: 12, last_seq: 0, ci: r.ci });
    }
    emit(r.cz_solicitud_id, 'outcome', OUTCOME_TARGET[r.outcome] || 3, r.id, 'outcome:' + r.id, {
      outcome: r.outcome,
      reason_code: r.reason_code,
      related_cz_solicitud_id: r.related_cz_solicitud_id,
    });
    settle(r.cz_solicitud_id);
  }

  const liveLockOf = (czId) =>
    locks.find((l) => l.cz_solicitud_id === czId && (l.state === 'reserved' || l.state === 'consumed')) || null;
  const closedInCz = (p) => p.disbursed_at || [3, 16].includes(projected(p.cz_solicitud_id));

  /**
   * Mirrors elm_ci_lock_try, the single claim used by elm_ci_lock_acquire (fallback worker) and
   * elm_claim_process (every origin). Blocker order: referral, uncertain, in progress, month.
   * fallbackRequestId null = lock of another origin (LEFT JOIN semantics in SQL).
   */
  function tryLock(a) {
    const t = now();
    const month = monthKey(t);
    const ci = Number(a.ci);
    const self = Number(a.czSolicitudId);
    const held = liveLockOf(self);
    if (held) return { status: 'held', state: held.state, month_key: held.month_key };
    const sameCi = locks.filter((l) => l.ci === ci);
    const procs = Array.from(elmRepo.rows.values()).filter((p) => Number(p.ci) === ci && p.cz_solicitud_id !== self);
    const blocked = (block, related, extra) =>
      Object.assign({ status: 'blocked', block: block, related_cz_solicitud_id: related }, extra || {});
    const firstLock = (pred) => (sameCi.find(pred) || {}).cz_solicitud_id;
    const firstProc = (pred) => (procs.find(pred) || {}).cz_solicitud_id;
    const expired = (s, lease) => s === 'in_flight' && Date.parse(lease) < t;
    const live = (s, lease) => s === 'in_flight' && Date.parse(lease) >= t;
    let rel;

    rel =
      firstLock((l) => l.block_reason === 'active_referral') ||
      firstProc((p) => p.s2_status === S2.REFERRED && !p.ops_resolved_at && !closedInCz(p));
    if (rel) return blocked('active_referral', rel);
    rel =
      firstLock((l) => {
        const r = requestById(l.fallback_request_id);
        return l.block_reason === 'uncertain_referral' || (l.state === 'reserved' && r && r.outcome !== 'pending');
      }) ||
      firstProc(
        (p) =>
          !p.ops_resolved_at &&
          (p.s1_status === S1.UNKNOWN ||
            expired(p.s1_status, p.s1_lease_expires_at) ||
            ((p.s2_status === S2.UNKNOWN || expired(p.s2_status, p.s2_lease_expires_at)) && !closedInCz(p))),
      );
    if (rel) return blocked('uncertain', rel);
    rel =
      firstLock((l) => {
        const r = requestById(l.fallback_request_id);
        return l.state === 'reserved' && (!r || r.outcome === 'pending');
      }) || firstProc((p) => live(p.s1_status, p.s1_lease_expires_at) || live(p.s2_status, p.s2_lease_expires_at));
    if (rel) return blocked('send_in_progress', rel);
    rel =
      firstLock((l) => l.state === 'consumed' && l.month_key === month) ||
      firstProc(
        (p) =>
          p.s1_started_at &&
          monthKey(Date.parse(p.s1_started_at)) === month &&
          receptionOf(p, t) === 'received' &&
          !liveLockOf(p.cz_solicitud_id),
      );
    if (rel) return blocked('monthly_quota_used', rel, { month_key: month });
    const lock = {
      ci: ci,
      month_key: month,
      cz_solicitud_id: self,
      fallback_request_id: a.fallbackRequestId || null,
      trigger_origin: a.triggerOrigin,
      state: 'reserved',
      block_reason: null,
    };
    locks.push(lock);
    return { status: 'acquired', state: 'reserved', month_key: month };
  }
  function acquire(a) {
    const req = requestById(a.fallbackRequestId);
    if (!req || req.cz_solicitud_id !== Number(a.czSolicitudId) || Number(req.ci) !== Number(a.ci)) {
      throw new Error('elm_ci_lock_request_mismatch');
    }
    return tryLock(Object.assign({}, a, { triggerOrigin: 'cz_automatic' }));
  }
  /** elm_claim_process: links the fallback request of the solicitud when there is one. */
  function lockForClaim(a) {
    const req = rows.get(a.czSolicitudId);
    const reqId = req && Number(req.ci) === Number(a.ci) ? req.id : null;
    return tryLock(Object.assign({}, a, { fallbackRequestId: reqId }));
  }
  const open = (r) => r.exec_status === 'queued' || r.exec_status === 'running';
  const sorted = () => Array.from(rows.values()).sort((a, b) => a._seq - b._seq);
  const view = (r) => {
    const o = Object.assign({}, r);
    delete o._seq;
    return o;
  };
  return {
    rows,
    reviewCases,
    calls,
    async enqueue(a) {
      await tick();
      const existing = rows.get(a.czSolicitudId);
      if (existing) {
        return { created: false, conflict: existing.snapshot_hash !== a.snapshotHash, request: view(existing) };
      }
      seq += 1;
      const row = {
        _seq: seq,
        id: 'req-' + seq,
        cz_solicitud_id: a.czSolicitudId,
        ci: a.ci,
        provider: 'elm',
        snapshot: a.snapshot,
        snapshot_hash: a.snapshotHash,
        exec_status: 'queued',
        run_after: iso(now()),
        job_lease_owner: null,
        job_lease_expires_at: null,
        claim_count: 0,
        not_started_attempts: 0,
        last_defer_reason: null,
        outcome: 'pending',
        reason_code: null,
        reason_detail: null,
        elm_process_id: null,
        related_cz_solicitud_id: null,
        finalized_at: null,
        cz_delivery_status: 'not_ready',
        cz_acked_at: null,
      };
      rows.set(a.czSolicitudId, row);
      return { created: true, conflict: false, request: view(row) };
    },
    async claim(a) {
      calls.claim += 1;
      await tick();
      const t = now();
      const all = sorted();
      const out = [];
      for (const r of all) {
        if (out.length >= a.limit) break;
        if (a.czSolicitudId != null && r.cz_solicitud_id !== a.czSolicitudId) continue;
        const due =
          (r.exec_status === 'queued' && Date.parse(r.run_after) <= t) ||
          (r.exec_status === 'running' && Date.parse(r.job_lease_expires_at) < t);
        if (!due) continue;
        if (all.some((o) => o.ci === r.ci && o.id !== r.id && open(o) && o._seq < r._seq)) continue;
        if (all.some((o) => o.ci === r.ci && o.id !== r.id && o.exec_status === 'running')) {
          throw new Error('unique running per CI violated');
        }
        Object.assign(r, {
          exec_status: 'running',
          job_lease_owner: a.workerId,
          job_lease_expires_at: iso(t + a.leaseSeconds * 1000),
          claim_count: r.claim_count + 1,
        });
        out.push(view(r));
      }
      return out;
    },
    async defer(a) {
      await tick();
      const r = Array.from(rows.values()).find((x) => x.id === a.id);
      if (!r || r.exec_status !== 'running' || r.job_lease_owner !== a.workerId) return null;
      Object.assign(r, {
        exec_status: 'queued',
        job_lease_owner: null,
        job_lease_expires_at: null,
        run_after: iso(now() + a.delaySeconds * 1000),
        not_started_attempts: r.not_started_attempts + (a.notStarted ? 1 : 0),
        last_defer_reason: a.reason,
      });
      return view(r);
    },
    async finalize(a) {
      await tick();
      const r = Array.from(rows.values()).find((x) => x.id === a.id);
      // Same checks as the 3B RPC: manual_review requires SLA, other outcomes reject it.
      if (a.outcome === 'manual_review') {
        if (!['urgent', 'high', 'normal', 'low'].includes(a.reviewPriority) || !(a.reviewDueSeconds >= 60)) {
          throw new Error('provider_fallback_review_sla_required');
        }
      } else if (a.reviewPriority != null || a.reviewDueSeconds != null) {
        throw new Error('provider_fallback_review_sla_only_for_manual_review');
      }
      if (!r || r.exec_status !== 'running' || r.job_lease_owner !== a.workerId || r.outcome !== 'pending') {
        return null;
      }
      Object.assign(r, {
        exec_status: 'done',
        job_lease_owner: null,
        job_lease_expires_at: null,
        outcome: a.outcome,
        reason_code: a.reasonCode,
        reason_detail: a.reasonDetail,
        elm_process_id: a.elmProcessId,
        related_cz_solicitud_id: a.relatedCzSolicitudId,
        finalized_at: iso(now()),
        cz_delivery_status: 'pending',
      });
      if (a.outcome === 'manual_review') {
        reviewCases.push({
          fallback_request_id: r.id,
          cz_solicitud_id: r.cz_solicitud_id,
          reason_code: a.reasonCode,
          priority: a.reviewPriority,
          due_at: iso(now() + a.reviewDueSeconds * 1000),
          status: 'open',
          assigned_to: null,
        });
      }
      afterFinalize(r);
      return view(r);
    },
    async getReviewStatusByRequestIds(ids) {
      await tick();
      const out = new Map();
      for (const c of reviewCases) if (ids.includes(c.fallback_request_id)) out.set(c.fallback_request_id, c);
      return out;
    },
    async countReviewAlerts(nowIso) {
      await tick();
      const open = reviewCases.filter((c) => c.status === 'open');
      return {
        open: open.length,
        unassigned: open.filter((c) => !c.assigned_to).length,
        overdue: open.filter((c) => Date.parse(c.due_at) < Date.parse(nowIso)).length,
      };
    },
    async getStatusByCzId(czId) {
      await tick();
      const r = rows.get(czId);
      return r ? view(r) : null;
    },
    async listPendingDeliveries(limit) {
      await tick();
      return sorted().filter((r) => r.cz_delivery_status === 'pending').slice(0, limit).map(view);
    },
    async ack(czId, outcome) {
      await tick();
      const r = rows.get(czId);
      if (!r) return { status: 'not_found' };
      if (r.outcome === 'pending') return { status: 'not_final' };
      if (r.outcome !== outcome) return { status: 'outcome_mismatch' };
      if (r.cz_delivery_status === 'acked') return { status: 'already_acked', acked_at: r.cz_acked_at };
      Object.assign(r, { cz_delivery_status: 'acked', cz_acked_at: iso(now()) });
      return { status: 'acked', acked_at: r.cz_acked_at };
    },
    async listElmProcessesByCi(ci) {
      await tick();
      return Array.from(elmRepo.rows.values())
        .filter((p) => Number(p.ci) === Number(ci))
        .map((p) => Object.assign({}, p, { cz_projected_estado: projected(p.cz_solicitud_id) }));
    },
    // --- C1 ---
    locks,
    czState,
    events,
    conflicts,
    flags,
    emit,
    lockForClaim,
    settleLock: settle,
    hasLiveLock: (czId, ci) => {
      const l = liveLockOf(czId);
      return Boolean(l && l.ci === ci);
    },
    async getCzStatesByCzIds(ids) {
      await tick();
      const out = new Map();
      for (const id of ids) {
        const s = czState.get(Number(id));
        if (s) out.set(Number(id), { cz_solicitud_id: Number(id), projected_estado: s.projected_estado, last_seq: s.last_seq });
      }
      return out;
    },
    async acquireCiLock(a) {
      await tick();
      return acquire(a);
    },
    async releaseUnstartedCiLock(czId) {
      await tick();
      const lock = locks.find((l) => l.cz_solicitud_id === czId && l.state === 'reserved');
      if (!lock) return { status: 'no_lock' };
      const p = elmRepo.rows.get(czId);
      if (p && p.s1_status !== S1.NOT_STARTED) return { status: 'process_exists' };
      lock.state = 'released';
      return { status: 'released' };
    },
    async reconcileCiLocks() {
      await tick();
      calls.reconcileLocks += 1;
      if (flags.failReconcile) throw new Error('db down');
      const counts = {};
      for (const l of locks.slice()) {
        const req = requestById(l.fallback_request_id);
        if (req && req.outcome === 'pending') continue;
        if (!(l.state === 'reserved' || l.block_reason != null)) continue;
        const out = settle(l.cz_solicitud_id);
        counts[out] = (counts[out] || 0) + 1;
      }
      return counts;
    },
    async reconcileLateEvents(statuses, limit) {
      await tick();
      calls.lateEvents.push({ statuses: Array.from(statuses), limit: limit });
      return {};
    },
    async listPendingEvents(limit) {
      await tick();
      const heads = events
        .filter((e) => e.delivery_status === 'pending')
        .filter((e) => !events.some((p) => p.cz_solicitud_id === e.cz_solicitud_id && p.seq < e.seq && p.delivery_status === 'pending'))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.cz_solicitud_id - b.cz_solicitud_id || a.seq - b.seq)
        .slice(0, limit);
      for (const e of heads) e.delivery_attempts += 1;
      return heads.map((e) => Object.assign({}, e));
    },
    async ackEvent(id, result) {
      await tick();
      if (!['applied', 'not_applied', 'ignored'].includes(result)) return { status: 'invalid_result' };
      const e = events.find((x) => x.id === id);
      if (!e) return { status: 'not_found' };
      if (e.delivery_status === 'acked') return { status: 'already_acked', result: e.cz_ack_result, seq: e.seq };
      if (events.some((p) => p.cz_solicitud_id === e.cz_solicitud_id && p.seq < e.seq && p.delivery_status === 'pending')) {
        return { status: 'out_of_order', seq: e.seq };
      }
      Object.assign(e, { delivery_status: 'acked', cz_ack_result: result });
      return { status: 'acked', result: result, seq: e.seq };
    },
  };
}

/** ELM client double. Default answer positive; per-docNumber scripts; counts every call. */
function createFakeClient() {
  const calls = { s1: [], s2: [] };
  const script = { s1: new Map(), s2: new Map() };
  async function answer(step, payload) {
    calls[step].push(payload);
    const s = script[step].get(payload.docNumber);
    if (typeof s === 'function') return s(payload);
    return s || { outcome: 'positive', httpStatus: 200, resultMessage: 'ok', latencyMs: 5 };
  }
  return {
    enabled: true,
    calls,
    script,
    service1: (p) => answer('s1', p),
    service2: (p) => answer('s2', p),
  };
}

function setup(opts) {
  const o = opts || {};
  const clock = { t: T0 };
  const now = () => clock.t;
  const logger = createLogger();
  const elmRepo = createFakeElmRepo(now);
  const repo = createFakeFallbackRepo(now, elmRepo);
  Object.assign(elmRepo.hooks, { lockTry: repo.lockForClaim, settle: repo.settleLock, hasLiveLock: repo.hasLiveLock });
  const client = o.client || createFakeClient();
  const elmConfig = o.elmConfig || ELM_CONFIG;
  const config = readProviderFallbackConfig(Object.assign({}, ALL_ON, o.env || {}), elmConfig);
  const orchestrator = createElmOrchestrator({
    repository: elmRepo,
    client: client,
    config: elmConfig,
    logger: logger,
    now: now,
    enabledTriggerOrigins:
      o.czAutomatic === false ? ['janus_manual'] : ['janus_manual', 'cz_automatic'],
  });
  const mk = (prefix) =>
    createProviderFallbackWorker({
      repository: repo,
      elmRepository: elmRepo,
      orchestrator: orchestrator,
      config: config,
      logger: logger,
      now: now,
      workerIdPrefix: prefix,
    });
  return { clock, now, logger, elmRepo, repo, client, config, orchestrator, mk };
}

function startBody(czId, ci, overrides) {
  return Object.assign(
    {
      cz_solicitud_id: czId,
      from_api: false,
      lrw_id: 'LRW-' + czId,
      jt: 'JT-BASE',
      cz_estado_id: 12,
      applicant: {
        ci: String(ci),
        nombre: 'Ana',
        apellido: 'Prueba',
        fecha_nacimiento: '1991-07-10',
        relacion_laboral: 'EPR',
        salario: 30000,
        celular: '59899123456',
        email: 'ana@example.test',
      },
    },
    overrides || {},
  );
}

async function enqueue(env, czId, ci, overrides) {
  const p = parseStartBody(startBody(czId, ci, overrides));
  assert.ok(p.value, 'fixture must parse: ' + JSON.stringify(p));
  return env.repo.enqueue({
    czSolicitudId: p.value.czSolicitudId,
    ci: p.value.ci,
    snapshot: p.value.snapshot,
    snapshotHash: p.value.snapshotHash,
  });
}

/** Simulates a worker that claimed the job and then died (process restart). */
async function claimAndDie(env, czId) {
  const jobs = await env.repo.claim({
    workerId: 'dead-worker',
    leaseSeconds: env.config.jobLeaseSeconds,
    limit: 1,
    czSolicitudId: czId,
  });
  assert.strictEqual(jobs.length, 1);
  return jobs[0];
}

function pastJobLease(env) {
  env.clock.t += env.config.jobLeaseSeconds * 1000 + 1000;
}

const job = (env, czId) => env.repo.rows.get(czId);

// ---------------------------------------------------------------------------
// HTTP helpers (loopback only)
// ---------------------------------------------------------------------------

function startServer(router) {
  const app = express();
  app.use(
    '/internal/providers',
    express.json({ limit: '8kb', verify: miplanHandoff.attachRawBody }),
    router,
    miplanHandoff.jsonErrorHandler,
  );
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function post(server, pathName, body, opts) {
  const o = opts || {};
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const ts = String(o.ts != null ? o.ts : Math.floor(Date.now() / 1000));
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) };
  if (o.sign !== false) {
    headers['x-janus-timestamp'] = ts;
    headers['x-janus-signature'] = signProviderFallbackPayload(o.secret || HMAC_SECRET, ts, raw);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method: 'POST', path: pathName, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, body: json, text: data });
        });
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
}

// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('flags default OFF; ELM client stays disabled', async () => {
  const cfg = readProviderFallbackConfig({}, ELM_CONFIG);
  assert.strictEqual(cfg.startEnabled, false);
  assert.strictEqual(cfg.workerEnabled, false);
  assert.strictEqual(cfg.czAutomaticEnabled, false);
  assert.strictEqual(cfg.immediateKickEnabled, false);
  assert.ok(cfg.jobLeaseSeconds >= 2 * ELM_CONFIG.inFlightLeaseSeconds + 120, 'job lease outlives S1+S2 leases');
  assert.strictEqual(createElmClient().enabled, false);

  const env = setup({ env: { PROVIDER_FALLBACK_WORKER_ENABLED: 'false' } });
  await enqueue(env, 1, 11111111);
  const out = await env.mk('w').runOnce();
  assert.deepStrictEqual(out, { ok: true, skipped: 'worker_disabled' });
  assert.strictEqual(env.repo.calls.claim, 0);
  assert.strictEqual(env.mk('w').kick(1), false);
});

test('two concurrent workers: each solicitud evaluated once, same-CI newer waits', async () => {
  const env = setup();
  for (let i = 1; i <= 6; i += 1) await enqueue(env, 100 + i, 10000000 + i);
  await enqueue(env, 201, 55555555);
  await enqueue(env, 202, 55555555);
  const [a, b] = await Promise.all([env.mk('A').runOnce({ limit: 10 }), env.mk('B').runOnce({ limit: 10 })]);
  assert.strictEqual(a.claimed + b.claimed, 7, 'every claimable job claimed exactly once');
  const s1Docs = env.client.calls.s1.map((p) => p.docNumber).sort();
  assert.strictEqual(new Set(s1Docs).size, s1Docs.length, 'no duplicate S1');
  assert.strictEqual(env.client.calls.s1.length, 7);
  assert.strictEqual(env.client.calls.s2.length, 7);
  for (let i = 1; i <= 6; i += 1) assert.strictEqual(job(env, 100 + i).outcome, OUTCOME.REFERRED);
  assert.strictEqual(job(env, 201).outcome, OUTCOME.REFERRED);
  assert.strictEqual(job(env, 202).exec_status, 'queued', 'newer of same CI not claimed while older open');

  const again = await Promise.all([env.mk('C').runOnce(), env.mk('D').runOnce()]);
  assert.strictEqual(again[0].claimed + again[1].claimed, 1);
  assert.strictEqual(job(env, 202).outcome, OUTCOME.ALREADY_REFERRED);
  assert.strictEqual(job(env, 202).reason_code, REASONS.CI_ACTIVE_REFERRAL);
  assert.strictEqual(job(env, 202).related_cz_solicitud_id, 201);
  assert.strictEqual(env.client.calls.s1.length, 7, 'nothing sent for the duplicate CI');
});

test('double start of the same solicitud: one job, one evaluation', async () => {
  const env = setup({ env: { PROVIDER_FALLBACK_IMMEDIATE_KICK_ENABLED: 'true' } });
  const worker = env.mk('kick');
  const router = createProviderFallbackRouter({
    repository: env.repo,
    getWorker: () => worker,
    config: env.config,
    logger: env.logger,
  });
  const server = await startServer(router);
  try {
    const body = startBody(300, 30000000);
    const [r1, r2] = await Promise.all([
      post(server, '/internal/providers/v1/fallback/start', body),
      post(server, '/internal/providers/v1/fallback/start', body),
    ]);
    assert.deepStrictEqual([r1.status, r2.status].sort(), [200, 202]);
    assert.strictEqual(env.repo.rows.size, 1);
    const changed = startBody(300, 30000000, { lrw_id: 'LRW-OTHER' });
    const r3 = await post(server, '/internal/providers/v1/fallback/start', changed);
    assert.strictEqual(r3.status, 409);
    assert.strictEqual(r3.body.error, 'snapshot_conflict');
    for (let i = 0; i < 20 && job(env, 300).outcome === 'pending'; i += 1) await tick();
    assert.strictEqual(job(env, 300).outcome, OUTCOME.REFERRED);
    assert.strictEqual(env.client.calls.s1.length, 1);
    assert.strictEqual(env.client.calls.s2.length, 1);
    const r4 = await post(server, '/internal/providers/v1/fallback/start', body);
    assert.strictEqual(r4.status, 200);
    assert.strictEqual(r4.body.request.outcome, OUTCOME.REFERRED);
    assert.strictEqual(env.client.calls.s1.length, 1, 'start after final never re-sends');
    for (const r of [r1, r2, r3, r4]) {
      assert.ok(!/applicant|ana@example|59899123456|30000000/.test(r.text), 'no PII/snapshot in responses');
    }
  } finally {
    server.close();
  }
});

test('restart before S1 started: reclaimed and sent once', async () => {
  const env = setup();
  await enqueue(env, 400, 40000000);
  await claimAndDie(env, 400);
  const early = await env.mk('B').runOnce();
  assert.strictEqual(early.claimed, 0, 'not reclaimable while the dead worker lease is valid');
  pastJobLease(env);
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 400).outcome, OUTCOME.REFERRED);
  assert.strictEqual(job(env, 400).claim_count, 2);
  assert.strictEqual(env.client.calls.s1.length, 1);
  assert.strictEqual(env.client.calls.s2.length, 1);
});

test('restart after S1 started (in_flight): never re-sent; lease expiry → unknown → manual_review', async () => {
  const env = setup();
  await enqueue(env, 500, 50000000);
  await claimAndDie(env, 500);
  // the dead worker had written S1 ahead (in_flight) and crashed before the answer
  await env.elmRepo.claimProcess({
    czSolicitudId: 500, ci: 50000000, sourceBrand: 'TestBrand', triggerOrigin: 'cz_automatic',
    triggeredByUserId: null, s1Request: { docNumber: '50000000' }, leaseSeconds: ELM_CONFIG.inFlightLeaseSeconds,
  });
  pastJobLease(env);
  await env.mk('B').runOnce();
  assert.strictEqual(env.elmRepo.rows.get(500).s1_status, S1.UNKNOWN);
  assert.strictEqual(job(env, 500).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 500).reason_code, REASONS.ELM_S1_UNKNOWN);
  assert.strictEqual(env.client.calls.s1.length, 0, 'unknown is never retried');
  pastJobLease(env);
  await env.mk('C').runOnce();
  assert.strictEqual(env.client.calls.s1.length, 0);
});

test('in_flight with a valid ELM lease: worker waits (no call), then unknown → manual_review', async () => {
  const env = setup();
  await enqueue(env, 510, 51000000);
  await env.elmRepo.claimProcess({
    czSolicitudId: 510, ci: 51000000, sourceBrand: 'TestBrand', triggerOrigin: 'cz_automatic',
    triggeredByUserId: null, s1Request: { docNumber: '51000000' }, leaseSeconds: ELM_CONFIG.inFlightLeaseSeconds,
  });
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 510).exec_status, 'queued');
  assert.strictEqual(job(env, 510).last_defer_reason, 'elm_in_flight');
  assert.strictEqual(job(env, 510).not_started_attempts, 0, 'started work never counts as not-started');
  assert.ok(Date.parse(job(env, 510).run_after) > Date.parse(env.elmRepo.rows.get(510).s1_lease_expires_at));
  env.clock.t += LEASE_MS + 10000;
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 510).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(env.client.calls.s1.length, 0);
});

test('restart after S1 eligible, before S2: S2 sent once', async () => {
  const env = setup();
  await enqueue(env, 520, 52000000);
  // the dead worker got S1 eligible and crashed right before S2
  const c = await env.elmRepo.claimProcess({
    czSolicitudId: 520, ci: 52000000, sourceBrand: 'TestBrand', triggerOrigin: 'cz_automatic',
    triggeredByUserId: null, s1Request: { docNumber: '52000000' }, leaseSeconds: ELM_CONFIG.inFlightLeaseSeconds,
  });
  await env.elmRepo.finishS1(c.process.id, { status: S1.ELIGIBLE });
  await claimAndDie(env, 520);
  pastJobLease(env);
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 520).outcome, OUTCOME.REFERRED);
  assert.strictEqual(env.client.calls.s1.length, 0, 'S1 not repeated');
  assert.strictEqual(env.client.calls.s2.length, 1);
});

test('restart after S2 started: never re-sent; unknown → manual_review', async () => {
  const env = setup();
  await enqueue(env, 530, 53000000);
  const c = await env.elmRepo.claimProcess({
    czSolicitudId: 530, ci: 53000000, sourceBrand: 'TestBrand', triggerOrigin: 'cz_automatic',
    triggeredByUserId: null, s1Request: { docNumber: '53000000' }, leaseSeconds: ELM_CONFIG.inFlightLeaseSeconds,
  });
  await env.elmRepo.finishS1(c.process.id, { status: S1.ELIGIBLE });
  await env.elmRepo.beginS2(530, { docNumber: '53000000' }, ELM_CONFIG.inFlightLeaseSeconds);
  await claimAndDie(env, 530);
  pastJobLease(env);
  await env.mk('B').runOnce();
  assert.strictEqual(env.elmRepo.rows.get(530).s2_status, S2.UNKNOWN);
  assert.strictEqual(job(env, 530).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 530).reason_code, REASONS.ELM_S2_UNKNOWN);
  assert.strictEqual(env.client.calls.s2.length, 0);
});

test('expired lease + late result: recorded for reconciliation, never applied', async () => {
  const env = setup();
  await enqueue(env, 600, 60000000);
  let release;
  env.client.script.s1.set('60000000', () => new Promise((r) => (release = r)));
  const runA = env.mk('A').runOnce();
  for (let i = 0; i < 50 && !release; i += 1) await tick();
  assert.ok(release, 'S1 call in progress');
  pastJobLease(env); // also past the S1 lease
  const b = await env.mk('B').runOnce();
  assert.strictEqual(b.claimed, 1);
  assert.strictEqual(job(env, 600).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 600).reason_code, REASONS.ELM_S1_UNKNOWN);
  release({ outcome: 'positive', httpStatus: 200, resultMessage: 'ok', latencyMs: 9 });
  const a = await runA;
  assert.strictEqual(a.lease_lost, 1, 'late worker cannot change the job');
  assert.strictEqual(env.elmRepo.rows.get(600).s1_status, S1.UNKNOWN, 'late result not applied');
  assert.deepStrictEqual(env.elmRepo.lateResults, [{ processId: 'proc-1', step: 's1', status: S1.ELIGIBLE }]);
  assert.strictEqual(job(env, 600).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(env.client.calls.s2.length, 0, 'no S2 after an unknown S1');
});

test('technical_error without proven-safe code → manual_review (specific reason), never retried', async () => {
  const env = setup();
  await enqueue(env, 610, 61000000);
  env.client.script.s1.set('61000000', { outcome: 'technical_error', httpStatus: 503, errorCode: 'x' });
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 610).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 610).reason_code, REASONS.ELM_S1_TECHNICAL_ERROR_RETRY_UNSAFE);
  assert.notStrictEqual(job(env, 610).outcome, OUTCOME.REJECTED, 'technical error is never a rejection');
  assert.strictEqual(env.repo.reviewCases.length, 1, 'review case registered with the outcome');
  pastJobLease(env);
  await env.mk('B').runOnce();
  assert.strictEqual(env.client.calls.s1.length, 1);
});

test('ELM negative answers → rejected only for documented definitive texts; others → manual_review', async () => {
  const env = setup();
  await enqueue(env, 620, 62000000);
  await enqueue(env, 621, 62100000);
  await enqueue(env, 622, 62200000);
  await enqueue(env, 623, 62300000);
  env.client.script.s1.set('62000000', { outcome: 'negative', httpStatus: 200, resultMessage: 'SCORE BAJO' });
  env.client.script.s2.set('62100000', { outcome: 'negative', httpStatus: 200, resultMessage: 'Documento no válido' });
  env.client.script.s2.set('62200000', { outcome: 'negative', httpStatus: 200, resultMessage: 'Lead no existe' });
  env.client.script.s1.set('62300000', { outcome: 'negative', httpStatus: 200, resultMessage: 'texto no documentado' });
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 620).outcome, OUTCOME.REJECTED);
  assert.strictEqual(job(env, 620).reason_code, REASONS.ELM_S1_REJECTED);
  assert.strictEqual(env.repo.czState.get(620).projected_estado, 3);
  assert.strictEqual(job(env, 621).outcome, OUTCOME.REJECTED);
  assert.strictEqual(job(env, 621).reason_code, REASONS.ELM_S2_REJECTED);
  assert.strictEqual(job(env, 622).outcome, OUTCOME.MANUAL_REVIEW, 'not a confirmed credit rejection');
  assert.strictEqual(job(env, 622).reason_code, REASONS.ELM_S2_REJECTION_NOT_DEFINITIVE);
  assert.strictEqual(env.repo.czState.get(622).projected_estado, 14);
  assert.strictEqual(job(env, 623).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 623).reason_code, REASONS.ELM_S1_REJECTION_NOT_DEFINITIVE);
  assert.deepStrictEqual(job(env, 623).reason_detail, { result_message: 'texto no documentado' });
});

test('technical_error / unknown / timeout / unmapped never become estado 3', async () => {
  const env = setup();
  const cases = [
    [631, { outcome: 'technical_error', httpStatus: 503, errorCode: 'elm_http_5xx' }],
    [632, { outcome: 'unknown', httpStatus: null, errorCode: 'elm_timeout' }],
    [633, () => { throw new Error('timeout after send'); }],
    [634, { outcome: 'technical_error', httpStatus: 200, resultMessage: 'respuesta nueva', errorCode: 'elm_unmapped_result' }],
  ];
  for (const [czId, answer] of cases) {
    await enqueue(env, czId, czId * 100000);
    env.client.script.s1.set(String(czId * 100000), answer);
  }
  await env.mk('A').runOnce({ limit: 10 });
  for (const [czId] of cases) {
    assert.strictEqual(job(env, czId).outcome, OUTCOME.MANUAL_REVIEW, czId + ': manual_review');
    assert.strictEqual(env.repo.czState.get(czId).projected_estado, 14, czId + ': CZ 14, never 3');
  }

  // Safety net before finalize: a rejection decision with a non-definitive reason is reviewed.
  const { DEFINITIVE_REJECTION_REASONS } = require('../src/services/providerFallback/constants');
  assert.ok(!DEFINITIVE_REJECTION_REASONS.includes(REASONS.ELM_S1_TECHNICAL_ERROR_RETRY_UNSAFE));
  assert.ok(!DEFINITIVE_REJECTION_REASONS.includes(REASONS.ELM_S1_UNKNOWN));
  assert.ok(DEFINITIVE_REJECTION_REASONS.includes(REASONS.ELM_S1_REJECTED));
  const src = readSrc('src/services/providerFallback/outcome.js');
  assert.ok(!/default:\s*return final\(OUTCOME\.REJECTED/.test(src), 'no default rejection in the outcome rules');
});

test('persist failure after the call: not counted as not-started; ends unknown → manual_review', async () => {
  const env = setup();
  await enqueue(env, 630, 63000000);
  env.elmRepo.flags.failFinishS1 = true;
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 630).last_defer_reason, 'elm_persist_failed');
  assert.strictEqual(job(env, 630).not_started_attempts, 0);
  env.elmRepo.flags.failFinishS1 = false;
  env.clock.t += LEASE_MS + 10000;
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 630).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(env.client.calls.s1.length, 1);
});

test('gates closed (cz_automatic off / send disabled): only proven not-started retries, bounded', async () => {
  const env = setup({ czAutomatic: false, env: { PROVIDER_FALLBACK_MAX_NOT_STARTED_ATTEMPTS: '2' } });
  await enqueue(env, 700, 70000000);
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 700).not_started_attempts, 1);
  assert.strictEqual(job(env, 700).last_defer_reason, 'not_started:' + CODES.TRIGGER_ORIGIN_NOT_ENABLED);
  env.clock.t += env.config.notStartedRetrySeconds * 1000 + 1000;
  await env.mk('A').runOnce();
  env.clock.t += env.config.notStartedRetrySeconds * 1000 + 1000;
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 700).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 700).reason_code, REASONS.NOT_STARTED_EXHAUSTED);
  assert.strictEqual(env.elmRepo.rows.size, 0, 'no ELM process created');
  assert.ok(env.repo.locks.length >= 1);
  assert.ok(env.repo.locks.every((l) => l.state === 'released'), 'C1: month reservation released when nothing started');

  const env2 = setup({ client: createElmClient() });
  await enqueue(env2, 701, 70100000);
  await env2.mk('A').runOnce();
  assert.strictEqual(job(env2, 701).last_defer_reason, 'not_started:' + CODES.SEND_DISABLED);
  assert.strictEqual(env2.elmRepo.rows.size, 0);
});

test('eligibility: data blockers → not_eligible; organic not blocked; unconfirmed config → manual_review', async () => {
  const env = setup();
  const noEmail = startBody(800, 80000000);
  noEmail.applicant.email = null;
  await enqueue(env, 800, 80000000, { applicant: noEmail.applicant });
  await enqueue(env, 801, 80100000, { jt: null });
  const badDob = startBody(803, 80300000);
  badDob.applicant.fecha_nacimiento = '0174-12-16';
  await enqueue(env, 803, 80300000, { applicant: badDob.applicant });
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 800).outcome, OUTCOME.NOT_ELIGIBLE);
  assert.strictEqual(job(env, 800).reason_code, CODES.MISSING_REQUIRED_FIELDS);
  assert.strictEqual(job(env, 803).outcome, OUTCOME.NOT_ELIGIBLE, 'impossible date of birth: same rule as missing data');
  assert.strictEqual(job(env, 803).reason_code, CODES.DATE_OF_BIRTH_INVALID);
  assert.strictEqual(env.elmRepo.rows.has(803), false, 'no ELM process for an impossible date of birth');
  assert.strictEqual(job(env, 801).outcome, OUTCOME.REFERRED, 'organic lead (no SMS base) is not blocked');
  assert.deepStrictEqual(env.client.calls.s1.map((p) => p.docNumber), ['80100000']);
  assert.strictEqual(env.client.calls.s1[0].source, 'copanel');
  assert.strictEqual(env.elmRepo.rows.get(801).commercial_origin, null);

  const noFormat = setup({ elmConfig: Object.assign({}, ELM_CONFIG, { dateOfBirthFormat: null }) });
  await enqueue(noFormat, 802, 80200000);
  await noFormat.mk('A').runOnce();
  assert.strictEqual(job(noFormat, 802).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(noFormat, 802).reason_code, REASONS.ELM_CONFIG_INCOMPLETE);
  assert.strictEqual(noFormat.client.calls.s1.length, 0);
});

test('payload comes from the CZ snapshot (mirror not synced yet)', async () => {
  const env = setup();
  await enqueue(env, 810, 81000000);
  await env.mk('A').runOnce();
  assert.strictEqual(env.client.calls.s1[0].docNumber, '81000000');
  assert.strictEqual(env.client.calls.s1[0].dateOfBirth, '10/7/1991');
  assert.strictEqual(env.client.calls.s2[0].mobilephone, '099123456');
  assert.strictEqual(env.elmRepo.rows.get(810).trigger_origin, 'cz_automatic');
  assert.ok(!('TrackingId' in env.client.calls.s1[0]), 'S1 carries no TrackingId');
  assert.strictEqual(env.client.calls.s2[0].TrackingId, '810', 'S2 TrackingId = cz_solicitud_id');
  assert.strictEqual(env.elmRepo.rows.get(810).commercial_origin, 'BASE_TEST');
  assert.ok(!env.elmRepo.calls.includes('loadSolicitudContext'), 'automatic flow never reads the mirror');
  const sol = snapshotToSolicitud(job(env, 810).snapshot);
  assert.strictEqual(sol.ci, 81000000);

  // C1: CZ only starts the fallback from 12 (en evaluación); 11 (CDV otorgado) never starts it.
  assert.strictEqual(parseStartBody(startBody(811, 81100000, { cz_estado_id: 11 })).error, 'cz_estado_not_evaluating');
  assert.strictEqual(parseStartBody(startBody(811, 81100000, { cz_estado_id: 3 })).error, 'cz_estado_not_evaluating');
  assert.strictEqual(parseStartBody(startBody(812, 1, { cz_estado_id: undefined })).error, 'invalid_cz_estado_id');
});

test('C1 a loan GRANTED in another solicitud of the CI does not block (credit evaluation is ELM\'s)', async () => {
  const env = setup();
  await enqueue(env, 811, 81100000);
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 811).outcome, OUTCOME.REFERRED);
  assert.strictEqual(env.client.calls.s1.length, 1);
  assert.strictEqual(REASONS.CI_CDV_LOAN_GRANTED, undefined);
  assert.strictEqual(REASONS.CI_ELM_LOAN_GRANTED, undefined);
  assert.strictEqual(CI_LOCK_BLOCK.GRANTED_ELM, undefined);
  assert.ok(!/findCdvGrantedForCi/.test(readSrc('src/services/providerFallback/worker.js')));
  assert.ok(!/findCdvGrantedForCi/.test(readSrc('src/services/providerFallback/repository.js')));
});

test('CI duplication guard: unknown / active referral (any provider status) / in_flight / rejected', async () => {
  const env = setup();
  const mkProc = async (czId, ci, s1, s2, extra) => {
    const c = await env.elmRepo.claimProcess({
      czSolicitudId: czId, ci: ci, sourceBrand: 'TestBrand', triggerOrigin: 'janus_manual',
      triggeredByUserId: 'u', s1Request: { docNumber: String(ci) }, leaseSeconds: ELM_CONFIG.inFlightLeaseSeconds,
    });
    if (s1 !== S1.IN_FLIGHT) await env.elmRepo.finishS1(c.process.id, { status: s1 });
    if (s2 && s2 !== S2.NOT_STARTED) {
      await env.elmRepo.beginS2(czId, { docNumber: String(ci) }, ELM_CONFIG.inFlightLeaseSeconds);
      if (s2 !== S2.IN_FLIGHT) await env.elmRepo.finishS2(c.process.id, { status: s2 });
    }
    Object.assign(env.elmRepo.rows.get(czId), extra || {});
  };
  await mkProc(900, 90000000, S1.UNKNOWN);
  await mkProc(910, 91000000, S1.ELIGIBLE, S2.REFERRED);
  await mkProc(920, 92000000, S1.ELIGIBLE, S2.REFERRED, { provider_status: 'rechazado' });
  await mkProc(930, 93000000, S1.IN_FLIGHT);
  await mkProc(940, 94000000, S1.REJECTED);
  const before = JSON.stringify(Array.from(env.elmRepo.rows.values()));
  await enqueue(env, 901, 90000000);
  await enqueue(env, 911, 91000000);
  await enqueue(env, 921, 92000000);
  await enqueue(env, 931, 93000000);
  await enqueue(env, 941, 94000000);
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 901).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 901).reason_code, REASONS.CI_PRIOR_UNKNOWN);
  assert.strictEqual(job(env, 911).outcome, OUTCOME.ALREADY_REFERRED);
  assert.strictEqual(job(env, 911).related_cz_solicitud_id, 910);
  // No automatic expiry: a provider status does not end the active referral.
  assert.strictEqual(job(env, 921).outcome, OUTCOME.ALREADY_REFERRED);
  assert.strictEqual(job(env, 921).reason_code, REASONS.CI_ACTIVE_REFERRAL);
  assert.strictEqual(job(env, 921).reason_detail.provider_status, 'rechazado');
  assert.strictEqual(job(env, 931).exec_status, 'queued');
  assert.strictEqual(job(env, 931).last_defer_reason, 'ci_other_in_flight');
  // C1: the rejected send was received by ELM this month → monthly quota used (no resend).
  assert.strictEqual(job(env, 941).outcome, OUTCOME.NOT_ELIGIBLE);
  assert.strictEqual(job(env, 941).reason_code, REASONS.CI_MONTHLY_QUOTA_USED);
  assert.strictEqual(job(env, 941).related_cz_solicitud_id, 940);
  assert.deepStrictEqual(env.client.calls.s1, []);
  const otherIds = [900, 910, 920, 930, 940];
  const after = JSON.parse(JSON.stringify(Array.from(env.elmRepo.rows.values()))).filter((p) => otherIds.includes(p.cz_solicitud_id));
  assert.deepStrictEqual(after, JSON.parse(before), 'other solicitudes never modified');

  env.clock.t += LEASE_MS + 10000;
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 931).outcome, OUTCOME.MANUAL_REVIEW, 'other in_flight expired → unknown → review');
  assert.strictEqual(job(env, 931).reason_code, REASONS.CI_PRIOR_UNKNOWN);
  assert.strictEqual(env.elmRepo.rows.get(930).s1_status, S1.IN_FLIGHT, 'guard only reads the other process');

  // A previous rejection does not block the next calendar month.
  env.clock.t = NOV_1_MVD;
  await enqueue(env, 942, 94000000);
  await env.mk('C').runOnce();
  assert.strictEqual(job(env, 942).outcome, OUTCOME.REFERRED, 'a previous rejection does not block next month');
  assert.deepStrictEqual(env.client.calls.s1.map((p) => p.docNumber), ['94000000']);
});

test('browser closed: start, cron worker, CZ polls pending, acks (duplicate ack idempotent)', async () => {
  const env = setup();
  const router = createProviderFallbackRouter({
    repository: env.repo,
    getWorker: () => env.mk('kick'),
    config: env.config,
    logger: env.logger,
  });
  const server = await startServer(router);
  try {
    const s = await post(server, '/internal/providers/v1/fallback/start', startBody(1000, 10000001));
    assert.strictEqual(s.status, 202);
    assert.strictEqual(s.body.request.outcome, 'pending');
    // browser gone; nothing else happens until the cron runs
    const st0 = await post(server, '/internal/providers/v1/fallback/status', { cz_solicitud_id: 1000 });
    assert.strictEqual(st0.body.request.outcome, 'pending');
    const p0 = await post(server, '/internal/providers/v1/fallback/deliveries/pending', {});
    assert.deepStrictEqual(p0.body.items, []);
    await env.mk('cron').runOnce();
    const st1 = await post(server, '/internal/providers/v1/fallback/status', { cz_solicitud_id: 1000 });
    assert.strictEqual(st1.body.request.outcome, OUTCOME.REFERRED);
    const p1 = await post(server, '/internal/providers/v1/fallback/deliveries/pending', { limit: 10 });
    assert.deepStrictEqual(p1.body.items.map((i) => [i.cz_solicitud_id, i.outcome]), [[1000, 'referred']]);

    const ackBody = { items: [{ cz_solicitud_id: 1000, outcome: 'referred' }] };
    const a1 = await post(server, '/internal/providers/v1/fallback/deliveries/ack', ackBody);
    const a2 = await post(server, '/internal/providers/v1/fallback/deliveries/ack', ackBody);
    assert.deepStrictEqual(a1.body.results, [{ cz_solicitud_id: 1000, status: 'acked' }]);
    assert.deepStrictEqual(a2.body.results, [{ cz_solicitud_id: 1000, status: 'already_acked' }]);
    const a3 = await post(server, '/internal/providers/v1/fallback/deliveries/ack', {
      items: [
        { cz_solicitud_id: 1000, outcome: 'rejected' },
        { cz_solicitud_id: 4242, outcome: 'rejected' },
        { cz_solicitud_id: 1000, outcome: 'pending' },
      ],
    });
    assert.deepStrictEqual(a3.body.results.map((r) => r.status), ['outcome_mismatch', 'not_found', 'invalid']);
    const p2 = await post(server, '/internal/providers/v1/fallback/deliveries/pending', {});
    assert.deepStrictEqual(p2.body.items, []);
    const st404 = await post(server, '/internal/providers/v1/fallback/status', { cz_solicitud_id: 777 });
    assert.strictEqual(st404.status, 404);
  } finally {
    server.close();
  }
});

test('routes: HMAC required, dedicated secret, flags, from_api excluded, body validation', async () => {
  const env = setup();
  const router = createProviderFallbackRouter({
    repository: env.repo,
    getWorker: () => env.mk('kick'),
    config: env.config,
    logger: env.logger,
  });
  const server = await startServer(router);
  const url = '/internal/providers/v1/fallback/start';
  try {
    assert.strictEqual((await post(server, url, startBody(1, 1), { sign: false })).status, 401);
    assert.strictEqual((await post(server, url, startBody(1, 1), { secret: 'wrong-secret' })).status, 401);
    assert.strictEqual((await post(server, url, startBody(1, 1), { ts: 1000 })).status, 401);
    const fromApi = await post(server, url, startBody(1, 1, { from_api: true }));
    assert.strictEqual(fromApi.status, 422);
    assert.strictEqual(fromApi.body.error, 'from_api_excluded');
    const notEvaluating = await post(server, url, startBody(1, 1, { cz_estado_id: 3 }));
    assert.strictEqual(notEvaluating.status, 422);
    assert.strictEqual(notEvaluating.body.error, 'cz_estado_not_evaluating');
    assert.strictEqual((await post(server, url, startBody(1, 1, { from_api: undefined }))).status, 400);
    assert.strictEqual((await post(server, url, startBody(0, 1))).status, 400);
    assert.strictEqual((await post(server, url, startBody(1, 'abc'))).status, 400);
    assert.strictEqual((await post(server, url, '{bad json')).status, 400);
    assert.strictEqual(env.repo.rows.size, 0);

    ENV.czProviderFallbackHmacSecret = ENV.czTrackingHmacSecret;
    assert.strictEqual((await post(server, url, startBody(1, 1), { secret: ENV.czTrackingHmacSecret })).status, 503, 'reused secret rejected');
    ENV.czProviderFallbackHmacSecret = null;
    assert.strictEqual((await post(server, url, startBody(1, 1))).status, 503);
  } finally {
    ENV.czProviderFallbackHmacSecret = HMAC_SECRET;
    server.close();
  }

  const off = setup({ env: { PROVIDER_FALLBACK_START_ENABLED: 'false' } });
  const server2 = await startServer(createProviderFallbackRouter({
    repository: off.repo, getWorker: () => off.mk('k'), config: off.config, logger: off.logger,
  }));
  try {
    const r = await post(server2, url, startBody(1, 1));
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error, 'fallback_disabled');
    assert.strictEqual(off.repo.rows.size, 0);
  } finally {
    server2.close();
  }
});

test('wiring: mounted before requireAuth; cron route admin/cron only; migration not applied by code', async () => {
  const app = readSrc('src/app.js');
  const mountAt = app.indexOf("'/internal/providers'");
  assert.ok(mountAt > 0 && mountAt < app.indexOf('app.use(requireAuth)'));
  const jobs = readSrc('src/routes/jobs.js');
  assert.match(jobs, /router\.post\('\/run-provider-fallback-worker', requireAdmin,/);
  const { resolveSectionForPath } = require('../src/middleware/dashboardSections');
  assert.strictEqual(resolveSectionForPath('/jobs/run-provider-fallback-worker'), 'preaprobados');
  const srcFiles = ['src/services/providerFallback/worker.js', 'src/services/providerFallback/repository.js', 'src/routes/providerFallback.js'];
  for (const f of srcFiles) {
    const s = readSrc(f);
    assert.ok(!/\.from\([^)]*\)\s*\.(insert|update|delete|upsert)\(/.test(s), f + ': no direct writes');
    assert.ok(!/setInterval\(/.test(s), f + ': no internal scheduler');
  }
  assert.ok(!/ENABLED_TRIGGER_ORIGINS = Object\.freeze\(\['janus_manual', 'cz_automatic'\]\)/.test(readSrc('src/services/elm/constants.js')));
});

// ---------------------------------------------------------------------------
// Fase 3B
// ---------------------------------------------------------------------------

const RETRY_ELM_CONFIG = readElmConfig({
  ELM_ACTIVITY_TYPE_MAP_JSON: '{"EPR":"TEST_ACTIVITY_EPR"}',
  ELM_DATE_OF_BIRTH_FORMAT: 'D/M/YYYY',
  ELM_MOBILE_PHONE_FORMAT: 'uy_local_0',
  ELM_RETRY_SAFE_ERROR_CODES: 'elm_test_safe_code',
  ELM_TECHNICAL_RETRY_MAX_ATTEMPTS: '3',
  ELM_TECHNICAL_RETRY_BACKOFF_SECONDS: '60',
  ELM_TECHNICAL_RETRY_BACKOFF_MAX_SECONDS: '600',
});
/** Test-only code configured as retry-safe (generic 3B rule; BCU has its own fixed policy). */
const SAFE_ERROR = { outcome: 'technical_error', httpStatus: 503, errorCode: 'elm_test_safe_code' };
const BCU_ERROR = { outcome: 'technical_error', httpStatus: 200, resultMessage: 'BCU error', errorCode: 'elm_provider_bcu_error' };

test('3B technical_error with proven-safe code: backoff, then same frozen request resent once', async () => {
  const env = setup({ elmConfig: RETRY_ELM_CONFIG });
  await enqueue(env, 1200, 12000000);
  let n = 0;
  env.client.script.s1.set('12000000', () => (++n === 1 ? SAFE_ERROR : { outcome: 'positive', httpStatus: 200, resultMessage: 'ok' }));
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 1200).exec_status, 'queued');
  assert.strictEqual(job(env, 1200).last_defer_reason, 'elm_technical_retry_backoff');
  assert.strictEqual(job(env, 1200).not_started_attempts, 0);
  assert.strictEqual(env.client.calls.s1.length, 1);
  await env.mk('A').runOnce();
  assert.strictEqual(env.client.calls.s1.length, 1, 'no resend before the backoff');
  env.clock.t += 61 * 1000 + env.config.inFlightPollGraceSeconds * 1000;
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 1200).outcome, OUTCOME.REFERRED);
  assert.strictEqual(env.client.calls.s1.length, 2);
  assert.deepStrictEqual(env.client.calls.s1[1], env.client.calls.s1[0], 'idempotent: same frozen payload');
  assert.strictEqual(env.elmRepo.rows.get(1200).s1_attempts, 2);
  assert.strictEqual(env.client.calls.s2.length, 1);
});

test('3B technical_error retries are bounded → manual_review retries_exhausted (never rejected)', async () => {
  const env = setup({ elmConfig: RETRY_ELM_CONFIG });
  await enqueue(env, 1210, 12100000);
  env.client.script.s1.set('12100000', SAFE_ERROR);
  for (let i = 0; i < 6; i += 1) {
    await env.mk('w' + i).runOnce();
    env.clock.t += 700 * 1000;
  }
  assert.strictEqual(job(env, 1210).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 1210).reason_code, REASONS.ELM_S1_TECHNICAL_ERROR_RETRIES_EXHAUSTED);
  assert.strictEqual(env.client.calls.s1.length, 3, 'max 3 attempts in total');
  assert.strictEqual(env.repo.reviewCases.length, 1);
});

test('3B unknown is never retried even when its error code is configured as safe', async () => {
  const cfg = Object.assign({}, RETRY_ELM_CONFIG, {
    retrySafeErrorCodes: Object.freeze(['elm_test_safe_code', CODES.CLIENT_THREW, CODES.LEASE_EXPIRED]),
  });
  const env = setup({ elmConfig: cfg });
  await enqueue(env, 1220, 12200000);
  env.client.script.s1.set('12200000', () => {
    throw new Error('socket hang up after send');
  });
  await env.mk('A').runOnce();
  env.clock.t += 3600 * 1000;
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 1220).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 1220).reason_code, REASONS.ELM_S1_UNKNOWN);
  assert.strictEqual(env.client.calls.s1.length, 1);
  assert.ok(!env.elmRepo.calls.includes('retryStep'));
});

test('3B S2 technical_error retried with the same request; concurrent retries send once', async () => {
  const env = setup({ elmConfig: RETRY_ELM_CONFIG });
  await enqueue(env, 1230, 12300000);
  let n = 0;
  env.client.script.s2.set('12300000', () => (++n === 1 ? Object.assign({}, SAFE_ERROR) : { outcome: 'positive', httpStatus: 200, resultMessage: 'ok' }));
  await env.mk('A').runOnce();
  assert.strictEqual(env.elmRepo.rows.get(1230).s2_status, S2.TECHNICAL_ERROR);
  env.clock.t += 120 * 1000;
  const ctx = { triggerOrigin: 'cz_automatic', solicitud: snapshotToSolicitud(job(env, 1230).snapshot) };
  const [r1, r2] = await Promise.all([
    env.orchestrator.retryElmStep(1230, ctx, { step: 's2', expectedAttempts: 1 }),
    env.orchestrator.retryElmStep(1230, ctx, { step: 's2', expectedAttempts: 1 }),
  ]);
  assert.deepStrictEqual([r1.ok, r2.ok].sort(), [false, true]);
  assert.strictEqual((r1.ok ? r2 : r1).code, CODES.RETRY_NOT_ALLOWED);
  assert.strictEqual(env.client.calls.s2.length, 2, 'original + exactly one retry');
  assert.deepStrictEqual(env.client.calls.s2[1], env.client.calls.s2[0]);
  assert.strictEqual(env.elmRepo.rows.get(1230).s2_status, S2.REFERRED);
  const stale = await env.orchestrator.retryElmStep(1230, ctx, { step: 's2', expectedAttempts: 1 });
  assert.strictEqual(stale.code, CODES.RETRY_NOT_ALLOWED);
  assert.strictEqual(env.client.calls.s2.length, 2);
});

test('3B CI guard ignores manually resolved processes; resolution never triggers a send', async () => {
  const env = setup();
  const c = await env.elmRepo.claimProcess({
    czSolicitudId: 1300, ci: 13000000, sourceBrand: 'copanel', triggerOrigin: 'janus_manual',
    triggeredByUserId: 'u', s1Request: { docNumber: '13000000' }, leaseSeconds: ELM_CONFIG.inFlightLeaseSeconds,
  });
  await env.elmRepo.finishS1(c.process.id, { status: S1.ELIGIBLE });
  await env.elmRepo.beginS2(1300, { docNumber: '13000000' }, ELM_CONFIG.inFlightLeaseSeconds);
  await env.elmRepo.finishS2(c.process.id, { status: S2.REFERRED });

  await enqueue(env, 1301, 13000000);
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 1301).outcome, OUTCOME.ALREADY_REFERRED);
  assert.strictEqual(job(env, 1301).related_cz_solicitud_id, 1300);
  assert.strictEqual(env.client.calls.s1.length, 0);

  // Audited manual resolution closes the active referral: B stays already_referred, nothing sent.
  env.elmRepo.resolveOps(1300, 'provider_closed_no_loan');
  env.clock.t += 3600 * 1000;
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 1301).outcome, OUTCOME.ALREADY_REFERRED, 'final outcome never reopened');
  assert.strictEqual(env.client.calls.s1.length, 0, 'resolution never sends automatically');

  // A NEW solicitud C of the same CI is no longer blocked by the referral, but the manual send
  // of A was received this month: C1 monthly quota. Next month it is sent.
  await enqueue(env, 1302, 13000000);
  await env.mk('C').runOnce();
  assert.strictEqual(job(env, 1302).outcome, OUTCOME.NOT_ELIGIBLE);
  assert.strictEqual(job(env, 1302).reason_code, REASONS.CI_MONTHLY_QUOTA_USED);
  assert.strictEqual(job(env, 1302).related_cz_solicitud_id, 1300);
  assert.strictEqual(env.client.calls.s1.length, 0);
  env.clock.t = NOV_1_MVD;
  await enqueue(env, 1303, 13000000);
  await env.mk('D').runOnce();
  assert.strictEqual(job(env, 1303).outcome, OUTCOME.REFERRED);
  assert.strictEqual(env.client.calls.s1.length, 1);
});

test('3B CZ view: already_referred is traceable; manual_review only with a registered case', async () => {
  const env = setup();
  const router = createProviderFallbackRouter({
    repository: env.repo,
    getWorker: () => env.mk('kick'),
    config: env.config,
    logger: env.logger,
  });
  const server = await startServer(router);
  try {
    await post(server, '/internal/providers/v1/fallback/start', startBody(1400, 14000000));
    await env.mk('A').runOnce();
    await post(server, '/internal/providers/v1/fallback/start', startBody(1401, 14000000));
    await env.mk('B').runOnce();
    const st = await post(server, '/internal/providers/v1/fallback/status', { cz_solicitud_id: 1401 });
    assert.strictEqual(st.body.request.outcome, OUTCOME.ALREADY_REFERRED);
    assert.strictEqual(st.body.request.related_cz_solicitud_id, 1400);
    assert.strictEqual(st.body.request.cz_estado_id_at_start, 12);
    assert.strictEqual(st.body.request.review, null);
    assert.strictEqual(st.body.request.projected_estado, 15, 'C1: derivación en otra solicitud');
    assert.strictEqual(st.body.request.last_event_seq, 1);
    const st0 = await post(server, '/internal/providers/v1/fallback/status', { cz_solicitud_id: 1400 });
    assert.strictEqual(st0.body.request.projected_estado, 13);

    env.client.script.s1.set('14100000', { outcome: 'technical_error', httpStatus: 503, errorCode: 'x' });
    await post(server, '/internal/providers/v1/fallback/start', startBody(1410, 14100000));
    await env.mk('C').runOnce();
    const pending = await post(server, '/internal/providers/v1/fallback/deliveries/pending', {});
    const mr = pending.body.items.find((i) => i.cz_solicitud_id === 1410);
    assert.strictEqual(mr.outcome, OUTCOME.MANUAL_REVIEW);
    assert.strictEqual(mr.review.status, 'open');
    assert.ok(mr.review.due_at);
    const ref = pending.body.items.find((i) => i.cz_solicitud_id === 1400);
    assert.strictEqual(ref.review, null);
    for (const item of pending.body.items) {
      if (item.outcome === OUTCOME.MANUAL_REVIEW) assert.ok(item.review, 'manual_review always has its case');
    }
    const ev = await post(server, '/internal/providers/v1/fallback/events/pending', {});
    const ev1410 = ev.body.items.find((i) => i.cz_solicitud_id === 1410);
    assert.deepStrictEqual([ev1410.type, ev1410.from_estado, ev1410.target_estado], ['outcome', 12, 14]);
    assert.strictEqual(ev1410.review.status, 'open', 'event into 14 carries its review case');
    assert.strictEqual(ev.body.items.find((i) => i.cz_solicitud_id === 1400).review, null);
  } finally {
    server.close();
  }
});

test('3B review SLA by reason; alerts for unassigned/overdue in cron summary + warning log', async () => {
  const env = setup({
    env: { PROVIDER_REVIEW_SLA_JSON: '{"default":{"priority":"low","hours":48},"elm_s1_technical_error_retry_unsafe":{"priority":"high","hours":2},"bad":{"priority":"x","hours":1}}' },
  });
  assert.deepStrictEqual(Object.keys(env.config.reviewSla).sort(), ['default', 'elm_s1_technical_error_retry_unsafe']);
  await enqueue(env, 1500, 15000000);
  env.client.script.s1.set('15000000', { outcome: 'technical_error', httpStatus: 503, errorCode: 'x' });
  const first = await env.mk('A').runOnce();
  assert.strictEqual(env.repo.reviewCases[0].priority, 'high');
  assert.strictEqual(Date.parse(env.repo.reviewCases[0].due_at) - env.now(), 2 * 3600 * 1000);
  assert.deepStrictEqual(first.review_alerts, { open: 1, unassigned: 1, overdue: 0 });
  env.clock.t += 3 * 3600 * 1000;
  const later = await env.mk('B').runOnce();
  assert.deepStrictEqual(later.review_alerts, { open: 1, unassigned: 1, overdue: 1 });
  assert.ok(env.logger.lines.some((l) => l.includes('provider review queue needs attention')));
  const dflt = readProviderFallbackConfig({}, ELM_CONFIG);
  assert.deepStrictEqual(dflt.reviewSla.default, { priority: 'normal', hours: 24 });
});

// ---------------------------------------------------------------------------
// C1: CZ events + monthly CI lock (SQL semantics verified in db-local-provider-fallback-c1-pglite.js)
// ---------------------------------------------------------------------------

test('C1 decideCiLock: lock result → worker decision', async () => {
  assert.deepStrictEqual(decideCiLock({ status: 'acquired' }), { kind: 'proceed' });
  assert.deepStrictEqual(decideCiLock({ status: 'held' }), { kind: 'proceed' });
  const b = (block, extra) => decideCiLock(Object.assign({ status: 'blocked', block: block, related_cz_solicitud_id: '77' }, extra || {}));
  const wait = b(CI_LOCK_BLOCK.SEND_IN_PROGRESS);
  assert.strictEqual(wait.kind, 'wait');
  assert.strictEqual(wait.relatedCzId, 77);
  const ref = b(CI_LOCK_BLOCK.ACTIVE_REFERRAL);
  assert.deepStrictEqual([ref.outcome, ref.reasonCode], [OUTCOME.ALREADY_REFERRED, REASONS.CI_ACTIVE_REFERRAL]);
  const unc = b(CI_LOCK_BLOCK.UNCERTAIN);
  assert.deepStrictEqual([unc.outcome, unc.reasonCode], [OUTCOME.MANUAL_REVIEW, REASONS.CI_PRIOR_UNKNOWN]);
  assert.strictEqual(b('granted_elm').outcome, OUTCOME.MANUAL_REVIEW, 'GRANTED is no longer a CI block');
  const quota = b(CI_LOCK_BLOCK.MONTHLY_QUOTA_USED, { month_key: '2026-10-01' });
  assert.deepStrictEqual([quota.outcome, quota.reasonCode], [OUTCOME.NOT_ELIGIBLE, REASONS.CI_MONTHLY_QUOTA_USED]);
  assert.strictEqual(quota.detail.month_key, '2026-10-01');
  assert.strictEqual(b('something_new').outcome, OUTCOME.MANUAL_REVIEW, 'unknown block → review, never a send');
  assert.strictEqual(decideCiLock(null).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(monthKey(NOV_1_MVD - 1000), '2026-10-01', 'Oct 31 23:59:59 in Montevideo');
  assert.strictEqual(monthKey(NOV_1_MVD), '2026-11-01');
});

test('C1 monthly CI lock: one effective send per CI per calendar month (America/Montevideo)', async () => {
  const env = setup();
  const CI = 21000000;
  env.client.script.s1.set(String(CI), { outcome: 'negative', httpStatus: 200, resultMessage: 'SCORE BAJO' });
  await enqueue(env, 2100, CI);
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 2100).outcome, OUTCOME.REJECTED);
  const l2100 = env.repo.locks.find((l) => l.cz_solicitud_id === 2100);
  assert.deepStrictEqual([l2100.state, l2100.block_reason, l2100.month_key], ['consumed', null, '2026-10-01'], 'ELM received it: quota consumed even though rejected');

  // Another solicitud of the same CI (e.g. rejected by CDV) in the same month: never resent.
  await enqueue(env, 2101, CI);
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 2101).outcome, OUTCOME.NOT_ELIGIBLE);
  assert.strictEqual(job(env, 2101).reason_code, REASONS.CI_MONTHLY_QUOTA_USED);
  assert.strictEqual(job(env, 2101).related_cz_solicitud_id, 2100);
  assert.strictEqual(job(env, 2101).reason_detail.month_key, '2026-10-01');
  assert.strictEqual(env.repo.czState.get(2101).projected_estado, 3);

  env.clock.t = NOV_1_MVD - 1000;
  await enqueue(env, 2102, CI);
  await env.mk('C').runOnce();
  assert.strictEqual(job(env, 2102).reason_code, REASONS.CI_MONTHLY_QUOTA_USED, 'still October in Montevideo');

  env.clock.t = NOV_1_MVD;
  env.client.script.s1.delete(String(CI));
  await enqueue(env, 2103, CI);
  await env.mk('D').runOnce();
  assert.strictEqual(job(env, 2103).outcome, OUTCOME.REFERRED, 'new calendar month');
  const l2103 = env.repo.locks.find((l) => l.cz_solicitud_id === 2103);
  assert.deepStrictEqual([l2103.state, l2103.block_reason, l2103.month_key], ['consumed', 'active_referral', '2026-11-01']);
  assert.strictEqual(env.repo.czState.get(2103).projected_estado, 13);

  // An active referral keeps blocking later months.
  env.clock.t = Date.parse('2026-12-15T15:00:00Z');
  await enqueue(env, 2104, CI);
  await env.mk('E').runOnce();
  assert.strictEqual(job(env, 2104).outcome, OUTCOME.ALREADY_REFERRED);
  assert.strictEqual(job(env, 2104).related_cz_solicitud_id, 2103);
  assert.strictEqual(env.repo.czState.get(2104).projected_estado, 15);
  assert.strictEqual(env.client.calls.s1.length, 2);

  // Referral closed as rejected (late event 13 → 3): the CI may be evaluated again in another month.
  assert.strictEqual(env.repo.emit(2103, 'late.rejected', 3, null, 'late:rejected:2103').status, 'emitted');
  assert.deepStrictEqual([l2103.state, l2103.block_reason], ['consumed', null]);
  await enqueue(env, 2105, CI);
  await env.mk('F').runOnce();
  assert.strictEqual(job(env, 2105).outcome, OUTCOME.REFERRED, 'December quota unused');
  assert.strictEqual(env.client.calls.s1.length, 3);
});

test('C1 technical failures: pre-reception error frees the month; uncertain keeps the reservation until reconciled', async () => {
  const env = setup();
  env.client.script.s1.set('22000000', { outcome: 'technical_error', httpStatus: 401, errorCode: 'elm_http_auth_rejected' });
  await enqueue(env, 2200, 22000000);
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 2200).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(env.repo.locks.find((l) => l.cz_solicitud_id === 2200).state, 'released', 'confirmed not received by ELM');
  env.client.script.s1.delete('22000000');
  await enqueue(env, 2201, 22000000);
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 2201).outcome, OUTCOME.REFERRED, 'same month, quota not consumed');

  env.client.script.s1.set('22100000', () => {
    throw new Error('socket hang up after send');
  });
  await enqueue(env, 2210, 22100000);
  await env.mk('C').runOnce();
  assert.strictEqual(job(env, 2210).reason_code, REASONS.ELM_S1_UNKNOWN);
  const l2210 = env.repo.locks.find((l) => l.cz_solicitud_id === 2210);
  assert.strictEqual(l2210.state, 'reserved', 'uncertain: reservation kept');
  await enqueue(env, 2211, 22100000);
  await env.mk('D').runOnce();
  assert.strictEqual(job(env, 2211).reason_code, REASONS.CI_PRIOR_UNKNOWN, 'blocked until reconciled');
  Object.assign(env.elmRepo.rows.get(2210), { ops_resolved_at: iso(env.now()), ops_resolution_code: 'provider_confirmed_not_received' });
  const cron = await env.mk('cron').runOnce();
  assert.strictEqual(cron.c1.locks.released, 1);
  assert.strictEqual(l2210.state, 'released');
  env.client.script.s1.delete('22100000');
  await enqueue(env, 2212, 22100000);
  await env.mk('E').runOnce();
  assert.strictEqual(job(env, 2212).outcome, OUTCOME.REFERRED);

  env.client.script.s1.set('22200000', () => {
    throw new Error('timeout after send');
  });
  await enqueue(env, 2220, 22200000);
  await env.mk('F').runOnce();
  Object.assign(env.elmRepo.rows.get(2220), { ops_resolved_at: iso(env.now()), ops_resolution_code: 'other' });
  await env.mk('cron').runOnce();
  assert.strictEqual(env.repo.locks.find((l) => l.cz_solicitud_id === 2220).state, 'consumed', 'resolved without proof of non-reception');
  await enqueue(env, 2221, 22200000);
  await env.mk('G').runOnce();
  assert.strictEqual(job(env, 2221).reason_code, REASONS.CI_MONTHLY_QUOTA_USED);
});

test('C1 concurrency: another open reservation of the CI → wait; parallel reservations → one wins', async () => {
  const env = setup();
  await enqueue(env, 2300, 23000000);
  await enqueue(env, 2301, 23000000);
  const held = await env.repo.acquireCiLock({ ci: 23000000, czSolicitudId: 2301, fallbackRequestId: job(env, 2301).id });
  assert.strictEqual(held.status, 'acquired');
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 2300).exec_status, 'queued');
  assert.strictEqual(job(env, 2300).last_defer_reason, 'ci_send_in_progress');
  assert.strictEqual(job(env, 2300).not_started_attempts, 0);
  assert.strictEqual(env.client.calls.s1.length, 0);

  await enqueue(env, 2310, 23100000);
  await enqueue(env, 2311, 23100000);
  const rs = await Promise.all([
    env.repo.acquireCiLock({ ci: 23100000, czSolicitudId: 2310, fallbackRequestId: job(env, 2310).id }),
    env.repo.acquireCiLock({ ci: 23100000, czSolicitudId: 2311, fallbackRequestId: job(env, 2311).id }),
    env.repo.acquireCiLock({ ci: 23100000, czSolicitudId: 2310, fallbackRequestId: job(env, 2310).id }),
  ]);
  assert.deepStrictEqual(rs.map((r) => r.status + (r.block ? ':' + r.block : '')), ['acquired', 'blocked:send_in_progress', 'held']);
  assert.strictEqual(env.repo.locks.filter((l) => l.ci === 23100000).length, 1);
});

test('C1 events (PULL): successive, duplicate, out of order, idempotent ACK, contradictory → conflict', async () => {
  const env = setup();
  const server = await startServer(
    createProviderFallbackRouter({ repository: env.repo, getWorker: () => env.mk('kick'), config: env.config, logger: env.logger }),
  );
  const EV = '/internal/providers/v1/fallback/events/';
  try {
    await post(server, '/internal/providers/v1/fallback/start', startBody(2400, 24000000));
    assert.deepStrictEqual((await post(server, EV + 'pending', {})).body.items, [], 'no event before the outcome');
    await env.mk('cron').runOnce();
    const p1 = await post(server, EV + 'pending', {});
    assert.strictEqual(p1.body.items.length, 1);
    const e1 = p1.body.items[0];
    assert.deepStrictEqual(
      [e1.cz_solicitud_id, e1.seq, e1.type, e1.from_estado, e1.target_estado, e1.outcome, e1.delivery_attempts],
      [2400, 1, 'outcome', 12, 13, OUTCOME.REFERRED, 1],
    );
    assert.ok(/^[0-9a-f-]{36}$/.test(e1.event_id) && e1.created_at);
    const again = await post(server, EV + 'pending', {});
    assert.strictEqual(again.body.items[0].event_id, e1.event_id, 'redelivered until acked');
    assert.strictEqual(again.body.items[0].delivery_attempts, 2);

    // Postback Convertido applied to the ELM process (1B), then the late reconcile emits 13 → 16.
    Object.assign(env.elmRepo.rows.get(2400), { provider_status: 'Convertido', disbursed_at: iso(env.now()) });
    const late = env.repo.emit(2400, 'late.granted', 16, null, 'late:granted:2400', { provider_status: 'Convertido' });
    assert.strictEqual(late.status, 'emitted');
    assert.strictEqual(env.repo.emit(2400, 'late.granted', 16, null, 'late:granted:2400').status, 'duplicate');
    assert.strictEqual(env.repo.events.length, 2, 'duplicate source produces no event');

    const head = await post(server, EV + 'pending', {});
    assert.deepStrictEqual(head.body.items.map((i) => i.seq), [1], 'seq 2 waits for the ACK of seq 1');
    const ooo = await post(server, EV + 'ack', { items: [{ event_id: late.event_id, result: 'applied' }] });
    assert.strictEqual(ooo.body.results[0].status, 'out_of_order');
    const a1 = await post(server, EV + 'ack', { items: [{ event_id: e1.event_id, result: 'applied' }] });
    const a1b = await post(server, EV + 'ack', { items: [{ event_id: e1.event_id, result: 'not_applied' }] });
    assert.deepStrictEqual(a1.body.results, [{ event_id: e1.event_id, status: 'acked', result: 'applied' }]);
    assert.deepStrictEqual(a1b.body.results, [{ event_id: e1.event_id, status: 'already_acked', result: 'applied' }], 'first ACK wins');
    const p2 = await post(server, EV + 'pending', {});
    assert.deepStrictEqual(p2.body.items.map((i) => [i.seq, i.type, i.from_estado, i.target_estado, i.provider_status]), [[2, 'late.granted', 13, 16, 'Convertido']]);
    const bad = await post(server, EV + 'ack', {
      items: [
        { event_id: late.event_id, result: 'ok' },
        { event_id: 'not-a-uuid', result: 'applied' },
        { event_id: crypto.randomUUID(), result: 'applied' },
      ],
    });
    assert.deepStrictEqual(bad.body.results.map((r) => r.status), ['invalid', 'invalid', 'not_found']);
    assert.strictEqual((await post(server, EV + 'ack', { items: [] })).status, 400);
    assert.strictEqual((await post(server, EV + 'pending', { limit: 201 })).status, 400);
    assert.strictEqual((await post(server, EV + 'ack', { items: [{ event_id: late.event_id, result: 'applied' }] })).body.results[0].status, 'acked');
    assert.deepStrictEqual((await post(server, EV + 'pending', {})).body.items, []);
    assert.strictEqual((await post(server, EV + 'pending', {}, { sign: false })).status, 401);

    // 16 is terminal: a later contradictory event is a conflict for review, not an event.
    assert.strictEqual(env.repo.emit(2400, 'late.rejected', 3, null, 'late:rejected:2400').status, 'conflict');
    assert.strictEqual(env.repo.conflicts.length, 1);
    assert.strictEqual(env.repo.czState.get(2400).projected_estado, 16);
    assert.strictEqual(env.repo.events.length, 2);
    const st = await post(server, '/internal/providers/v1/fallback/status', { cz_solicitud_id: 2400 });
    assert.deepStrictEqual([st.body.request.projected_estado, st.body.request.last_event_seq], [16, 2]);

    // GRANTED closes that solicitud (quota of the month consumed) but does not block the CI forever.
    const lock = env.repo.locks.find((l) => l.cz_solicitud_id === 2400);
    assert.deepStrictEqual([lock.state, lock.block_reason], ['consumed', null]);
    await enqueue(env, 2402, 24000000);
    await env.mk('B').runOnce();
    assert.strictEqual(job(env, 2402).reason_code, REASONS.CI_MONTHLY_QUOTA_USED, 'same month: blocked by the quota');
    env.clock.t = NOV_1_MVD;
    await enqueue(env, 2401, 24000000);
    await env.mk('C').runOnce();
    assert.strictEqual(job(env, 2401).outcome, OUTCOME.REFERRED, 'another month: not blocked only because of the GRANTED');
    assert.strictEqual(env.client.calls.s1.length, 2);
  } finally {
    server.close();
  }
});

const POSITIVE = { outcome: 'positive', httpStatus: 200, resultMessage: 'ok' };
const DAY_MS = 24 * 3600 * 1000;

test('BCU error: pending (CZ 12), one automatic retry exactly 24 h later, same TrackingId / solicitud / lock', async () => {
  const env = setup();
  const CI = 25000000;
  let n = 0;
  env.client.script.s1.set(String(CI), () => (++n === 1 ? Object.assign({}, BCU_ERROR) : POSITIVE));
  await enqueue(env, 2500, CI);
  await env.mk('A').runOnce();
  const p = env.elmRepo.rows.get(2500);
  assert.deepStrictEqual([p.s1_status, p.s1_attempts, p.s1_error_code, p.s1_result_message], ['technical_error', 1, 'elm_provider_bcu_error', 'BCU error']);
  assert.strictEqual(job(env, 2500).outcome, 'pending', 'BCU is not a rejection');
  assert.strictEqual(job(env, 2500).last_defer_reason, 'elm_technical_retry_backoff');
  assert.strictEqual(Date.parse(job(env, 2500).run_after), T0 + DAY_MS, 'scheduled exactly 24 h after the error');
  assert.strictEqual(env.repo.czState.has(2500), false, 'no event: CZ stays 12');
  assert.strictEqual(env.repo.reviewCases.length, 0);
  const lock = env.repo.locks.find((l) => l.cz_solicitud_id === 2500);
  assert.deepStrictEqual([lock.state, lock.month_key], ['reserved', '2026-10-01']);

  // During the wait: nothing is resent, and no other solicitud of the CI gets around the block.
  env.clock.t = T0 + DAY_MS - 1000;
  assert.strictEqual((await env.mk('B').runOnce()).claimed, 0);
  const ctx = { triggerOrigin: 'cz_automatic', solicitud: snapshotToSolicitud(job(env, 2500).snapshot) };
  assert.strictEqual((await env.orchestrator.retryElmStep(2500, ctx, { step: 's1', expectedAttempts: 1 })).code, CODES.RETRY_NOT_ALLOWED);
  await enqueue(env, 2501, CI);
  assert.strictEqual((await env.mk('B').runOnce()).claimed, 0, 'newer job of the CI waits for the older one');
  const solOf = (czId) => snapshotToSolicitud(parseStartBody(startBody(czId, CI)).value.snapshot);
  env.elmRepo.loadSolicitudContext = async (czId) => ({ solicitud: solOf(czId), grantedRow: null });
  const manual = await env.orchestrator.evaluateElm(2502, { triggerOrigin: 'janus_manual', triggeredByUserId: 'u-1', sendOrigin: 'rechazados_manual' });
  assert.deepStrictEqual([manual.code, manual.lock.block, Number(manual.lock.related_cz_solicitud_id)], [CODES.CI_LOCK_BLOCKED, 'send_in_progress', 2500]);
  assert.strictEqual(env.client.calls.s1.length, 1);

  // 24 h: two workers race; the retry is sent once with the same frozen request.
  env.clock.t = T0 + DAY_MS;
  await Promise.all([env.mk('C').runOnce(), env.mk('D').runOnce()]);
  assert.strictEqual(job(env, 2500).outcome, OUTCOME.REFERRED);
  assert.strictEqual(env.client.calls.s1.length, 2);
  assert.deepStrictEqual(env.client.calls.s1[1], env.client.calls.s1[0], 'same payload, no new solicitud');
  assert.strictEqual(env.client.calls.s2[0].TrackingId, '2500', 'TrackingId = the same cz_solicitud_id');
  assert.strictEqual(env.elmRepo.rows.get(2500).s1_attempts, 2);
  assert.deepStrictEqual(
    env.elmRepo.stepAttempts.map((a) => [a.cz_solicitud_id, a.step, a.attempt_no, a.error_code, a.result_message]),
    [[2500, 's1', 1, 'elm_provider_bcu_error', 'BCU error']],
    'first attempt archived',
  );
  assert.strictEqual(env.repo.locks.filter((l) => l.ci === CI).length, 1, 'no extra quota: same lock');
  assert.deepStrictEqual([lock.state, lock.block_reason, lock.month_key], ['consumed', 'active_referral', '2026-10-01']);
  assert.strictEqual(env.repo.rows.size, 2, 'no new request');
  assert.ok(!env.elmRepo.rows.has(2502));
});

test('BCU error twice → manual review (CZ 14) with reason and attempts; concurrent retries send once', async () => {
  const env = setup();
  const CI = 25100000;
  env.client.script.s1.set(String(CI), () => Object.assign({}, BCU_ERROR));
  await enqueue(env, 2510, CI);
  await env.mk('A').runOnce();
  env.clock.t = T0 + DAY_MS;
  const ctx = { triggerOrigin: 'cz_automatic', solicitud: snapshotToSolicitud(job(env, 2510).snapshot) };
  const rs = await Promise.all([
    env.orchestrator.retryElmStep(2510, ctx, { step: 's1', expectedAttempts: 1 }),
    env.orchestrator.retryElmStep(2510, ctx, { step: 's1', expectedAttempts: 1 }),
  ]);
  assert.deepStrictEqual(rs.map((r) => r.ok).sort(), [false, true]);
  assert.strictEqual(env.client.calls.s1.length, 2, 'original + exactly one retry');
  await env.mk('B').runOnce();
  assert.strictEqual(job(env, 2510).outcome, OUTCOME.MANUAL_REVIEW);
  assert.strictEqual(job(env, 2510).reason_code, REASONS.ELM_S1_BCU_ERROR_REPEATED);
  assert.deepStrictEqual(job(env, 2510).reason_detail, { error_code: 'elm_provider_bcu_error', attempts: 2 });
  assert.strictEqual(env.repo.czState.get(2510).projected_estado, 14, 'never 3, no survey');
  assert.strictEqual(env.repo.reviewCases[0].reason_code, REASONS.ELM_S1_BCU_ERROR_REPEATED);
  env.clock.t += 3 * DAY_MS;
  await env.mk('C').runOnce();
  assert.strictEqual((await env.orchestrator.retryElmStep(2510, ctx, { step: 's1', expectedAttempts: 2 })).code, CODES.RETRY_NOT_ALLOWED);
  assert.strictEqual(env.client.calls.s1.length, 2, 'no third attempt');
  assert.strictEqual(env.elmRepo.stepAttempts.length, 1);
  assert.strictEqual(env.repo.locks.find((l) => l.cz_solicitud_id === 2510).state, 'consumed');

  // The retry itself ends uncertain (timeout after send): nothing is resent until reconciled.
  const CI2 = 25200000;
  let n = 0;
  env.client.script.s1.set(String(CI2), () => {
    n += 1;
    if (n === 1) return Object.assign({}, BCU_ERROR);
    throw new Error('timeout after send');
  });
  const t0 = env.now();
  await enqueue(env, 2520, CI2);
  await env.mk('D').runOnce();
  env.clock.t = t0 + DAY_MS;
  await env.mk('E').runOnce();
  assert.strictEqual(env.elmRepo.rows.get(2520).s1_status, S1.UNKNOWN);
  assert.strictEqual(job(env, 2520).reason_code, REASONS.ELM_S1_UNKNOWN);
  env.clock.t += 3 * DAY_MS;
  await env.mk('F').runOnce();
  const ctx2 = { triggerOrigin: 'cz_automatic', solicitud: snapshotToSolicitud(job(env, 2520).snapshot) };
  assert.strictEqual((await env.orchestrator.retryElmStep(2520, ctx2, { step: 's1', expectedAttempts: 2 })).code, CODES.RETRY_NOT_ALLOWED);
  assert.strictEqual(n, 2, 'uncertain retry never resent');
  assert.strictEqual(env.repo.locks.find((l) => l.cz_solicitud_id === 2520).state, 'reserved', 'reservation kept until reconciled');
});

test('unified claim: manual, batch and automatic go through the same CI lock', async () => {
  const env = setup();
  const orch = createElmOrchestrator({
    repository: env.elmRepo,
    client: env.client,
    config: ELM_CONFIG,
    logger: env.logger,
    now: env.now,
    enabledTriggerOrigins: ['janus_manual', 'janus_batch', 'cz_automatic'],
  });
  const solOf = (czId, ci) => snapshotToSolicitud(parseStartBody(startBody(czId, ci)).value.snapshot);
  const ciOf = new Map();
  env.elmRepo.loadSolicitudContext = async (czId) => ({ solicitud: solOf(czId, ciOf.get(czId)), grantedRow: null });
  const manual = (czId, ci) => {
    ciOf.set(czId, ci);
    return orch.evaluateElm(czId, { triggerOrigin: 'janus_manual', triggeredByUserId: 'u-1', sendOrigin: 'rechazados_manual' });
  };
  const batch = (czId, ci) => {
    ciOf.set(czId, ci);
    return orch.evaluateElm(czId, { triggerOrigin: 'janus_batch' });
  };
  const s1For = (ci) => env.client.calls.s1.filter((p) => p.docNumber === String(ci)).length;

  // Automatic reservation in progress blocks manual and batch.
  const CI = 26000000;
  await enqueue(env, 2602, CI);
  assert.strictEqual((await env.repo.acquireCiLock({ ci: CI, czSolicitudId: 2602, fallbackRequestId: job(env, 2602).id })).status, 'acquired');
  for (const r of [await manual(2600, CI), await batch(2601, CI)]) {
    assert.deepStrictEqual([r.code, r.lock.block, Number(r.lock.related_cz_solicitud_id)], [CODES.CI_LOCK_BLOCKED, 'send_in_progress', 2602]);
  }
  assert.strictEqual(s1For(CI), 0);
  assert.strictEqual(env.elmRepo.rows.size, 0, 'refused claims write nothing');
  await env.mk('A').runOnce();
  assert.strictEqual(job(env, 2602).outcome, OUTCOME.REFERRED);
  for (const r of [await manual(2600, CI), await batch(2601, CI)]) {
    assert.deepStrictEqual([r.code, r.lock.block], [CODES.CI_LOCK_BLOCKED, 'active_referral']);
  }
  assert.strictEqual(s1For(CI), 1);

  // A manual send consumes the month for the automatic and batch paths.
  const CI2 = 26100000;
  env.client.script.s1.set(String(CI2), { outcome: 'negative', httpStatus: 200, resultMessage: 'SCORE BAJO' });
  const m = await manual(2610, CI2);
  assert.strictEqual(m.ok, true);
  const l2610 = env.repo.locks.find((l) => l.cz_solicitud_id === 2610);
  assert.deepStrictEqual([l2610.trigger_origin, l2610.fallback_request_id, l2610.state], ['janus_manual', null, 'consumed']);
  await enqueue(env, 2611, CI2);
  await env.mk('B').runOnce();
  assert.deepStrictEqual([job(env, 2611).outcome, job(env, 2611).reason_code, job(env, 2611).related_cz_solicitud_id], [OUTCOME.NOT_ELIGIBLE, REASONS.CI_MONTHLY_QUOTA_USED, 2610]);
  const b = await batch(2612, CI2);
  assert.deepStrictEqual([b.code, b.lock.block], [CODES.CI_LOCK_BLOCKED, 'monthly_quota_used']);
  assert.strictEqual(s1For(CI2), 1);

  // Simultaneous manual + batch + automatic for a fresh CI: a single S1.
  const CI3 = 26200000;
  await enqueue(env, 2622, CI3);
  const out = await Promise.all([manual(2620, CI3), batch(2621, CI3), env.mk('C').runOnce()]);
  assert.strictEqual(s1For(CI3), 1, 'one send for the CI: ' + JSON.stringify(out.map((o) => o.code || o.claimed)));
  assert.strictEqual(env.repo.locks.filter((l) => l.ci === CI3 && l.state !== 'released').length, 1);
});

test('C1 cron maintenance: lock reconcile every run, late events only with flag, never fails the run', async () => {
  const env = setup();
  const out = await env.mk('cron').runOnce();
  assert.deepStrictEqual(out.c1, { locks: {}, late_events: 'disabled' });
  assert.strictEqual(env.repo.calls.reconcileLocks, 1);
  assert.deepStrictEqual(env.repo.calls.lateEvents, []);
  const kick = await env.mk('k').runOnce({ trigger: 'kick' });
  assert.ok(!('c1' in kick), 'kick runs do no maintenance');
  env.repo.flags.failReconcile = true;
  const failed = await env.mk('cron').runOnce();
  assert.strictEqual(failed.ok, true);
  assert.strictEqual(failed.c1.locks, null);
  assert.ok(env.logger.lines.some((l) => l.includes('provider ci lock reconcile failed')));

  const on = setup({
    env: {
      PROVIDER_FALLBACK_LATE_EVENTS_ENABLED: 'true',
      ELM_POST_REFERRAL_REJECTION_STATUSES: 'Rechazado, rechazado por asesor ,Convertido,Inventado',
    },
  });
  assert.deepStrictEqual(Array.from(on.config.postReferralRejectionStatuses), ['rechazado', 'rechazado por asesor']);
  const r = await on.mk('cron').runOnce();
  assert.deepStrictEqual(r.c1.late_events, {});
  assert.deepStrictEqual(on.repo.calls.lateEvents, [{ statuses: ['rechazado', 'rechazado por asesor'], limit: on.config.c1ReconcileLimit }]);

  const dflt = readProviderFallbackConfig({}, ELM_CONFIG);
  assert.strictEqual(dflt.lateEventsEnabled, false);
  assert.deepStrictEqual(Array.from(dflt.postReferralRejectionStatuses), [], 'no ELM rejection status assumed');
  assert.strictEqual(dflt.activeReferralStaleHours, 72);
  assert.deepStrictEqual(Array.from(parseRejectionStatuses('convertido')), [], 'Convertido is never a rejection');
  assert.strictEqual(readProviderFallbackConfig({ PROVIDER_C1_ACTIVE_REFERRAL_STALE_HOURS: '24' }, ELM_CONFIG).activeReferralStaleHours, 24);
});

test('logs carry no applicant PII', async () => {
  const env = setup();
  await enqueue(env, 1100, 11000001);
  await env.mk('A').runOnce();
  const all = env.logger.lines.join('\n');
  assert.ok(!/ana@example\.test|59899123456|Prueba|1991-07-10/.test(all));
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
  assert.strictEqual(externalNet.length, 0, 'external network attempts: ' + externalNet.join(','));
  console.log(
    'unit-provider-fallback: ' + passed + '/' + tests.length + ' checks passed; external network attempts: ' + externalNet.length,
  );
})();
