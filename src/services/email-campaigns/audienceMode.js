'use strict';

/**
 * email_campaigns.audience_mode — explicit audience materialization mode.
 * DB stores TEXT + CHECK; no permanent DEFAULT (fail-closed direct inserts).
 */

const EMAIL_AUDIENCE_MODES = Object.freeze({
  SEGMENT_DRIVEN: 'SEGMENT_DRIVEN',
  DIRECTED: 'DIRECTED',
});

const EMAIL_AUDIENCE_MODE_SET = new Set(Object.values(EMAIL_AUDIENCE_MODES));

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidEmailAudienceMode(value) {
  if (value == null || value === '') return false;
  return EMAIL_AUDIENCE_MODE_SET.has(String(value).trim());
}

/**
 * Resolve create-time audience mode from HTTP body.
 * Legacy: mode omitted + segment_id present → SEGMENT_DRIVEN (explicit in app).
 * Never assume DIRECTED from missing segment alone.
 *
 * @param {{ audience_mode?: unknown, mode?: unknown, segment_id?: unknown }} body
 * @returns {{ ok: true, mode: string }|{ ok: false, error: string }}
 */
function resolveAudienceModeForCreate(body) {
  const input = body || {};
  const rawMode =
    input.audience_mode != null && String(input.audience_mode).trim() !== ''
      ? String(input.audience_mode).trim()
      : input.mode != null && String(input.mode).trim() !== ''
        ? String(input.mode).trim()
        : null;
  const hasSegment =
    input.segment_id != null && String(input.segment_id).trim() !== '';

  if (rawMode == null) {
    if (hasSegment) {
      return { ok: true, mode: EMAIL_AUDIENCE_MODES.SEGMENT_DRIVEN };
    }
    return {
      ok: false,
      error:
        'audience_mode is required when segment_id is omitted (use DIRECTED or SEGMENT_DRIVEN)',
    };
  }

  if (!isValidEmailAudienceMode(rawMode)) {
    return { ok: false, error: 'unknown audience_mode: ' + rawMode };
  }

  const mode = String(rawMode).trim();
  if (mode === EMAIL_AUDIENCE_MODES.DIRECTED && hasSegment) {
    return {
      ok: false,
      error: 'DIRECTED campaigns must not include segment_id',
    };
  }
  if (mode === EMAIL_AUDIENCE_MODES.SEGMENT_DRIVEN && !hasSegment) {
    return {
      ok: false,
      error: 'segment_id is required for SEGMENT_DRIVEN campaigns',
    };
  }
  return { ok: true, mode: mode };
}

module.exports = {
  EMAIL_AUDIENCE_MODES,
  EMAIL_AUDIENCE_MODE_SET,
  isValidEmailAudienceMode,
  resolveAudienceModeForCreate,
};
