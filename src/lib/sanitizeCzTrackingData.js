/**
 * Allowlist-only sanitizer for Credizona solicitudes.tracking_data.
 * Never persist raw tracking_data — only these keys, if present.
 * `jt`, `seo_landing`, `seo_cta`, `cz_click` and `presentation_at` are
 * allowlisted and validated. They are not copied like UTMs.
 */

const TRACKING_SUMMARY_ALLOWLIST = Object.freeze([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'submitted_at',
  'jt',
  'seo_landing',
  'seo_cta',
  'cz_click',
  'presentation_at',
]);

const SEO_LANDING_MAX = 200;
const SEO_LANDING_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEO_CTA_VALUES = Object.freeze({ hero: true, footer: true });

const TRACKING_SUMMARY_COPY_KEYS = Object.freeze(
  TRACKING_SUMMARY_ALLOWLIST.filter(function (k) {
    return (
      k !== 'jt' &&
      k !== 'seo_landing' &&
      k !== 'seo_cta' &&
      k !== 'cz_click' &&
      k !== 'presentation_at'
    );
  }),
);

const JT_RE = /^[A-Za-z0-9_-]{22}$/;
const CZ_CLICK_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESENTATION_AT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeJt(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!JT_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeSeoLanding(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > SEO_LANDING_MAX) return null;
  if (!SEO_LANDING_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeSeoCta(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!SEO_CTA_VALUES[trimmed]) return null;
  return trimmed;
}

function normalizeCzClick(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!CZ_CLICK_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * ISO-8601 with an explicit zone. Naive datetimes are rejected.
 * The original text is kept so the offset is not rewritten.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizePresentationAt(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!PRESENTATION_AT_RE.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
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
  const seoLanding = normalizeSeoLanding(obj.seo_landing);
  if (seoLanding) out.seo_landing = seoLanding;
  const seoCta = normalizeSeoCta(obj.seo_cta);
  if (seoCta) out.seo_cta = seoCta;
  const czClick = normalizeCzClick(obj.cz_click);
  if (czClick) out.cz_click = czClick;
  const presentationAt = normalizePresentationAt(obj.presentation_at);
  if (presentationAt) out.presentation_at = presentationAt;
  return out;
}

function summaryObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw;
}

/**
 * Keep a value already stored for this solicitud. Incoming fills it only when
 * the stored row does not have a valid one yet.
 * @param {Record<string, unknown>} out
 * @param {Record<string, unknown>|null} existingSummary
 * @param {string} key
 * @param {(raw: unknown) => string|null} normalize
 */
function keepStoredAttribution(out, existingSummary, key, normalize) {
  const stored = normalize(existingSummary && existingSummary[key]);
  if (stored) {
    out[key] = stored;
    return;
  }
  const incoming = normalize(out[key]);
  if (incoming) out[key] = incoming;
  else delete out[key];
}

/**
 * First valid jt wins per cz_id. Incoming UTMs otherwise replace.
 * A cz_click or presentation_at already stored on the row is kept.
 * @param {number} czId
 * @param {Record<string, unknown>|null|undefined} incomingSummary
 * @param {unknown} existingJt
 * @param {Record<string, unknown>|null|undefined} [existingSummary]
 * @returns {{ tracking_data_summary: Record<string, unknown>, conflict: object|null }}
 */
function applyJtFirstValidWins(czId, incomingSummary, existingJt, existingSummary) {
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
  const stored = summaryObject(existingSummary);
  keepStoredAttribution(out, stored, 'cz_click', normalizeCzClick);
  keepStoredAttribution(out, stored, 'presentation_at', normalizePresentationAt);
  return { tracking_data_summary: out, conflict: conflict };
}

module.exports = {
  TRACKING_SUMMARY_ALLOWLIST,
  TRACKING_SUMMARY_COPY_KEYS,
  JT_RE,
  normalizeJt,
  normalizeSeoLanding,
  normalizeCzClick,
  normalizePresentationAt,
  applyJtFirstValidWins,
  sanitizeTrackingDataSummary,
};
