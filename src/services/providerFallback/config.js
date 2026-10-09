'use strict';

/**
 * Provider fallback (Fase 3A) config. Every flag defaults OFF; only the string "true"
 * (case-insensitive) enables. Enabling these flags does NOT enable real ELM sends: the ELM
 * client stays disabled (src/services/elm/client.js) until its transport is implemented.
 *
 *   PROVIDER_FALLBACK_START_ENABLED          accept POST /internal/providers/v1/fallback/start
 *   PROVIDER_FALLBACK_WORKER_ENABLED         POST /jobs/run-provider-fallback-worker processes jobs
 *   PROVIDER_FALLBACK_CZ_AUTOMATIC_ENABLED   orchestrator accepts trigger_origin cz_automatic
 *   PROVIDER_FALLBACK_IMMEDIATE_KICK_ENABLED start also runs the worker for that solicitud now
 *
 * C1 (CZ events / monthly lock):
 *   PROVIDER_FALLBACK_LATE_EVENTS_ENABLED    cron also emits late events (Convertido → 16,
 *                                            configured rejection → 3)
 *   ELM_POST_REFERRAL_REJECTION_STATUSES     comma list of ELM postback statuses that close a
 *                                            referral as rejected. EMPTY by default (no status is
 *                                            assumed definitive until ELM confirms). Unknown
 *                                            statuses and "Convertido" are ignored.
 *   PROVIDER_C1_ACTIVE_REFERRAL_STALE_HOURS  ops: a referral without ELM signal for this long is
 *                                            flagged stale (default 72)
 *
 * Manual review SLA (provisional default until operations defines it):
 *   PROVIDER_REVIEW_SLA_JSON  {"default":{"priority":"normal","hours":24},
 *                              "<reason_code>":{"priority":"high","hours":4}}
 *   priority ∈ REVIEW_PRIORITIES, hours 1..720. Invalid entries are ignored.
 */

const { readElmConfig } = require('../elm/config');
const { classifyProviderStatus } = require('../elm/providerStatus');
const { REVIEW_PRIORITIES } = require('./constants');

const DEFAULT_MAX_NOT_STARTED_ATTEMPTS = 5;
const DEFAULT_NOT_STARTED_RETRY_SECONDS = 300;
const DEFAULT_WORKER_BATCH_LIMIT = 10;
const DEFAULT_MAX_CONCURRENT_KICKS = 4;
const IN_FLIGHT_POLL_GRACE_SECONDS = 5;
const MAX_LEASE_SECONDS = 86400;
const DEFAULT_C1_RECONCILE_LIMIT = 100;
const DEFAULT_ACTIVE_REFERRAL_STALE_HOURS = 72;

function flag(env, name) {
  return String(env[name] == null ? '' : env[name]).trim().toLowerCase() === 'true';
}

function intIn(raw, fallback, min, max) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

const DEFAULT_REVIEW_SLA = Object.freeze({ priority: 'normal', hours: 24 });
const MAX_REVIEW_SLA_HOURS = 720;

function slaEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const priority = typeof raw.priority === 'string' ? raw.priority.trim() : '';
  const hours = Number(raw.hours);
  if (!REVIEW_PRIORITIES.includes(priority)) return null;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_REVIEW_SLA_HOURS) return null;
  return Object.freeze({ priority: priority, hours: hours });
}

/** @returns {Readonly<Record<string, { priority: string, hours: number }>>} always has `default` */
function parseReviewSla(raw) {
  const out = { default: DEFAULT_REVIEW_SLA };
  if (raw == null || String(raw).trim() === '') return Object.freeze(out);
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return Object.freeze(out);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.freeze(out);
  for (const [k, v] of Object.entries(parsed)) {
    const key = String(k).trim();
    const entry = slaEntry(v);
    if (key && entry) out[key] = entry;
  }
  return Object.freeze(out);
}

/**
 * Normalized catalog statuses (same normalization as elm_postback_events.normalized_status).
 * @returns {readonly string[]}
 */
function parseRejectionStatuses(raw) {
  if (raw == null || String(raw).trim() === '') return Object.freeze([]);
  const out = new Set();
  for (const part of String(raw).split(',')) {
    const c = classifyProviderStatus(part);
    if (c.known && !c.grantedElm) out.add(c.normalized);
  }
  return Object.freeze(Array.from(out));
}

