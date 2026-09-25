'use strict';

/**
 * Pure helpers for Credizona /solicitudes profile fields already present in
 * the decode API payload but previously discarded by JANUS upsert mapping.
 * No I/O. No Credizona changes.
 */

/**
 * Digits-only celular text from API number/string. Empty → null.
 * Does not invent E.164; stores what CZ returns after their own limpiarCelular.
 * @param {unknown} raw
 * @returns {string|null}
 */
function nullableCelular(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    // Avoid scientific notation for phone-sized integers.
    if (!Number.isSafeInteger(raw) || raw < 0) return null;
    return String(raw);
  }
  const digits = String(raw).replace(/\D/g, '');
  return digits === '' ? null : digits;
}

/**
 * Declared salario (income). Non-finite / empty → null.
 * @param {unknown} raw
 * @returns {number|null}
 */
function nullableSalario(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Parse CZ fecha_nacimiento to YYYY-MM-DD or null.
 * Accepts "YYYY-MM-DD" or datetime-ish strings; stores date-only.
 * @param {unknown} raw
 * @returns {string|null}
 */
function parseCzDateOnly(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Validate calendar date via UTC Date.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return (
    String(y).padStart(4, '0') +
    '-' +
    String(mo).padStart(2, '0') +
    '-' +
    String(d).padStart(2, '0')
  );
}

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
 * Map API item → profile patch for cz_funnel_solicitudes upsert.
 * @param {object} item
 * @returns {{
 *   celular: string|null,
 *   salario: number|null,
 *   fecha_nacimiento: string|null,
 *   relacion_laboral: string|null
 * }}
 */
function mapSolicitudProfileFields(item) {
  const src = item && typeof item === 'object' ? item : {};
  return {
    celular: nullableCelular(src.celular),
    salario: nullableSalario(src.salario),
    fecha_nacimiento: parseCzDateOnly(src.fecha_nacimiento),
    relacion_laboral: nullableTrimmedText(src.relacion_laboral),
  };
}

/**
 * Latest non-null celular for a CI from episode rows.
 * Rule: updated_at_src DESC, tie cz_id DESC.
 *
 * @param {Array<{ ci?: unknown, cz_id?: unknown, celular?: unknown, updated_at_src?: unknown }>} rows
 * @param {number} ci
 * @returns {string|null}
 */
function resolveLatestCelularByCi(rows, ci) {
  const target = Number(ci);
  if (!Number.isSafeInteger(target)) return null;
  let best = null;
  let bestT = -1;
  let bestId = -1;
  for (let i = 0; i < (rows || []).length; i += 1) {
    const r = rows[i];
    if (!r || Number(r.ci) !== target) continue;
    const phone = nullableCelular(r.celular);
    if (!phone) continue;
    const t =
      r.updated_at_src != null && r.updated_at_src !== ''
        ? Date.parse(String(r.updated_at_src))
        : NaN;
    const tSafe = Number.isFinite(t) ? t : -1;
    const id = Number(r.cz_id);
    const idSafe = Number.isFinite(id) ? id : -1;
    if (
      !best ||
      tSafe > bestT ||
      (tSafe === bestT && idSafe > bestId)
    ) {
      best = phone;
      bestT = tSafe;
      bestId = idSafe;
    }
  }
  return best;
}

module.exports = {
  nullableCelular,
  nullableSalario,
  parseCzDateOnly,
  mapSolicitudProfileFields,
  resolveLatestCelularByCi,
};
