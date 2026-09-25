'use strict';

/**
 * Mi Plan handoff (A3): emit + redeem + allowlisted context builder.
 * Raw handoff_code is never logged and never stored — only SHA-256 hex hash.
 */

const crypto = require('crypto');
const { PURPOSE } = require('./czMiplanHandoffHmac');

const TTL_SECONDS = 15 * 60;
const REJECTED_ESTADO_IDS = new Set([2, 3]); // fallida, negada (Credizona Constantes)
const TOKEN_BYTES = 32;

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function nullableTrimmedText(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

function omitNulls(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  Object.keys(obj).forEach(function (k) {
    const v = obj[k];
    if (v == null) return;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = omitNulls(v);
      if (nested && Object.keys(nested).length) out[k] = nested;
      return;
    }
    out[k] = v;
  });
  return out;
}

/**
 * Map Credizona relacion_laboral codes to Mi Plan laboral when known.
 * Unknown → omit laboral, keep laboral_source_raw.
 */
function mapLaboral(raw) {
  const code = nullableTrimmedText(raw);
  if (!code) return { laboral: null, laboral_source_raw: null };
  const upper = code.toUpperCase();
  const map = {
    EPR: 'relacion_dependencia',
    EPU: 'relacion_dependencia',
    JUB: 'jubilado',
    ISL: 'monotributista',
    ICL: 'monotributista',
    OTR: 'desempleado',
  };
  return {
    laboral: map[upper] || null,
    laboral_source_raw: code,
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} lrw
 */
async function resolveRejectedEpisodeByLrw(supabase, lrw) {
  const ref = nullableTrimmedText(lrw);
  if (!ref) {
    return { ok: false, reason: 'missing_lrw' };
  }

  const { data: rows, error } = await supabase
    .from('cz_funnel_solicitudes')
    .select(
      'cz_id, ci, lrw_id, email, nombre, apellido, celular, salario, fecha_nacimiento, relacion_laboral, solicitudes_estados_id, synced_at, updated_at_src',
    )
    .eq('lrw_id', ref)
    .order('cz_id', { ascending: false })
    .limit(5);

  if (error) {
    return { ok: false, reason: 'episode_lookup_failed', detail: error.message };
  }
  if (!rows || !rows.length) {
    return { ok: false, reason: 'lrw_not_found' };
  }

  const episode =
    rows.find(function (r) {
      return REJECTED_ESTADO_IDS.has(Number(r.solicitudes_estados_id));
    }) || null;

  if (!episode) {
    return { ok: false, reason: 'episode_not_rejected' };
  }

  return { ok: true, episode: episode, external_ref: ref };
}

/**
 * Lifetime survey by CI (CONTRACT-01). Prefer completed_at DESC, tie cz_id DESC.
 * Sync lag: may be absent immediately after Credizona write — emit still allowed
 * when HMAC-authenticated CZ calls; survey attached at redeem if present.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number|null} ci
 */
async function selectLifetimeSurveyByCi(supabase, ci) {
  if (ci == null || !Number.isFinite(Number(ci))) {
    return null;
  }
  const { data: rows, error } = await supabase
    .from('cz_funnel_encuestas')
    .select('cz_id, ci, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, completed_at')
    .eq('ci', Number(ci))
    .order('completed_at', { ascending: false, nullsFirst: false })
    .order('cz_id', { ascending: false })
    .limit(20);

  if (error || !rows || !rows.length) return null;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (
      r.p1 &&
      r.p2 &&
      r.p3 &&
      r.p4 &&
      r.p5 &&
      r.p6 &&
      r.p7 &&
      r.p8 &&
      r.p9 &&
      r.p10
    ) {
      return r;
    }
  }
  // Fallback: any row for CI (invite gate semantics) without full answers
  return rows[0] || null;
}

/**
 * Revoke active issued tokens for same purpose+LRW, then insert new.
 * Retry-safe: at most one active capability per episode.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ external_ref: string, episode: object }} resolved
 */
