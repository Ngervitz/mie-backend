'use strict';

/**
 * Historical survey-invite sequence (pilot) — pure helpers.
 * Clock is independent of rejection T0 / resolveDueSurveyInviteStep.
 *
 * T_HIST = STEP1 recipient.sent_at only (no created_at fallback).
 * STEP2 due at T_HIST + 24h
 * STEP3 due at T_HIST + 72h (from T_HIST, not from STEP2)
 */

const {
  classifyPriorRecipient,
} = require('./rejectedSurveyInvite');

const MS_HOUR = 60 * 60 * 1000;
const STEP2_OFFSET_MS = 24 * MS_HOUR;
const STEP3_OFFSET_MS = 72 * MS_HOUR;

/** Authorized pilot cohort — cz_funnel_solicitudes.cz_id of last-rejection rows. */
const HISTORICAL_PILOT_CZ_IDS = Object.freeze([
  1153, 1154, 1159, 1161, 1163, 1165, 1166, 1169, 1170, 1172,
]);

const HISTORICAL_PILOT_STEP_CAMPAIGN_IDS = Object.freeze({
  1: 6,
  2: 7,
  3: 8,
});

const HISTORICAL_RESULTS = Object.freeze({
  MATERIALIZE: 'materialize',
  NOT_DUE: 'not_due',
  WAITING_STEP1_SEND: 'waiting_step1_send',
  SEQUENCE_STOPPED_SURVEY: 'sequence_stopped_survey',
  SEQUENCE_STOPPED_SUPPRESSION: 'sequence_stopped_suppression',
  SEQUENCE_COMPLETE: 'sequence_complete',
  STEP_ALREADY_PRESENT: 'step_already_present',
  NOT_IN_COHORT: 'not_in_cohort',
  DATA_INELIGIBLE: 'data_ineligible',
});

