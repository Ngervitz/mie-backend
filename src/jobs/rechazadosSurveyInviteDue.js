'use strict';

/**
 * Job: rechazados_survey_invite_due
 * Cadence: cron-job.org → POST /jobs/run-rechazados-survey-invite-due
 *
 * Catch-up materialize for Encuesta 3-step sequence.
 * Does NOT call processQueue / provider.
 */

const { randomUUID } = require('crypto');
const logger = require('../lib/logger');
const {
  PURPOSE,
  REASONS,
  REJECTED_ESTADO_ID,
  resolveLastRejectionByCi,
  nullableTrimmedText,
} = require('../lib/rejectedSurveyInvite');
const {
  resolveDueSurveyInviteStep,
  STEP1_MIN_MS,
  surveyInviteAgeMs,
} = require('../lib/rejectedSurveyInviteSequence');
const {
  decideSurveyInviteSequenceAction,
  SEQUENCE_REASONS,
} = require('../lib/rejectedSurveyInviteEvaluate');
const eligibilityIo = require('../lib/rejectedSurveyInviteEligibility');
const {
  materializeRejectedSurveyInvite,
} = require('../lib/rejectedSurveyInviteMaterialize');
const {
  normalizeEmail,
} = require('../services/email-campaigns/unsubscribeToken');
const {
  resolveNormalCutoffAt,
} = require('../lib/rejectedSurveyInviteNormalCutoff');

const JOB_NAME = 'rechazados_survey_invite_due';
const JOB_LOCK_TTL_SECONDS = 10 * 60;

function getSupabase(override) {
  if (override) return override;
  return require('../clients/supabase');
}

async function acquireJobLock(lockedBy, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { data, error } = await supabase.rpc('acquire_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
    p_ttl_seconds: JOB_LOCK_TTL_SECONDS,
  });
  if (error) {
    throw new Error('acquire_job_lock failed: ' + error.message);
  }
  return data === true;
}

async function releaseJobLock(lockedBy, supabaseOverride) {
  const supabase = getSupabase(supabaseOverride);
  const { error } = await supabase.rpc('release_job_lock', {
    p_job_name: JOB_NAME,
    p_locked_by: lockedBy,
  });
  if (error) {
    logger.error('release_job_lock failed', {
      jobName: JOB_NAME,
      lockedBy: lockedBy,
      error: error.message,
    });
  }
}

function emptyCounters() {
  return {
    ok: true,
    candidates: 0,
    not_due: 0,
    before_normal_cutoff: 0,
    eligible: 0,
    materialized_step1: 0,
    materialized_step2: 0,
    materialized_step3: 0,
    already_attempted: 0,
    previous_pending: 0,
    stuck_pending_over_threshold: 0,
    survey_completed: 0,
    suppressed: 0,
    config_missing: 0,
    sequence_complete: 0,
    errors: 0,
  };
}

function bumpAlreadyAttempted(counters, reason) {
  if (
    reason === REASONS.ALREADY_PENDING ||
    reason === REASONS.ALREADY_SENT ||
    reason === REASONS.PRIOR_ATTEMPT_BLOCKS
  ) {
    counters.already_attempted += 1;
    return true;
  }
  return false;
}

/**
 * @param {{
 *   supabase?: object,
 *   now?: Date,
 *   acquireLockFn?: Function,
 *   releaseLockFn?: Function,
 *   skipLock?: boolean,
 *   materializeFn?: Function,
 * }} [opts]
 */
/**
 * @param {{
 *   supabase?: object,
 *   now?: Date,
 *   acquireLockFn?: Function,
 *   releaseLockFn?: Function,
 *   skipLock?: boolean,
 *   materializeFn?: Function,
 *   cutoffRaw?: unknown,
 *   cutoffMs?: number,
 *   env?: object,
 * }} [opts]
 */