async function emitHandoffToken(supabase, resolved) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_SECONDS * 1000);
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const episode = resolved.episode;
  const externalRef = resolved.external_ref;

  const { error: revokeErr } = await supabase
    .from('miplan_handoff_tokens')
    .update({
      status: 'revoked',
      revoked_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('purpose', PURPOSE)
    .eq('external_ref_type', 'lrw')
    .eq('external_ref', externalRef)
    .eq('status', 'issued')
    .is('redeemed_at', null);

  if (revokeErr) {
    return {
      ok: false,
      reason: 'revoke_failed',
      detail: revokeErr.message,
    };
  }

  const row = {
    token_hash: tokenHash,
    purpose: PURPOSE,
    external_ref_type: 'lrw',
    external_ref: externalRef,
    cz_solicitud_id:
      episode.cz_id != null && Number.isFinite(Number(episode.cz_id))
        ? Number(episode.cz_id)
        : null,
    ci:
      episode.ci != null && Number.isFinite(Number(episode.ci))
        ? Number(episode.ci)
        : null,
    status: 'issued',
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('miplan_handoff_tokens')
    .insert(row)
    .select('id, expires_at, issued_at')
    .single();

  if (insertErr) {
    return {
      ok: false,
      reason: 'insert_failed',
      detail: insertErr.message,
    };
  }

  return {
    ok: true,
    handoff_code: raw,
    expires_in: TTL_SECONDS,
    expires_at: inserted.expires_at,
    token_id: inserted.id,
  };
}

/**
 * Build allowlisted CONTRACT-01 context. Never includes monto_solicitado / motivo_rechazo.
 * person.ci omitted from response (minimize).
 *
 * @param {object} episode
 * @param {object|null} survey
 * @param {string} issuedAtIso
 */
function buildAllowlistedContext(episode, survey, issuedAtIso) {
  const laboral = mapLaboral(episode.relacion_laboral);
  const person = omitNulls({
    nombre: nullableTrimmedText(episode.nombre),
    apellido: nullableTrimmedText(episode.apellido),
    email: nullableTrimmedText(episode.email),
    celular:
      episode.celular != null && String(episode.celular).trim() !== ''
        ? String(episode.celular).trim()
        : null,
    fecha_nacimiento: nullableTrimmedText(episode.fecha_nacimiento),
  });

  const financial = omitNulls({
    ingreso:
      episode.salario != null && episode.salario !== ''
        ? Number(episode.salario)
        : null,
    laboral: laboral.laboral,
    laboral_source_raw: laboral.laboral_source_raw,
  });

  let surveyBlock = null;
  if (survey && survey.p1) {
    surveyBlock = {
      selection_rule: 'lifetime_ci',
      completed_at: survey.completed_at || null,
      respuestas: omitNulls({
        p1: survey.p1,
        p2: survey.p2,
        p3: survey.p3,
        p4: survey.p4,
        p5: survey.p5,
        p6: survey.p6,
        p7: survey.p7,
        p8: survey.p8,
        p9: survey.p9,
        p10: survey.p10,
      }),
    };
  }

  const context = {
    contract_version: 1,
    context: {
      funnel: 'credizona_rejected',
      external_ref_type: 'lrw',
      external_ref: nullableTrimmedText(episode.lrw_id),
      issued_at: issuedAtIso,
    },
    provenance: omitNulls({
      source_system: 'credizona',
      synced_at: episode.synced_at || episode.updated_at_src || null,
    }),
  };

  if (person && Object.keys(person).length) context.person = person;
  if (financial && Object.keys(financial).length) {
    context.financial_prefill = financial;
  }
  if (surveyBlock) context.survey = surveyBlock;

  return context;
}

/**
 * Atomic redeem via SQL function. Second concurrent call gets empty set.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rawCode
 */
async function redeemHandoffToken(supabase, rawCode) {
  const raw = nullableTrimmedText(rawCode);
  if (!raw) {
    return { ok: false, reason: 'missing_code', status: 400 };
  }
  const tokenHash = hashToken(raw);

  const { data: consumedRows, error: redeemErr } = await supabase.rpc(
    'redeem_miplan_handoff_token',
    { p_token_hash: tokenHash },
  );

  if (redeemErr) {
    return {
      ok: false,
      reason: 'redeem_failed',
      status: 503,
      detail: redeemErr.message,
    };
  }

  const consumed =
    Array.isArray(consumedRows) && consumedRows.length ? consumedRows[0] : null;

  if (!consumed) {
    // Distinguish expired/missing/already used without leaking which
    const { data: existing } = await supabase
      .from('miplan_handoff_tokens')
      .select('id, status, expires_at, purpose, redeemed_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (!existing) {
      return { ok: false, reason: 'invalid_code', status: 401 };
    }
    if (existing.purpose !== PURPOSE) {
      return { ok: false, reason: 'invalid_purpose', status: 401 };
    }
    if (existing.status === 'consumed' || existing.redeemed_at) {
      return { ok: false, reason: 'already_redeemed', status: 409 };
    }
    if (
      existing.status === 'expired' ||
      (existing.expires_at && Date.parse(existing.expires_at) <= Date.now())
    ) {
      return { ok: false, reason: 'expired', status: 401 };
    }
    if (existing.status === 'revoked') {
      return { ok: false, reason: 'revoked', status: 401 };
    }
    return { ok: false, reason: 'invalid_code', status: 401 };
  }

  if (consumed.purpose !== PURPOSE) {
    return { ok: false, reason: 'invalid_purpose', status: 401 };
  }

  const resolved = await resolveRejectedEpisodeByLrw(
    supabase,
    consumed.external_ref,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      reason: 'episode_unresolvable',
      status: 409,
      detail: resolved.reason,
    };
  }

  const survey = await selectLifetimeSurveyByCi(supabase, resolved.episode.ci);
  const payload = buildAllowlistedContext(
    resolved.episode,
    survey,
    consumed.issued_at || new Date().toISOString(),
  );

  return {
    ok: true,
    context: payload,
    token_id: consumed.id,
  };
}

module.exports = {
  PURPOSE,
  TTL_SECONDS,
  REJECTED_ESTADO_IDS,
  hashToken,
  generateRawToken,
  resolveRejectedEpisodeByLrw,
  selectLifetimeSurveyByCi,
  emitHandoffToken,
  redeemHandoffToken,
  buildAllowlistedContext,
  mapLaboral,
};
