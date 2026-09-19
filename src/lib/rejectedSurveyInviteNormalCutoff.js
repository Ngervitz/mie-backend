'use strict';

/**
 * Normal-flow cutoff for Rechazados survey-invite (fail-closed).
 *
 * HISTORICAL: T0 < cutoff → skip normal orchestration
 * NORMAL:     T0 >= cutoff → may proceed with resolveDueSurveyInviteStep
 *
 * Does NOT gate materializeRejectedSurveyInvite (historical pilot primitive).
 */

const CUTOFF_ENV_NAME = 'RECHAZADOS_SURVEY_INVITE_NORMAL_CUTOFF_AT';

const NORMAL_CUTOFF_REASONS = Object.freeze({
  BEFORE_NORMAL_CUTOFF: 'before_normal_cutoff',
  NORMAL_CUTOFF_NOT_CONFIGURED: 'normal_cutoff_not_configured',
});

/**
 * Parse ISO-8601 (must include timezone / Z).
 * @param {unknown} raw
 * @returns {{ ok: true, ms: number, iso: string } | { ok: false, reason: string }}
 */
function parseNormalCutoffAt(raw) {
  if (raw == null) {
    return {
      ok: false,
      reason: NORMAL_CUTOFF_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
    };
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: NORMAL_CUTOFF_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
    };
  }
  // Require explicit timezone: Z or ±HH:MM (or ±HHMM)
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return {
      ok: false,
      reason: NORMAL_CUTOFF_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
    };
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      reason: NORMAL_CUTOFF_REASONS.NORMAL_CUTOFF_NOT_CONFIGURED,
    };
  }
  return { ok: true, ms: ms, iso: new Date(ms).toISOString() };
}

/**
 * Resolve cutoff from opts override or process env / env module.
 * @param {{
 *   cutoffRaw?: unknown,
 *   cutoffMs?: number,
 *   env?: { rechazadosSurveyInviteNormalCutoffAt?: string|null },
 * }=} [opts]
 */
function resolveNormalCutoffAt(opts) {
  const options = opts || {};
  if (
    options.cutoffMs != null &&
    typeof options.cutoffMs === 'number' &&
    Number.isFinite(options.cutoffMs)
  ) {
    return {
      ok: true,
      ms: options.cutoffMs,
      iso: new Date(options.cutoffMs).toISOString(),
    };
  }
  if (options.cutoffRaw !== undefined) {
    return parseNormalCutoffAt(options.cutoffRaw);
  }
  let fromEnvMod = null;
  try {
    const env = options.env || require('../config/env');
    if (
      env &&
      env.rechazadosSurveyInviteNormalCutoffAt != null &&
      String(env.rechazadosSurveyInviteNormalCutoffAt).trim() !== ''
    ) {
      fromEnvMod = env.rechazadosSurveyInviteNormalCutoffAt;
    }
  } catch (_e) {
    /* env may be unavailable in pure unit contexts */
  }
  if (fromEnvMod != null) {
    return parseNormalCutoffAt(fromEnvMod);
  }
  return parseNormalCutoffAt(process.env[CUTOFF_ENV_NAME]);
}

function t0Ms(t0) {
  if (t0 == null || t0 === '') return null;
  if (t0 instanceof Date) {
    const t = t0.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(String(t0));
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {unknown} t0
 * @param {number} cutoffMs
 * @returns {boolean|null} null if T0 unparseable
 */
function isT0AtOrAfterNormalCutoff(t0, cutoffMs) {
  const a = t0Ms(t0);
  if (a == null || !Number.isFinite(cutoffMs)) return null;
  return a >= cutoffMs;
}

module.exports = {
  CUTOFF_ENV_NAME,
  NORMAL_CUTOFF_REASONS,
  parseNormalCutoffAt,
  resolveNormalCutoffAt,
  isT0AtOrAfterNormalCutoff,
  t0Ms,
};
