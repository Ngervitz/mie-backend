'use strict';

/**
 * CDV estado 8 → ELM: enqueue on funnel sync; S1/S2 on provider-fallback worker cron (separate from C1).
 */

const supabase = require('../clients/supabase');
const logger = require('./logger');
const { readCdvEstado8ElmConfig, PREAPROBADOS_ESTADO_ID } = require('./cdvEstado8ElmConfig');
const { ENABLED_TRIGGER_ORIGINS, CODES } = require('../services/elm/constants');
const { createElmOrchestrator } = require('../services/elm/orchestrator');
const { createElmRepository } = require('../services/elm/repository');
const { evaluateCiResendHold, readElmSendRowsByCis } = require('./rejectedElmResendGuard');
const { readPostReferralRejectionStatuses } = require('../services/elm/classification');

const QUEUE_TABLE = 'cdv_estado8_elm_queue';
const STALE_PROCESSING_MS = 20 * 60 * 1000;

/** Terminal queue status for exhausted retries: commercial vs technical (not skipped_ineligible). */
const COMMERCIAL_TERMINAL_CODES = new Set([
  CODES.CDV_GRANTED,
  CODES.MISSING_REQUIRED_FIELDS,
  CODES.ACTIVITY_TYPE_MAPPING_MISSING,
  CODES.DATE_OF_BIRTH_INVALID,
  CODES.MOBILEPHONE_NEEDS_CORRECTION,
  CODES.MOBILEPHONE_INVALID,
  CODES.SALARY_INVALID,
  CODES.S1_NOT_ELIGIBLE,
  CODES.INVALID_CONTEXT,
  CODES.TRIGGER_ORIGIN_NOT_ENABLED,
]);

function isCdvEstado8RetryableFailure(code) {
  return (
    code === CODES.SEND_DISABLED ||
    code === CODES.CI_LOCK_BLOCKED ||
    code === CODES.CLIENT_THREW ||
    code === CODES.PERSIST_FAILED ||
    code === CODES.LEASE_EXPIRED ||
    code === CODES.LATE_RESULT_DISCARDED ||
    code === 'exception' ||
    code === CODES.SOLICITUD_NOT_FOUND ||
    code === CODES.TRANSPORT_ERROR ||
    code === CODES.HTTP_TIMEOUT
  );
}

function formatCdvEstado8QueueError(sendResult) {
  const code = sendResult && sendResult.code ? String(sendResult.code) : 'elm_send_blocked';
  const detail =
    sendResult && sendResult.detail != null && String(sendResult.detail).trim()
      ? String(sendResult.detail).trim()
      : '';
  const text = detail ? code + ': ' + detail : code;
  return text.slice(0, 500);
}

/**
 * @param {{ code?: string }} sendResult
 * @param {number} attemptNext
 * @param {number} maxAttempts
 * @returns {'failed'|'completed'|'skipped_ineligible'}
 */
function resolveCdvEstado8QueueTerminalStatus(sendResult, attemptNext, maxAttempts) {
  const code = sendResult && sendResult.code ? String(sendResult.code) : 'elm_send_blocked';
  if (code === CODES.PROCESS_EXISTS) return 'completed';
  if (isCdvEstado8RetryableFailure(code) && attemptNext < maxAttempts) return 'failed';
  if (isCdvEstado8RetryableFailure(code)) return 'failed';
  if (COMMERCIAL_TERMINAL_CODES.has(code)) return 'skipped_ineligible';
  return 'skipped_ineligible';
}

function toMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

function parseCzDateTime(raw) {
  const t = toMs(raw);
  return t != null ? new Date(t).toISOString() : null;
}

/**
 * From one CZ /solicitudes API payload page: earliest estado-8 signal per cz_id.
 * @param {object[]} items
 * @returns {Map<number, string>} cz_id → fechahora_estado8 ISO
 */
