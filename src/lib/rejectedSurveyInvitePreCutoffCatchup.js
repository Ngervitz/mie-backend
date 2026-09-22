'use strict';

/**
 * Pre-cutoff survey-invite catch-up runner (authorized frozen 112 CZ IDs).
 *
 * Clock: T_HIST = STEP1.sent_at → S2 = +24h, S3 = +72h (historical helpers).
 * Does NOT auto-materialize STEP1 (one-time external). allowStep1Materialize=false.
 * Does NOT use rejection T0 / normal due-job / cutoff.
 * Does NOT attach legacy NULL bridge (pilot-only).
 * Always materializes with { czSolicitudId: episodeId }.
 *
 * Distinct from runHistoricalSurveyInvitePilot (HISTORICAL_PILOT_CZ_IDS ×10).
 */

const {
  PURPOSE,
  REASONS,
  evaluateRejectedSurveyInviteEligibility,
  nullableTrimmedText,
  isValidEmail,
} = require('./rejectedSurveyInvite');
const {
  HISTORICAL_PILOT_STEP_CAMPAIGN_IDS,
  HISTORICAL_RESULTS,
  decideHistoricalSurveyInviteAction,
  putPreferredAttempt,
  buildHistoricalPilotAttemptsByStep,
  isAuthorizedPilotCzId,
} = require('./rejectedSurveyInviteHistorical');
const {
  PRE_CUTOFF_CATCHUP_CZ_IDS,
  isAuthorizedPreCutoffCatchupCzId,
} = require('./rejectedSurveyInvitePreCutoffCatchupIds');

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function defaultMaterializeFn() {
  return require('./rejectedSurveyInviteMaterialize')
    .materializeRejectedSurveyInvite;
}

const REJECTED_ESTADO_ID = 3;
const RECIPIENT_SELECT =
  'id, campaign_id, ci, email, status, error_reason, purpose, created_at, sent_at, provider_send_started_at, idempotency_key, cz_solicitud_id';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   now?: Date,
 *   dryRun?: boolean,
 *   stopOnError?: boolean,
 *   materializeFn?: Function,
 * }} [opts]
 */
