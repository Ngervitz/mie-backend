'use strict';

/**
 * Pure helpers for CZ funnel solicitud contact fields (email / lrw_id)
 * and Rechazados last-rejection resolution. No I/O.
 */

const REJECTED_ESTADO_ID = 3;

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function nullableTrimmedText(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * Lightweight email shape check for rehydration gating (not full RFC).
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidEmail(raw) {
  const s = nullableTrimmedText(raw);
  if (!s) return false;
  const lower = s.toLowerCase();
  const at = lower.indexOf('@');
  if (at < 1) return false;
  const domain = lower.slice(at + 1);
  if (!domain || domain.indexOf('.') < 1) return false;
  if (/\s/.test(s)) return false;
  return true;
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidLrwId(raw) {
  const s = nullableTrimmedText(raw);
  return Boolean(s);
}

/**
 * Map API /solicitudes items → contact patch by cz_id.
 * @param {object[]} apiItems
 * @returns {Map<number, { email: string|null, lrw_id: string|null, ci: number|null }>}
 */
function indexApiContactByCzId(apiItems) {
  const map = new Map();
  for (let i = 0; i < (apiItems || []).length; i += 1) {
    const item = apiItems[i];
    if (!item || item.id == null) continue;
    const czId = Number(item.id);
    if (!Number.isFinite(czId)) continue;
    const ci =
      item.ci != null && item.ci !== '' ? Number(item.ci) : null;
    map.set(czId, {
      email: nullableTrimmedText(item.email),
      lrw_id: nullableTrimmedText(item.lrw_id),
      ci: Number.isFinite(ci) ? ci : null,
    });
  }
  return map;
}

function tsMs(raw) {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

/**
 * Last rejection (estado 3) per CI.
 * Rule: fechahora_src DESC, tie cz_historico_id DESC.
 *
 * @param {Array<{ cz_historico_id?: unknown, cz_solicitud_id?: unknown, fechahora_src?: unknown, solicitudes_estados_id?: unknown }>} estadoRows
 * @param {Array<{ cz_id?: unknown, ci?: unknown }>} solicitudRows
 * @returns {Map<number, { ci: number, cz_solicitud_id: number, cz_historico_id: number, fechahora_src: string|null }>}
 */
function resolveLastRejectionByCi(estadoRows, solicitudRows) {
  const solById = new Map();
  for (let i = 0; i < (solicitudRows || []).length; i += 1) {
    const s = solicitudRows[i];
    const id = Number(s && s.cz_id);
    if (!Number.isFinite(id)) continue;
    solById.set(id, s);
  }

  /** @type {Map<number, { ci: number, cz_solicitud_id: number, cz_historico_id: number, fechahora_src: string|null }>} */
  const byCi = new Map();

  for (let i = 0; i < (estadoRows || []).length; i += 1) {
    const e = estadoRows[i];
    if (Number(e && e.solicitudes_estados_id) !== REJECTED_ESTADO_ID) continue;
    const solId = Number(e && e.cz_solicitud_id);
    const sol = Number.isFinite(solId) ? solById.get(solId) : null;
    const ci = sol && sol.ci != null ? Number(sol.ci) : null;
    if (ci == null || !Number.isSafeInteger(ci)) continue;

    const histId = Number(e.cz_historico_id);
    const t = tsMs(e.fechahora_src);
    const prev = byCi.get(ci);
    if (!prev) {
      byCi.set(ci, {
        ci: ci,
        cz_solicitud_id: solId,
        cz_historico_id: Number.isFinite(histId) ? histId : 0,
        fechahora_src: e.fechahora_src != null ? String(e.fechahora_src) : null,
      });
      continue;
    }
    const pt = tsMs(prev.fechahora_src);
    const tSafe = t == null ? -1 : t;
    const ptSafe = pt == null ? -1 : pt;
    if (
      tSafe > ptSafe ||
      (tSafe === ptSafe &&
        (Number.isFinite(histId) ? histId : 0) > prev.cz_historico_id)
    ) {
      byCi.set(ci, {
        ci: ci,
        cz_solicitud_id: solId,
        cz_historico_id: Number.isFinite(histId) ? histId : 0,
        fechahora_src: e.fechahora_src != null ? String(e.fechahora_src) : null,
      });
    }
  }

  return byCi;
}

/**
 * Plan contact-field updates for existing Janus rows only.
 *
 * @param {{
 *   apiContactByCzId: Map<number, { email: string|null, lrw_id: string|null, ci: number|null }>,
 *   existingCzIds: Set<number>|number[],
 *   lastRejectionByCi: Map<number, { ci: number, cz_solicitud_id: number }>,
 *   janusContactByCzId?: Map<number, { email?: string|null, lrw_id?: string|null }>,
 * }} input
 */
function planSolicitudContactRehydration(input) {
  const apiMap = input.apiContactByCzId || new Map();
  const existing = input.existingCzIds;
  const existingSet =
    existing instanceof Set
      ? existing
      : new Set(
          (existing || [])
            .map(function (id) {
              return Number(id);
            })
            .filter(function (id) {
              return Number.isFinite(id);
            }),
        );
  const lastByCi = input.lastRejectionByCi || new Map();
  const janusMap = input.janusContactByCzId || new Map();

  const rejected = [];
  let withEmail = 0;
  let withLrw = 0;
  let withBoth = 0;
  let resolvable = 0;
  let missingFromJanus = 0;
  let missingFromApi = 0;
  let emailMismatchAcrossSols = 0;

  const apiSolsByCi = new Map();
  apiMap.forEach(function (contact, czId) {
    if (contact.ci == null) return;
    if (!apiSolsByCi.has(contact.ci)) apiSolsByCi.set(contact.ci, []);
    apiSolsByCi.get(contact.ci).push({
      cz_id: czId,
      email: contact.email,
    });
  });

  lastByCi.forEach(function (last, ci) {
    const sols = apiSolsByCi.get(ci) || [];
    const emails = sols
      .map(function (s) {
        return isValidEmail(s.email)
          ? String(s.email).trim().toLowerCase()
          : null;
      })
      .filter(Boolean);
    if (new Set(emails).size > 1) emailMismatchAcrossSols += 1;

    const solId = Number(last.cz_solicitud_id);
    const inJanus = existingSet.has(solId);
    const api = apiMap.get(solId) || null;
    const emailOk = api ? isValidEmail(api.email) : false;
    const lrwOk = api ? isValidLrwId(api.lrw_id) : false;

    if (!inJanus) missingFromJanus += 1;
    if (!api) missingFromApi += 1;

    rejected.push({
      ci: ci,
      cz_solicitud_id: solId,
      in_janus: inJanus,
      in_api: Boolean(api),
      email_ok: emailOk,
      lrw_ok: lrwOk,
      both_ok: emailOk && lrwOk,
    });

    if (inJanus && api) {
      resolvable += 1;
      if (emailOk) withEmail += 1;
      if (lrwOk) withLrw += 1;
      if (emailOk && lrwOk) withBoth += 1;
    }
  });

  const updatesFinal = [];
  const seen = new Set();
  lastByCi.forEach(function (last) {
    const solId = Number(last.cz_solicitud_id);
    if (seen.has(solId)) return;
    if (!existingSet.has(solId)) return;
    const api = apiMap.get(solId);
    if (!api || !isValidEmail(api.email) || !isValidLrwId(api.lrw_id)) return;
    const nextEmail = nullableTrimmedText(api.email);
    const nextLrw = nullableTrimmedText(api.lrw_id);
    const current = janusMap.get(solId) || {};
    const curEmail = nullableTrimmedText(current.email);
    const curLrw = nullableTrimmedText(current.lrw_id);
    if (curEmail === nextEmail && curLrw === nextLrw) return;
    seen.add(solId);
    updatesFinal.push({
      cz_id: solId,
      email: nextEmail,
      lrw_id: nextLrw,
    });
  });

  return {
    rejected_ci_count: lastByCi.size,
    resolvable_count: resolvable,
    with_email_count: withEmail,
    with_lrw_count: withLrw,
    with_both_count: withBoth,
    rows_would_update: updatesFinal.length,
    missing_solicitud_in_janus: missingFromJanus,
    missing_solicitud_in_api: missingFromApi,
    email_mismatch_across_sols: emailMismatchAcrossSols,
    updates: updatesFinal,
    rejected_rows: rejected,
  };
}

/**
 * Gate for the audited 35/35 freeze criterion.
 * @param {ReturnType<typeof planSolicitudContactRehydration>} plan
 * @param {{ expectedRejectedCi?: number }} [opts]
 */
function evaluateRehydrationGate(plan, opts) {
  const expected =
    opts && opts.expectedRejectedCi != null
      ? Number(opts.expectedRejectedCi)
      : 35;
  const ok =
    plan.rejected_ci_count === expected &&
    plan.with_email_count === expected &&
    plan.with_lrw_count === expected &&
    plan.with_both_count === expected &&
    plan.missing_solicitud_in_janus === 0 &&
    plan.missing_solicitud_in_api === 0;

  const discrepancies = [];
  if (plan.rejected_ci_count !== expected) {
    discrepancies.push(
      'rejected_ci_count=' +
        plan.rejected_ci_count +
        ' expected=' +
        expected,
    );
  }
  if (plan.with_email_count !== expected) {
    discrepancies.push(
      'with_email_count=' +
        plan.with_email_count +
        ' expected=' +
        expected,
    );
  }
  if (plan.with_lrw_count !== expected) {
    discrepancies.push(
      'with_lrw_count=' + plan.with_lrw_count + ' expected=' + expected,
    );
  }
  if (plan.with_both_count !== expected) {
    discrepancies.push(
      'with_both_count=' +
        plan.with_both_count +
        ' expected=' +
        expected,
    );
  }
  if (plan.missing_solicitud_in_janus !== 0) {
    discrepancies.push(
      'missing_solicitud_in_janus=' + plan.missing_solicitud_in_janus,
    );
  }
  if (plan.missing_solicitud_in_api !== 0) {
    discrepancies.push(
      'missing_solicitud_in_api=' + plan.missing_solicitud_in_api,
    );
  }

  return { ok: ok, expected: expected, discrepancies: discrepancies };
}

module.exports = {
  REJECTED_ESTADO_ID,
  nullableTrimmedText,
  isValidEmail,
  isValidLrwId,
  indexApiContactByCzId,
  resolveLastRejectionByCi,
  planSolicitudContactRehydration,
  evaluateRehydrationGate,
};
