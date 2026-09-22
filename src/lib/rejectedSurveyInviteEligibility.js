'use strict';

/**
 * I/O: load Janus state + evaluate survey-invite eligibility for one CI.
 */

const env = require('../config/env');
const { normalizeCi } = require('./rejectedOps');
const {
  PURPOSE,
  REASONS,
  REJECTED_ESTADO_ID,
  evaluateRejectedSurveyInviteEligibility,
  resolveCurrentLastRejectionForCi,
  nullableTrimmedText,
} = require('./rejectedSurveyInvite');
const { normalizeEmail } = require('../services/email-campaigns/unsubscribeToken');

function getWave1CampaignId() {
  const fromEnv =
    env && env.rechazadosSurveyInviteCampaignId != null
      ? String(env.rechazadosSurveyInviteCampaignId).trim()
      : '';
  if (fromEnv) return fromEnv;
  const raw = process.env.RECHAZADOS_SURVEY_INVITE_CAMPAIGN_ID;
  if (raw == null) return null;
  const t = String(raw).trim();
  return t || null;
}

/**
 * Step campaign ids for the 3-step Encuesta sequence.
 * Never falls back to RECHAZADOS_SURVEY_INVITE_CAMPAIGN_ID (legacy).
 * @param {1|2|3|number} step
 * @returns {string|null}
 */
function getSurveyInviteStepCampaignId(step) {
  const n = Number(step);
  let key = null;
  let envProp = null;
  if (n === 1) {
    key = 'RECHAZADOS_SURVEY_INVITE_STEP1_CAMPAIGN_ID';
    envProp = 'rechazadosSurveyInviteStep1CampaignId';
  } else if (n === 2) {
    key = 'RECHAZADOS_SURVEY_INVITE_STEP2_CAMPAIGN_ID';
    envProp = 'rechazadosSurveyInviteStep2CampaignId';
  } else if (n === 3) {
    key = 'RECHAZADOS_SURVEY_INVITE_STEP3_CAMPAIGN_ID';
    envProp = 'rechazadosSurveyInviteStep3CampaignId';
  } else {
    return null;
  }
  const fromEnv =
    env && env[envProp] != null ? String(env[envProp]).trim() : '';
  if (fromEnv) return fromEnv;
  const raw = process.env[key];
  if (raw == null) return null;
  const t = String(raw).trim();
  return t || null;
}

function getAllSurveyInviteStepCampaignIds() {
  return {
    1: getSurveyInviteStepCampaignId(1),
    2: getSurveyInviteStepCampaignId(2),
    3: getSurveyInviteStepCampaignId(3),
  };
}

