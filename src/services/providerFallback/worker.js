'use strict';

/**
 * Provider fallback worker (Fase 3A). Run by the existing external cron
 * (POST /jobs/run-provider-fallback-worker) and, when enabled, by an immediate kick after start
 * that uses the same atomic claim narrowed to one solicitud. No internal scheduler.
 *
 * Every run re-derives the job state from elm_lead_processes, so reclaiming a job after a
 * restart or an expired job lease is always safe:
 *  - no process + gates closed (proven not started)  → defer, not_started_attempts++;
 *  - process in_flight with a valid lease            → defer until the lease ends (no new call);
 *  - process in_flight with an expired lease         → unknown (never retried) → manual_review;
 *  - S1 eligible + S2 not_started                    → S2 (begin_s2 is atomic, once);
 *  - step technical_error, retry-safe code, < limit  → wait backoff, then resend the same frozen
 *                                                      request (elm_retry_step, atomic);
 *  - S1 "BCU error" (first)                          → job stays pending (CZ 12, lock kept),
 *                                                      24 h later the same request once;
 *  - S1 "BCU error" (second)                         → manual_review elm_s1_bcu_error_repeated;
 *  - technical_error otherwise                       → manual_review (specific reason).
 * New external calls only go through the ELM orchestrator (claim / begin_s2 / retry write-ahead).
 * Every manual_review outcome registers its review case in the same DB transaction.
 * rejected / not_eligible only with a definitive reason (DEFINITIVE_REJECTION_REASONS); any
 * other is turned into manual_review here and refused by provider_fallback_finalize.
 *
 * C1: before any new external call → CI guard → monthly send lock (elm_ci_lock_acquire, atomic
 * per CI; elm_claim_process takes the same lock for every origin). A reservation is released only
 * when it is proven that no call started; otherwise finalize settles it (same transaction as the
 * outcome event). Cron runs (not kicks) also reconcile locks and, when enabled, late ELM events.
 */

const crypto = require('crypto');
const os = require('os');
const defaultLogger = require('../../lib/logger');
const { OUTCOME, REASONS, DEFER, DEFINITIVE_REJECTION_REASONS } = require('./constants');
const { reviewSlaFor } = require('./config');
const { snapshotToSolicitud } = require('./snapshot');
const { deriveFromProcess, evaluateCiGuard, decideCiLock, classifyBlocked } = require('./outcome');

const TRIGGER_ORIGIN = 'cz_automatic';
const MAX_STEPS_PER_RUN = 6;

function hasExpiredInFlight(p, nowMs) {
  function expired(iso) {
    const t = Date.parse(String(iso || ''));
    return Number.isFinite(t) && t < nowMs;
  }
  return (
    (p.s1_status === 'in_flight' && expired(p.s1_lease_expires_at)) ||
    (p.s2_status === 'in_flight' && expired(p.s2_lease_expires_at))
  );
}

/**
 * @param {{
 *   repository: object,       providerFallback repository
 *   elmRepository: object,    ELM repository (process reads + expiry)
 *   orchestrator: object,     ELM orchestrator built with cz_automatic enabled (or not)
 *   config: object,           readProviderFallbackConfig()
 *   logger?: object,
 *   now?: () => number,
 *   workerIdPrefix?: string,
 * }} deps
 */
