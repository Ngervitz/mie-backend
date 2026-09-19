'use strict';

/**
 * Shared catch-up evaluation + optional materialize for Encuesta 3-step sequence.
 * Used by job and POST /rechazados/:ci/survey-invite.
 *
 * Pipeline (strict):
 * 1 T0 → 2 age → 3 single dueStep → 4 attempts → 5 previous unresolved
 * → 6 eligibility(due campaign) → 7 materialize at most that dueStep
 */

const { normalizeCi } = require('./rejectedOps');
const {
  PURPOSE,
  REASONS,
  REJECTED_ESTADO_ID,
  resolveCurrentLastRejectionForCi,
  evaluateRejectedSurveyInviteEligibility,
  nullableTrimmedText,
} = require('./rejectedSurveyInvite');
const {
  resolveDueSurveyInviteStep,
  findPreviousUnresolvedSurveyInvite,
  isStuckPendingSurveyInvite,
  isSurveyInviteSequenceComplete,
  classifySurveyInviteAttemptKind,
  ATTEMPT_KIND,
  SEQUENCE_REASONS,
} = require('./rejectedSurveyInviteSequence');
const {
  resolveNormalCutoffAt,
  isT0AtOrAfterNormalCutoff,
} = require('./rejectedSurveyInviteNormalCutoff');
const eligibilityIo = require('./rejectedSurveyInviteEligibility');
const { materializeRejectedSurveyInvite } = require('./rejectedSurveyInviteMaterialize');
const { normalizeEmail } = require('../services/email-campaigns/unsubscribeToken');

/**
 * Pure decision given snapshot (no I/O).
 *
 * @param {{
 *   ci: number,
 *   now: Date,
 *   lastRejection: object|null,
 *   solicitud: object|null,
 *   hasEncuesta: boolean,
 *   isSuppressed: boolean,
 *   stepCampaignIds: {1:string|null,2:string|null,3:string|null},
 *   attemptsByStep: {1:object|null,2:object|null,3:object|null},
 *   publicBaseUrlConfigured: boolean,
 *   normalCutoffAtMs?: number|null,
 *   normalCutoff?: { ok: boolean, ms?: number },
 * }} input
 */
