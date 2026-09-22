'use strict';

/**
 * Display-only survey-invite sequence for Janus Rechazados SCORE column.
 *
 * Separates:
 *   A) OBSERVABLE campaign IDs for dashboard (historical + optional normal env)
 *   B) ENABLED campaign IDs for normal resolve/materialize (env only — untouched here)
 *
 * Observing a campaign does NOT enable the normal job/resolver.
 */

const {
  HISTORICAL_PILOT_STEP_CAMPAIGN_IDS,
  isAuthorizedPilotCzId,
} = require('./rejectedSurveyInviteHistorical');
const { PURPOSE } = require('./rejectedSurveyInvite');
const {
  getAllSurveyInviteStepCampaignIds,
} = require('./rejectedSurveyInviteEligibility');

/**
 * Historical pilot STEP campaign map (display observability).
 * @returns {{1: string, 2: string, 3: string}}
 */
function getHistoricalSurveyInviteStepCampaignIds() {
  return {
    1: String(HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[1]),
    2: String(HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[2]),
    3: String(HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[3]),
  };
}

/**
 * Resolve which campaign IDs are observable for SCORE sequence display.
 * Does not mutate env or enable normal automation.
 *
 * @param {{
 *   normalStepCampaignIds?: {1: string|null, 2: string|null, 3: string|null},
 *   historicalStepCampaignIds?: {1: string, 2: string, 3: string},
 * }=} [opts]
 */
function resolveDisplaySurveyInviteStepCampaigns(opts) {
  const hist =
    (opts && opts.historicalStepCampaignIds) ||
    getHistoricalSurveyInviteStepCampaignIds();
  const normalRaw =
    (opts && opts.normalStepCampaignIds) ||
    getAllSurveyInviteStepCampaignIds();
  const normal = {
    1: normalRaw && normalRaw[1] ? String(normalRaw[1]) : null,
    2: normalRaw && normalRaw[2] ? String(normalRaw[2]) : null,
    3: normalRaw && normalRaw[3] ? String(normalRaw[3]) : null,
  };

  /** @type {Map<string, number>} */
  const campaignToStep = new Map();
  const histSet = new Set();
  const normSet = new Set();

  for (let step = 1; step <= 3; step += 1) {
    const h = hist[step] != null ? String(hist[step]) : null;
    if (h) {
      histSet.add(h);
      campaignToStep.set(h, step);
    }
    const n = normal[step];
    if (n) {
      normSet.add(n);
      campaignToStep.set(n, step);
    }
  }

  const uniqueCampaignIds = [...campaignToStep.keys()];
  const setsEqual =
    histSet.size === normSet.size &&
    [...histSet].every(function (id) {
      return normSet.has(id);
    });

  return {
    historical: hist,
    normal: normal,
    campaignToStep: campaignToStep,
    uniqueCampaignIds: uniqueCampaignIds,
    historicalCampaignIdSet: histSet,
    normalCampaignIdSet: normSet,
    /** True when hist and normal resolve to the exact same ID set (or normal empty). */
    sameCampaignUniverse: normSet.size === 0 || setsEqual,
  };
}

/**
 * Pure: build survey_sequence for one episode from sent recipient rows.
 *
 * @param {object[]} sentRows rows already filtered to purpose + status=sent + episode
 * @param {ReturnType<typeof resolveDisplaySurveyInviteStepCampaigns>} resolution
 */
function buildSurveySequenceForCi(sentRows, resolution) {
  const stepSentAt = { 1: null, 2: null, 3: null };
  let sawHistorical = false;
  let sawNormal = false;
  const histSet = resolution.historicalCampaignIdSet;
  const normSet = resolution.normalCampaignIdSet;

  for (let i = 0; i < (sentRows || []).length; i += 1) {
    const row = sentRows[i];
    const cid = String(row.campaign_id);
    const step = resolution.campaignToStep.get(cid);
    if (step == null) continue;
    const sentAt = row.sent_at != null ? String(row.sent_at) : null;
    if (!sentAt) continue;
    if (histSet.has(cid)) sawHistorical = true;
    if (normSet.has(cid)) sawNormal = true;
    const prev = stepSentAt[step];
    if (prev == null || String(sentAt) > String(prev)) {
      stepSentAt[step] = sentAt;
    }
  }

  const sources_overlap =
    !resolution.sameCampaignUniverse && sawHistorical && sawNormal;

  return {
    step1_sent_at: stepSentAt[1],
    step2_sent_at: stepSentAt[2],
    step3_sent_at: stepSentAt[3],
    sources_overlap: sources_overlap,
  };
}

