'use strict';

/**
 * Credizona funnel solicitudes email audience (mirror of CZ solicitudes).
 * Commercial contact evidence: valid email on a synced Credizona solicitud
 * (same contact basis as rechazados survey invite — no marketing_consent flag).
 */

const { isValidEmail } = require('../../lib/rejectedSurveyInvite');
const { normalizeEmail } = require('./unsubscribeToken');

const PAGE_SIZE = 1000;

const CONTROL_EXCLUDE_EMAILS = Object.freeze(['nico@copanel.uy']);

const TEST_EMAIL_DOMAIN_SUFFIXES = Object.freeze(['@example.com', '@example.org', '@test']);

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} table
 * @param {string} columns
 */
async function fetchAllRows(supabase, table, columns) {
  const all = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase.from(table).select(columns).range(from, to);
    if (error) {
      throw new Error(`funnelSolicitudAudience: ${table} fetch failed: ${error.message}`);
    }
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/**
 * @param {string} emailNorm
 * @returns {boolean}
 */
function isExcludedTestAddress(emailNorm) {
  if (!emailNorm) return true;
  const control = new Set(
    CONTROL_EXCLUDE_EMAILS.map((e) => normalizeEmail(e)).filter(Boolean),
  );
  if (control.has(emailNorm)) return true;
  for (let i = 0; i < TEST_EMAIL_DOMAIN_SUFFIXES.length; i += 1) {
    if (emailNorm.endsWith(TEST_EMAIL_DOMAIN_SUFFIXES[i])) return true;
  }
  if (emailNorm.indexOf('e2e-') !== -1 || emailNorm.indexOf('unsub_e2e') !== -1) {
    return true;
  }
  return false;
}

/**
 * @param {object[]} solicitudes
 * @returns {Map<string, object>}
 */
function canonicalByEmail(solicitudes) {
  const byEmail = new Map();
  for (const row of solicitudes) {
    const rawEmail = row && row.email;
    if (!isValidEmail(rawEmail)) continue;
    const emailNorm = normalizeEmail(rawEmail);
    const prev = byEmail.get(emailNorm);
    const ts = row.fecha_reg ? Date.parse(String(row.fecha_reg)) : NaN;
    const prevTs = prev && prev.fecha_reg ? Date.parse(String(prev.fecha_reg)) : NaN;
    if (
      !prev ||
      (Number.isFinite(ts) && (!Number.isFinite(prevTs) || ts > prevTs)) ||
      (ts === prevTs && Number(row.cz_id) > Number(prev.cz_id))
    ) {
      byEmail.set(emailNorm, row);
    }
  }
  return byEmail;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ suppressedSet: Set<string> }} input
 */
async function buildFunnelSolicitudAudienceEligible(supabase, input) {
  const suppressedSet = input && input.suppressedSet ? input.suppressedSet : new Set();
  const solicitudes = await fetchAllRows(
    supabase,
    'cz_funnel_solicitudes',
    'cz_id, ci, email, fecha_reg',
  );

  const canonical = canonicalByEmail(solicitudes);
  let excludedNoEmail = solicitudes.length - canonical.size;
  if (excludedNoEmail < 0) excludedNoEmail = 0;
  let excludedSuppressed = 0;
  let excludedTestControl = 0;
  let excludedDuplicates = 0;

  const eligible = [];
  for (const [emailNorm, row] of canonical.entries()) {
    if (isExcludedTestAddress(emailNorm)) {
      excludedTestControl += 1;
      continue;
    }
    if (suppressedSet.has(emailNorm)) {
      excludedSuppressed += 1;
      continue;
    }
    eligible.push({
      ci: row.ci != null ? String(row.ci) : null,
      email: emailNorm,
      encuesta_score: null,
      marketing_consent: null,
      attributes: { audience_source: 'cz_funnel_solicitudes' },
    });
  }

  return {
    eligible,
    stats: {
      solicitud_rows: solicitudes.length,
      unique_valid_emails: canonical.size,
      excluded_invalid_or_duplicate_rows: excludedNoEmail,
      excluded_suppressed: excludedSuppressed,
      excluded_test_or_control: excludedTestControl,
      excluded_duplicates: excludedDuplicates,
      eligible_count: eligible.length,
    },
  };
}

module.exports = {
  buildFunnelSolicitudAudienceEligible,
  isExcludedTestAddress,
  CONTROL_EXCLUDE_EMAILS,
};
