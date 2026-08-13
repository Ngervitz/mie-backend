/**
 * Allowlist-only sanitizer for Credizona solicitudes.tracking_data.
 * Never persist raw tracking_data — only these keys, if present.
 */

const TRACKING_SUMMARY_ALLOWLIST = Object.freeze([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'submitted_at',
]);

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function sanitizeTrackingDataSummary(raw) {
  let obj = null;
  if (raw == null || raw === '') {
    return {};
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '{}' || trimmed === 'null') return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed;
      } else {
        return {};
      }
    } catch {
      return {};
    }
  } else {
    return {};
  }

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of TRACKING_SUMMARY_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const v = obj[key];
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

module.exports = {
  TRACKING_SUMMARY_ALLOWLIST,
  sanitizeTrackingDataSummary,
};