/**
 * Batch-attach survey_sequence to list rows. No N+1.
 * Episode-scoped: recipients with cz_solicitud_id matching the row.
 *
 * Display-only legacy bridge: for authorized historical pilot episodes
 * (HISTORICAL_PILOT_CZ_IDS), also include sent recipients with
 * cz_solicitud_id IS NULL for that row's CI and historical campaigns.
 * Does NOT attach those NULLs to any newer/non-pilot episode (e.g. 1357).
 * Does not persist; does not change delivery/eligibility.
 *
 * Delivery-side twin: buildHistoricalPilotAttemptsByStep in
 * rejectedSurveyInviteHistorical.js (same isAuthorizedPilotCzId gate).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object[]} rows
 * @param {object=} opts
 */
async function attachSurveySequenceToListRows(supabase, rows, opts) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;

  const resolution = resolveDisplaySurveyInviteStepCampaigns(opts);
  const ids = resolution.uniqueCampaignIds;
  if (!ids.length) {
    return list.map(function (row) {
      return Object.assign({}, row, {
        survey_sequence: {
          step1_sent_at: null,
          step2_sent_at: null,
          step3_sent_at: null,
          sources_overlap: false,
        },
      });
    });
  }

  const episodeIds = [];
  const seenEp = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const ep = Number(list[i].cz_solicitud_id);
    if (!Number.isFinite(ep) || seenEp.has(ep)) continue;
    seenEp.add(ep);
    episodeIds.push(ep);
  }

  /** @type {Map<string, object[]>} */
  const byEpisode = new Map();

  if (episodeIds.length) {
    const { data: priors, error } = await supabase
      .from('email_campaign_recipients')
      .select('ci, campaign_id, status, purpose, sent_at, cz_solicitud_id')
      .in('campaign_id', ids)
      .eq('purpose', PURPOSE)
      .eq('status', 'sent')
      .in('cz_solicitud_id', episodeIds);
    if (error) {
      throw new Error('list survey_sequence recipients: ' + error.message);
    }
    for (let i = 0; i < (priors || []).length; i += 1) {
      const row = priors[i];
      const key = String(row.cz_solicitud_id);
      if (!byEpisode.has(key)) byEpisode.set(key, []);
      byEpisode.get(key).push(row);
    }
  }

  // Legacy NULL bridge — only for authorized historical pilot episodes.
  /** @type {Map<string, object[]>} */
  const legacyByCi = new Map();
  const pilotCis = [];
  const seenPilotCi = new Set();
  for (let i = 0; i < list.length; i += 1) {
    if (!isAuthorizedPilotCzId(list[i].cz_solicitud_id)) continue;
    const ciKey = list[i].ci != null ? String(list[i].ci) : '';
    if (!ciKey || seenPilotCi.has(ciKey)) continue;
    seenPilotCi.add(ciKey);
    pilotCis.push(ciKey);
  }

  const histCampaignIds = [...resolution.historicalCampaignIdSet];
  if (pilotCis.length && histCampaignIds.length) {
    const { data: legacyRows, error: legErr } = await supabase
      .from('email_campaign_recipients')
      .select('ci, campaign_id, status, purpose, sent_at, cz_solicitud_id')
      .in('campaign_id', histCampaignIds)
      .eq('purpose', PURPOSE)
      .eq('status', 'sent')
      .in('ci', pilotCis)
      .is('cz_solicitud_id', null);
    if (legErr) {
      throw new Error(
        'list survey_sequence legacy recipients: ' + legErr.message,
      );
    }
    for (let i = 0; i < (legacyRows || []).length; i += 1) {
      const row = legacyRows[i];
      const ciKey = row.ci != null ? String(row.ci) : '';
      if (!ciKey) continue;
      if (!legacyByCi.has(ciKey)) legacyByCi.set(ciKey, []);
      legacyByCi.get(ciKey).push(row);
    }
  }

  return list.map(function (row) {
    const epKey =
      row.cz_solicitud_id != null ? String(row.cz_solicitud_id) : '';
    let sentRows = epKey ? byEpisode.get(epKey) || [] : [];
    if (isAuthorizedPilotCzId(row.cz_solicitud_id)) {
      const ciKey = row.ci != null ? String(row.ci) : '';
      const legacy = ciKey ? legacyByCi.get(ciKey) || [] : [];
      if (legacy.length) {
        sentRows = sentRows.concat(legacy);
      }
    }
    return Object.assign({}, row, {
      survey_sequence: buildSurveySequenceForCi(sentRows, resolution),
    });
  });
}

const CLICK_QUERY_CHUNK = 200;

/**
 * Pure: map CI keys that have ≥1 survey-invite email click.
 * CI-lifetime (not episode-scoped). Raw clicks only — no bot filter.
 *
 * @param {{ ci: unknown, marketing_impact_id: unknown }[]} recipients
 * @param {{ id: unknown, channel?: unknown }[]} impacts
 * @param {{ impact_id: unknown, event_name?: unknown }[]} events
 * @returns {Set<string>}
 */