function decideSurveyInviteSequenceAction(input) {
  const ci = input.ci;
  const base = {
    ci: ci,
    due_step: null,
    campaign_id: null,
    action: 'skip',
    result: REASONS.NO_CURRENT_REJECTION,
    stuck_pending: false,
    previous_step: null,
    eligible: false,
    repairable: false,
    email_masked: null,
  };

  if (!input.lastRejection) {
    return Object.assign({}, base, {
      result: REASONS.NO_CURRENT_REJECTION,
    });
  }

  let cutoffOk = false;
  let cutoffMs = null;
  if (input.normalCutoff && typeof input.normalCutoff === 'object') {
    cutoffOk = input.normalCutoff.ok === true;
    cutoffMs =
      cutoffOk && Number.isFinite(input.normalCutoff.ms)
        ? input.normalCutoff.ms
        : null;
  } else if (
    input.normalCutoffAtMs != null &&
    Number.isFinite(Number(input.normalCutoffAtMs))
  ) {
    cutoffOk = true;
    cutoffMs = Number(input.normalCutoffAtMs);
  }

  if (!cutoffOk || cutoffMs == null) {
    return Object.assign({}, base, {
      action: 'skip',
      result: SEQUENCE_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
    });
  }

  const atOrAfter = isT0AtOrAfterNormalCutoff(
    input.lastRejection.fechahora_src,
    cutoffMs,
  );
  if (atOrAfter !== true) {
    return Object.assign({}, base, {
      action: 'skip',
      result: SEQUENCE_REASONS.BEFORE_NORMAL_CUTOFF,
    });
  }

  const dueStep = resolveDueSurveyInviteStep(
    input.lastRejection.fechahora_src,
    input.now,
  );
  if (dueStep == null) {
    return Object.assign({}, base, {
      action: 'skip',
      result: SEQUENCE_REASONS.NOT_DUE,
    });
  }

  const attempts = input.attemptsByStep || { 1: null, 2: null, 3: null };

  if (isSurveyInviteSequenceComplete(attempts)) {
    return Object.assign({}, base, {
      due_step: dueStep,
      action: 'skip',
      result: SEQUENCE_REASONS.SEQUENCE_COMPLETE,
    });
  }

  const dueCampaignId =
    input.stepCampaignIds && input.stepCampaignIds[dueStep]
      ? input.stepCampaignIds[dueStep]
      : null;
  if (!dueCampaignId) {
    return Object.assign({}, base, {
      due_step: dueStep,
      action: 'skip',
      result: REASONS.CAMPAIGN_NOT_CONFIGURED,
    });
  }

  const prev = findPreviousUnresolvedSurveyInvite(attempts, dueStep);
  if (prev) {
    const stuck = isStuckPendingSurveyInvite(prev.recipient, input.now);
    return Object.assign({}, base, {
      due_step: dueStep,
      campaign_id: dueCampaignId,
      action: 'skip',
      result: SEQUENCE_REASONS.PREVIOUS_PENDING,
      previous_step: prev.step,
      stuck_pending: stuck,
    });
  }

  const priorRecipient = attempts[dueStep] || null;
  const elig = evaluateRejectedSurveyInviteEligibility({
    ci: ci,
    campaignId: dueCampaignId,
    publicBaseUrlConfigured: Boolean(input.publicBaseUrlConfigured),
    lastRejection: input.lastRejection,
    solicitud: input.solicitud,
    hasEncuesta: Boolean(input.hasEncuesta),
    isSuppressed: Boolean(input.isSuppressed),
    priorRecipient: priorRecipient,
  });

  if (!elig.eligible) {
    return Object.assign({}, base, {
      due_step: dueStep,
      campaign_id: dueCampaignId,
      action: 'skip',
      result: elig.reason,
      eligible: false,
      repairable: false,
      email_masked: elig.email_masked,
    });
  }

  return Object.assign({}, base, {
    due_step: dueStep,
    campaign_id: dueCampaignId,
    action: 'materialize',
    result: REASONS.ELIGIBLE,
    eligible: true,
    repairable: Boolean(elig.repairable),
    email_masked: elig.email_masked,
  });
}

/**
 * Load Janus snapshot + attempts for one CI, then decide.
 */
