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
 */
async function getRejectedSurveyInviteEligibility(supabase, ciRaw) {
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

  const campaignId = getWave1CampaignId();
  const publicBase = getEmailPublicBaseUrl();

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
  if (campaignId) {
    const { data: prior, error: priorErr } = await supabase
      .from('email_campaign_recipients')
      .select(
        'id, campaign_id, ci, email, status, error_reason, purpose, template_vars, idempotency_key',
      )
      .eq('campaign_id', campaignId)
      .eq('purpose', PURPOSE)
      .eq('ci', String(ci))
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (priorErr) {
      // Columns purpose may be missing if 2A migration not applied locally —
      // surface clearly.
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
 * Batch attach survey_invite summary onto list rows (same reasons as eligibility).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object[]} rows
 */
async function attachSurveyInviteToListRows(supabase, rows) {
  const list = rows || [];
  if (!list.length) return list;

  const campaignId = getWave1CampaignId();
  const publicBase = getEmailPublicBaseUrl();

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

  let priorByCi = new Map();
  if (campaignId) {
    const { data: priors, error: pErr } = await supabase
      .from('email_campaign_recipients')
      .select(
        'id, campaign_id, ci, email, status, error_reason, purpose, created_at',
      )
      .eq('campaign_id', campaignId)
      .eq('purpose', PURPOSE)
      .in(
        'ci',
        cis.map(String),
      );
    if (pErr) throw new Error('list survey recipients: ' + pErr.message);
    // keep latest per ci
    for (const p of priors || []) {
      const c = Number(p.ci);
      const prev = priorByCi.get(c);
      if (
        !prev ||
        String(p.created_at || '') > String(prev.created_at || '')
      ) {
        priorByCi.set(c, p);
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
    const elig = evaluateRejectedSurveyInviteEligibility({
      ci: ci,
      campaignId: campaignId,
      publicBaseUrlConfigured: Boolean(publicBase),
      lastRejection: last,
      solicitud: solicitud,
      hasEncuesta: encuestaCis.has(ci),
      isSuppressed: emailNorm ? suppressed.has(emailNorm) : false,
      priorRecipient: priorByCi.get(ci) || null,
    });
    return Object.assign({}, row, {
      survey_invite: {
        reason: elig.reason,
        eligible: elig.eligible,
        email_masked: elig.email_masked,
      },
    });
  });
}

module.exports = {
  getWave1CampaignId,
  getEmailPublicBaseUrl,
  getRejectedSurveyInviteEligibility,
  attachSurveyInviteToListRows,
  REASONS,
  PURPOSE,
};
