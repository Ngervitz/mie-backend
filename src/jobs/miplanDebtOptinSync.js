/**
 * Job: miplan_debt_optin_sync (Mi Deuda Stage 2)
 * Trigger: POST /jobs/run-miplan-debt-optin-sync (session or X-Cron-Key). No cron is registered.
 *
 * Pulls Mi Plan debt-management opt-in events (Mi Plan = source of truth) and stores the
 * operational, immutable JANUS copy through ingest_miplan_debt_optin_event (atomic, idempotent).
 *
 * Delivery: at-least-once, pending/ACK (no cursor, no time window).
 *   Per page: GET pending → validate contract + every event → resolve CI (consumed handoff
 *   token) → load creditor catalog once → resolve creditors (miplan_declared only) → RPC per
 *   event → ACK to Mi Plan exactly the events whose RPC returned (inserted | already_ingested).
 *   ACK = "JANUS durably persisted the event" (incl. events without CI: their reconciliation row
 *   is written in the same transaction). It does not mean "fully processed".
 *   Malformed page → nothing acked, run fails (page re-exported next run).
 *   RPC failure mid-page → only the already-persisted prefix is acked, run fails.
 *   Mi Plan / ACK unavailable → run fails; unacked events are re-exported, replay is a no-op.
 * Then: CI reconciliation pass (reconcile_miplan_optin_ci) with an injectable clock.
 * Alerts (structured logs, `alert` key): MIPLAN_OPTIN_CI_UNRESOLVED (WARN, from the first
 * appearance and while any is pending), MIPLAN_OPTIN_CI_TERMINAL_UNRESOLVABLE (ERROR on the
 * transition, WARN while any exists).
 * Logs carry counters, codes and Mi Plan event ids only: never CI, token hash, secret, or debts.
 */

const { randomUUID } = require('crypto');
const {
  validateExportPage,
  resolveCiForEvent,
  buildIngestPayload,
  CI_RESOLUTION,
} = require('../lib/miplanDebtOptinContract');
const { RESOLUTION } = require('../lib/creditorCatalog');

const JOB_NAME = 'miplan_debt_optin_sync';
const JOB_LOCK_TTL_SECONDS = 15 * 60;
const DEFAULT_PAGE_LIMIT = 100;
/** GET + ACK per page: 10 pages = 20 requests, under Mi Plan's 30 req/min per-IP limit. */
const DEFAULT_MAX_PAGES = 10;
const RECONCILE_LIMIT = 200;
const TOKEN_LOOKUP_CHUNK = 100;
const KNOWN_RPC_CODES = /\b(MIPLAN_OPTIN_[A-Z_]+)\b/;

const ALERT = Object.freeze({
  CI_UNRESOLVED: 'MIPLAN_OPTIN_CI_UNRESOLVED',
  CI_TERMINAL: 'MIPLAN_OPTIN_CI_TERMINAL_UNRESOLVABLE',
});

class MiplanDebtOptinSyncError extends Error {
  /** @param {string|null} [detail] static validator message only (never payload values) */
  constructor(code, stage, detail) {
    super(JOB_NAME + ' failed at ' + stage + ': ' + code);
    this.name = 'MiplanDebtOptinSyncError';
    this.code = code;
    this.stage = stage;
    this.detail = detail || null;
  }
}

function safeRpcCode(error, fallback) {
  const msg = String((error && error.message) || '');
  const m = KNOWN_RPC_CODES.exec(msg);
  if (m) return m[1];
  if (error && /^[0-9A-Z]{5}$/.test(String(error.code || ''))) return 'SQLSTATE_' + error.code;
  return fallback || 'INGEST_RPC_FAILED';
}

function toSyncError(e, stage) {
  if (e instanceof MiplanDebtOptinSyncError) return e;
  if (e && e.name === 'MiplanOptinPayloadError') {
    return new MiplanDebtOptinSyncError(e.code || 'MIPLAN_OPTIN_PAYLOAD_INVALID', stage, e.message);
  }
  return new MiplanDebtOptinSyncError('UNEXPECTED', stage);
}

/**
 * @param {{
 *   supabase: object,
 *   client: { fetchPage: Function, ackEvents: Function },
 *   loadCatalog: (supabase: object) => Promise<object>,
 *   logger: { info: Function, error: Function, warn: Function },
 *   pageLimit?: number,
 *   maxPages?: number,
 *   now?: () => Date,
 * }} deps `now` is the reconciliation clock (default: database now()).
 */