async function runRechazadosSurveyInviteDue(opts) {
  const options = opts || {};
  const now = options.now || new Date();
  const counters = emptyCounters();
  const lockedBy = randomUUID();
  const skipLock = options.skipLock === true;

  const acquire =
    options.acquireLockFn ||
    function (id) {
      return acquireJobLock(id, options.supabase);
    };
  const release =
    options.releaseLockFn ||
    function (id) {
      return releaseJobLock(id, options.supabase);
    };

  if (!skipLock) {
    const got = await acquire(lockedBy);
    if (!got) {
      return {
        ok: false,
        reason: 'lock_not_acquired',
        job: JOB_NAME,
      };
    }
  }

  try {
    const normalCutoff = resolveNormalCutoffAt({
      cutoffRaw: options.cutoffRaw,
      cutoffMs: options.cutoffMs,
      env: options.env,
    });
    if (!normalCutoff.ok) {
      logger.error('rechazados_survey_invite_due fail-closed: cutoff', {
        jobName: JOB_NAME,
        reason: SEQUENCE_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
      });
      return Object.assign(
        {
          ok: false,
          reason: SEQUENCE_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
          job: JOB_NAME,
        },
        emptyCounters(),
        { ok: false },
      );
    }

    const supabase = getSupabase(options.supabase);
    const stepCampaignIds = eligibilityIo.getAllSurveyInviteStepCampaignIds();
    const publicBase = eligibilityIo.getEmailPublicBaseUrl();
    const materializeFn =
      options.materializeFn || materializeRejectedSurveyInvite;

    const { data: estadoRows, error: estErr } = await supabase
      .from('cz_funnel_solicitud_estados')
      .select(
        'cz_historico_id, cz_solicitud_id, fechahora_src, solicitudes_estados_id',
      )
      .eq('solicitudes_estados_id', REJECTED_ESTADO_ID);
    if (estErr) throw new Error('job estados: ' + estErr.message);

    const { data: solicitudRows, error: solErr } = await supabase
      .from('cz_funnel_solicitudes')
      .select('cz_id, ci, email, lrw_id, nombre');
    if (solErr) throw new Error('job solicitudes: ' + solErr.message);

    const lastByCi = resolveLastRejectionByCi(
      estadoRows || [],
      solicitudRows || [],
    );

    /** @type {number[]} */
    const candidateCis = [];
    lastByCi.forEach(function (last, ci) {
      const age = surveyInviteAgeMs(last.fechahora_src, now);
      if (age == null || age < STEP1_MIN_MS) {
        counters.not_due += 1;
        return;
      }
      candidateCis.push(ci);
    });
    counters.candidates = candidateCis.length;

    if (!candidateCis.length) {
      return Object.assign({ job: JOB_NAME }, counters);
    }

    const { data: encuestas, error: encErr } = await supabase
      .from('cz_funnel_encuestas')
      .select('ci')
      .in('ci', candidateCis);
    if (encErr) throw new Error('job encuestas: ' + encErr.message);
    const encuestaCis = new Set(
      (encuestas || []).map(function (e) {
        return Number(e.ci);
      }),
    );

    const emails = [];
    const solByCzId = new Map();
    for (const s of solicitudRows || []) {
      solByCzId.set(Number(s.cz_id), s);
    }
    for (let i = 0; i < candidateCis.length; i += 1) {
      const last = lastByCi.get(candidateCis[i]);
      const sol = last ? solByCzId.get(Number(last.cz_solicitud_id)) : null;
      if (sol && sol.email) emails.push(normalizeEmail(sol.email));
    }
    const suppressed = new Set();
    const uniqueEmails = [...new Set(emails.filter(Boolean))];
    if (uniqueEmails.length) {
      const { data: supRows, error: sErr } = await supabase
        .from('email_suppressions')
        .select('email')
        .in('email', uniqueEmails);
      if (sErr) throw new Error('job suppressions: ' + sErr.message);
      for (const s of supRows || []) {
        suppressed.add(normalizeEmail(s.email));
      }
    }

    const configuredIds = [1, 2, 3]
      .map(function (s) {
        return stepCampaignIds[s];
      })
      .filter(Boolean);

    /** @type {Map<string, object>} campaignId:ci → recipient */
    const priorByCampaignCi = new Map();
    if (configuredIds.length) {
      const { data: priors, error: pErr } = await supabase
        .from('email_campaign_recipients')
        .select(
          'id, campaign_id, ci, email, status, error_reason, purpose, created_at, last_attempt_at, next_attempt_at',
        )
        .in('campaign_id', configuredIds)
        .eq('purpose', PURPOSE)
        .in(
          'ci',
          candidateCis.map(String),
        );
      if (pErr) throw new Error('job recipients: ' + pErr.message);
      for (const p of priors || []) {
        const key = String(p.campaign_id) + ':' + String(p.ci);
        const prev = priorByCampaignCi.get(key);
        if (
          !prev ||
          String(p.created_at || '') > String(prev.created_at || '')
        ) {
          priorByCampaignCi.set(key, p);
        }
      }
    }

    for (let i = 0; i < candidateCis.length; i += 1) {
      const ci = candidateCis[i];
      try {
        const last = lastByCi.get(ci);
        const dueCheck = resolveDueSurveyInviteStep(
          last && last.fechahora_src,
          now,
        );
        if (dueCheck == null) {
          counters.not_due += 1;
          continue;
        }

        const solicitud = last
          ? solByCzId.get(Number(last.cz_solicitud_id)) || null
          : null;
        const emailNorm = solicitud
          ? normalizeEmail(nullableTrimmedText(solicitud.email) || '')
          : '';

        const attemptsByStep = { 1: null, 2: null, 3: null };
        for (let s = 1; s <= 3; s += 1) {
          const cid = stepCampaignIds[s];
          if (!cid) continue;
          attemptsByStep[s] =
            priorByCampaignCi.get(String(cid) + ':' + String(ci)) || null;
        }

        const decision = decideSurveyInviteSequenceAction({
          ci: ci,
          now: now,
          lastRejection: last,
          solicitud: solicitud,
          hasEncuesta: encuestaCis.has(ci),
          isSuppressed: emailNorm ? suppressed.has(emailNorm) : false,
          stepCampaignIds: stepCampaignIds,
          attemptsByStep: attemptsByStep,
          publicBaseUrlConfigured: Boolean(publicBase),
          normalCutoff: normalCutoff,
        });

        if (decision.result === SEQUENCE_REASONS.NOT_DUE) {
          counters.not_due += 1;
          continue;
        }
        if (decision.result === SEQUENCE_REASONS.BEFORE_NORMAL_CUTOFF) {
          counters.before_normal_cutoff += 1;
          continue;
        }
        if (
          decision.result === SEQUENCE_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED
        ) {
          counters.config_missing += 1;
          continue;
        }
        if (decision.result === SEQUENCE_REASONS.PREVIOUS_PENDING) {
          counters.previous_pending += 1;
          if (decision.stuck_pending) {
            counters.stuck_pending_over_threshold += 1;
          }
          continue;
        }
        if (decision.result === SEQUENCE_REASONS.SEQUENCE_COMPLETE) {
          counters.sequence_complete += 1;
          continue;
        }
        if (decision.result === REASONS.CAMPAIGN_NOT_CONFIGURED) {
          counters.config_missing += 1;
          continue;
        }
        if (decision.result === REASONS.PUBLIC_BASE_URL_MISSING) {
          counters.config_missing += 1;
          continue;
        }
        if (decision.result === REASONS.SURVEY_ALREADY_COMPLETED) {
          counters.survey_completed += 1;
          continue;
        }
        if (decision.result === REASONS.EMAIL_SUPPRESSED) {
          counters.suppressed += 1;
          continue;
        }
        if (bumpAlreadyAttempted(counters, decision.result)) {
          continue;
        }

        if (decision.action !== 'materialize' || !decision.campaign_id) {
          continue;
        }

        counters.eligible += 1;
        const outcome = await materializeFn(
          supabase,
          ci,
          decision.campaign_id,
        );
        const materialized =
          outcome &&
          outcome.ok === true &&
          (outcome.result === 'queued' ||
            outcome.result === REASONS.ALREADY_PENDING);
        if (materialized && outcome.result === 'queued') {
          if (decision.due_step === 1) counters.materialized_step1 += 1;
          else if (decision.due_step === 2) counters.materialized_step2 += 1;
          else if (decision.due_step === 3) counters.materialized_step3 += 1;
        } else if (
          outcome &&
          bumpAlreadyAttempted(counters, outcome.result)
        ) {
          // counted
        } else if (outcome && outcome.result === REASONS.CAMPAIGN_NOT_CONFIGURED) {
          counters.config_missing += 1;
        } else if (!outcome || outcome.ok === false) {
          if (outcome && outcome.result === REASONS.SURVEY_ALREADY_COMPLETED) {
            counters.survey_completed += 1;
          } else if (outcome && outcome.result === REASONS.EMAIL_SUPPRESSED) {
            counters.suppressed += 1;
          }
        }
      } catch (err) {
        counters.errors += 1;
        logger.error('rechazados_survey_invite_due CI failed', {
          ci: ci,
          error: err && err.message ? String(err.message).slice(0, 300) : 'unknown',
        });
      }
    }

    return Object.assign({ job: JOB_NAME }, counters);
  } finally {
    if (!skipLock) {
      await release(lockedBy);
    }
  }
}

module.exports = {
  JOB_NAME,
  runRechazadosSurveyInviteDue,
  emptyCounters,
};