async function evaluateSurveyInviteSequenceForCi(supabase, ciRaw, opts) {
  const options = opts || {};
  const now = options.now || new Date();
  const normalCutoff =
    options.normalCutoff ||
    resolveNormalCutoffAt({
      cutoffRaw: options.cutoffRaw,
      cutoffMs: options.cutoffMs,
      env: options.env,
    });
  const ci = normalizeCi(ciRaw);
  if (ci == null) {
    return decideSurveyInviteSequenceAction({
      ci: null,
      now: now,
      lastRejection: null,
      solicitud: null,
      hasEncuesta: false,
      isSuppressed: false,
      stepCampaignIds: eligibilityIo.getAllSurveyInviteStepCampaignIds(),
      attemptsByStep: { 1: null, 2: null, 3: null },
      publicBaseUrlConfigured: Boolean(eligibilityIo.getEmailPublicBaseUrl()),
      normalCutoff: normalCutoff,
    });
  }

  const stepCampaignIds =
    options.stepCampaignIds ||
    eligibilityIo.getAllSurveyInviteStepCampaignIds();
  const publicBase = eligibilityIo.getEmailPublicBaseUrl();

  const { data: estadoRows, error: estErr } = await supabase
    .from('cz_funnel_solicitud_estados')
    .select(
      'cz_historico_id, cz_solicitud_id, fechahora_src, solicitudes_estados_id',
    )
    .eq('solicitudes_estados_id', REJECTED_ESTADO_ID);
  if (estErr) throw new Error('sequence estados: ' + estErr.message);

  const { data: solicitudRows, error: solErr } = await supabase
    .from('cz_funnel_solicitudes')
    .select('cz_id, ci, email, lrw_id, nombre');
  if (solErr) throw new Error('sequence solicitudes: ' + solErr.message);

  const last = resolveCurrentLastRejectionForCi(
    estadoRows || [],
    solicitudRows || [],
    ci,
  );
  let solicitud = null;
  if (last) {
    solicitud =
      (solicitudRows || []).find(function (s) {
        return Number(s.cz_id) === Number(last.cz_solicitud_id);
      }) || null;
  }

  const { count: encCount, error: encErr } = await supabase
    .from('cz_funnel_encuestas')
    .select('cz_id', { count: 'exact', head: true })
    .eq('ci', ci);
  if (encErr) throw new Error('sequence encuestas: ' + encErr.message);
  const hasEncuesta = Number(encCount) > 0;

  const emailNorm = solicitud
    ? normalizeEmail(nullableTrimmedText(solicitud.email) || '')
    : '';
  let isSuppressed = false;
  if (emailNorm) {
    const { data: sup, error: supErr } = await supabase
      .from('email_suppressions')
      .select('id')
      .eq('email', emailNorm)
      .maybeSingle();
    if (supErr) throw new Error('sequence suppressions: ' + supErr.message);
    isSuppressed = Boolean(sup);
  }

  const attemptsByStep = { 1: null, 2: null, 3: null };
  const configuredIds = [1, 2, 3]
    .map(function (s) {
      return stepCampaignIds[s];
    })
    .filter(Boolean);
  if (configuredIds.length) {
    const { data: priors, error: pErr } = await supabase
      .from('email_campaign_recipients')
      .select(
        'id, campaign_id, ci, email, status, error_reason, purpose, created_at, last_attempt_at, next_attempt_at',
      )
      .in('campaign_id', configuredIds)
      .eq('purpose', PURPOSE)
      .eq('ci', String(ci));
    if (pErr) throw new Error('sequence recipients: ' + pErr.message);
    const latestByCampaign = new Map();
    for (const p of priors || []) {
      const key = String(p.campaign_id);
      const prev = latestByCampaign.get(key);
      if (
        !prev ||
        String(p.created_at || '') > String(prev.created_at || '')
      ) {
        latestByCampaign.set(key, p);
      }
    }
    for (let s = 1; s <= 3; s += 1) {
      const cid = stepCampaignIds[s];
      if (!cid) continue;
      attemptsByStep[s] = latestByCampaign.get(String(cid)) || null;
    }
  }

  return decideSurveyInviteSequenceAction({
    ci: ci,
    now: now,
    lastRejection: last,
    solicitud: solicitud,
    hasEncuesta: hasEncuesta,
    isSuppressed: isSuppressed,
    stepCampaignIds: stepCampaignIds,
    attemptsByStep: attemptsByStep,
    publicBaseUrlConfigured: Boolean(publicBase),
    normalCutoff: normalCutoff,
  });
}

/**
 * Evaluate then materialize at most one due step (shared by job + POST).
 */
async function runSurveyInviteSequenceForCi(supabase, ciRaw, opts) {
  const decision = await evaluateSurveyInviteSequenceForCi(
    supabase,
    ciRaw,
    opts,
  );
  if (decision.action !== 'materialize' || !decision.campaign_id) {
    return {
      ok: false,
      result: decision.result,
      due_step: decision.due_step,
      campaign_id: decision.campaign_id,
      stuck_pending: decision.stuck_pending === true,
      previous_step: decision.previous_step,
      email_masked: decision.email_masked,
      recipient_id: null,
      materialized: false,
    };
  }

  const outcome = await materializeRejectedSurveyInvite(
    supabase,
    ciRaw,
    decision.campaign_id,
  );
  return Object.assign({}, outcome, {
    due_step: decision.due_step,
    campaign_id: decision.campaign_id,
    stuck_pending: false,
    previous_step: null,
    materialized:
      outcome.ok === true &&
      (outcome.result === 'queued' ||
        outcome.result === REASONS.ALREADY_PENDING),
  });
}

module.exports = {
  decideSurveyInviteSequenceAction,
  evaluateSurveyInviteSequenceForCi,
  runSurveyInviteSequenceForCi,
  PURPOSE,
  REASONS,
  SEQUENCE_REASONS,
  ATTEMPT_KIND,
  classifySurveyInviteAttemptKind,
};