function createMiplanDebtOptinSync(deps) {
  const supabase = deps.supabase;
  const client = deps.client;
  const loadCatalog = deps.loadCatalog;
  const logger = deps.logger;
  const pageLimit = deps.pageLimit || DEFAULT_PAGE_LIMIT;
  const maxPages = deps.maxPages || DEFAULT_MAX_PAGES;
  const now = deps.now || null;

  async function acquireJobLock(lockedBy) {
    const { data, error } = await supabase.rpc('acquire_job_lock', {
      p_job_name: JOB_NAME,
      p_locked_by: lockedBy,
      p_ttl_seconds: JOB_LOCK_TTL_SECONDS,
    });
    if (error) throw new MiplanDebtOptinSyncError('LOCK_RPC_FAILED', 'lock');
    return data === true;
  }

  async function releaseJobLock(lockedBy) {
    const { error } = await supabase.rpc('release_job_lock', {
      p_job_name: JOB_NAME,
      p_locked_by: lockedBy,
    });
    if (error) logger.error('release_job_lock failed', { jobName: JOB_NAME });
  }

  async function lookupTokens(hashes) {
    const byHash = new Map();
    for (let i = 0; i < hashes.length; i += TOKEN_LOOKUP_CHUNK) {
      const chunk = hashes.slice(i, i + TOKEN_LOOKUP_CHUNK);
      const { data, error } = await supabase
        .from('miplan_handoff_tokens')
        .select('id, token_hash, status, ci')
        .in('token_hash', chunk);
      if (error) throw new MiplanDebtOptinSyncError('TOKEN_LOOKUP_FAILED', 'ci_resolution');
      (data || []).forEach(function (row) {
        byHash.set(row.token_hash, row);
      });
    }
    return byHash;
  }

  async function ingest(payload) {
    const { data, error } = await supabase.rpc('ingest_miplan_debt_optin_event', { p_payload: payload });
    if (error) throw new MiplanDebtOptinSyncError(safeRpcCode(error), 'ingest');
    const status = data && data.status;
    if (status !== 'inserted' && status !== 'already_ingested') {
      throw new MiplanDebtOptinSyncError('INGEST_UNEXPECTED_RESULT', 'ingest');
    }
    return data;
  }

  async function ack(acks, stats) {
    let res;
    try {
      res = await client.ackEvents(acks);
    } catch (e) {
      throw new MiplanDebtOptinSyncError((e && e.code) || 'MIPLAN_UNAVAILABLE', 'ack');
    }
    stats.events_acked += res.acked;
    stats.events_already_acked += res.already_acked;
  }

  async function pull(stats) {
    let resolver = null;
    for (let p = 0; p < maxPages; p += 1) {
      let body;
      try {
        body = await client.fetchPage({ limit: pageLimit });
      } catch (e) {
        throw new MiplanDebtOptinSyncError((e && e.code) || 'MIPLAN_UNAVAILABLE', 'fetch');
      }
      let page;
      try {
        page = validateExportPage(body);
      } catch (e) {
        throw toSyncError(e, 'validate');
      }
      stats.pages += 1;
      stats.has_more = page.has_more;
      if (!page.events.length) break;

      const hashes = Array.from(new Set(page.events.map(function (e) {
        return e.handoff_token_hash;
      }).filter(Boolean)));
      const tokens = hashes.length ? await lookupTokens(hashes) : new Map();
      if (!resolver) {
        try {
          resolver = await loadCatalog(supabase);
        } catch (_e) {
          throw new MiplanDebtOptinSyncError('CREDITOR_CATALOG_UNAVAILABLE', 'catalog');
        }
      }

      const acks = [];
      let pageError = null;
      for (let i = 0; i < page.events.length; i += 1) {
        const event = page.events[i];
        let ciResolution;
        let payload;
        let out;
        try {
          ciResolution = resolveCiForEvent(
            event,
            event.handoff_token_hash ? tokens.get(event.handoff_token_hash) || null : null,
          );
          payload = buildIngestPayload(event, ciResolution, resolver);
          out = await ingest(payload);
        } catch (e) {
          pageError = toSyncError(e, 'ingest');
          break;
        }
        acks.push({ event_id: event.event_id, janus_status: out.status });
        stats.events_seen += 1;
        if (ciResolution.ci_resolution === CI_RESOLUTION.UNRESOLVABLE) {
          stats.ci_unresolvable += 1;
          if (out.status === 'inserted') {
            logger.warn('miplan_optin_ci_unresolved', {
              alert: ALERT.CI_UNRESOLVED,
              event_id: event.event_id,
              reason: ciResolution.ci_unresolved_reason,
            });
          }
        }
        if (out.status === 'inserted') {
          stats.events_inserted += 1;
          stats.debts_inserted += Number(out.debts_inserted) || 0;
          stats.debts_unknown += payload.debts.filter(function (d) {
            return d.ingestion_resolution === RESOLUTION.UNKNOWN;
          }).length;
        } else {
          stats.events_already_ingested += 1;
        }
      }

      if (acks.length) {
        try {
          await ack(acks, stats);
        } catch (e) {
          if (!pageError) throw e;
          logger.error('miplan_debt_optin_sync ack after partial page failed', { code: e.code, stage: 'ack' });
        }
      }
      if (pageError) throw pageError;
      if (!page.has_more) break;
    }
  }

  async function reconcile() {
    const { data, error } = await supabase.rpc('reconcile_miplan_optin_ci', {
      p_now: now ? now().toISOString() : null,
      p_limit: RECONCILE_LIMIT,
    });
    if (error) throw new MiplanDebtOptinSyncError(safeRpcCode(error, 'RECONCILE_RPC_FAILED'), 'reconcile');
    if (!data || !Number.isInteger(data.pending_total) || !Number.isInteger(data.terminal_total)) {
      throw new MiplanDebtOptinSyncError('RECONCILE_UNEXPECTED_RESULT', 'reconcile');
    }
    (data.newly_resolved || []).forEach(function (r) {
      logger.info('miplan_optin_ci_resolved', { event_id: r.event_id });
    });
    (data.newly_terminal || []).forEach(function (r) {
      logger.error('miplan_optin_ci_terminal_unresolvable', {
        alert: ALERT.CI_TERMINAL,
        event_id: r.event_id,
        terminal_reason: r.terminal_reason,
      });
    });
    if (data.pending_total > 0) {
      logger.warn('miplan_optin_ci_reconciliation_pending', {
        alert: ALERT.CI_UNRESOLVED,
        pending_total: data.pending_total,
      });
    }
    if (data.terminal_total > 0) {
      logger.warn('miplan_optin_ci_terminal_present', {
        alert: ALERT.CI_TERMINAL,
        terminal_total: data.terminal_total,
      });
    }
    return {
      attempted: data.attempted,
      resolved: data.resolved,
      terminal: data.terminal,
      still_pending: data.still_pending,
      pending_total: data.pending_total,
      terminal_total: data.terminal_total,
    };
  }

  async function run() {
    const lockedBy = 'miplan-debt-optin-sync-' + randomUUID();
    const acquired = await acquireJobLock(lockedBy);
    if (!acquired) return { ok: false, reason: 'lock_not_acquired' };

    const stats = {
      pages: 0,
      events_seen: 0,
      events_inserted: 0,
      events_already_ingested: 0,
      ci_unresolvable: 0,
      debts_inserted: 0,
      debts_unknown: 0,
      events_acked: 0,
      events_already_acked: 0,
      has_more: false,
      reconciliation: null,
    };
    try {
      let failure = null;
      try {
        await pull(stats);
      } catch (e) {
        failure = toSyncError(e, 'unknown');
      }
      try {
        stats.reconciliation = await reconcile();
      } catch (e) {
        const err = toSyncError(e, 'reconcile');
        if (failure) logger.error('miplan_debt_optin_sync reconcile failed', { code: err.code, stage: err.stage });
        else failure = err;
      }
      if (failure) {
        logger.error('miplan_debt_optin_sync failed', Object.assign({
          code: failure.code,
          stage: failure.stage,
          detail: failure.detail,
        }, stats));
        throw failure;
      }
      logger.info('miplan_debt_optin_sync completed', stats);
      return Object.assign({ ok: true }, stats);
    } finally {
      await releaseJobLock(lockedBy);
    }
  }

  return { run };
}

/**
 * Production wiring. Dormant unless both MIPLAN_EXPORT_BASE_URL and MIPLAN_JANUS_EXPORT_SECRET
 * are configured.
 */
async function runMiplanDebtOptinSync() {
  const env = require('../config/env');
  if (!env.miplanExportBaseUrl || !env.miplanJanusExportSecret ||
      env.miplanJanusExportSecret === env.miplanHandoffRedeemSecret) {
    return { ok: false, reason: 'not_configured' };
  }
  const { createMiplanExportClient } = require('../lib/miplanExportClient');
  const { loadCreditorCatalog } = require('../lib/creditorCatalogRead');
  return createMiplanDebtOptinSync({
    supabase: require('../clients/supabase'),
    client: createMiplanExportClient({
      baseUrl: env.miplanExportBaseUrl,
      secret: env.miplanJanusExportSecret,
    }),
    loadCatalog: loadCreditorCatalog,
    logger: require('../lib/logger'),
  }).run();
}

module.exports = {
  JOB_NAME,
  ALERT,
  MiplanDebtOptinSyncError,
  createMiplanDebtOptinSync,
  runMiplanDebtOptinSync,
};