function detectEstado8CandidatesFromItems(items) {
  const byCz = new Map();
  const list = Array.isArray(items) ? items : [];
  const estado8 = PREAPROBADOS_ESTADO_ID;

  function consider(czId, fechahoraIso) {
    if (!Number.isSafeInteger(czId) || czId <= 0 || !fechahoraIso) return;
    const prev = byCz.get(czId);
    if (!prev || Date.parse(fechahoraIso) < Date.parse(prev)) {
      byCz.set(czId, fechahoraIso);
    }
  }

  for (const item of list) {
    if (!item || item.id == null) continue;
    const czId = Number(item.id);
    if (!Number.isFinite(czId)) continue;

    if (Number(item.solicitudes_estados_id) === estado8) {
      consider(
        czId,
        parseCzDateTime(item.fechaReg) || parseCzDateTime(item.updated) || new Date().toISOString(),
      );
    }

    const hist = Array.isArray(item.historico) ? item.historico : [];
    for (const row of hist) {
      if (Number(row && row.solicitudes_estados_id) !== estado8) continue;
      consider(czId, parseCzDateTime(row.fechahora) || new Date().toISOString());
    }
  }
  return byCz;
}

async function enqueueEstado8Candidates(candidateMap, config) {
  const excluded = new Set(
    (config.excludedCzSolicitudIds || []).map(function (id) {
      return Number(id);
    }),
  );
  let enqueued = 0;
  let skippedExcluded = 0;
  for (const [czId, fechahora] of candidateMap.entries()) {
    if (excluded.has(Number(czId))) {
      skippedExcluded += 1;
      continue;
    }
    const { data, error } = await supabase.rpc('cdv_estado8_elm_try_enqueue', {
      p_cz_solicitud_id: Number(czId),
      p_fechahora_estado8: fechahora,
    });
    if (error) {
      logger.warn('cdv_estado8_elm enqueue rpc failed', {
        cz_solicitud_id: czId,
        error: String(error.message).slice(0, 200),
      });
      continue;
    }
    if (data === true) enqueued += 1;
  }
  return { enqueued: enqueued, skippedExcluded: skippedExcluded, candidates: candidateMap.size };
}

/**
 * Funnel sync hook: detect + enqueue only (no ELM HTTP).
 * @param {Map<number, string>} candidateMap
 * @param {object} [deps]
 */
async function enqueueCdvEstado8FromSync(candidateMap, deps) {
  const d = deps || {};
  const config = d.config || readCdvEstado8ElmConfig();
  if (!config.automationEnabled) {
    return { ok: true, skipped: 'automation_disabled' };
  }
  if (!candidateMap || candidateMap.size === 0) {
    return { ok: true, skipped: 'no_candidates_in_batch' };
  }
  const enqueue = await enqueueEstado8Candidates(candidateMap, config);
  return { ok: true, enqueue: enqueue };
}

function terminalSkipFromHold(hold) {
  if (!hold || !hold.reason) return false;
  const permanent = new Set([
    'elm_ci_active',
    'elm_ci_monthly_quota_used',
    'elm_ci_recent_send',
  ]);
  return permanent.has(String(hold.reason));
}

function createOrchestrator(config) {
  const origins = ENABLED_TRIGGER_ORIGINS.concat([config.triggerOrigin]);
  return createElmOrchestrator({
    repository: createElmRepository(),
    enabledTriggerOrigins: origins,
  });
}

async function loadCiHold(ci, czId, nowMs, sbClient) {
  const cis = [Number(ci)].filter(function (n) {
    return Number.isSafeInteger(n) && n > 0;
  });
  if (!cis.length) {
    return { reason: 'elm_ci_history_unverifiable', related_cz_solicitud_id: null };
  }
  const rows = await readElmSendRowsByCis(sbClient || supabase, cis);
  return evaluateCiResendHold({
    ci: Number(ci),
    czSolicitudId: Number(czId),
    processes: rows.processes,
    states: rows.states,
    openRequests: rows.openRequests,
    locks: rows.locks,
    nowMs: nowMs,
    postReferralRejectionStatuses: readPostReferralRejectionStatuses(),
  });
}