function createProviderFallbackWorker(deps) {
  const repo = deps.repository;
  const elmRepo = deps.elmRepository;
  const orchestrator = deps.orchestrator;
  const config = deps.config;
  const logger = deps.logger || defaultLogger;
  const now = deps.now || Date.now;
  const prefix = deps.workerIdPrefix || os.hostname() + ':' + process.pid;
  let activeKicks = 0;

  function secondsUntil(untilMs) {
    const grace = config.inFlightPollGraceSeconds;
    if (untilMs == null) return config.elmInFlightLeaseSeconds + grace;
    // provider_fallback_defer accepts at most 86400 s (the 24 h BCU wait reaches it).
    return Math.min(86400, Math.max(0, Math.ceil((untilMs - now()) / 1000)) + grace);
  }

  async function finalize(job, workerId, decidedOutcome, decidedReason, extra) {
    let e = extra || {};
    let outcome = decidedOutcome;
    let reasonCode = decidedReason;
    const rejection = outcome === OUTCOME.REJECTED || outcome === OUTCOME.NOT_ELIGIBLE;
    if (rejection && !DEFINITIVE_REJECTION_REASONS.includes(reasonCode)) {
      outcome = OUTCOME.MANUAL_REVIEW;
      reasonCode = REASONS.REJECTION_NOT_CONFIRMED;
      e = Object.assign({}, e, {
        detail: { decided_outcome: decidedOutcome, decided_reason: decidedReason, detail: e.detail || null },
      });
    }
    const review = outcome === OUTCOME.MANUAL_REVIEW ? reviewSlaFor(config, reasonCode) : null;
    const row = await repo.finalize({
      id: job.id,
      workerId: workerId,
      outcome: outcome,
      reasonCode: reasonCode,
      reasonDetail: e.detail || null,
      elmProcessId: e.elmProcessId || null,
      relatedCzSolicitudId: e.relatedCzId || null,
      reviewPriority: review ? review.priority : null,
      reviewDueSeconds: review ? review.dueSeconds : null,
    });
    if (!row) {
      logger.warn('provider fallback finalize lost lease', { cz_solicitud_id: job.cz_solicitud_id });
      return { result: 'lease_lost' };
    }
    logger.info('provider fallback finalized', {
      cz_solicitud_id: job.cz_solicitud_id,
      outcome: outcome,
      reason_code: reasonCode,
    });
    return { result: 'finalized', outcome: outcome };
  }

  async function defer(job, workerId, delaySeconds, notStarted, reason) {
    const row = await repo.defer({
      id: job.id,
      workerId: workerId,
      delaySeconds: delaySeconds,
      notStarted: notStarted,
      reason: reason,
    });
    if (!row) {
      logger.warn('provider fallback defer lost lease', { cz_solicitud_id: job.cz_solicitud_id });
      return { result: 'lease_lost' };
    }
    return { result: 'deferred', reason: reason };
  }

  function finalizeDecision(job, workerId, d, elmProcessId) {
    return finalize(job, workerId, d.outcome, d.reasonCode, {
      detail: d.detail,
      elmProcessId: elmProcessId,
      relatedCzId: d.relatedCzId,
    });
  }

  /**
   * Checks before any NEW external call. Returns a terminal action or null to proceed.
   */
  async function preCallChecks(job, workerId, elmProcessId) {
    if (Number(job.not_started_attempts) >= config.maxNotStartedAttempts) {
      return finalize(job, workerId, OUTCOME.MANUAL_REVIEW, REASONS.NOT_STARTED_EXHAUSTED, {
        detail: { last_defer_reason: job.last_defer_reason || null },
        elmProcessId: elmProcessId,
      });
    }
    const ci = Number(job.ci);
    const czId = Number(job.cz_solicitud_id);
    const others = await repo.listElmProcessesByCi(ci);
    const guard = evaluateCiGuard(others, czId, now());
    if (guard.kind === 'final') return finalizeDecision(job, workerId, guard, elmProcessId);
    if (guard.kind === 'wait') {
      return defer(job, workerId, secondsUntil(guard.untilMs), false, DEFER.CI_OTHER_IN_FLIGHT);
    }
    const lock = decideCiLock(
      await repo.acquireCiLock({ ci: ci, czSolicitudId: czId, fallbackRequestId: job.id }),
    );
    if (lock.kind === 'final') return finalizeDecision(job, workerId, lock, elmProcessId);
    if (lock.kind === 'wait') {
      return defer(job, workerId, config.notStartedRetrySeconds, false, DEFER.CI_SEND_IN_PROGRESS);
    }
    return null;
  }

  async function handleBlocked(job, workerId, res, elmProcessId) {
    const c = classifyBlocked(res);
    if (c.kind === 'final') return finalizeDecision(job, workerId, c, elmProcessId);
    if (c.kind === 'wait') {
      return defer(job, workerId, config.notStartedRetrySeconds, false, DEFER.CI_SEND_IN_PROGRESS);
    }
    if (c.kind === 'not_started') {
      // Gates closed before any ELM process existed: the month must not stay reserved.
      if (!elmProcessId) await repo.releaseUnstartedCiLock(Number(job.cz_solicitud_id));
      return defer(job, workerId, config.notStartedRetrySeconds, true, DEFER.NOT_STARTED_PREFIX + c.code);
    }
    if (c.kind === 'persist_failed') {
      // The call happened; its process stays in_flight until the lease ends → unknown.
      return defer(job, workerId, secondsUntil(null), false, DEFER.PERSIST_FAILED);
    }
    return null;
  }

  async function processJob(job, workerId) {
    const czId = Number(job.cz_solicitud_id);
    const context = {
      triggerOrigin: TRIGGER_ORIGIN,
      solicitud: snapshotToSolicitud(job.snapshot),
      jt: job.snapshot && job.snapshot.jt ? job.snapshot.jt : null,
    };

    for (let i = 0; i < MAX_STEPS_PER_RUN; i += 1) {
      let process = await elmRepo.getProcessByCzId(czId);
      if (process && hasExpiredInFlight(process, now())) {
        process = (await elmRepo.expireStaleInFlight(czId)) || process;
      }

      if (!process) {
        const stop = await preCallChecks(job, workerId, null);
        if (stop) return stop;
        const res = await orchestrator.evaluateElm(czId, context);
        if (res.ok) continue;
        const handled = await handleBlocked(job, workerId, res, null);
        if (handled) return handled;
        continue;
      }

      const d = deriveFromProcess(process, now(), config.technicalRetry);
      if (d.kind === 'final') return finalizeDecision(job, workerId, d, process.id);
      if (d.kind === 'wait') {
        return defer(job, workerId, secondsUntil(d.untilMs), false, DEFER.ELM_IN_FLIGHT);
      }
      if (d.kind === 'backoff') {
        return defer(job, workerId, secondsUntil(d.untilMs), false, DEFER.TECHNICAL_RETRY_BACKOFF);
      }
      if (d.kind === 'expire') continue;

      const stop = await preCallChecks(job, workerId, process.id);
      if (stop) return stop;
      const res =
        d.kind === 'retry'
          ? await orchestrator.retryElmStep(czId, context, {
              step: d.step,
              expectedAttempts: d.expectedAttempts,
            })
          : await orchestrator.referElm(czId, context);
      if (res.ok) continue;
      const handled = await handleBlocked(job, workerId, res, process.id);
      if (handled) return handled;
    }
    return defer(job, workerId, 0, false, DEFER.LOOP_LIMIT);
  }

  async function safeProcessJob(job, workerId) {
    try {
      return await processJob(job, workerId);
    } catch (err) {
      logger.error('provider fallback job failed', {
        cz_solicitud_id: job.cz_solicitud_id,
        error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      });
      // Cannot prove whether a call started: never counted as not-started. The next run
      // re-derives from elm_lead_processes.
      try {
        return await defer(job, workerId, config.notStartedRetrySeconds, false, DEFER.WORKER_ERROR);
      } catch (_) {
        return { result: 'error' };
      }
    }
  }

  /**
   * @param {{ limit?: number, czSolicitudId?: number|null, trigger?: string }} [opts]
   */
  async function runOnce(opts) {
    const o = opts || {};
    if (!config.workerEnabled) return { ok: true, skipped: 'worker_disabled' };
    const workerId = prefix + ':' + crypto.randomUUID();
    const limit = Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, 100) : config.workerBatchLimit;
    const jobs = await repo.claim({
      workerId: workerId,
      leaseSeconds: config.jobLeaseSeconds,
      limit: limit,
      czSolicitudId: o.czSolicitudId != null ? o.czSolicitudId : null,
    });
    const summary = {
      ok: true,
      trigger: o.trigger || 'cron',
      claimed: jobs.length,
      finalized: 0,
      deferred: 0,
      lease_lost: 0,
      errors: 0,
      outcomes: {},
    };
    for (const job of jobs) {
      const r = await safeProcessJob(job, workerId);
      if (r.result === 'finalized') {
        summary.finalized += 1;
        summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] || 0) + 1;
      } else if (r.result === 'deferred') {
        summary.deferred += 1;
      } else if (r.result === 'lease_lost') {
        summary.lease_lost += 1;
      } else {
        summary.errors += 1;
      }
    }
    if (summary.trigger !== 'kick') {
      summary.review_alerts = await reviewAlerts();
      summary.c1 = await c1Maintenance();
    }
    return summary;
  }

  /**
   * Lock reconcile (postbacks / manual resolutions change what a lock must block) and, only with
   * PROVIDER_FALLBACK_LATE_EVENTS_ENABLED, late CZ events (Convertido; rejection statuses from
   * ELM_POST_REFERRAL_REJECTION_STATUSES, empty by default). Never fails the run.
   */
  async function c1Maintenance() {
    const out = { locks: null, late_events: config.lateEventsEnabled ? null : 'disabled' };
    try {
      out.locks = await repo.reconcileCiLocks(config.c1ReconcileLimit);
    } catch (err) {
      logger.warn('provider ci lock reconcile failed', {
        error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      });
    }
    if (config.lateEventsEnabled) {
      try {
        out.late_events = await repo.reconcileLateEvents(
          config.postReferralRejectionStatuses,
          config.c1ReconcileLimit,
        );
      } catch (err) {
        logger.warn('provider late events reconcile failed', {
          error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
        });
      }
    }
    return out;
  }

  /**
   * Alert channel for the manual review queue: structured warning on every cron run plus the
   * counts in the run summary (the dashboard shows the same counts). Never fails the run.
   */
  async function reviewAlerts() {
    if (typeof repo.countReviewAlerts !== 'function') return null;
    try {
      const a = await repo.countReviewAlerts(new Date(now()).toISOString());
      if (a.unassigned > 0 || a.overdue > 0) {
        logger.warn('provider review queue needs attention', a);
      }
      return a;
    } catch (err) {
      logger.warn('provider review alerts unavailable', {
        error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      });
      return null;
    }
  }

  /**
   * Fire-and-forget run for one solicitud right after start. Bounded concurrency; when the cap
   * is reached the job simply waits for the cron. Returns whether a run was scheduled.
   */
  function kick(czSolicitudId) {
    if (!config.workerEnabled || !config.immediateKickEnabled) return false;
    if (activeKicks >= config.maxConcurrentKicks) return false;
    activeKicks += 1;
    setImmediate(function () {
      runOnce({ limit: 1, czSolicitudId: czSolicitudId, trigger: 'kick' })
        .catch(function (err) {
          logger.error('provider fallback kick failed', {
            cz_solicitud_id: czSolicitudId,
            error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
          });
        })
        .finally(function () {
          activeKicks -= 1;
        });
    });
    return true;
  }

  return { runOnce, kick };
}