function getEmailPublicBaseUrl() {
  const fromEnv =
    env && env.emailPublicBaseUrl != null
      ? String(env.emailPublicBaseUrl).trim()
      : '';
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const raw = process.env.EMAIL_PUBLIC_BASE_URL;
  if (raw == null) return null;
  const t = String(raw).trim().replace(/\/+$/, '');
  return t || null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {unknown} ciRaw
 * @param {{
 *   campaignId?: string|number|null,
 *   czSolicitudId?: string|number|null,
 * }} [opts]
 *   campaignId — required for sequence steps; if omitted, legacy wave1 env.
 *   czSolicitudId — optional explicit episode. When set, eligibility uses that
 *   solicitud (must belong to ciRaw) instead of global last-rejection-by-CI.
 *   Used by the historical pilot so STEP materialization preserves the pilot CZ.
 */
async function getRejectedSurveyInviteEligibility(supabase, ciRaw, opts) {
  const ci = normalizeCi(ciRaw);
  if (ci == null) {
    return evaluateRejectedSurveyInviteEligibility({
      ci: null,
      campaignId: null,
      publicBaseUrlConfigured: false,
      lastRejection: null,
      solicitud: null,
      hasEncuesta: false,
      isSuppressed: false,
      priorRecipient: null,
    });
  }

  const options = opts || {};
  const campaignId =
    options.campaignId != null && String(options.campaignId).trim() !== ''
      ? String(options.campaignId).trim()
      : getWave1CampaignId();
  const publicBase = getEmailPublicBaseUrl();

  const explicitCzRaw = options.czSolicitudId;
  const explicitCz =
    explicitCzRaw != null && String(explicitCzRaw).trim() !== ''
      ? Number(explicitCzRaw)
      : null;
  const hasExplicitEpisode =
    explicitCz != null && Number.isFinite(explicitCz);

  const { data: estadoRows, error: estErr } = await supabase
    .from('cz_funnel_solicitud_estados')
    .select(
      'cz_historico_id, cz_solicitud_id, fechahora_src, solicitudes_estados_id',
    )
    .eq('solicitudes_estados_id', REJECTED_ESTADO_ID);
  if (estErr) throw new Error('eligibility estados: ' + estErr.message);

  const { data: solicitudRows, error: solErr } = await supabase
    .from('cz_funnel_solicitudes')
    .select('cz_id, ci, email, lrw_id, nombre');
  if (solErr) throw new Error('eligibility solicitudes: ' + solErr.message);

  /** @type {{ cz_solicitud_id: number, ci: number, cz_historico_id: number, fechahora_src: string|null }|null} */
  let last = null;
  /** @type {object|null} */
  let solicitud = null;

  if (hasExplicitEpisode) {
    solicitud =
      (solicitudRows || []).find(function (s) {
        return Number(s.cz_id) === explicitCz;
      }) || null;
    if (!solicitud) {
      return evaluateRejectedSurveyInviteEligibility({
        ci: ci,
        campaignId: campaignId,
        publicBaseUrlConfigured: Boolean(publicBase),
        lastRejection: null,
        solicitud: null,
        hasEncuesta: false,
        isSuppressed: false,
        priorRecipient: null,
      });
    }
    const solCi = normalizeCi(solicitud.ci);
    if (solCi == null || Number(solCi) !== Number(ci)) {
      return Object.assign(
        evaluateRejectedSurveyInviteEligibility({
          ci: ci,
          campaignId: campaignId,
          publicBaseUrlConfigured: Boolean(publicBase),
          lastRejection: null,
          solicitud: null,
          hasEncuesta: false,
          isSuppressed: false,
          priorRecipient: null,
        }),
        {
          reason: REASONS.EPISODE_CI_MISMATCH,
          eligible: false,
          cz_solicitud_id: explicitCz,
        },
      );
    }
    last = {
      ci: ci,
      cz_solicitud_id: explicitCz,
      cz_historico_id: 0,
      fechahora_src: null,
    };
  } else {
    last = resolveCurrentLastRejectionForCi(
      estadoRows || [],
      solicitudRows || [],
      ci,
    );
    if (last) {
      solicitud =
        (solicitudRows || []).find(function (s) {
          return Number(s.cz_id) === Number(last.cz_solicitud_id);
        }) || null;
    }
  }

  const { count: encCount, error: encErr } = await supabase
    .from('cz_funnel_encuestas')
    .select('cz_id', { count: 'exact', head: true })
    .eq('ci', ci);
  if (encErr) throw new Error('eligibility encuestas: ' + encErr.message);
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
    if (supErr) throw new Error('eligibility suppressions: ' + supErr.message);
    isSuppressed = Boolean(sup);
  }

  let priorRecipient = null;
  const episodeForPrior =
    last && last.cz_solicitud_id != null
      ? Number(last.cz_solicitud_id)
      : null;
  if (campaignId && episodeForPrior != null && Number.isFinite(episodeForPrior)) {
    const { data: prior, error: priorErr } = await supabase
      .from('email_campaign_recipients')
      .select(
        'id, campaign_id, ci, email, status, error_reason, purpose, template_vars, idempotency_key, cz_solicitud_id',
      )
      .eq('campaign_id', campaignId)
      .eq('purpose', PURPOSE)
      .eq('cz_solicitud_id', episodeForPrior)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (priorErr) {
      throw new Error('eligibility prior recipients: ' + priorErr.message);
    }
    priorRecipient = prior || null;
  }

  return evaluateRejectedSurveyInviteEligibility({
    ci: ci,
    campaignId: campaignId,
    publicBaseUrlConfigured: Boolean(publicBase),
    lastRejection: last,
    solicitud: solicitud,
    hasEncuesta: hasEncuesta,
    isSuppressed: isSuppressed,
    priorRecipient: priorRecipient,
  });
}

/**
 * Batch attach survey_invite summary onto list rows.
 * Uses the same catch-up due-step rules as the job (T0 → dueStep → gates).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object[]} rows
 * @param {{ now?: Date }} [opts]
 */