function buildSurveyEmailClickedCiSet(recipients, impacts, events) {
  const emailImpactIds = new Set();
  for (let i = 0; i < (impacts || []).length; i += 1) {
    const imp = impacts[i];
    if (!imp || imp.id == null) continue;
    if (String(imp.channel || '') !== 'email') continue;
    emailImpactIds.add(String(imp.id));
  }

  const clickedImpactIds = new Set();
  for (let i = 0; i < (events || []).length; i += 1) {
    const ev = events[i];
    if (!ev || ev.impact_id == null) continue;
    if (String(ev.event_name || '') !== 'click') continue;
    const id = String(ev.impact_id);
    if (!emailImpactIds.has(id)) continue;
    clickedImpactIds.add(id);
  }

  const clickedCis = new Set();
  for (let i = 0; i < (recipients || []).length; i += 1) {
    const r = recipients[i];
    if (!r || r.marketing_impact_id == null || r.ci == null) continue;
    if (!clickedImpactIds.has(String(r.marketing_impact_id))) continue;
    clickedCis.add(String(r.ci));
  }
  return clickedCis;
}

/**
 * Batch-attach survey_email_clicked (CI lifetime) to list rows.
 * purpose=rechazados_survey_invite → marketing_impacts(channel=email) →
 * marketing_impact_events(event_name=click). No N+1 per row.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object[]} rows
 */
async function attachSurveyEmailClickedToListRows(supabase, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;

  const cis = [];
  const seenCi = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const ciKey = list[i].ci != null ? String(list[i].ci) : '';
    if (!ciKey || seenCi.has(ciKey)) continue;
    seenCi.add(ciKey);
    cis.push(ciKey);
  }

  /** @type {Set<string>} */
  const clickedCis = new Set();

  for (let i = 0; i < cis.length; i += CLICK_QUERY_CHUNK) {
    const ciSlice = cis.slice(i, i + CLICK_QUERY_CHUNK);
    const { data: recipients, error: rErr } = await supabase
      .from('email_campaign_recipients')
      .select('ci, marketing_impact_id')
      .eq('purpose', PURPOSE)
      .in('ci', ciSlice)
      .not('marketing_impact_id', 'is', null);
    if (rErr) {
      throw new Error('list survey_email_clicked recipients: ' + rErr.message);
    }

    const impactIds = [];
    const seenImpact = new Set();
    for (let j = 0; j < (recipients || []).length; j += 1) {
      const mid = recipients[j].marketing_impact_id;
      if (mid == null) continue;
      const id = String(mid);
      if (seenImpact.has(id)) continue;
      seenImpact.add(id);
      impactIds.push(id);
    }
    if (!impactIds.length) continue;

    /** @type {object[]} */
    const impacts = [];
    for (let j = 0; j < impactIds.length; j += CLICK_QUERY_CHUNK) {
      const slice = impactIds.slice(j, j + CLICK_QUERY_CHUNK);
      const { data, error } = await supabase
        .from('marketing_impacts')
        .select('id, channel')
        .in('id', slice);
      if (error) {
        throw new Error('list survey_email_clicked impacts: ' + error.message);
      }
      for (let k = 0; k < (data || []).length; k += 1) impacts.push(data[k]);
    }

    const emailImpactIds = [];
    for (let j = 0; j < impacts.length; j += 1) {
      if (String(impacts[j].channel || '') !== 'email') continue;
      emailImpactIds.push(String(impacts[j].id));
    }
    if (!emailImpactIds.length) continue;

    /** @type {object[]} */
    const events = [];
    for (let j = 0; j < emailImpactIds.length; j += CLICK_QUERY_CHUNK) {
      const slice = emailImpactIds.slice(j, j + CLICK_QUERY_CHUNK);
      const { data, error } = await supabase
        .from('marketing_impact_events')
        .select('impact_id, event_name')
        .in('impact_id', slice)
        .eq('event_name', 'click');
      if (error) {
        throw new Error('list survey_email_clicked events: ' + error.message);
      }
      for (let k = 0; k < (data || []).length; k += 1) events.push(data[k]);
    }

    const chunkClicked = buildSurveyEmailClickedCiSet(
      recipients || [],
      impacts,
      events,
    );
    for (const ci of chunkClicked) clickedCis.add(ci);
  }

  return list.map(function (row) {
    const ciKey = row.ci != null ? String(row.ci) : '';
    return Object.assign({}, row, {
      survey_email_clicked: ciKey ? clickedCis.has(ciKey) : false,
    });
  });
}

module.exports = {
  PURPOSE,
  getHistoricalSurveyInviteStepCampaignIds,
  resolveDisplaySurveyInviteStepCampaigns,
  buildSurveySequenceForCi,
  attachSurveySequenceToListRows,
  buildSurveyEmailClickedCiSet,
  attachSurveyEmailClickedToListRows,
};