async function reconcileStaleProcessing(nowMs, sbClient) {
  const db = sbClient || supabase;
  const cutoff = new Date(nowMs - STALE_PROCESSING_MS).toISOString();
  const { error } = await db
    .from(QUEUE_TABLE)
    .update({ status: 'failed', last_error: 'stale_processing_reset' })
    .eq('status', 'processing')
    .lt('last_attempt_at', cutoff);
  if (error) {
    logger.warn('cdv_estado8_elm stale processing reset failed', {
      error: String(error.message).slice(0, 200),
    });
  }
}

/**
 * Provider-fallback worker cron: drain cdv_estado8_elm_queue (no provider_fallback / no C1).
 * sendElm on an existing process never starts a second S1 for that solicitud (PROCESS_EXISTS);
 * elm_claim_process + CI lock block a second S1 for another solicitud of the same CI.
 *
 * @param {object} [deps]
 */
async function processCdvEstado8ElmQueue(deps) {
  const d = deps || {};
  const sb = d.supabase || supabase;
  const config = d.config || readCdvEstado8ElmConfig();
  if (!config.automationEnabled) {
    return { ok: true, skipped: 'automation_disabled' };
  }
  const excludedSet = new Set(
    (config.excludedCzSolicitudIds || []).map(function (id) {
      return Number(id);
    }),
  );
  const orchestrator = d.orchestrator || createOrchestrator(config);
  const nowMs = d.nowMs != null ? Number(d.nowMs) : Date.now();

  await reconcileStaleProcessing(nowMs, sb);

  const { data: queueRows, error: qErr } = await sb
    .from(QUEUE_TABLE)
    .select('cz_solicitud_id, attempts, status')
    .in('status', ['pending', 'failed'])
    .lt('attempts', config.maxAttempts)
    .order('fechahora_estado8', { ascending: true })
    .limit(config.batchLimit);
  if (qErr) {
    logger.error('cdv_estado8_elm queue read failed', { error: qErr.message });
    return { ok: false, error: 'queue_read_failed' };
  }

  const processed = [];
  for (const row of queueRows || []) {
    const czId = Number(row.cz_solicitud_id);
    if (excludedSet.has(czId)) {
      await sb
        .from(QUEUE_TABLE)
        .update({ status: 'skipped_excluded', last_attempt_at: new Date().toISOString() })
        .eq('cz_solicitud_id', czId);
      processed.push({ cz_solicitud_id: czId, status: 'skipped_excluded' });
      continue;
    }

    const { data: sol } = await sb
      .from('cz_funnel_solicitudes')
      .select('cz_id, ci')
      .eq('cz_id', czId)
      .maybeSingle();
    const ci = sol && sol.ci != null ? Number(sol.ci) : null;
    if (!ci) {
      await sb
        .from(QUEUE_TABLE)
        .update({
          status: 'failed',
          attempts: Number(row.attempts || 0) + 1,
          last_attempt_at: new Date().toISOString(),
          last_error: 'solicitud_not_found',
        })
        .eq('cz_solicitud_id', czId);
      processed.push({ cz_solicitud_id: czId, status: 'failed', code: 'solicitud_not_found' });
      continue;
    }

    const hold = await loadCiHold(ci, czId, nowMs, sb);
    if (hold) {
      if (terminalSkipFromHold(hold)) {
        await sb
          .from(QUEUE_TABLE)
          .update({
            status: 'skipped_hold',
            last_attempt_at: new Date().toISOString(),
            last_error: String(hold.reason).slice(0, 200),
          })
          .eq('cz_solicitud_id', czId);
        processed.push({ cz_solicitud_id: czId, status: 'skipped_hold', hold: hold.reason });
        continue;
      }
      await sb
        .from(QUEUE_TABLE)
        .update({
          attempts: Number(row.attempts || 0) + 1,
          last_attempt_at: new Date().toISOString(),
          last_error: 'hold:' + String(hold.reason).slice(0, 180),
        })
        .eq('cz_solicitud_id', czId);
      processed.push({ cz_solicitud_id: czId, status: 'deferred', hold: hold.reason });
      continue;
    }

    await sb
      .from(QUEUE_TABLE)
      .update({ status: 'processing', last_attempt_at: new Date().toISOString() })
      .eq('cz_solicitud_id', czId)
      .in('status', ['pending', 'failed']);

    let sendResult;
    try {
      sendResult = await orchestrator.sendElm(czId, { triggerOrigin: config.triggerOrigin });
    } catch (err) {
      sendResult = {
        ok: false,
        code: 'exception',
        detail: err && err.message ? String(err.message) : 'unknown',
      };
    }

    const attemptNext = Number(row.attempts || 0) + 1;
    if (sendResult.ok && !sendResult.s2_blocked) {
      const { data: proc } = await sb
        .from('elm_lead_processes')
        .select('id')
        .eq('cz_solicitud_id', czId)
        .maybeSingle();
      await sb
        .from(QUEUE_TABLE)
        .update({
          status: 'completed',
          attempts: attemptNext,
          last_attempt_at: new Date().toISOString(),
          last_error: null,
          elm_process_id: proc && proc.id ? proc.id : null,
        })
        .eq('cz_solicitud_id', czId);
      processed.push({ cz_solicitud_id: czId, status: 'completed', stage: sendResult.stage || null });
      continue;
    }
    if (sendResult.ok && sendResult.s2_blocked) {
      const s2Code = String(sendResult.s2_blocked.code || 's2_blocked');
      const s2Blocked = { ok: false, code: s2Code, detail: null };
      const nextStatus =
        attemptNext < config.maxAttempts && isCdvEstado8RetryableFailure(s2Code)
          ? 'failed'
          : resolveCdvEstado8QueueTerminalStatus(s2Blocked, attemptNext, config.maxAttempts);
      await sb
        .from(QUEUE_TABLE)
        .update({
          status: nextStatus,
          attempts: attemptNext,
          last_attempt_at: new Date().toISOString(),
          last_error: formatCdvEstado8QueueError(s2Blocked),
        })
        .eq('cz_solicitud_id', czId);
      processed.push({
        cz_solicitud_id: czId,
        status: nextStatus,
        code: s2Code,
      });
      continue;
    }

    const code = sendResult.code || 'elm_send_blocked';
    const nextStatus =
      isCdvEstado8RetryableFailure(String(code)) && attemptNext < config.maxAttempts
        ? 'failed'
        : resolveCdvEstado8QueueTerminalStatus(sendResult, attemptNext, config.maxAttempts);

    let elmProcessId = null;
    if (nextStatus === 'completed') {
      if (sendResult.process && sendResult.process.id) {
        elmProcessId = sendResult.process.id;
      } else {
        const { data: procRow } = await sb
          .from('elm_lead_processes')
          .select('id')
          .eq('cz_solicitud_id', czId)
          .maybeSingle();
        elmProcessId = procRow && procRow.id ? procRow.id : null;
      }
    }

    await sb
      .from(QUEUE_TABLE)
      .update({
        status: nextStatus,
        attempts: attemptNext,
        last_attempt_at: new Date().toISOString(),
        last_error: nextStatus === 'completed' ? null : formatCdvEstado8QueueError(sendResult),
        elm_process_id: elmProcessId,
      })
      .eq('cz_solicitud_id', czId);
    processed.push({ cz_solicitud_id: czId, status: nextStatus, code: code });
  }

  return { ok: true, processed: processed, claimed: (queueRows || []).length };
}

module.exports = {
  detectEstado8CandidatesFromItems,
  enqueueEstado8Candidates,
  enqueueCdvEstado8FromSync,
  processCdvEstado8ElmQueue,
  formatCdvEstado8QueueError,
  resolveCdvEstado8QueueTerminalStatus,
  isCdvEstado8RetryableFailure,
};