/**
 * @param {{ reviewSla: Record<string, { priority: string, hours: number }> }} config
 * @param {string} reasonCode
 * @returns {{ priority: string, dueSeconds: number }}
 */
function reviewSlaFor(config, reasonCode) {
  const sla = (config && config.reviewSla) || {};
  const entry = sla[reasonCode] || sla.default || DEFAULT_REVIEW_SLA;
  return { priority: entry.priority, dueSeconds: entry.hours * 3600 };
}

/**
 * @param {Record<string, string|undefined>} [envOverride]
 * @param {object} [elmConfigOverride]
 */
function readProviderFallbackConfig(envOverride, elmConfigOverride) {
  const env = envOverride || process.env;
  const elmConfig = elmConfigOverride || readElmConfig(env);
  // A worker must outlive S1 + S2 in-flight leases, so another worker never reclaims a live job.
  const minJobLease = Math.min(MAX_LEASE_SECONDS, 2 * elmConfig.inFlightLeaseSeconds + 120);
  return {
    startEnabled: flag(env, 'PROVIDER_FALLBACK_START_ENABLED'),
    workerEnabled: flag(env, 'PROVIDER_FALLBACK_WORKER_ENABLED'),
    czAutomaticEnabled: flag(env, 'PROVIDER_FALLBACK_CZ_AUTOMATIC_ENABLED'),
    immediateKickEnabled: flag(env, 'PROVIDER_FALLBACK_IMMEDIATE_KICK_ENABLED'),
    maxNotStartedAttempts: intIn(
      env.PROVIDER_FALLBACK_MAX_NOT_STARTED_ATTEMPTS,
      DEFAULT_MAX_NOT_STARTED_ATTEMPTS,
      1,
      100,
    ),
    notStartedRetrySeconds: intIn(
      env.PROVIDER_FALLBACK_NOT_STARTED_RETRY_SECONDS,
      DEFAULT_NOT_STARTED_RETRY_SECONDS,
      1,
      MAX_LEASE_SECONDS,
    ),
    workerBatchLimit: intIn(
      env.PROVIDER_FALLBACK_WORKER_BATCH_LIMIT,
      DEFAULT_WORKER_BATCH_LIMIT,
      1,
      100,
    ),
    maxConcurrentKicks: DEFAULT_MAX_CONCURRENT_KICKS,
    inFlightPollGraceSeconds: IN_FLIGHT_POLL_GRACE_SECONDS,
    elmInFlightLeaseSeconds: elmConfig.inFlightLeaseSeconds,
    jobLeaseSeconds: Math.max(
      minJobLease,
      intIn(env.PROVIDER_FALLBACK_JOB_LEASE_SECONDS, minJobLease, 1, MAX_LEASE_SECONDS),
    ),
    technicalRetry: Object.freeze({
      safeErrorCodes: elmConfig.retrySafeErrorCodes || Object.freeze([]),
      maxAttempts: elmConfig.technicalRetryMaxAttempts || 1,
      backoffSeconds: elmConfig.technicalRetryBackoffSeconds || 300,
      backoffMaxSeconds: elmConfig.technicalRetryBackoffMaxSeconds || 21600,
    }),
    reviewSla: parseReviewSla(env.PROVIDER_REVIEW_SLA_JSON),
    lateEventsEnabled: flag(env, 'PROVIDER_FALLBACK_LATE_EVENTS_ENABLED'),
    postReferralRejectionStatuses: parseRejectionStatuses(env.ELM_POST_REFERRAL_REJECTION_STATUSES),
    c1ReconcileLimit: DEFAULT_C1_RECONCILE_LIMIT,
    activeReferralStaleHours: intIn(
      env.PROVIDER_C1_ACTIVE_REFERRAL_STALE_HOURS,
      DEFAULT_ACTIVE_REFERRAL_STALE_HOURS,
      1,
      8760,
    ),
  };
}

module.exports = {
  DEFAULT_MAX_NOT_STARTED_ATTEMPTS,
  DEFAULT_NOT_STARTED_RETRY_SECONDS,
  DEFAULT_REVIEW_SLA,
  DEFAULT_ACTIVE_REFERRAL_STALE_HOURS,
  parseReviewSla,
  parseRejectionStatuses,
  reviewSlaFor,
  readProviderFallbackConfig,
};
