'use strict';

/**
 * Deterministic {{var}} merge for email subject/body.
 * Only replaces \{\{[a-z_]+\}\} tokens present in the vars map (after defaults).
 * Unknown placeholders are left unchanged.
 */

const { EMAIL_PURPOSES } = require('./purposes');

const PLACEHOLDER_RE = /\{\{([a-z_]+)\}\}/g;
const NOMBRE_FALLBACK = 'Cliente';

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizeTemplateVars(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (!/^[a-z_]+$/.test(k)) continue;
    const v = raw[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s === '') continue;
    out[k] = s;
  }
  return out;
}

/**
 * @param {Record<string, string>} vars
 * @param {string[]} requiredKeys
 * @returns {{ ok: true }|{ ok: false, missing: string }}
 */
function validateRequiredTemplateVars(vars, requiredKeys) {
  for (let i = 0; i < requiredKeys.length; i += 1) {
    const key = requiredKeys[i];
    if (!vars[key]) {
      return { ok: false, missing: key };
    }
  }
  return { ok: true };
}

/**
 * @param {string} text
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function applyTemplate(text, vars) {
  return String(text || '').replace(PLACEHOLDER_RE, function (match, key) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    return vars[key];
  });
}

/**
 * Build merge map including optional nombre fallback.
 * @param {Record<string, string>} vars
 * @param {{ nombreFallback?: string }} [opts]
 * @returns {Record<string, string>}
 */
function buildMergeMap(vars, opts) {
  const map = Object.assign({}, vars);
  if (!map.nombre) {
    map.nombre =
      opts && opts.nombreFallback != null
        ? String(opts.nombreFallback)
        : NOMBRE_FALLBACK;
  }
  return map;
}

/**
 * Validate + render for a recipient purpose.
 * Legacy (purpose null): no required vars; still applies any provided placeholders.
 *
 * @param {{
 *   purpose?: string|null,
 *   subject: string,
 *   bodyHtml: string,
 *   templateVars?: unknown,
 * }} input
 * @returns {{
 *   ok: true,
 *   subject: string,
 *   html: string,
 * }|{
 *   ok: false,
 *   errorReason: string,
 * }}
 */
function renderOutboundEmail(input) {
  const purpose =
    input.purpose != null && String(input.purpose).trim() !== ''
      ? String(input.purpose).trim()
      : null;
  const vars = normalizeTemplateVars(input.templateVars);

  if (purpose === EMAIL_PURPOSES.RECHAZADOS_SURVEY_INVITE) {
    const check = validateRequiredTemplateVars(vars, [
      'survey_url',
      'unsubscribe_url',
    ]);
    if (!check.ok) {
      return {
        ok: false,
        errorReason: 'missing_required_template_var:' + check.missing,
      };
    }
  }

  const merge = buildMergeMap(vars, { nombreFallback: NOMBRE_FALLBACK });
  return {
    ok: true,
    subject: applyTemplate(input.subject, merge),
    html: applyTemplate(input.bodyHtml, merge),
  };
}

module.exports = {
  NOMBRE_FALLBACK,
  PLACEHOLDER_RE,
  normalizeTemplateVars,
  validateRequiredTemplateVars,
  applyTemplate,
  buildMergeMap,
  renderOutboundEmail,
};