/**
 * Production wiring (Supabase repositories, disabled ELM client, flags from env).
 * @param {{ config?: object }} [opts]
 */
function createDefaultProviderFallbackWorker(opts) {
  const { readProviderFallbackConfig } = require('./config');
  const { createProviderFallbackRepository } = require('./repository');
  const { createElmRepository } = require('../elm/repository');
  const { createElmOrchestrator } = require('../elm/orchestrator');
  const { ENABLED_TRIGGER_ORIGINS } = require('../elm/constants');
  const config = (opts && opts.config) || readProviderFallbackConfig();
  const elmRepository = createElmRepository();
  const orchestrator = createElmOrchestrator({
    repository: elmRepository,
    enabledTriggerOrigins: config.czAutomaticEnabled
      ? ENABLED_TRIGGER_ORIGINS.concat([TRIGGER_ORIGIN])
      : ENABLED_TRIGGER_ORIGINS,
  });
  return createProviderFallbackWorker({
    repository: createProviderFallbackRepository(),
    elmRepository: elmRepository,
    orchestrator: orchestrator,
    config: config,
  });
}

let defaultWorker = null;

/** Process-wide instance shared by the cron route and the immediate kick. */
function getDefaultProviderFallbackWorker() {
  if (!defaultWorker) defaultWorker = createDefaultProviderFallbackWorker();
  return defaultWorker;
}

module.exports = {
  TRIGGER_ORIGIN,
  createProviderFallbackWorker,
  createDefaultProviderFallbackWorker,
  getDefaultProviderFallbackWorker,
};
