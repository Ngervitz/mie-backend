'use strict';

/**
 * Mi Plan waitlist interest from the Credizona rejected thank-you page.
 *
 * The browser only sends the handoff_code it already holds. Identity (CI, LRW,
 * solicitud) comes from miplan_handoff_tokens; the token is read, never redeemed.
 * One interest per CI: the first registration wins, replays are success no-ops.
 * Raw handoff_code and CI are never logged.
 */

const { PURPOSE } = require('./czMiplanHandoffHmac');
const { hashToken } = require('./miplanHandoffTokens');

const SOURCE = 'credizona_rejected_thank_you';
const HANDOFF_CODE_RE = /^[A-Za-z0-9_-]{20,128}$/;
const TOKEN_SELECT =
  'id, purpose, status, external_ref_type, external_ref, cz_solicitud_id, ci, expires_at, redeemed_at, revoked_at';
const INTEREST_SELECT = 'ci, mi_plan_interest_at';

/**
 * Only handoff_code is read; anything else in the body is ignored.
 * @param {unknown} body
 */
function parseInterestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid_body' };
  }
  const code = typeof body.handoff_code === 'string' ? body.handoff_code.trim() : '';
  if (!HANDOFF_CODE_RE.test(code)) {
    return { error: 'invalid_code' };
  }
  return { value: { handoff_code: code } };
}

function safeInteger(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Fail closed: unknown, other purpose, consumed, revoked or expired → not usable.
 * @param {object|null} token
 * @param {number} nowMs
 */
function tokenRejection(token, nowMs) {
  if (!token) return 'invalid_code';
  if (token.purpose !== PURPOSE) return 'invalid_purpose';
  if (token.status === 'consumed' || token.redeemed_at) return 'already_redeemed';
  if (token.status === 'revoked' || token.revoked_at) return 'revoked';
  if (token.status !== 'issued') return 'invalid_code';
  const exp = Date.parse(token.expires_at);
  if (!Number.isFinite(exp) || exp <= nowMs) return 'expired';
  return null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} handoffCode validated by parseInterestBody
 * @param {{ nowMs?: number }=} options
 * @returns {Promise<{ ok: boolean, status: number, reason: string, token_id?: string, replay?: boolean }>}
 */
async function registerMiplanInterest(supabase, handoffCode, options) {
  const nowMs = options && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  const { data: token, error: tokenErr } = await supabase
    .from('miplan_handoff_tokens')
    .select(TOKEN_SELECT)
    .eq('token_hash', hashToken(handoffCode))
    .maybeSingle();
  if (tokenErr) {
    return { ok: false, status: 503, reason: 'token_lookup_failed' };
  }

  const rejection = tokenRejection(token, nowMs);
  if (rejection) {
    return { ok: false, status: 401, reason: rejection };
  }

  const ci = safeInteger(token.ci);
  if (ci == null) {
    return { ok: false, status: 409, reason: 'identity_unresolvable', token_id: token.id };
  }

  const { error: rowErr } = await supabase
    .from('rejected_ci_outreach')
    .upsert({ ci: ci }, { onConflict: 'ci', ignoreDuplicates: true });
  if (rowErr) {
    return { ok: false, status: 503, reason: 'outreach_row_failed', token_id: token.id };
  }

  const { data: updated, error: updErr } = await supabase
    .from('rejected_ci_outreach')
    .update({
      mi_plan_interest_at: new Date(nowMs).toISOString(),
      mi_plan_interest_source: SOURCE,
      mi_plan_interest_lrw:
        token.external_ref_type === 'lrw' && token.external_ref != null
          ? String(token.external_ref)
          : null,
      mi_plan_interest_cz_solicitud_id: safeInteger(token.cz_solicitud_id),
    })
    .eq('ci', ci)
    .is('mi_plan_interest_at', null)
    .select(INTEREST_SELECT);
  if (updErr) {
    return { ok: false, status: 503, reason: 'interest_write_failed', token_id: token.id };
  }
  if (Array.isArray(updated) && updated.length) {
    return { ok: true, status: 200, reason: 'registered', token_id: token.id, replay: false };
  }

  const { data: existing, error: selErr } = await supabase
    .from('rejected_ci_outreach')
    .select(INTEREST_SELECT)
    .eq('ci', ci)
    .maybeSingle();
  if (selErr || !existing || !existing.mi_plan_interest_at) {
    return { ok: false, status: 503, reason: 'interest_confirm_failed', token_id: token.id };
  }
  return { ok: true, status: 200, reason: 'replay', token_id: token.id, replay: true };
}

module.exports = {
  SOURCE,
  HANDOFF_CODE_RE,
  parseInterestBody,
  tokenRejection,
  registerMiplanInterest,
};
