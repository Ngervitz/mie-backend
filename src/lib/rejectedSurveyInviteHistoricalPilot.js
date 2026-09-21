'use strict';

/**
 * Historical survey-invite pilot runner (authorized 10 CI only).
 *
 * Uses materializeRejectedSurveyInvite → RPC (never due_step / T0 catch-up).
 * Idempotent. At most one new STEP per CI per run.
 * Stop on first unexpected materialize error.
 */

const {
  PURPOSE,
  REASONS,
  evaluateRejectedSurveyInviteEligibility,
  nullableTrimmedText,
  isValidEmail,
} = require('./rejectedSurveyInvite');
const {
  resolveLastRejectionByCi,
} = require('./czFunnelSolicitudContact');
const {
  HISTORICAL_PILOT_CZ_IDS,
  HISTORICAL_PILOT_STEP_CAMPAIGN_IDS,
  HISTORICAL_RESULTS,
  decideHistoricalSurveyInviteAction,
  isAuthorizedPilotCzId,
} = require('./rejectedSurveyInviteHistorical');

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
async function runHistoricalSurveyInvitePilot(supabase, opts) {
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
    authorized_cz_ids: HISTORICAL_PILOT_CZ_IDS.slice(),
    cohort_resolved: 0,
    decisions: [],
    materialized: [],
    skipped: [],
    stopped_survey: [],
    stopped_suppression: [],
    errors: [],
    aborted: false,
    abort_reason: null,
  };

  const { data: estadoRows, error: estErr } = await supabase
    .from('cz_funnel_solicitud_estados')
    .select(
      'cz_historico_id, cz_solicitud_id, fechahora_src, solicitudes_estados_id',
    )
    .eq('solicitudes_estados_id', REJECTED_ESTADO_ID);
  if (estErr) throw new Error('pilot estados: ' + estErr.message);

  const { data: solicitudRows, error: solErr } = await supabase
    .from('cz_funnel_solicitudes')
    .select('cz_id, ci, email, lrw_id, nombre')
    .in('cz_id', HISTORICAL_PILOT_CZ_IDS.slice());
  if (solErr) throw new Error('pilot solicitudes: ' + solErr.message);

  const solByCz = new Map();
  for (const s of solicitudRows || []) {
    solByCz.set(Number(s.cz_id), s);
  }

  for (let i = 0; i < HISTORICAL_PILOT_CZ_IDS.length; i += 1) {
    const id = HISTORICAL_PILOT_CZ_IDS[i];
    if (!solByCz.has(id)) {
      summary.ok = false;
      summary.aborted = true;
      summary.abort_reason = 'missing_solicitud_cz_id_' + id;
      return summary;
    }
  }

  const lastByCi = resolveLastRejectionByCi(
    estadoRows || [],
    solicitudRows || [],
  );

  const cohort = [];
  for (let i = 0; i < HISTORICAL_PILOT_CZ_IDS.length; i += 1) {
    const czId = HISTORICAL_PILOT_CZ_IDS[i];
    const sol = solByCz.get(czId);
    const ci = sol && sol.ci != null ? Number(sol.ci) : null;
    if (ci == null || !Number.isSafeInteger(ci)) {
      summary.ok = false;
      summary.aborted = true;
      summary.abort_reason = 'invalid_ci_for_cz_id_' + czId;
      return summary;
    }
    const last = lastByCi.get(ci);
    if (!last || Number(last.cz_solicitud_id) !== czId) {
      summary.ok = false;
      summary.aborted = true;
      summary.abort_reason =
        'last_rejection_cz_mismatch_ci_' + ci + '_expected_' + czId;
      return summary;
    }
    if (!isAuthorizedPilotCzId(last.cz_solicitud_id)) {
      summary.ok = false;
      summary.aborted = true;
      summary.abort_reason = 'cz_not_authorized_' + last.cz_solicitud_id;
      return summary;
    }
    cohort.push({ ci: ci, cz_id: czId, last: last, sol: sol });
  }
  summary.cohort_resolved = cohort.length;

  const cis = cohort.map(function (c) {
    return c.ci;
  });

  const { data: encuestas, error: encErr } = await supabase
    .from('cz_funnel_encuestas')
    .select('ci')
    .in('ci', cis);
  if (encErr) throw new Error('pilot encuestas: ' + encErr.message);
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
    if (sErr) throw new Error('pilot suppressions: ' + sErr.message);
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
  const { data: priors, error: pErr } = await supabase
    .from('email_campaign_recipients')
    .select(RECIPIENT_SELECT)
    .eq('purpose', PURPOSE)
    .in('campaign_id', campaignIds)
    .in('cz_solicitud_id', episodeIds);
  if (pErr) throw new Error('pilot recipients: ' + pErr.message);

  /** @type {Map<string, object>} campaignId:cz_solicitud_id → recipient */
  const priorByCampaignEpisode = new Map();
  for (const p of priors || []) {
    if (p.cz_solicitud_id == null) continue;
    const key =
      String(p.campaign_id) + ':' + String(p.cz_solicitud_id);
    const prev = priorByCampaignEpisode.get(key);
    if (!prev || String(p.created_at || '') > String(prev.created_at || '')) {
      priorByCampaignEpisode.set(key, p);
    }
  }

  const { data: anyPurpose, error: apErr } = await supabase
    .from('email_campaign_recipients')
    .select('id, campaign_id, ci, status, purpose, created_at')
    .eq('purpose', PURPOSE)
    .in(
      'ci',
      cis.map(String),
    );
  if (apErr) throw new Error('pilot purpose scan: ' + apErr.message);
  const purposeOutsidePilot = [];
  for (const r of anyPurpose || []) {
    const cid = Number(r.campaign_id);
    if (campaignIds.indexOf(cid) < 0) {
      purposeOutsidePilot.push(r);
    }
  }
  if (purposeOutsidePilot.length) {
    summary.ok = false;
    summary.aborted = true;
    summary.abort_reason = 'purpose_recipient_outside_pilot_campaigns';
    summary.errors.push({
      detail: purposeOutsidePilot.map(function (r) {
        return {
          ci: r.ci,
          campaign_id: r.campaign_id,
          status: r.status,
        };
      }),
    });
    return summary;
  }

  for (let i = 0; i < cohort.length; i += 1) {
    const row = cohort[i];
    const ci = row.ci;
    const emailNorm = normalizeEmail(
      nullableTrimmedText(row.sol.email) || '',
    );
    const episodeId = Number(row.cz_id);
    const attemptsByStep = {
      1:
        priorByCampaignEpisode.get(
          String(HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[1]) +
            ':' +
            String(episodeId),
        ) || null,
      2:
        priorByCampaignEpisode.get(
          String(HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[2]) +
            ':' +
            String(episodeId),
        ) || null,
      3:
        priorByCampaignEpisode.get(
          String(HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[3]) +
            ':' +
            String(episodeId),
        ) || null,
    };

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
    });

    const entry = {
      ci: ci,
      cz_id: row.cz_id,
      decision: decision,
      elig_reason: elig.reason,
    };
    summary.decisions.push(entry);

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

    if (dryRun) {
      summary.materialized.push({
        ci: ci,
        cz_id: row.cz_id,
        due_step: decision.due_step,
        campaign_id: decision.campaign_id,
        dry_run: true,
      });
      continue;
    }

    try {
      const outcome = await materializeFn(
        supabase,
        ci,
        decision.campaign_id,
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
  runHistoricalSurveyInvitePilot,
  HISTORICAL_PILOT_CZ_IDS,
  HISTORICAL_PILOT_STEP_CAMPAIGN_IDS,
};
