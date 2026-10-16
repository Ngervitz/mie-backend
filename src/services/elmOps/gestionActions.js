'use strict';

/**
 * Stage B admin actions for Gestión ELM. One solicitud per call. No mass resend.
 *
 *   closeS1AsRejected  — only with documented S1 commercial rejection + open review in CZ 14.
 *                        Uses provider_review_resolve (14→3) and, when the process is still
 *                        s1_unknown, elm_resolve_process (unblock CI). Never calls ELM.
 *   retryS1            — only when elm_manual_retry_s1 applies (pre-reception, janus_manual).
 *                        Reuses the same process. Never creates another solicitud.
 *
 * requireElmAction (admin, human session) is the caller's gate. Versions / attempt counts
 * the operator saw are re-checked; a concurrent change answers stale.
 */

const { retryManualToElm } = require('../../lib/elmManualSend');
const { loadCiResendHold } = require('../../lib/rejectedElmResendGuard');
const { S1_SUBCLASS, classifyS1Unknown, existingRetryApplies } = require('./s1UnknownClassify');
const { ACTION_HTTP } = require('./service');

const CLOSE_RESOLUTION = 'resolved_with_provider';
const PROCESS_UNBLOCK_RESOLUTION = 'other';
const acting = new Set();

function parseCzId(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function confirmed(body) {
  return body && body.confirm === true;
}

/**
 * @param {{
 *   repository?: object,
 *   elmRepository?: object,
 *   retryDeps?: {
 *     orchestrator: object,
 *     listView: object,
 *     loadCiResendHold?: Function,
 *   },
 *   logger?: object,
 * }} [deps]
 */
function createGestionActions(deps) {
  const d = deps || {};
  const repo = d.repository || require('./repository').createElmOpsRepository();
  const elmRepo = d.elmRepository || require('../elm/repository').createElmRepository();
  const logger = d.logger || require('../../lib/logger');

  function retryDeps() {
    if (d.retryDeps) return d.retryDeps;
    const supabase = require('../../clients/supabase');
    return {
      orchestrator: require('../elm/orchestrator').createElmOrchestrator(),
      listView: require('../elm/listView').createElmListView(),
      loadCiResendHold: function (ci, czId, opts) {
        return loadCiResendHold(supabase, ci, czId, opts);
      },
    };
  }

  async function loadEvidence(czId) {
    const [process, review, projected] = await Promise.all([
      typeof repo.getProcessByCzId === 'function'
        ? repo.getProcessByCzId(czId)
        : elmRepo.getProcessByCzId(czId),
      typeof repo.getOpenReviewCaseByCzId === 'function'
        ? repo.getOpenReviewCaseByCzId(czId)
        : Promise.resolve(null),
      elmRepo.getProjectedEstadosByCzIds([czId]),
    ]);
    return {
      process: process,
      review: review,
      projected: projected.has(czId) ? Number(projected.get(czId)) : null,
    };
  }

  function evidenceBag(czId, ev) {
    const p = ev.process || {};
    const c = ev.review || {};
    return {
      cz_solicitud_id: czId,
      s1_status: p.s1_status || null,
      s2_status: p.s2_status || null,
      s1_result_message: p.s1_result_message || null,
      s1_error_code: p.s1_error_code || null,
      s1_http_status: p.s1_http_status,
      s1_attempts: p.s1_attempts,
      s1_started_at: p.s1_started_at || null,
      ops_resolved_at: p.ops_resolved_at || null,
      trigger_origin: p.trigger_origin || null,
      process_id: p.id || null,
      process_updated_at: p.updated_at || null,
      review_id: c.id || null,
      review_version: c.version,
      reason_code: c.reason_code || null,
      projected_estado: ev.projected,
    };
  }

  async function withLock(czId, fn) {
    if (acting.has(czId)) return { status: 'in_flight' };
    acting.add(czId);
    try {
      return await fn();
    } finally {
      acting.delete(czId);
    }
  }

  /**
   * Close a misclassified definitive S1 rejection. No ELM call.
   * body: { confirm: true, note, expected_version, expected_updated_at? }
   */
  async function closeS1AsRejected(czSolicitudId, body, actorUserId) {
    const czId = parseCzId(czSolicitudId);
    if (czId == null || !actorUserId) return { status: 'invalid_request' };
    if (!confirmed(body)) return { status: 'confirm_required' };
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length < 10 || note.length > 2000) return { status: 'note_required' };
    const expectedVersion = Number(body.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return { status: 'invalid_request' };
    }

    return withLock(czId, async function () {
      const ev = await loadEvidence(czId);
      const bag = evidenceBag(czId, ev);
      if (classifyS1Unknown(bag) !== S1_SUBCLASS.DEFINITIVE_REJECT) {
        return { status: 'not_definitive', cz_solicitud_id: czId };
      }
      if (!ev.review || ev.review.status !== 'open') {
        return { status: 'no_review_case', cz_solicitud_id: czId };
      }
      if (ev.projected !== 14) {
        return { status: 'cz_outcome_not_applicable', cz_solicitud_id: czId, projected_estado: ev.projected };
      }
      if (Number(ev.review.version) !== expectedVersion) return { status: 'stale' };

      const reviewOut = await repo.resolveReviewCase({
        caseId: ev.review.id,
        expectedVersion: expectedVersion,
        resolutionCode: CLOSE_RESOLUTION,
        note: note,
        actorUserId: actorUserId,
        czOutcome: 'rejected',
      });
      if (reviewOut.status !== 'resolved') return reviewOut;

      let processOut = null;
      if (ev.process && !ev.process.ops_resolved_at && ev.process.s1_status === 'unknown') {
        const expectedUpdatedAt =
          typeof body.expected_updated_at === 'string' && body.expected_updated_at
            ? body.expected_updated_at
            : ev.process.updated_at;
        processOut = await repo.resolveProcess({
          processId: ev.process.id,
          expectedUpdatedAt: expectedUpdatedAt,
          resolutionCode: PROCESS_UNBLOCK_RESOLUTION,
          note: note,
          actorUserId: actorUserId,
          czOutcome: 'none',
        });
      }

      logger.info('gestion elm close s1 as rejected', {
        cz_solicitud_id: czId,
        review_id: ev.review.id,
        process_id: ev.process ? ev.process.id : null,
        review_status: reviewOut.status,
        process_status: processOut && processOut.status,
      });
      return {
        status: 'resolved',
        cz_solicitud_id: czId,
        review: reviewOut,
        process: processOut,
        sent_to_elm: false,
      };
    });
  }

  /**
   * Retry the same S1 when ELM never received it. body: { confirm: true, expected_attempts }
   */
  async function retryS1(czSolicitudId, body, actorUserId) {
    const czId = parseCzId(czSolicitudId);
    if (czId == null || !actorUserId) return { status: 'invalid_request' };
    if (!confirmed(body)) return { status: 'confirm_required' };
    const expectedAttempts = Number(body.expected_attempts);
    if (!Number.isInteger(expectedAttempts) || expectedAttempts < 1) {
      return { status: 'invalid_request' };
    }

    return withLock(czId, async function () {
      const ev = await loadEvidence(czId);
      const bag = evidenceBag(czId, ev);
      if (!existingRetryApplies(bag)) {
        return { status: 'retry_not_allowed', cz_solicitud_id: czId };
      }
      if (Number(ev.process.s1_attempts) !== expectedAttempts) return { status: 'stale' };

      const deps = retryDeps();
      const out = await retryManualToElm(deps, {
        czSolicitudId: czId,
        expectedAttempts: expectedAttempts,
        actorUserId: actorUserId,
        resolveMember: async function () {
          return { ci: ev.process.ci };
        },
      });
      logger.info('gestion elm retry s1', {
        cz_solicitud_id: czId,
        process_id: ev.process.id,
        http_status: out.status,
        code: out.body && out.body.code,
      });
      return Object.assign({ status: out.body && out.body.ok ? 'retried' : out.body && out.body.code || 'retry_failed' }, out.body, {
        http_status: out.status,
      });
    });
  }

  return { closeS1AsRejected, retryS1 };
}

const GESTION_ACTION_HTTP = Object.assign({}, ACTION_HTTP, {
  retried: 200,
  confirm_required: 400,
  not_definitive: 409,
  no_review_case: 409,
  retry_not_allowed: 409,
  retry_failed: 409,
});

module.exports = {
  createGestionActions,
  GESTION_ACTION_HTTP,
  CLOSE_RESOLUTION,
};