function tsMs(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

/**
 * Single clock semantic: STEP1.sent_at only.
 * @param {{ sent_at?: unknown }|null|undefined} step1Recipient
 * @returns {string|null}
 */
function resolveHistoricalTHist(step1Recipient) {
  if (!step1Recipient) return null;
  const sent = step1Recipient.sent_at;
  if (sent == null || sent === '') return null;
  const ms = tsMs(sent);
  if (ms == null) return null;
  return sent instanceof Date ? sent.toISOString() : String(sent);
}

function historicalStep2DueAt(tHist) {
  const ms = tsMs(tHist);
  if (ms == null) return null;
  return new Date(ms + STEP2_OFFSET_MS).toISOString();
}

function historicalStep3DueAt(tHist) {
  const ms = tsMs(tHist);
  if (ms == null) return null;
  return new Date(ms + STEP3_OFFSET_MS).toISOString();
}

/**
 * @param {object|null|undefined} recipient
 */
function historicalStepAlreadyPresent(recipient) {
  if (!recipient) return false;
  classifyPriorRecipient(recipient);
  return true;
}

/**
 * Decide at most one historical action for one CI.
 *
 * @param {{
 *   now: Date|string|number,
 *   inCohort: boolean,
 *   dataEligible: boolean,
 *   dataReason?: string|null,
 *   hasEncuesta: boolean,
 *   isSuppressed: boolean,
 *   attemptsByStep: { 1?: object|null, 2?: object|null, 3?: object|null },
 * }} input
 */
function decideHistoricalSurveyInviteAction(input) {
  const nowMs =
    input.now instanceof Date ? input.now.getTime() : tsMs(input.now);
  const attempts = input.attemptsByStep || { 1: null, 2: null, 3: null };
  const base = {
    action: 'skip',
    result: HISTORICAL_RESULTS.NOT_DUE,
    due_step: null,
    campaign_id: null,
    t_hist: null,
    step2_due_at: null,
    step3_due_at: null,
  };

  if (!input.inCohort) {
    return Object.assign({}, base, {
      result: HISTORICAL_RESULTS.NOT_IN_COHORT,
    });
  }

  if (input.hasEncuesta) {
    return Object.assign({}, base, {
      result: HISTORICAL_RESULTS.SEQUENCE_STOPPED_SURVEY,
    });
  }
  if (input.isSuppressed) {
    return Object.assign({}, base, {
      result: HISTORICAL_RESULTS.SEQUENCE_STOPPED_SUPPRESSION,
    });
  }

  const step1 = attempts[1] || null;
  const step2 = attempts[2] || null;
  const step3 = attempts[3] || null;

  if (!step1) {
    if (!input.dataEligible) {
      return Object.assign({}, base, {
        result: HISTORICAL_RESULTS.DATA_INELIGIBLE,
        data_reason: input.dataReason || null,
      });
    }
    return Object.assign({}, base, {
      action: 'materialize',
      result: HISTORICAL_RESULTS.MATERIALIZE,
      due_step: 1,
      campaign_id: HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[1],
    });
  }

  const tHist = resolveHistoricalTHist(step1);
  const step2Due = historicalStep2DueAt(tHist);
  const step3Due = historicalStep3DueAt(tHist);
  Object.assign(base, {
    t_hist: tHist,
    step2_due_at: step2Due,
    step3_due_at: step3Due,
  });

  if (!tHist || nowMs == null) {
    return Object.assign({}, base, {
      result: HISTORICAL_RESULTS.WAITING_STEP1_SEND,
    });
  }

  if (step3 && historicalStepAlreadyPresent(step3)) {
    return Object.assign({}, base, {
      result: HISTORICAL_RESULTS.SEQUENCE_COMPLETE,
      due_step: 3,
      campaign_id: HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[3],
    });
  }

  // At most one new step; never skip STEP2 even if STEP3 wall-clock is past.
  if (!step2) {
    if (nowMs >= tsMs(step2Due)) {
      if (!input.dataEligible) {
        return Object.assign({}, base, {
          result: HISTORICAL_RESULTS.DATA_INELIGIBLE,
          data_reason: input.dataReason || null,
        });
      }
      return Object.assign({}, base, {
        action: 'materialize',
        result: HISTORICAL_RESULTS.MATERIALIZE,
        due_step: 2,
        campaign_id: HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[2],
      });
    }
    return Object.assign({}, base, { result: HISTORICAL_RESULTS.NOT_DUE });
  }

  if (!step3) {
    if (nowMs >= tsMs(step3Due)) {
      if (!input.dataEligible) {
        return Object.assign({}, base, {
          result: HISTORICAL_RESULTS.DATA_INELIGIBLE,
          data_reason: input.dataReason || null,
        });
      }
      return Object.assign({}, base, {
        action: 'materialize',
        result: HISTORICAL_RESULTS.MATERIALIZE,
        due_step: 3,
        campaign_id: HISTORICAL_PILOT_STEP_CAMPAIGN_IDS[3],
      });
    }
    return Object.assign({}, base, { result: HISTORICAL_RESULTS.NOT_DUE });
  }

  return Object.assign({}, base, {
    result: HISTORICAL_RESULTS.STEP_ALREADY_PRESENT,
  });
}

function isAuthorizedPilotCzId(czId) {
  const n = Number(czId);
  return HISTORICAL_PILOT_CZ_IDS.indexOf(n) !== -1;
}

module.exports = {
  MS_HOUR,
  STEP2_OFFSET_MS,
  STEP3_OFFSET_MS,
  HISTORICAL_PILOT_CZ_IDS,
  HISTORICAL_PILOT_STEP_CAMPAIGN_IDS,
  HISTORICAL_RESULTS,
  resolveHistoricalTHist,
  historicalStep2DueAt,
  historicalStep3DueAt,
  decideHistoricalSurveyInviteAction,
  isAuthorizedPilotCzId,
  tsMs,
};
