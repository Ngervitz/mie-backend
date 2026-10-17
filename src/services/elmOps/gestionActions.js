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

const { retryManualToElm, sendManualToElm } = require('../../lib/elmManualSend');
const { loadCiResendHold } = require('../../lib/rejectedElmResendGuard');
const { S1_SUBCLASS, classifyS1Unknown, existingRetryApplies } = require('./s1UnknownClassify');
const { ACTION_HTTP } = require('./service');
const { S2, CODES } = require('../elm/constants');
const { planGestionSend, SEND_MODES } = require('./gestionElmSendPlan');
const { runAdminProviderResend } = require('./gestionAdminProviderSend');
const { classifyElmProcess, readPostReferralRejectionStatuses } = require('../elm/classification');

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

  function sendDeps() {
    if (d.sendDeps) return d.sendDeps;
    const supabase = require('../../clients/supabase');
    return {
      orchestrator: require('../elm/orchestrator').createElmOrchestrator(),
      listView: require('../elm/listView').createElmListView(),
      elmRepository: require('../elm/repository').createElmRepository(),
      loadCiResendHold: function (ci, czId, opts) {
        return loadCiResendHold(supabase, ci, czId, opts);
      },
    };
  }

  function retryDeps() {
    if (d.retryDeps) return d.retryDeps;
    const base = sendDeps();
    return {
      orchestrator: base.orchestrator,
      listView: base.listView,
      loadCiResendHold: base.loadCiResendHold,
    };
  }

  function providerRefOk(body) {
    const ref = body && typeof body.provider_reference === 'string' ? body.provider_reference.trim() : '';
    return ref.length >= 4 && ref.length <= 200;
  }

  async function buildSendContext(czId, body) {
    const ev = await loadEvidence(czId);
    const bag = evidenceBag(czId, ev);
    const deps = sendDeps();
    const status = await deps.orchestrator.getElmStatus(czId);
    const data = status && status.ok ? status.data : {};
    const process = ev.process;
    const ci =
      process && process.ci != null
        ? Number(process.ci)
        : data.eligibility && data.process
          ? Number(data.process && data.process.ci)
          : null;
    let ciFromSol = ci;
    if (!Number.isSafeInteger(ciFromSol) || ciFromSol <= 0) {
      try {
        const ctx = await deps.elmRepository.loadSolicitudContext(czId);
        if (ctx.solicitud && ctx.solicitud.ci != null) ciFromSol = Number(ctx.solicitud.ci);
      } catch (_) {
        ciFromSol = null;
      }
    }
    const gestionAuthorized = providerRefOk(body);
    let hold = null;
    if (Number.isSafeInteger(ciFromSol) && ciFromSol > 0) {
      const retryOwn =
        process &&
        (existingRetryApplies(bag) ||
          (process.s1_status === 'eligible' && process.s2_status === S2.NOT_STARTED) ||
          gestionAuthorized === true);
      hold = await deps.loadCiResendHold(ciFromSol, czId, {
        retryOwnProcess: retryOwn === true,
        gestionAuthorized: gestionAuthorized,
      });
    }
    const retrySafeS2 =
      process &&
      process.s2_status === S2.TECHNICAL_ERROR &&
      process.s2_attempts != null &&
      Number(process.s2_attempts) >= 1;
    const planInput = {
      czId: czId,
      ci: ciFromSol,
      process: process,
      bag: bag,
      readiness: deps.orchestrator.getSendReadiness(),
      hold: hold,
      eligibility: data.eligibility || { eligible: false, blockers: [] },
      gestionAuthorized: gestionAuthorized,
      retrySafeS2: retrySafeS2,
      s2ExpectedAttempts: process && process.s2_attempts != null ? Number(process.s2_attempts) : null,
    };
    const plan = planGestionSend(planInput);
    let intended_mode = plan.mode || null;
    if (!intended_mode && plan.hold && process) {
      const peek = planGestionSend(Object.assign({}, planInput, { hold: null }));
      intended_mode = peek.mode || null;
    }
    const planWithIntent = Object.assign({}, plan, {
      intended_mode: intended_mode,
    });
    const projected = ev.projected;
    const commercial = process
      ? classifyElmProcess(process, {
          projectedEstado:
            process.trigger_origin === 'cz_automatic' && projected != null ? projected : null,
          postReferralRejectionStatuses: readPostReferralRejectionStatuses(),
        })
      : null;
    return {
      ev: ev,
      bag: bag,
      deps: deps,
      plan: planWithIntent,
      ci: ciFromSol,
      gestionAuthorized: gestionAuthorized,
      commercial: commercial,
      cell: data.cell || null,
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

  async function getSendPreview(czSolicitudId, body) {
    const czId = parseCzId(czSolicitudId);
    if (czId == null) return { status: 'invalid_request' };
    const ctx = await buildSendContext(czId, body || {});
    const p = ctx.plan;
    return {
      status: 'preview',
      cz_solicitud_id: czId,
      ci: ctx.ci != null ? String(ctx.ci) : null,
      can_send: p.can_send === true,
      code: p.code || null,
      mode: p.mode || null,
      intended_mode: p.intended_mode || p.mode || null,
      steps: p.steps || [],
      s1_status: p.s1_status || (ctx.ev.process && ctx.ev.process.s1_status) || null,
      s2_status: p.s2_status || (ctx.ev.process && ctx.ev.process.s2_status) || null,
      last_send_at: p.last_send_at || null,
      duplicate_warning: p.duplicate_warning || null,
      warnings: p.warnings || [],
      hold: p.hold || null,
      fields: p.fields || null,
      expected_attempts: p.expected_attempts != null ? p.expected_attempts : null,
      commercial: ctx.commercial,
      provider_reference_required_for_hold:
        p.hold &&
        (p.hold.reason === 'elm_ci_recent_send' || p.hold.reason === 'elm_ci_monthly_quota_used'),
      expected_updated_at: p.expected_updated_at || null,
      requires_provider_reference: p.requires_provider_reference === true,
    };
  }

  async function recordSendAudit(czId, actorUserId, detail) {
    const ev = await loadEvidence(czId);
    const processId = ev.process && ev.process.id;
    if (!processId || typeof repo.appendGestionSendAudit !== 'function') {
      logger.info('gestion elm send audit (log only)', Object.assign({ cz_solicitud_id: czId }, detail));
      return;
    }
    try {
      await repo.appendGestionSendAudit({
        entity_id: processId,
        cz_solicitud_id: czId,
        actor_user_id: actorUserId,
        detail: detail,
      });
    } catch (err) {
      logger.warn('gestion elm send audit insert failed', {
        cz_solicitud_id: czId,
        error: err && err.message ? String(err.message).slice(0, 120) : 'unknown',
      });
    }
  }

  /**
   * Gestión ELM «Enviar a ELM». body: { confirm, provider_reference?, confirm_duplicate? }
   */
  async function sendToElm(czSolicitudId, body, actorUserId) {
    const czId = parseCzId(czSolicitudId);
    if (czId == null || !actorUserId) return { status: 'invalid_request' };
    if (!confirmed(body)) return { status: 'confirm_required' };
    const preview = await getSendPreview(czId, body);
    if (preview.can_send !== true) {
      return Object.assign({ status: 'send_not_allowed' }, preview);
    }
    if (preview.hold && preview.provider_reference_required_for_hold && !providerRefOk(body)) {
      return { status: 'provider_reference_required', hold: preview.hold };
    }
    if (preview.requires_provider_reference === true && !providerRefOk(body)) {
      return { status: 'provider_reference_required' };
    }
    if (preview.mode === SEND_MODES.ADMIN_PROVIDER_RESEND) {
      const expected =
        typeof body.expected_updated_at === 'string' ? body.expected_updated_at.trim() : '';
      if (!expected) {
        return { status: 'invalid_request', code: CODES.ADMIN_PROVIDER_RESEND_STALE };
      }
    }
    if (preview.duplicate_warning && body.confirm_duplicate !== true) {
      return { status: 'confirm_duplicate_required', preview: preview };
    }

    return withLock(czId, async function () {
      const ctx = await buildSendContext(czId, body);
      const plan = ctx.plan;
      if (plan.can_send !== true) {
        return Object.assign({ status: 'stale' }, plan);
      }
      if (plan.mode === SEND_MODES.ADMIN_PROVIDER_RESEND) {
        if (!providerRefOk(body)) {
          return { status: 'provider_reference_required' };
        }
        const expected =
          typeof body.expected_updated_at === 'string' ? body.expected_updated_at.trim() : '';
        if (!expected || (plan.expected_updated_at && expected !== plan.expected_updated_at)) {
          return { status: 'stale', code: CODES.ADMIN_PROVIDER_RESEND_STALE };
        }
      }
      const deps = ctx.deps;
      const resolveMember = async function () {
        if (!Number.isSafeInteger(ctx.ci) || ctx.ci <= 0) {
          return { status: 422, body: { ok: false, code: 'missing_ci' } };
        }
        return { ci: ctx.ci };
      };
      const holdOpts = {
        retryOwnProcess: plan.mode !== SEND_MODES.FULL,
        gestionAuthorized: ctx.gestionAuthorized,
      };
      let out;
      if (plan.mode === SEND_MODES.RETRY_S1) {
        out = await retryManualToElm(deps, {
          czSolicitudId: czId,
          expectedAttempts: plan.expected_attempts,
          actorUserId: actorUserId,
          resolveMember: resolveMember,
        });
      } else if (plan.mode === SEND_MODES.RETRY_S2) {
        const orchOut = await deps.orchestrator.retryElmStep(
          czId,
          { triggerOrigin: 'janus_manual', triggeredByUserId: actorUserId },
          { step: 's2', expectedAttempts: plan.expected_attempts },
        );
        const cells = await deps.listView.cellsForCzIds([czId], { allowSend: true });
        out = {
          status: orchOut.ok ? 200 : 409,
          body: {
            ok: orchOut.ok === true,
            code: orchOut.code || null,
            outcome: orchOut.ok ? 'referred' : 'blocked',
            cz_solicitud_id: czId,
            cell: cells.get(czId) || null,
            mode: plan.mode,
          },
        };
      } else if (plan.mode === SEND_MODES.ADMIN_PROVIDER_RESEND) {
        out = await runAdminProviderResend(
          {
            orchestrator: deps.orchestrator,
            elmRepository: deps.elmRepository,
            listView: deps.listView,
          },
          {
            czSolicitudId: czId,
            actorUserId: actorUserId,
            providerReference: String(body.provider_reference).trim(),
            expectedUpdatedAt: String(body.expected_updated_at).trim(),
          },
        );
      } else {
        const preHold = await deps.loadCiResendHold(ctx.ci, czId, holdOpts);
        if (preHold && !ctx.gestionAuthorized) {
          return {
            status: 'send_not_allowed',
            code: preHold.reason,
            hold: preHold,
          };
        }
        out = await sendManualToElm(
          Object.assign({}, deps, {
            loadCiResendHold: function (ci, id) {
              return deps.loadCiResendHold(ci, id, holdOpts);
            },
          }),
          {
            czSolicitudId: czId,
            actorUserId: actorUserId,
            resolveMember: resolveMember,
          },
        );
      }

      const bodyOut = out.body || {};
      await recordSendAudit(czId, actorUserId, {
        mode: plan.mode,
        provider_reference: ctx.gestionAuthorized ? String(body.provider_reference).trim() : null,
        ok: bodyOut.ok === true,
        code: bodyOut.code || null,
        outcome: bodyOut.outcome || null,
        stage: bodyOut.stage || null,
      });
      logger.info('gestion elm send', {
        cz_solicitud_id: czId,
        mode: plan.mode,
        http_status: out.status,
        ok: bodyOut.ok,
        code: bodyOut.code,
      });
      return Object.assign(
        {
          status: out.status === 200 ? 'sent' : 'send_failed',
          http_status: out.status,
          mode: plan.mode,
        },
        bodyOut,
      );
    });
  }

  return { closeS1AsRejected, retryS1, getSendPreview, sendToElm };
}

const GESTION_ACTION_HTTP = Object.assign({}, ACTION_HTTP, {
  retried: 200,
  sent: 200,
  preview: 200,
  confirm_required: 400,
  confirm_duplicate_required: 400,
  provider_reference_required: 400,
  send_not_allowed: 409,
  send_failed: 409,
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