async function attachSurveyInviteToListRows(supabase, rows, opts) {
  const list = rows || [];
  if (!list.length) return list;

  const now = (opts && opts.now) || new Date();
  const publicBase = getEmailPublicBaseUrl();
  const stepCampaignIds = getAllSurveyInviteStepCampaignIds();
  const configuredStepIds = [1, 2, 3]
    .map(function (s) {
      return stepCampaignIds[s];
    })
    .filter(Boolean);
  const {
    resolveNormalCutoffAt,
    isT0AtOrAfterNormalCutoff,
  } = require('./rejectedSurveyInviteNormalCutoff');
  const normalCutoff = resolveNormalCutoffAt({
    cutoffRaw: opts && opts.cutoffRaw,
    cutoffMs: opts && opts.cutoffMs,
    env: opts && opts.env,
  });

  const cis = list.map(function (r) {
    return Number(r.ci);
  });

  const { data: solicitudRows, error: solErr } = await supabase
    .from('cz_funnel_solicitudes')
    .select('cz_id, ci, email, lrw_id, nombre');
  if (solErr) throw new Error('list survey solicitudes: ' + solErr.message);

  const { data: estadoRows, error: estErr } = await supabase
    .from('cz_funnel_solicitud_estados')
    .select(
      'cz_historico_id, cz_solicitud_id, fechahora_src, solicitudes_estados_id',
    )
    .eq('solicitudes_estados_id', REJECTED_ESTADO_ID);
  if (estErr) throw new Error('list survey estados: ' + estErr.message);

  const { data: encuestas, error: encErr } = await supabase
    .from('cz_funnel_encuestas')
    .select('ci')
    .in('ci', cis);
  if (encErr) throw new Error('list survey encuestas: ' + encErr.message);
  const encuestaCis = new Set(
    (encuestas || []).map(function (e) {
      return Number(e.ci);
    }),
  );

  /** @type {Map<string, object>} key = campaignId + ':' + cz_solicitud_id */
  const priorByCampaignEpisode = new Map();
  const episodeIdsForPriors = [];
  const seenEpPriors = new Set();
  for (const ci of cis) {
    const last = resolveCurrentLastRejectionForCi(
      estadoRows || [],
      solicitudRows || [],
      ci,
    );
    if (last && last.cz_solicitud_id != null) {
      const ep = Number(last.cz_solicitud_id);
      if (Number.isFinite(ep) && !seenEpPriors.has(ep)) {
        seenEpPriors.add(ep);
        episodeIdsForPriors.push(ep);
      }
    }
  }
  if (configuredStepIds.length && episodeIdsForPriors.length) {
    const { data: priors, error: pErr } = await supabase
      .from('email_campaign_recipients')
      .select(
        'id, campaign_id, ci, email, status, error_reason, purpose, created_at, last_attempt_at, next_attempt_at, cz_solicitud_id',
      )
      .in('campaign_id', configuredStepIds)
      .eq('purpose', PURPOSE)
      .in('cz_solicitud_id', episodeIdsForPriors);
    if (pErr) throw new Error('list survey recipients: ' + pErr.message);
    for (const p of priors || []) {
      const key =
        String(p.campaign_id) + ':' + String(p.cz_solicitud_id);
      const prev = priorByCampaignEpisode.get(key);
      if (
        !prev ||
        String(p.created_at || '') > String(prev.created_at || '')
      ) {
        priorByCampaignEpisode.set(key, p);
      }
    }
  }

  const emails = [];
  const lastByCi = new Map();
  for (const ci of cis) {
    const last = resolveCurrentLastRejectionForCi(
      estadoRows || [],
      solicitudRows || [],
      ci,
    );
    lastByCi.set(ci, last);
    if (last) {
      const sol = (solicitudRows || []).find(function (s) {
        return Number(s.cz_id) === Number(last.cz_solicitud_id);
      });
      if (sol && sol.email) emails.push(normalizeEmail(sol.email));
    }
  }

  const suppressed = new Set();
  const uniqueEmails = [...new Set(emails.filter(Boolean))];
  if (uniqueEmails.length) {
    const { data: supRows, error: sErr } = await supabase
      .from('email_suppressions')
      .select('email')
      .in('email', uniqueEmails);
    if (sErr) throw new Error('list survey suppressions: ' + sErr.message);
    for (const s of supRows || []) {
      suppressed.add(normalizeEmail(s.email));
    }
  }

  const {
    resolveDueSurveyInviteStep,
    findPreviousUnresolvedSurveyInvite,
    isSurveyInviteSequenceComplete,
    SEQUENCE_REASONS,
  } = require('./rejectedSurveyInviteSequence');

  return list.map(function (row) {
    const ci = Number(row.ci);
    const last = lastByCi.get(ci) || null;
    let solicitud = null;
    if (last) {
      solicitud =
        (solicitudRows || []).find(function (s) {
          return Number(s.cz_id) === Number(last.cz_solicitud_id);
        }) || null;
    }
    const emailNorm = solicitud
      ? normalizeEmail(nullableTrimmedText(solicitud.email) || '')
      : '';

    if (!configuredStepIds.length) {
      return Object.assign({}, row, {
        survey_invite: {
          reason: REASONS.CAMPAIGN_NOT_CONFIGURED,
          eligible: false,
          email_masked: null,
          due_step: null,
        },
      });
    }

    if (!normalCutoff.ok) {
      return Object.assign({}, row, {
        survey_invite: {
          reason: SEQUENCE_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
          eligible: false,
          email_masked: null,
          due_step: null,
        },
      });
    }

    const dueStep = last
      ? resolveDueSurveyInviteStep(last.fechahora_src, now)
      : null;

    if (!last) {
      const elig = evaluateRejectedSurveyInviteEligibility({
        ci: ci,
        campaignId: stepCampaignIds[1],
        publicBaseUrlConfigured: Boolean(publicBase),
        lastRejection: null,
        solicitud: null,
        hasEncuesta: encuestaCis.has(ci),
        isSuppressed: false,
        priorRecipient: null,
      });
      return Object.assign({}, row, {
        survey_invite: {
          reason: elig.reason,
          eligible: false,
          email_masked: elig.email_masked,
          due_step: null,
        },
      });
    }

    if (
      isT0AtOrAfterNormalCutoff(last.fechahora_src, normalCutoff.ms) !== true
    ) {
      return Object.assign({}, row, {
        survey_invite: {
          reason: SEQUENCE_REASONS.BEFORE_NORMAL_CUTOFF,
          eligible: false,
          email_masked: null,
          due_step: null,
        },
      });
    }

    if (dueStep == null) {
      return Object.assign({}, row, {
        survey_invite: {
          reason: SEQUENCE_REASONS.NOT_DUE,
          eligible: false,
          email_masked: null,
          due_step: null,
        },
      });
    }

    const episodeId =
      last && last.cz_solicitud_id != null
        ? Number(last.cz_solicitud_id)
        : null;
    const attemptsByStep = { 1: null, 2: null, 3: null };
    for (let s = 1; s <= 3; s += 1) {
      const cid = stepCampaignIds[s];
      if (!cid || episodeId == null || !Number.isFinite(episodeId)) continue;
      attemptsByStep[s] =
        priorByCampaignEpisode.get(
          String(cid) + ':' + String(episodeId),
        ) || null;
    }

    if (isSurveyInviteSequenceComplete(attemptsByStep)) {
      return Object.assign({}, row, {
        survey_invite: {
          reason: SEQUENCE_REASONS.SEQUENCE_COMPLETE,
          eligible: false,
          email_masked: null,
          due_step: dueStep,
        },
      });
    }

    const dueCampaignId = stepCampaignIds[dueStep];
    if (!dueCampaignId) {
      return Object.assign({}, row, {
        survey_invite: {
          reason: REASONS.CAMPAIGN_NOT_CONFIGURED,
          eligible: false,
          email_masked: null,
          due_step: dueStep,
        },
      });
    }

    const prev = findPreviousUnresolvedSurveyInvite(attemptsByStep, dueStep);
    if (prev) {
      return Object.assign({}, row, {
        survey_invite: {
          reason: SEQUENCE_REASONS.PREVIOUS_PENDING,
          eligible: false,
          email_masked: null,
          due_step: dueStep,
        },
      });
    }

    const priorRecipient =
      episodeId != null && Number.isFinite(episodeId)
        ? priorByCampaignEpisode.get(
            String(dueCampaignId) + ':' + String(episodeId),
          ) || null
        : null;
    const elig = evaluateRejectedSurveyInviteEligibility({
      ci: ci,
      campaignId: dueCampaignId,
      publicBaseUrlConfigured: Boolean(publicBase),
      lastRejection: last,
      solicitud: solicitud,
      hasEncuesta: encuestaCis.has(ci),
      isSuppressed: emailNorm ? suppressed.has(emailNorm) : false,
      priorRecipient: priorRecipient,
    });
    return Object.assign({}, row, {
      survey_invite: {
        reason: elig.reason,
        eligible: elig.eligible,
        email_masked: elig.email_masked,
        due_step: dueStep,
      },
    });
  });
}

module.exports = {
  getWave1CampaignId,
  getSurveyInviteStepCampaignId,
  getAllSurveyInviteStepCampaignIds,
  getEmailPublicBaseUrl,
  getRejectedSurveyInviteEligibility,
  attachSurveyInviteToListRows,
  REASONS,
  PURPOSE,
};
