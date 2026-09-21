'use strict';

/**
 * Continuous (always-open) rejected-survey STEP campaigns.
 *
 * Campaigns currently configured as STEP1/2/3 via env are permanent sequence
 * campaigns — they must not auto-complete like one-shot batch campaigns.
 *
 * CONFIG_CHANGE_ASSUMPTION:
 *   Continuity is defined solely by the *active* STEP1/2/3 env values.
 *   Changing STEP1 from campaign A → B makes B continuous and A batch again.
 *
 * CONFIG_CHANGE_RISK:
 *   If A still has queued recipients when removed from STEP config,
 *   the next processQueue drain + recalculateCampaignStatus may set A to
 *   completed (batch semantics). Drain/verify pending recipients before
 *   re-pointing STEP env IDs in production.
 *
 * FUTURE_MIGRATION_REQUIREMENT:
 *   Reconfiguring STEP campaign IDs is an ops change: verify no orphaned
 *   queued recipients on the previous campaign before flipping ENV.
 */

const {
  getAllSurveyInviteStepCampaignIds,
} = require('./rejectedSurveyInviteEligibility');

/**
 * @param {unknown} campaignId
 * @param {{1?: string|null, 2?: string|null, 3?: string|null}|null} [stepIds]
 * @returns {boolean}
 */
function isContinuousRejectedSurveyCampaign(campaignId, stepIds) {
  if (campaignId == null || String(campaignId).trim() === '') return false;
  const id = String(campaignId).trim();
  const steps = stepIds || getAllSurveyInviteStepCampaignIds();
  for (let s = 1; s <= 3; s += 1) {
    const configured = steps[s] != null ? String(steps[s]).trim() : '';
    if (configured && configured === id) return true;
  }
  return false;
}

/**
 * Pure next-status decision after counting recipient buckets.
 * Continuous campaigns never go to completed when the queue is empty.
 *
 * @param {{
 *   queued: number,
 *   sent: number,
 *   failed: number,
 *   isContinuous: boolean,
 * }} input
 * @returns {'sending'|'completed'|'partial_error'|'error'}
 */
function resolveRecalculatedCampaignStatus(input) {
  const queued = Number(input.queued) || 0;
  const sent = Number(input.sent) || 0;
  const failed = Number(input.failed) || 0;
  const continuous = input.isContinuous === true;

  if (queued > 0) return 'sending';
  if (sent > 0 && failed === 0) {
    return continuous ? 'sending' : 'completed';
  }
  if (sent > 0 && failed > 0) return 'partial_error';
  if (sent === 0 && failed > 0) return 'error';
  return 'sending';
}

module.exports = {
  isContinuousRejectedSurveyCampaign,
  resolveRecalculatedCampaignStatus,
};
