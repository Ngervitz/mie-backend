/**
 * Allowlist-only sanitizer for Credizona solicitudes.tracking_data.
 * Never persist raw tracking_data — only these keys, if present.
 * `jt` is allowlisted but validated structurally; not copied like UTMs.
 */

const TRACKING_SUMMARY_ALLOWLIST = Object.freeze([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'submitted_at',
  'jt',
]);

const TRACKING_SUMMARY_COPY_KEYS = Object.freeze(
  TRACKING_SUMMARY_ALLOWLIST.filter(function (k) {
    return k !== 'jt';
  }),
);

const JT_RE = /^[A-Za-z0-9_-]{22}$/;

function normalizeJt(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!JT_RE.test(trimmed)) return null;
  return trimmed;
}

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
  for (const key of TRACKING_SUMMARY_COPY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const v = obj[key];
      if (v !== undefined) out[key] = v;
    }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'jt')) {
    const jt = normalizeJt(obj.jt);
    if (jt) out.jt = jt;
  }
  return out;
}

/**
 * First valid jt wins per cz_id. Incoming UTMs otherwise replace.
 * @param {number} czId
 * @param {Record<string, unknown>|null|undefined} incomingSummary
 * @param {unknown} existingJt
 * @returns {{ tracking_data_summary: Record<string, unknown>, conflict: object|null }}
 */
function applyJtFirstValidWins(czId, incomingSummary, existingJt) {
  const incoming = normalizeJt(incomingSummary && incomingSummary.jt);
  const existing = normalizeJt(existingJt);
  const out = Object.assign({}, incomingSummary || {});
  delete out.jt;
  let conflict = null;
  if (existing) {
    out.jt = existing;
    if (incoming && incoming !== existing) {
      conflict = {
        kind: 'cz_funnel_jt_conflict',
        cz_id: czId,
        existing_jt_suffix: existing.slice(-4),
        incoming_jt_suffix: incoming.slice(-4),
      };
    }
  } else if (incoming) {
    out.jt = incoming;
  }
  return { tracking_data_summary: out, conflict: conflict };
}

module.exports = {
  TRACKING_SUMMARY_ALLOWLIST,
  TRACKING_SUMMARY_COPY_KEYS,
  JT_RE,
  normalizeJt,
  applyJtFirstValidWins,
  sanitizeTrackingDataSummary,
};