async function runPreCutoffCatchupSurveyInvite(supabase, opts) {
  const options = opts || {};
  const now = options.now || new Date();
  const dryRun = options.dryRun === true;
  const stopOnError = options.stopOnError !== false;
  const materializeFn = dryRun
    ? null
    : options.materializeFn || defaultMaterializeFn();

  const summary = {
    ok: true,
    dry_run: dryRun,
    cohort: 'pre_cutoff_catchup',
    authorized_cz_ids: PRE_CUTOFF_CATCHUP_CZ_IDS.slice(),
    authorized_count: PRE_CUTOFF_CATCHUP_CZ_IDS.length,
    cohort_resolved: 0,
    decisions: [],
    materialized: [],
    skipped: [],
    s1_not_started: [],
    waiting_step1_send: [],
    stopped_survey: [],
    stopped_suppression: [],
    errors: [],
    aborted: false,
    abort_reason: null,
  };

  for (let i = 0; i < PRE_CUTOFF_CATCHUP_CZ_IDS.length; i += 1) {
    const id = PRE_CUTOFF_CATCHUP_CZ_IDS[i];
    if (Number(id) === 1357) {
      summary.ok = false;
      summary.aborted = true;
      summary.abort_reason = 'cohort_contains_forbidden_cz_1357';
      return summary;
    }
    if (isAuthorizedPilotCzId(id)) {
      summary.ok = false;
      summary.aborted = true;
      summary.abort_reason = 'cohort_overlaps_historical_pilot_cz_' + id;
      return summary;
    }
  }

  const { data: solicitudRows, error: solErr } = await supabase
    .from('cz_funnel_solicitudes')
    .select('cz_id, ci, email, lrw_id, nombre')
    .in('cz_id', PRE_CUTOFF_CATCHUP_CZ_IDS.slice());
  if (solErr) throw new Error('catchup solicitudes: ' + solErr.message);

  const solByCz = new Map();
  for (const s of solicitudRows || []) {
    solByCz.set(Number(s.cz_id), s);
  }

  const { data: estadoRows, error: estErr } = await supabase
    .from('cz_funnel_solicitud_estados')
    .select(
      'cz_historico_id, cz_solicitud_id, fechahora_src, solicitudes_estados_id',
    )
    .eq('solicitudes_estados_id', REJECTED_ESTADO_ID)
    .in('cz_solicitud_id', PRE_CUTOFF_CATCHUP_CZ_IDS.slice());
  if (estErr) throw new Error('catchup estados: ' + estErr.message);

  const estadoByCz = new Map();
  for (const est of estadoRows || []) {
    const cz = Number(est.cz_solicitud_id);
    const prev = estadoByCz.get(cz);
    if (
      !prev ||
      String(est.fechahora_src || '') > String(prev.fechahora_src || '')
    ) {
      estadoByCz.set(cz, est);
    }
  }

  const cohort = [];
  for (let i = 0; i < PRE_CUTOFF_CATCHUP_CZ_IDS.length; i += 1) {
    const czId = PRE_CUTOFF_CATCHUP_CZ_IDS[i];
    if (!isAuthorizedPreCutoffCatchupCzId(czId)) {
      summary.ok = false;
      summary.aborted = true;
      summary.abort_reason = 'cz_not_authorized_' + czId;
      return summary;
    }
    const sol = solByCz.get(czId);
    if (!sol) {
      summary.errors.push({ cz_id: czId, error: 'missing_solicitud' });
      summary.skipped.push({ cz_id: czId, reason: 'missing_solicitud' });
      continue;
    }
    const ci = sol.ci != null ? Number(sol.ci) : null;
    if (ci == null || !Number.isSafeInteger(ci)) {
      summary.errors.push({ cz_id: czId, error: 'invalid_ci' });
      summary.skipped.push({ cz_id: czId, reason: 'invalid_ci' });
      continue;
    }
    const est = estadoByCz.get(czId) || null;
    const last = {
      ci: ci,
      cz_solicitud_id: czId,
      cz_historico_id: est ? Number(est.cz_historico_id) || 0 : 0,
      fechahora_src: est ? est.fechahora_src : null,
    };
    cohort.push({ ci: ci, cz_id: czId, last: last, sol: sol });
  }
  summary.cohort_resolved = cohort.length;

  const cis = cohort.map(function (c) {
    return c.ci;
  });

  const { data: encuestas, error: encErr } = await supabase
    .from('cz_funnel_encuestas')
    .select('ci')
    .in('ci', cis.length ? cis : [-1]);
  if (encErr) throw new Error('catchup encuestas: ' + encErr.message);
  const encuestaCis = new Set(
    (encuestas || []).map(function (e) {
      return Number(e.ci);
    }),
  );

  const emails = [];
  for (let i = 0; i < cohort.length; i += 1) {
    const em = nullableTrimmedText(cohort[i].sol.email);
    if (isValidEmail(em)) emails.push(normalizeEmail(em));
  }
  const suppressed = new Set();
  const uniqueEmails = [...new Set(emails.filter(Boolean))];
  if (uniqueEmails.length) {
    const { data: supRows, error: sErr } = await supabase
      .from('email_suppressions')
      .select('email')
      .in('email', uniqueEmails);
    if (sErr) throw new Error('catchup suppressions: ' + sErr.message);
    for (const s of supRows || []) {
      suppressed.add(normalizeEmail(s.email));
    }
  }

  const campaignIds = [
    HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[1],
    HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[2],
    HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[3],
  ];
  const episodeIds = cohort.map(function (row) {
    return Number(row.cz_id);
  });

  const priorByCampaignEpisode = new Map();
  if (episodeIds.length) {
    const { data: priors, error: pErr } = await supabase
      .from('email_campaign_recipients')
      .select(RECIPIENT_SELECT)
      .eq('purpose', PURPOSE)
      .in('campaign_id', campaignIds)
      .in('cz_solicitud_id', episodeIds);
    if (pErr) throw new Error('catchup recipients: ' + pErr.message);
    for (const p of priors || []) {
      if (p.cz_solicitud_id == null) continue;
      const key =
        String(p.campaign_id) + ':' + String(p.cz_solicitud_id);
      putPreferredAttempt(priorByCampaignEpisode, key, p);
    }
  }

  for (let i = 0; i < cohort.length; i += 1) {
    const row = cohort[i];
    const ci = row.ci;
    const emailNorm = normalizeEmail(
      nullableTrimmedText(row.sol.email) || '',
    );
    const episodeId = Number(row.cz_id);

    const attemptsByStep = buildHistoricalPilotAttemptsByStep({
      episodeId: episodeId,
      ci: ci,
      episodeScopedByCampaignEpisode: priorByCampaignEpisode,
      legacyNullByCiCampaign: new Map(),
    });

    const dueStepGuess = !attemptsByStep[1]
      ? 1
      : !attemptsByStep[2]
        ? 2
        : 3;
    const dueCampaignId = HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[dueStepGuess];
    const elig = evaluateRejectedSurveyInviteEligibility({
      ci: ci,
      campaignId: dueCampaignId,
      publicBaseUrlConfigured: true,
      lastRejection: row.last,
      solicitud: row.sol,
      hasEncuesta: encuestaCis.has(ci),
      isSuppressed: emailNorm ? suppressed.has(emailNorm) : false,
      priorRecipient: attemptsByStep[dueStepGuess] || null,
    });

    const decision = decideHistoricalSurveyInviteAction({
      now: now,
      inCohort: true,
      dataEligible: elig.eligible === true,
      dataReason: elig.eligible ? null : elig.reason,
      hasEncuesta: encuestaCis.has(ci),
      isSuppressed: emailNorm ? suppressed.has(emailNorm) : false,
      attemptsByStep: attemptsByStep,
      allowStep1Materialize: false,
    });

    const entry = {
      ci: ci,
      cz_id: row.cz_id,
      decision: decision,
      elig_reason: elig.reason,
    };
    summary.decisions.push(entry);

    if (decision.result === HISTORICAL_RESULTS.S1_NOT_STARTED) {
      summary.s1_not_started.push(row.cz_id);
      summary.skipped.push(entry);
      continue;
    }
    if (decision.result === HISTORICAL_RESULTS.WAITING_STEP1_SEND) {
      summary.waiting_step1_send.push(row.cz_id);
      summary.skipped.push(entry);
      continue;
    }
    if (decision.result === HISTORICAL_RESULTS.SEQUENCE_STOPPED_SURVEY) {
      summary.stopped_survey.push(ci);
      summary.skipped.push(entry);
      continue;
    }
    if (decision.result === HISTORICAL_RESULTS.SEQUENCE_STOPPED_SUPPRESSION) {
      summary.stopped_suppression.push(ci);
      summary.skipped.push(entry);
      continue;
    }
    if (decision.action !== 'materialize') {
      summary.skipped.push(entry);
      continue;
    }

    if (Number(decision.due_step) === 1) {
      summary.ok = false;
      summary.errors.push({
        ci: ci,
        cz_id: row.cz_id,
        error: 'refused_step1_materialize',
      });
      if (stopOnError) {
        summary.aborted = true;
        summary.abort_reason = 'refused_step1_cz_' + row.cz_id;
        return summary;
      }
      continue;
    }

    if (dryRun) {
      summary.materialized.push({
        ci: ci,
        cz_id: row.cz_id,
        due_step: decision.due_step,
        campaign_id: decision.campaign_id,
        dry_run: true,
        t_hist: decision.t_hist,
        step2_due_at: decision.step2_due_at,
        step3_due_at: decision.step3_due_at,
      });
      continue;
    }

    try {
      const outcome = await materializeFn(
        supabase,
        ci,
        decision.campaign_id,
        { czSolicitudId: episodeId },
      );
      const ok =
        outcome &&
        outcome.ok === true &&
        (outcome.result === 'queued' ||
          outcome.result === REASONS.ALREADY_PENDING);
      summary.materialized.push({
        ci: ci,
        cz_id: row.cz_id,
        due_step: decision.due_step,
        campaign_id: decision.campaign_id,
        outcome: {
          ok: outcome && outcome.ok,
          result: outcome && outcome.result,
          recipient_id: outcome && outcome.recipient_id,
        },
      });
      if (!ok) {
        summary.ok = false;
        summary.errors.push({
          ci: ci,
          error: 'materialize_not_ok',
          outcome: outcome,
        });
        if (stopOnError) {
          summary.aborted = true;
          summary.abort_reason = 'materialize_failed_ci_' + ci;
          return summary;
        }
      }
    } catch (err) {
      summary.ok = false;
      summary.errors.push({
        ci: ci,
        error: err && err.message ? String(err.message) : String(err),
      });
      if (stopOnError) {
        summary.aborted = true;
        summary.abort_reason = 'materialize_exception_ci_' + ci;
        return summary;
      }
    }
  }

  return summary;
}

module.exports = {
  runPreCutoffCatchupSurveyInvite,
  PRE_CUTOFF_CATCHUP_CZ_IDS,
  isAuthorizedPreCutoffCatchupCzId,
};
